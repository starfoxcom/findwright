-- Tables for the opt-in usage counter (counter/src/store.js).
-- A project is a random id the plugin makes once per repo; nothing here
-- names a repo, a query, a file, a user or an IP address.

CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,  -- 32 lowercase hex characters, random
  kind       TEXT NOT NULL,     -- one of rules.js KINDS
  country    TEXT NOT NULL,     -- two-letter code Cloudflare derived from the last send, XX unknown
  sessions   INTEGER NOT NULL DEFAULT 0,  -- sessions that ran at least one search, summed
  searches   INTEGER NOT NULL DEFAULT 0,  -- searches run, summed
  hits       INTEGER NOT NULL DEFAULT 0,  -- searches that returned at least one result, summed
  bytes      INTEGER NOT NULL DEFAULT 0,  -- answer sizes, summed; each answer capped in rules.js
  last_send  INTEGER NOT NULL,  -- milliseconds since the epoch
  covered_to INTEGER NOT NULL   -- end of the newest counted window, milliseconds since the epoch
);

CREATE INDEX IF NOT EXISTS projects_by_searches ON projects (searches DESC, hits DESC);

-- The projects first accepted on the current UTC day, for the daily cap.
-- Earlier days are deleted on the next send.
CREATE TABLE IF NOT EXISTS new_projects (
  day TEXT NOT NULL,  -- YYYY-MM-DD
  id  TEXT NOT NULL,
  PRIMARY KEY (day, id)
);
