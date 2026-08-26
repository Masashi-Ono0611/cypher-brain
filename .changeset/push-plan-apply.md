---
"cypher-brain": minor
---

`estimate --out <path.json>` / `push --plan <path.json>` (#231): a
Terraform-style plan/apply pair that strictly binds consent to execution.
`estimate --out` writes a plan pinning the artifact's sha256, `--backend`,
the configured payer address (if any wallet is set up for that backend),
the full cost estimate, and a 15-minute expiry. `push --plan` re-validates
that plan against the CURRENT state — the artifact, backend, price (beyond
a 10% drift tolerance), and payer must all still match, and the plan must
not have expired — refusing with a specific reason before ever reaching the
existing `--yes`/`CYPHER_BRAIN_YES` consent gate, which stays required and
unchanged: `--plan` is an additional, stricter guarantee on top of it, not
a replacement. Works with any backend (free ones just validate
artifact/backend/expiry — there's no price to drift).
