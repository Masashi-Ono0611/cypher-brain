---
"cypher-brain": patch
---

Fixes #434: `schedule install`'s two `--backend` error messages now match
reality.

```
$ cypher-brain schedule install --dir x
error: --backend <file|arweave|turbo|ton-provider> required   # ton-provider was missing

$ cypher-brain schedule install --backend ton-provider --dir x
error: ton-provider requires CYPHER_BRAIN_TON_WALLET=<path> — see 'wallet create --chain ton'
# previously: "unknown backend: ton-provider (expected one of file|arweave|turbo)",
# which read as if ton-provider weren't a real backend at all.
```

A genuinely unknown `--backend` name still gets the normal "unknown
backend" error listing the real options.
