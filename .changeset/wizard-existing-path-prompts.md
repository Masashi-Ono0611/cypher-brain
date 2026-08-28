---
"cypher-brain": patch
---

`init`'s obsidian/chatgpt-export/o2b path prompts (`--vault`/`--zip`/`--export`)
and the `none` profile's directory prompt now loop until the answer is both
non-empty and actually exists on disk, instead of sailing through to the final
"Choose a backend" step and failing deep inside `snapshot()` — which used to
roll back the primary identity, the offline backup keypair, and the signing
keypair generated earlier in the same run (#605).

Answering the backup-keypair path prompt with the same path as the primary
`CYPHER_BRAIN_HOME` now refuses immediately with an explicit message, instead
of surfacing `keygenAt`'s own confusing "identity already exists" refusal for
what is actually a self-collision (#621).

The `CYPHER_BRAIN_PIN_RECIPIENTS` suggestion step now notes that its shell-rc
alternative sources the line as literal shell code, unlike the config file
(#622).
