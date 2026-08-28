---
'cypher-brain': patch
---

Docs: fill three small gaps found during a dogfooding pass (#580, #581, #582).
`llms.txt`'s "Everyday commands" now lists `doctor`, `ledger`, `audit`, and
`wallet create` alongside the other commands. README.md and MANAGEMENT.md's
`--dir ~/.gbrain` examples now note that gbrain's own `GBRAIN_HOME` env var
relocates that path to `$GBRAIN_HOME/.gbrain`. MANAGEMENT.md's config.env
section now mentions the pre-rename `CIPHER_BRAIN_*` spelling fallback that
`--help` already documents.
