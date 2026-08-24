---
'cypher-brain': patch
---

Fix the `schedule install --backend` usage line in `--help` — it was missing
`ton-provider`, even though `schedule.ts` already allows installing that
backend once a local TON wallet is configured. README.md's generated HELP
block is regenerated to match (`scripts/check-help-docs.mjs --write`).

Also brings README.md, docs/durability.md, MANAGEMENT.md, CONTRIBUTING.md,
CHANGELOG.md, llms.txt, and package.json's keywords up to date with the
`ton`/`ton-provider` backends shipped in #381/#396/#399/#400/#405 — no other
runtime behavior changed.
