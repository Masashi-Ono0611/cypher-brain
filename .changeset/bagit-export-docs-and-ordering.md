---
"cypher-brain": patch
---

`bagit-export`'s `--help` text and the README's "Long-term interoperability"
section no longer imply a `*.minisig` authenticity signature naturally ends up
in a restore's `--out-dir` layout — `restore` never copies one there, so
`bagit-export` never sees it either. Both now say explicitly: copy
`<in>.age.minisig` into `--from-restored-dir` yourself before running
`bagit-export` if you want the signature preserved in the bag (#921).

Both also now document how to verify a produced bag's own internal integrity
afterward with standard tools alone — `shasum -a 256 -c manifest-sha256.txt`
and `shasum -a 256 -c tagmanifest-sha256.txt` from inside the bag directory,
or a reference BagIt implementation for a fuller spec-conformance check (#922).

`exportBagit()` now checks whether `--out-dir` already exists BEFORE calling
`planTopLevel()` (which walks `--from-restored-dir` and can print the
informational "skipping ... expanded" notice to stderr) — so a doomed
invocation (an existing `--out-dir` without `--force`) fails immediately,
without implying progress on a run that is about to abort (#923).
