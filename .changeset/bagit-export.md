---
'cypher-brain': minor
---

New command: `bagit-export --from-restored-dir <dir> --out-dir <path> [--force] [--json]`
packages an already-restored `restore --out-dir` output as a standards-conformant
[BagIt 1.0](https://www.rfc-editor.org/rfc/rfc8493) bag (`bagit.txt`, `bag-info.txt`,
`manifest-sha256.txt`, `tagmanifest-sha256.txt`) at a separate directory — fully
offline, post-restore, and non-destructive (`--from-restored-dir` is only ever read;
restore's own output is untouched). Addresses part of #217: if cypher-brain the tool
ever stops being maintained, the decrypted payload becomes independently
interpretable via any BagIt-aware tool, not only via cypher-brain's own custom
`manifest.json` layout. Written in-house on Node builtins only (no new runtime
dependency) after a design consultation found no npm BagIt implementation both
maintained and license-compatible with this MIT project. RO-Crate — a JSON-LD
semantic description of the payload — is a separate, deliberately deferred scope;
see README's "Long-term interoperability" section and docs/prior-art.md.
