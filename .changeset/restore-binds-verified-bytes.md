---
'cypher-brain': patch
---

`restore` and `verify` now prove their checks against the bytes they actually restore.
Each phase used to re-open `--in` by pathname — the `--sha256` pin, the `*.minisig`
verification, the size cap, the tar-entry inspection, and the extraction — so anyone able
to replace that path for a few seconds (a shared or synced directory, a network mount, a
world-writable `/tmp`, or the gap between an unattended `pull` and the `restore` reading
its output back) could pass verification with a genuine, correctly-signed artifact and
have a different one extracted. `--in` is opened once and every phase reads that one
descriptor, so renaming another artifact onto the path mid-run no longer changes what is
restored, and `verify --level drill` hands the same descriptor to the restore it performs.
Rewriting the same file in place is caught by requiring every pass that read it to agree
on one sha256 — showing genuine bytes to the signature check and attacker bytes to the
extraction fails exactly like the reverse. On a mismatch `restore` refuses with the new
**`CB-E026`**, leaving `--out-dir` untouched, running no `pg_restore`, and removing its
scratch tree; `verify` refuses rather than report a verdict describing two different
files. Always on, no flag; the only cost is one extra read pass over `--in` on restore.
