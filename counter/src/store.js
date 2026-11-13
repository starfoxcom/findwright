// The counter's storage on Cloudflare D1 (SQLite). Tables are in
// counter/schema.sql. No row holds an IP address, a repo name or a user.

import { COUNT_FIELDS, dayOf } from "./rules.js";

/**
 * Wraps a D1 database binding with the two calls the handler needs. The
 * handler takes any object with the same methods, so tests pass an
 * in-memory one.
 */
export class D1Store {
  /** @param {D1Database} database the `DB` binding from wrangler.jsonc */
  constructor(database) {
    this._database = database;
  }

  /**
   * Adds one checked send to its project's totals and answers `{ outcome }`:
   * `"added"`; `"overlap"` with `coveredTo` when the send's window starts before
   * the end of one already counted, so a resent window never counts twice;
   * `"too-soon"` when the project sent less than `gapInMilliseconds` ago; or
   * `"day-full"` for a new project past `maxNewPerDay` today. The limits are
   * conditions of the writes themselves, run as one D1 batch, which is a
   * transaction: two sends arriving together cannot both pass a check.
   */
  async addSend({ send, country, timeInMilliseconds, gapInMilliseconds, maxNewPerDay }) {
    const day = dayOf(timeInMilliseconds);
    const counts = COUNT_FIELDS.map((field) => send[field]);
    const [, , upsert] = await this._database.batch([
      this._database.prepare("DELETE FROM new_projects WHERE day < ?1").bind(day),
      this._database
        .prepare(
          `INSERT OR IGNORE INTO new_projects (day, id)
           SELECT ?1, ?2
           WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = ?2)
             AND (SELECT COUNT(*) FROM new_projects WHERE day = ?1) < ?3`,
        )
        .bind(day, send.project, maxNewPerDay),
      this._database
        .prepare(
          `INSERT INTO projects (id, kind, country, sessions, searches, hits, bytes,
                                 last_send, covered_to)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?12
           WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?1)
              OR EXISTS (SELECT 1 FROM new_projects WHERE day = ?9 AND id = ?1)
           ON CONFLICT (id) DO UPDATE SET
             kind = excluded.kind,
             country = excluded.country,
             sessions = sessions + excluded.sessions,
             searches = searches + excluded.searches,
             hits = hits + excluded.hits,
             bytes = bytes + excluded.bytes,
             last_send = excluded.last_send,
             covered_to = excluded.covered_to
           WHERE projects.last_send <= excluded.last_send - ?10 AND projects.covered_to <= ?11`,
        )
        .bind(
          send.project,
          send.kind,
          country,
          ...counts,
          timeInMilliseconds,
          day,
          gapInMilliseconds,
          send.from,
          send.to,
        ),
    ]);
    if (upsert.meta.changes > 0) return { outcome: "added" };
    const known = await this._database
      .prepare("SELECT covered_to FROM projects WHERE id = ?1")
      .bind(send.project)
      .first();
    if (known === null) return { outcome: "day-full" };
    if (known.covered_to > send.from) return { outcome: "overlap", coveredTo: known.covered_to };
    return { outcome: "too-soon" };
  }

  /** The overall sums, projects per country and the top projects by searches, then hits. */
  async totals(topProjects) {
    const [sums, countries, top] = await this._database.batch([
      this._database.prepare(
        `SELECT COUNT(*) AS projects, COALESCE(SUM(sessions), 0) AS sessions,
                COALESCE(SUM(searches), 0) AS searches, COALESCE(SUM(hits), 0) AS hits,
                COALESCE(SUM(bytes), 0) AS bytes
         FROM projects`,
      ),
      this._database.prepare(
        `SELECT country, COUNT(*) AS projects FROM projects
         GROUP BY country ORDER BY projects DESC`,
      ),
      this._database
        .prepare(
          `SELECT kind, sessions, searches, hits, bytes FROM projects
           ORDER BY searches DESC, hits DESC LIMIT ?1`,
        )
        .bind(topProjects),
    ]);
    return { ...sums.results[0], countries: countries.results, top: top.results };
  }
}
