# Prior art

Most of this project's feature ideas come from reading what comparable tools
already do well. This file names them.

It serves two purposes at once, and the first is the more important:

1. **Credit.** These projects did the thinking. Ideas are not copyrightable and
   nothing here uses their code — but taking a design without saying where it
   came from is bad manners in a commons this project also depends on. Every row
   below says which project an idea came from and what was taken.
2. **Not repeating ourselves.** Without a record, the next person to go looking
   re-reads the same projects, re-derives the same idea, and files a duplicate
   of an issue that is already open.

Projects whose *code* cypher-brain actually runs are credited in
[`README.md`](../README.md#acknowledgements) instead. The rule for borrowing —
what needs a citation, what needs a license check — is in
[`CONTRIBUTING.md`](../CONTRIBUTING.md#credit-what-you-borrowed).

## How to use it

**Before** proposing a feature borrowed from another project, search for the
project name — then compare **what you want to take** against the "Taken away"
column, not just the name.

A project appearing here does **not** mean every idea it could inspire is
already filed. restic is listed for chunking and staged verification; a restic
idea about something else is a new idea, and should be filed as one. What is
already covered is the *takeaway*, not the project. So:

- Same takeaway as a row → read that issue and comment there. Do not open a
  second one.
- Same project, different takeaway → file it, and say in the issue how it
  differs from the existing row so the next reader is not confused by two
  entries citing one project.

**When** you file an issue whose reasoning is "project X does this", add a row.
One line, in the same sitting: a ledger nobody updates is worse than none,
because it reads as authoritative while being stale. The feature issue form asks
for this, but nothing can enforce it — a row added a week later is a row that
never gets added.

Not everything belongs here — this is for *external projects consulted as a
model*, not for every dependency. `age`/typage, Turbo/ArDrive, `rclone` and
`gitleaks` are integrations cypher-brain builds on, credited in
[`README.md`](../README.md#acknowledgements).

## Surveyed

Two separate things are tracked, because they answer different questions.
**Issue state** is just the linked issue's open/closed state. **Outcome** is
whether the borrowed idea was taken up at all — an open issue means the idea was
accepted as worth doing and has not been built yet, which is not the same as an
idea that was considered and declined.

| Project | Consulted for | Taken away | Issue | Issue state | Outcome |
|---|---|---|---|---|---|
| [restic](https://restic.net) / [Kopia](https://kopia.io) / [BorgBackup](https://borgbackup.org) / [Duplicacy](https://duplicacy.com) | Snapshot-oriented backup CLIs | Content-defined chunking to cut upload cost; staged `verify` levels; a `doctor` health command | [#208](https://github.com/Masashi-Ono0611/cypher-brain/issues/208), [#209](https://github.com/Masashi-Ono0611/cypher-brain/issues/209), [#201](https://github.com/Masashi-Ono0611/cypher-brain/issues/201) | Open | Accepted, not built |
| [Cryptomator](https://cryptomator.org) | Encrypted-vault format design | Separate key material from format version / KDF parameters | [#225](https://github.com/Masashi-Ono0611/cypher-brain/issues/225) | Open | Accepted, not built |
| [zfec](https://github.com/tahoe-lafs/zfec) / [Tahoe-LAFS](https://www.tahoe-lafs.org) | Erasure coding, distributed durability | Redundant fragmented placement for large snapshots | [#224](https://github.com/Masashi-Ono0611/cypher-brain/issues/224) | Open | Accepted, not built |
| [Magic Wormhole](https://magic-wormhole.readthedocs.io) | Short-lived authenticated key exchange | One-time code to authenticate an offline backup recipient at registration | [#223](https://github.com/Masashi-Ono0611/cypher-brain/issues/223) | Open | Accepted, not built |
| Shamir's Secret Sharing | Threshold key recovery | Optional threshold recovery of the identity | [#207](https://github.com/Masashi-Ono0611/cypher-brain/issues/207) | Open | Accepted, not built |
| [age-plugin-yubikey](https://github.com/str4d/age-plugin-yubikey) / FIDO2 | Hardware-backed identities | Protect the identity with a hardware key | [#203](https://github.com/Masashi-Ono0611/cypher-brain/issues/203) | Open | Accepted, not built |
| [libarchive](https://github.com/libarchive/libarchive) | Secure extraction | Two-stage restore: inspect tar entries before extracting, then extract isolated | [#218](https://github.com/Masashi-Ono0611/cypher-brain/issues/218) | Open | Accepted, not built |
| [BagIt](https://www.rfc-editor.org/rfc/rfc8493) | Long-term archival packaging | `bagit-export`: package an already-restored `--out-dir` as a spec-correct BagIt 1.0 bag (`bagit.txt`/`bag-info.txt`/`manifest-sha256.txt`/`tagmanifest-sha256.txt`), written in-house (Node builtins only) after a design consultation found no npm implementation both maintained and MIT-compatible | [#217](https://github.com/Masashi-Ono0611/cypher-brain/issues/217) | Open | **Partly shipped** (BagIt export merged; the RO-Crate row below is the still-open remainder) |
| [RO-Crate](https://www.researchobject.org/ro-crate/) | Long-term archival packaging | A JSON-LD semantic description of the payload (`ro-crate-metadata.json`) — profile type, generating software/version, component relationships — deliberately deferred as a separate, larger scope from the BagIt row above | [#217](https://github.com/Masashi-Ono0611/cypher-brain/issues/217) | Open | Accepted, not built |
| [AR.IO Wayfinder](https://ar.io) | Verified gateway reads | Replace the plain gateway fetch in `arweave get()` with a verifying one | [#210](https://github.com/Masashi-Ono0611/cypher-brain/issues/210) | Open | Accepted, not built |
| [Socket.dev](https://socket.dev) | Behaviour-based dependency review | Supply-chain scanning that does not depend on a CVE existing | [#213](https://github.com/Masashi-Ono0611/cypher-brain/issues/213) | Open | Accepted, not built |
| [Presidio](https://microsoft.github.io/presidio/) | PII detection | Redact PII before snapshot, so a key compromise leaks less | [#234](https://github.com/Masashi-Ono0611/cypher-brain/issues/234) | Open | Accepted, not built |
| [OpenDP](https://opendp.org) | Differential privacy | A DP aggregate artifact — explicitly *not* a replacement for the raw backup | [#236](https://github.com/Masashi-Ono0611/cypher-brain/issues/236) | Open | Accepted, not built |
| [FOCUS](https://focus.finops.org) / [OpenMeter](https://openmeter.io) | FinOps cost reporting | Persist provider receipts into a cumulative spend ledger | [#232](https://github.com/Masashi-Ono0611/cypher-brain/issues/232) | Open | Accepted, not built |
| [Terraform](https://developer.hashicorp.com/terraform) | `plan` / `apply` consent split | A spend plan that binds the estimate the user consented to, to the push that spends it | [#231](https://github.com/Masashi-Ono0611/cypher-brain/issues/231) | Open | Accepted, not built |
| [@clack/prompts](https://github.com/bombshell-dev/clack) | Interactive CLI prompts | Rework the `init` wizard; handle `NO_COLOR` and screen readers | [#230](https://github.com/Masashi-Ono0611/cypher-brain/issues/230) | Open | Accepted, not built |
| [fast-check](https://fast-check.dev) | Property-based testing | Property tests, the official age test vectors, bounded mutation testing | [#228](https://github.com/Masashi-Ono0611/cypher-brain/issues/228) | Open | Accepted, not built |
| [pino](https://getpino.io) / [OpenTelemetry](https://opentelemetry.io) | Structured logging, tracing | Structured logs, a hash-chained audit trail, opt-in OTel-lite | [#226](https://github.com/Masashi-Ono0611/cypher-brain/issues/226) | Open | Accepted, not built |
| [Changesets](https://github.com/changesets/changesets) / [commitlint](https://commitlint.js.org) | Release automation | Changesets for versioning + Conventional Commits enforced on the PR title | [#227](https://github.com/Masashi-Ono0611/cypher-brain/issues/227) | Closed | **Shipped** ([#274](https://github.com/Masashi-Ono0611/cypher-brain/pull/274)) |
| semantic-release | Release automation | Nothing — evaluated in [#227](https://github.com/Masashi-Ono0611/cypher-brain/issues/227) and **declined** as overlapping Changesets | [#227](https://github.com/Masashi-Ono0611/cypher-brain/issues/227) | Closed | **Declined** |
| [OpenSSF Best Practices](https://www.bestpractices.dev) / [contributing-template](https://github.com/nayafia/contributing-template) | Project health baseline | SECURITY.md, private vulnerability reporting, branch protection, CONTRIBUTING.md | [#229](https://github.com/Masashi-Ono0611/cypher-brain/issues/229) | Closed | Shipped except the bestpractices.dev registration itself |
| [healthchecks.io](https://healthchecks.io/docs/) | Dead-man's-switch monitoring | `schedule --ping-url`: the runner pings a URL on success and appends `/fail` on failure, so a nightly job that stops running surfaces instead of going quiet. The URL convention is theirs — base URL means success, `/fail` means failure — which is why the code and tests say "healthchecks.io-style" | [#202](https://github.com/Masashi-Ono0611/cypher-brain/issues/202) | Closed | **Shipped** |
| [1Password Emergency Kit](https://support.1password.com/emergency-kit/) | A printable recovery document | The `init` wizard ends in a printable plain-text recovery document, kept physically rather than digitally. What it *enables* differs by setup and the kit says so itself: kit-only recovery on a fresh machine works when a backup identity was generated and inlined, and the artifact is on a network backend — with no backup identity, or a `file`-backend store that was not copied alongside, the kit is a pointer and a procedure, not a self-sufficient key | — (shipped with `init`) | — | **Shipped** |
| [ngrok](https://ngrok.com/docs/errors/) | Stable, greppable error codes | The `CB-E###` scheme: a stable identifier per failure that maps to a documented entry (`MANAGEMENT.md#error-codes`), so an error can be searched for rather than pattern-matched on its wording. ngrok's `ERR_NGROK_XXXX` works the same way — stable error codes, each with its own documentation page | [#212](https://github.com/Masashi-Ono0611/cypher-brain/issues/212) | Closed | **Shipped** |
| [Open Second Brain](https://github.com/itechmeat/open-second-brain) | A comparable second-brain project | A `--profile o2b` that ingests its bank-export bundle | [#206](https://github.com/Masashi-Ono0611/cypher-brain/issues/206) | Open | Accepted, not built |
| [Open Second Brain](https://github.com/itechmeat/open-second-brain) | Its `o2b brain doctor --remediate` command | The `doctor` command idea itself: re-check permission/config health across an existing setup in one read-only pass, rather than leaving each past bug (#91/#119/#35/#101/#99) to be individually re-verified by hand. Different takeaway from the `--profile o2b` row above — same project, a separate feature | [#201](https://github.com/Masashi-Ono0611/cypher-brain/issues/201) | Open | In progress ([#333](https://github.com/Masashi-Ono0611/cypher-brain/pull/333), not yet merged) |
| [x402](https://www.x402.org) | Agentic payment rails | Let an agent hold its own means of payment for a paid push | [#187](https://github.com/Masashi-Ono0611/cypher-brain/issues/187) | Open | Under discussion |
| [Sigstore](https://www.sigstore.dev) | Keyless signing, transparency logs | Considered for release signing alongside npm OIDC provenance | [#186](https://github.com/Masashi-Ono0611/cypher-brain/issues/186), [#66](https://github.com/Masashi-Ono0611/cypher-brain/issues/66) | Closed | Partly shipped (npm OIDC provenance; no Rekor entry) |
| [rclone](https://rclone.org/flags/) / [restic](https://restic.net) / [Turbo SDK](https://github.com/ardriveapp/turbo-sdk) | Transfer progress reporting | Report upload progress on `push`. The finding was that we need to *build* almost none of it: the Turbo SDK has emitted `onProgress`/`onUploadProgress` since v1.26.0 and we require `^1.42.0`, and rclone has `-P`/`--stats` we can pass through. Only the arweave L1 path has no upstream answer. **The SDK documents no resume API** — resumption is deliberately excluded | [#283](https://github.com/Masashi-Ono0611/cypher-brain/issues/283) | Open | Accepted, not built |
| [Model Context Protocol spec](https://modelcontextprotocol.io/specification/2025-11-25/server) | What an MCP server should expose, and to whom | The protocol's own control model as a design question: tools are **model-controlled** (the LLM decides to invoke), resources are **application-controlled** (the client attaches them). Our server declares `capabilities: { tools: {} }` and nothing else, which was never a decision. Whether `last_snapshot_status`/`schedule_status` — state documents rather than actions — belong as resources, and whether the documented recovery procedures belong as prompts | [#285](https://github.com/Masashi-Ono0611/cypher-brain/issues/285) | Open | **Undecided — the issue argues both ways** |
| [rclone.conf](https://rclone.org/docs/#config-config-file) / restic / [git config](https://git-scm.com/docs/git-config) | Configuration file models | Configuration is 25 environment variables and no file, which is the root cause of [#276](https://github.com/Masashi-Ono0611/cypher-brain/issues/276): the variable list has to be re-enumerated by hand in two unrelated places. Node's built-in `process.loadEnvFile()` (stable since v20.10.0, and `engines` requires >=22.6.0) means this needs **no new dependency** — which matters for a tool with three runtime deps | [#286](https://github.com/Masashi-Ono0611/cypher-brain/issues/286) | Open | Accepted in principle; open questions on precedence and on whether `schedule` should stop baking values |
| [restic](https://restic.readthedocs.io/en/stable/060_forget.html) / [Perkeep](https://perkeep.org/doc/schema/delete.md) / [NIST SP 800-88 Rev. 2](https://csrc.nist.gov/pubs/sp/800/88/r2/final) | Retention and forgetting on a store that cannot delete | Three different answers, which is the useful part. restic's **vocabulary**: `forget` (drop the snapshot reference) and `prune` (remove data no longer referenced by retained snapshots) are deliberately separate words, and its docs say outright that forgetting alone leaves the data in place — a `forget` that sounded like deletion while the ciphertext stayed public would be dangerous. Perkeep's **model**: "No need to delete in general", and where it does delete it is claim-based — a delete *claim* is added rather than a blob physically removed. That shape fits an append-only store, which is what we have. NIST's **mechanism**: Cryptographic Erase, sanitize the key rather than the media, made for exactly the media you cannot reach — and it requires sanitizing *every copy* of the relevant key, which is the hard part here. Today we have no per-snapshot erase at all: erasing means destroying every private identity that can decrypt, which shreds everything those identities ever encrypted — and a backup identity inlined in the printable kit is precisely such a copy, so per-snapshot erasability needs its own key hierarchy rather than a tweak to the existing recovery model | [#301](https://github.com/Masashi-Ono0611/cypher-brain/issues/301) | Open | **Undecided — the issue argues three positions** |
| [Stripe](https://docs.stripe.com/api/idempotent_requests) | Idempotency keys for a paid API | `snapshot_now`'s `idempotency_key` (the only MCP tool that can spend money): a repeat call carrying the SAME key returns the FIRST call's result instead of re-executing, so an AI agent's own retry logic (a network blip after an arweave/turbo upload already succeeded) cannot spend twice for what it believes is one call. The same-key-must-mean-the-same-request rule ("Keys can only be reused for the exact same operation") is Stripe's too | [#220](https://github.com/Masashi-Ono0611/cypher-brain/issues/220) | Closed | **Shipped** |

## Angles already swept

These directions have been mined once. Reading another tool in one of these
categories will *mostly* re-derive a row above — but "mostly" is not "always",
and this list is a prompt to check, never a reason to drop an idea. If yours is
genuinely different, file it and say what is new relative to the linked row.

Snapshot/backup CLIs · encrypted vault formats · erasure coding · authenticated
key exchange · threshold recovery · hardware-backed keys · archive extraction
safety · archival packaging standards · verified gateway reads · supply-chain
scanning · PII/privacy tooling · FinOps cost reporting · plan-then-apply consent
· interactive prompt libraries · property-based testing · structured
logging/tracing · release automation · project-health baselines · transfer
progress reporting · dead-man's-switch monitoring · printable recovery documents
· stable error-code schemes · agent-protocol surface design · configuration-file
models · retention and forgetting on a store that cannot delete · idempotent
retry safety for a paid API.

## Angles not yet swept

Recorded so a survey has somewhere to start. These are directions, not
proposals — each still needs the usual "does this fit the project's scope?"
judgement against [`README.md`](../README.md)'s "What cypher-brain isn't".

- **Emergency access — a delegated, time-delayed one.** The *document* half of
  this is done (1Password's Emergency Kit, in the table above). The other half is
  not: [Bitwarden's Emergency Access](https://bitwarden.com/help/emergency-access/)
  is a mechanism rather than a document — a grantor nominates a trusted contact,
  the grantor's key is wrapped to that contact's public key, and a request either
  gets approved *immediately by the grantor*, or unlocks after a grantor-set
  waiting period. cypher-brain's answer to "what happens to the brain if I am hit
  by a bus" is currently "hope someone finds the printed kit".

  Be precise about how much of this age gives us, because it is less than it
  looks: age encrypts to multiple recipients, so a second party *can* be given
  the ability to decrypt — but that access is **immediate and unconditional from
  the moment the snapshot is written**. There is no escrow, no approval step and
  no delayed release in age, and this project has no server to enforce one. The
  hard part of Bitwarden's design is precisely the part age does not provide, so
  "we already have multi-recipient" is not most of the way there.
- **Deterministic/reproducible archives.** Checked once and found *not* to be a
  correctness problem — `--skip-unchanged` hashes a sorted, normalized plaintext
  tree listing, not the tar bytes, so tar non-determinism cannot affect it.
  Recorded here so the next person does not spend the same hour on it.
