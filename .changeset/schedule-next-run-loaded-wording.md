---
"cypher-brain": patch
---

`schedule status`'s plain-text `next run:` line no longer states a
confident future time when the trigger isn't actually registered (#433).
It now distinguishes all three `trigger.loaded` states: `'yes'` unchanged
(`next run: <time> (local)`); `'no'` reads `next run: none — the trigger
is not registered ...`; `'unknown'` (registration status couldn't be
confirmed) reads `next run: unknown — ...` — a deliberately different
claim from `'no'`, since "not registered" and "couldn't check" aren't the
same fact. `--json`'s `next_run` field, and the MCP tool/resource that
serve the same object, are unaffected — only the human-readable framing
changed.
