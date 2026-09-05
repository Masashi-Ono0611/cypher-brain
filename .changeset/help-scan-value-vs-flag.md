---
'cypher-brain': patch
---

The raw, pre-`parseArgs()` `--help`/`-h` scan (issue #171) no longer mistakes a flag's
VALUE for a help request. It used to test raw argv for a bare `-h`/`--help` token
independently of `parseArgs()`'s own value-consumption logic, so `--dir -h` (a directory
literally named `-h`) printed the help screen instead of snapshotting that directory. A
new `isValueConsumingFlag()`/`valueConsumedIndices()` pair in `src/cli.ts` walks argv the
same left-to-right way `parseArgs()`'s loop does and marks which indices will be consumed
as another flag's value, so the scan can skip those positions — without duplicating or
rewriting `parseArgs()` itself. A standalone `-h`/`--help` (not consumed as any flag's
value) still shows help exactly as before.
