-- Tables for the opt-in usage counter (counter/src/store.js).
-- A project is a random id the plugin makes once per repo; nothing here
-- names a repo, a query, a file, a user or an IP address.

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,  -- 32 lowercase hex characters, random
  kind       TEXT NOT NULL,     -- one of rules.js KINDS
  country    TEXT NOT NULL,     -- two-letter code Cloudflare derived from the last send, XX unknown
  sessions   INTEGER NOT NULL DEFAULT 0,  -- sessions with at least one scored search, summed
  searches   INTEGER NOT NULL DEFAULT 0,  -- scored searches: ones the session followed by opening a file, summed
  hits       INTEGER NOT NULL DEFAULT 0,  -- scored searches whose answer named the file opened, summed
  bytes      INTEGER NOT NULL DEFAULT 0,  -- answer sizes, summed; each answer capped in rules.js
  last_send  INTEGER NOT NULL,  -- milliseconds since the epoch
  covered_to INTEGER NOT NULL   -- end of the newest counted window, milliseconds since the epoch
);

CREATE INDEX IF NOT EXISTS projects_by_searches ON projects (searches DESC, hits DESC);

-- The last GET /total answer, so a read costs one row. The first read after
-- rules.js TOTALS_MAX_AGE_IN_SECONDS claims the refresh by moving refreshed_at,
-- so one request per period recomputes; every other read gets this copy.
CREATE TABLE IF NOT EXISTS totals_copy (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  refreshed_at INTEGER NOT NULL,  -- milliseconds since the epoch, 0 before the first read
  body         TEXT NOT NULL      -- the answer as JSON
);

INSERT OR IGNORE INTO totals_copy (id, refreshed_at, body) VALUES (1, 0,
  '{"projects":0,"sessions":0,"searches":0,"hits":0,"bytes":0,"countries":[],"top":[]}');

-- The projects first accepted on the current UTC day, for the daily cap.
-- Earlier days are deleted on the next send.
CREATE TABLE IF NOT EXISTS new_projects (
  day TEXT NOT NULL,  -- YYYY-MM-DD
  id  TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
