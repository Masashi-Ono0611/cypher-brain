---
"cypher-brain": patch
---

Four operator-script-only fixes found during a `scripts/` audit pass (this is
test/tooling-infrastructure-only; no runtime behavior of the `cypher-brain` CLI
changes):

- De-duplicated the SSH injection-allowlist helper (`HOST_RE`/`API_RE`/`HEX64_RE`,
  `assertSafe()`, `sshBaseArgs()`, `sshRun()`) that was copy-pasted byte-for-byte
  between `scripts/ton-dogfood.mjs` and `scripts/ton-provider-experiment.mjs` into
  a new shared `scripts/ton-ssh-lib.mjs`, so a future hardening fix to the
  allowlist can no longer land in only one copy and silently reopen the
  shell-injection surface in the other (#604).
- Fixed `scripts/real-gbrain-roundtrip.sh` silently dropping the query string
  (e.g. `?sslmode=require`) from `CB_PG_URL` when deriving the scratch DB URL —
  the naive `${CB_PG_URL%/*}` strip removed everything after the last `/`,
  including any query params. It now replaces only the path component via a
  `python3 -c` URL-parse/rebuild (#618).
- Simplified `drive-init.mjs`'s exit-code resolution from
  `resolve(code ?? (signal ? 1 : 1))` (both ternary branches returned the same
  value) to `resolve(code ?? 1)` (#619).
- Added a comment noting `scripts/large-file-test.sh`'s `/usr/bin/time -l` is
  macOS/BSD-only, with the GNU `time -v` equivalent for Linux (#620).
