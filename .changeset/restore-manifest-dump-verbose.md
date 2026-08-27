---
"cypher-brain": patch
---

`restore --in ... --out-dir ...` (and `verify --level drill`, which shares
the same code path) no longer prints the full raw `manifest.json` — `tool`,
`schema`, `host`, `created_at`, every component's original absolute SOURCE
path, digests, the whole `components[]` array — unconditionally to the
console ahead of the actually-useful "expanded N component(s) into ..."
summary and (for `verify --level drill`) the VERDICT (#436). The default
console output is now just that short summary: which components landed
where under `expanded/`. A new `--verbose` flag opts back into the raw
manifest dump — for `restore` unconditionally, for `verify` only its
non-JSON `--level drill` output (the only level that ever reads a
manifest.json in the first place; `--json` already means "one alternate
machine-readable report", so `--verbose` has no effect alongside it).

`--json` was deliberately left alone rather than reused for this: it
already means something different for `verify` (one machine-readable JSON
object replacing the whole human report), and `restore` had no `--json` at
all — colliding either meaning with "also show me the manifest" would have
been confusing. This is a console-output-only change: neither command's
actual restore/verify behavior changes, and the raw `manifest.json` file
itself is still written to `--out-dir` exactly as before either way.
