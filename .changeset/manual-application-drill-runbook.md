---
'cypher-brain': patch
---

Document a manual application-level recovery drill runbook in MANAGEMENT.md
(#904): `verify --level drill` deliberately never runs `pg_restore` or opens a
PGLite data directory (restoring a dump can execute arbitrary source-controlled
code), and this repo has decided not to add container/VM orchestration as a new
runtime dependency to automate that check today. The new section spells out how
to run this verification manually, in an isolated, disposable environment, on
whatever cadence an operator chooses — no code change, no new dependency.
