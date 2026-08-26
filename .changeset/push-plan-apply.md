---
"cypher-brain": minor
---

`estimate --out <path.json>` / `push --plan <path.json>` (#231): a
Terraform-style plan/apply pair that binds what `push` validates to what
`estimate --out` reviewed. `estimate --out` writes a plan pinning the
artifact's sha256, `--backend`, `--remote` (rclone only), the configured
payer address (if any wallet is set up for that backend), the full cost
estimate, and a 15-minute expiry. `push --plan` re-validates that plan
against the CURRENT state — the artifact, backend, remote, price (beyond a
10% drift tolerance), and payer must all still match, and the plan must not
have expired — refusing with a specific reason before ever reaching the
existing `--yes`/`CYPHER_BRAIN_YES` consent gate, which stays required and
unchanged: `--plan` is an additional guarantee on top of it, not a
replacement, and not a replacement for `CYPHER_BRAIN_MAX_SPEND` either
(still the actual spend cap, enforced separately inside the upload itself).
A plan.json is a plain, unsigned local file — the same trust boundary as
the wallet/identity key files already on disk, not a cryptographic
guarantee against someone who already has access to those. Works with any
backend (free ones just validate artifact/backend/remote/expiry — there's
no price to drift).
