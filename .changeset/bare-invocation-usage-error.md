---
"cypher-brain": patch
---

Running `cypher-brain` with zero arguments is now a usage error — `error: no command
given` plus the valid-command list on stderr, exit 2, stdout empty — instead of
dumping the entire ~26 KB help reference to stdout and exiting 0. This matches the
posture #269 already established for a mistyped command: `--help` (explicit) remains
a REQUEST and is unaffected (full reference, exit 0), but no arguments at all almost
always means the command was forgotten, not that the reference was wanted, and a
script relying on that being an error used to get a silent success and the whole
reference captured instead (#427).
