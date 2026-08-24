# Contributing to cypher-brain

Thanks for taking the time to contribute. `cypher-brain` is a cryptographic
tool — it encrypts second-brain snapshots client-side and parks the
ciphertext on pluggable storage backends — so contributions here get a
higher review bar than a typical CLI project, especially anything touching
key handling or the storage backends. This document sets expectations
up front so review is predictable for everyone.

## Language policy

All GitHub issues and pull requests (title, body, and comments), commit
messages, and code comments must be written in **English**. This applies to
everything created from now on. A number of issues and PRs from earlier work
in this repo were written in Japanese — those are left as historical
exceptions and are not being retroactively translated; do not use them as a
template for language when writing new ones.

(This is the same policy [`AGENTS.md`](AGENTS.md) states for AI coding
agents working in this repo — this section is the human-contributor
counterpart of that.)

## Before you start

- **Small fixes** (typos, docs, obviously-correct one-liners): open a PR
  directly.
- **Anything larger** (new flags, new backends, behaviour changes): open an
  issue first describing what you want to do and why. This avoids spending
  time on a PR that doesn't fit the project's direction — see "What
  cypher-brain isn't" in [`README.md`](README.md) for scope boundaries the
  project intentionally does not expand.
- Check open issues and PRs first so you're not duplicating in-flight work.
- If your idea comes from how another project does something, check
  [`docs/prior-art.md`](docs/prior-art.md) — it lists the projects already
  consulted and the issue each one became, so you can join that discussion
  instead of starting a parallel one. If your project isn't listed, add a row
  when you file.

## Prefer an existing implementation

The crypto rule below is one instance of a general preference: **wire in a
maintained implementation rather than writing our own.** age does the
encryption, rclone does the 70+ storage providers, gitleaks does the secret
scanning, `ignore` does gitignore matching, Changesets does versioning. Each of
those is a problem this project chose not to re-solve, and the codebase is small
because of it.

So when an issue could be closed either by adding a dependency or by writing the
logic here, adding the dependency is the default. If you write it in-house
instead, say why in the issue or PR — a genuinely tiny surface, a dependency
that is unmaintained or wildly oversized for what we need, or a hard constraint
like "a `pull` on a fresh machine must work with no optional packages
installed", which is why the gateway read path is deliberately dependency-free.

The counterweight, stated honestly: this is a security tool, and every
dependency is attack surface. Runtime dependencies are kept deliberately few and
are weighed against the supply-chain cost, which is why paid-upload SDKs are
`peerDependencies` rather than hard requirements. "Prefer the dependency" means
prefer it over *reinventing* — not over *not needing the feature at all*. The
first question is still whether the feature belongs here (see "What cypher-brain
isn't" in [`README.md`](README.md)).

## Credit what you borrowed

This project is open source and lives off other open-source work, so borrowing
is expected — doing it without saying so is not.

- **Ideas.** If your issue or PR is reasoned from "project X does this", name X
  and link it, in the issue or PR body. Add it to
  [`docs/prior-art.md`](docs/prior-art.md) too, which is both the credit record
  and how we avoid re-deriving the same idea twice.
- **Code and text.** Do not paste in code, comments, or documentation from
  another project without checking that its license permits it and keeping the
  required notice. When in doubt, describe the approach in your own words and
  cite the source instead of copying. If a change genuinely needs to vendor
  someone's code, raise it in an issue first — that is a licensing decision, not
  a coding one.
- **New dependencies.** Per the section above, adding one is usually right. Note
  its license in the PR (this project is MIT and its dependency tree should stay
  compatible with that), and say what it saved us from writing.

## Do not roll your own crypto

This is the single most important rule for this repo.

- Do **not** write new cryptographic primitives, re-implement encryption,
  key derivation, or key-wrapping schemes, or "improve" the existing age/
  typage integration's cryptographic logic. Use the existing
  [age](https://age-encryption.org) (X25519 + ChaCha20-Poly1305) format via
  [typage](https://github.com/FiloSottile/typage), which is what this
  project is built on and byte-compatible with the reference `age` CLI.
- If a change appears to require new crypto (a new algorithm, a new key
  format, a new wrapping scheme), open an issue describing the *problem*
  first — do not submit the implementation directly. Cryptographic design
  changes need discussion and, ideally, review from someone with a crypto
  background before any code is written.
- Vendor/upstream crypto bugs (in `age-encryption`/typage, `@ardrive/
  turbo-sdk`, `arweave`) belong upstream; a report here explaining how this
  repo's *usage* of them is unsafe is welcome.
- See [`SECURITY.md`](SECURITY.md) for how to report an actual
  vulnerability — not as a public issue or PR.

## What gets extra scrutiny

Because of what this tool does, PRs touching any of the following get a
slower, more careful review than a typical docs or CLI-ergonomics change:

- Identity/recipient generation, storage, or file permissions
  (`~/.cypher-brain/*`).
- The age/typage encryption or decryption call paths.
- Any storage backend (`file`, `arweave`/`turbo`, `rclone`, `ton`,
  `ton-provider`) — anything that could let ciphertext-only guarantees slip,
  or that touches wallet/JWK/TON-wallet handling.
- The MCP server contract (`src/mcp.ts`) — its tool surface is a public API
  surface for agents.
- Signal handling (SIGINT/SIGTERM/SIGHUP) and atomic write paths, where a
  bug can corrupt a snapshot or leave partial plaintext on disk.

Security- or crypto-adjacent PRs should go through a multi-model review
before merge (see the PR template's "Multi-model review" section) — this is
not optional for that category of change, even from the maintainer.

## Commit messages and PR titles

Follow [Conventional Commits](https://www.conventionalcommits.org/): a
`type[(scope)]: summary` header — the scope is optional, so both
`fix(push): reject a non-age artifact` and `docs: fix a broken link` are fine.
Allowed types are the conventional set plus `security` and `style`
(see [`commitlint.config.js`](commitlint.config.js)).

CI lints the **pull request title**, not the branch's individual commits. This
repo squash-merges, so the PR title is the message that actually lands on `main`
and the only one that survives in `git log` — your work-in-progress commit
messages are yours.

## Changesets

Versioning and `CHANGELOG.md` are generated by
[Changesets](https://github.com/changesets/changesets), not written by hand. A PR
that changes anything under `src/` must include a changeset, and CI fails without
one:

```sh
bun run changeset          # pick patch/minor/major, describe the user-visible change
bun run changeset --empty  # the src/ change ships nothing user-visible
```

Commit the generated `.changeset/*.md` file along with your code. Write the
description for someone reading the release notes — what changed for a *user of
the CLI*, not what you did to the code.

PRs that only touch docs, CI, scripts or tests need no changeset: they reach no
user, and requiring one there just trains everybody to write empty ones.

Releasing (maintainer): `bun run changeset:version` consumes the accumulated
changesets into a version bump plus `CHANGELOG.md` entries; commit that, then
push the matching `vX.Y.Z` tag — [`publish.yml`](.github/workflows/publish.yml)
takes it from there (gate, npm publish via OIDC, GitHub Release).

## Quality bar

Before opening a PR:

- `npm run lint` (biome, `--error-on-warnings`) passes.
- `npm run verify` (build + typecheck + the full selftest suite + CLI/MCP
  smoke) passes.
- No new `VERDICT: FAIL`, and no unexpected `VERDICT: PARTIAL`, in
  `verify`/`restore` output — see the README's
  [Threat model](README.md#threat-model--the-key-is-only-mine) for what
  those verdicts mean.
- Fill out the [PR template](.github/pull_request_template.md) checklist
  honestly, including the "Architecture impact" and "Regression / behaviour"
  sections — they tell the reviewer where to look first.

## Response time

This is a single-maintainer project maintained outside of working hours, so
please set expectations accordingly:

- **Security reports** (via GitHub's private vulnerability reporting, see
  [`SECURITY.md`](SECURITY.md)): best-effort acknowledgement, prioritized
  over everything else.
- **Bug reports and PRs**: no guaranteed SLA. Expect an initial response
  within roughly a week for most issues; complex crypto/storage-touching PRs
  may take longer given the review bar above.
- **Feature requests**: read and considered, but may sit unanswered for a
  while if they're not an immediate priority — a PR moves things faster than
  a request.

If something looks stalled, a polite bump on the issue/PR is fine.

## Code style

- TypeScript, formatted and linted with [biome](https://biomejs.dev)
  (`npm run format` / `npm run lint`) — match existing style rather than
  introducing a new one.
- Match the tone of existing code comments and docs: direct and technical,
  no marketing language.
- Keep changes scoped to what the issue/PR describes — avoid drive-by
  refactors of unrelated code in the same PR.

## License

By contributing, you agree that your contributions will be licensed under
this project's [MIT License](LICENSE).
