---
'cypher-brain': patch
---

Fixed and documented three `push-status`/Turbo issues found via dogfooding (#918, #919, #920):

- `checkTurboUploadStatus()` (`src/lib/backends/turbo.ts`) assumed a Turbo 404 response
  body was always JSON (`{"error":"TX doesn't exist"}`) and called `res.json()`
  unconditionally before checking status. The real production endpoint
  (`https://upload.ardrive.io`) answers a genuine "TX doesn't exist" 404 with a
  PLAIN-TEXT body, not JSON — this threw a JSON-parse error that fell into the generic
  catch and was reported as "lookup failed; status unknown" instead of the documented
  `{found:false}`, making the documented not-found path unreachable against the real
  API (100% reproducible per the report). The status code is now checked BEFORE any
  body parsing: a 404 is decisive on its own and the body is never inspected — a
  non-404 failure status still throws, and a non-404 response still has its JSON body
  validated exactly as before.
- `push --help`'s doc block (`src/cli.ts`) never mentioned `push-status` — an operator
  who just ran a real `push --backend turbo` had no signposted way to learn a follow-up
  status check exists short of already knowing the command name or reading
  MANAGEMENT.md in full. Added a one-line pointer at the point of use.
- `errMsg()` (`src/lib/util.ts`) only read `e.message` and dropped Node `fetch`'s
  `error.cause`, which carries the actual `ECONNREFUSED`/`ENOTFOUND` reason for a
  `TypeError: fetch failed` — a misconfigured `CYPHER_BRAIN_TURBO_STATUS_URL` produced
  the same generic "fetch failed" text for a connection refusal and a DNS failure alike.
  `errMsg()` now appends the cause's code/message when present, in the same
  `(cause: <code> — <message>)` shape `scripts/arweave-roundtrip.mjs`'s own failure
  reporting already used; unaffected when no cause is present (the vast majority of this
  codebase's throws), so every existing caller matching on exact `.message` text is
  unaffected.
