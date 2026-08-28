---
'cypher-brain': patch
---

`schedule status` now reports a corrupt or partially-written `schedule.json` with a
clear, structured `CB-E017` error instead of a raw `SyntaxError` (#494). `readConfig()`
previously did `JSON.parse(await readFile(CONFIG, 'utf8'))` with no try/catch and no
shape validation — its sibling `tryReadConfig()` (used only for legacy-migration checks)
already wrapped the identical read+parse, but `readConfig()` (the one `status` actually
calls) did not. A truncated write, disk-full-mid-write, or hand edit now surfaces
`schedule config is corrupt (<path> is not valid JSON: <detail>) — reinstall with:
cypher-brain schedule install`; a config that parses but is missing a field `status`
needs (`at`/`hour`/`minute`/`backend`/`home`/`runner`/`trigger`) surfaces `schedule
config is corrupt (<path> is missing required field "<field>") — reinstall with: …`
instead of a generic "Cannot read properties of undefined" deep inside
`scheduleStatusReport()`.
