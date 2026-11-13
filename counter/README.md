# Usage counter

A Cloudflare Worker that adds up anonymous search counts from users who opted in, so the FindWright page can show live results beside its own measurements.

The design follows Bindwright's review counter, with fields for FindWright's searches.

| Call | Takes | Returns |
|---|---|---|
| `POST /increment` | `{project, kind, sessions, searches, hits, bytes, from, to}` as JSON: `from` and `to` are the window the counts cover, in epoch milliseconds | `{"ok": true}`; 409 with `coveredTo` when the window starts before the end of one already counted; or an error with 400, 413 or 429 |
| `GET /total` | nothing | the sums of each count, the project count, projects per country and the top 10 projects by searches, then hits, each as its kind and counts |

What the counts mean:

- `sessions`: sessions with at least one scored search.
- `searches`: scored searches, the ones the session followed by opening a project file within its next few tool calls.
- `hits`: searches whose answer named a file the session then opened within its next few tool calls, the hit rate FindWright scores on each session.
- `bytes`: the sizes of the answers, each counted up to 65 536 bytes.

## What it keeps

One row per project: a random 32-character id the plugin makes once per repo, the kind picked at opt-in (`src/rules.js` lists them), the country Cloudflare derives from the last send, the running counts (sessions, searches, hits and bytes), the time of the last send and the end of the last counted window. No repo names, queries, code, file names, usernames or IP addresses. `GET /total` never returns project ids.

## Limits

All in `src/rules.js`:

- Each send carries at most 2 000 sessions and 20 000 searches. The caps are sized so a project's first send can carry its whole past history.
- `hits` and `sessions` never exceed `searches`. `sessions` is at least 1 when `searches` is above 0.
- `bytes` is at most 65 536 for each search.
- A send with 0 searches is refused as nothing to add.
- A project sends at most once every 20 hours, and a window that overlaps one already counted is refused, so a send whose answer was lost and is sent again never counts twice.
- At most 200 new projects a day across all senders.
- Five sends a minute per IP through Cloudflare's rate limiter (`wrangler.jsonc`); the Worker never stores the IP.
- Bodies over 1 KB are refused before parsing.

These keep casual inflation out, but an anonymous counter cannot prove a count is real, so the page shows these numbers apart from the maintainer's own measurements.

## Deploy

From this folder, signed in with `npx wrangler@4.152.0 login` (wrangler stays pinned to a release at least two weeks old, so a hijacked new release never runs here; move the pin on purpose):

```
npx wrangler@4.152.0 d1 create findwright-counter   # first time only; paste the database_id it prints into wrangler.jsonc
npx wrangler@4.152.0 d1 execute findwright-counter --remote --file schema.sql   # first time only
npx wrangler@4.152.0 deploy
```

Tests: `node --test test/counter.test.mjs` from the repo root.
