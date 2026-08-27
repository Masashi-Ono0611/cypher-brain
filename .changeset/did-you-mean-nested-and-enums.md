---
"cypher-brain": patch
---

Fixes #435 (follow-up to #425): "did you mean" now also covers nested
subcommand typos and enum-valued flag typos, using the same
`nearestName()` matcher #425 already wired into top-level commands and
flags.

```
$ cypher-brain schedule statuz
error: schedule: expected install | uninstall | status, got: statuz (did you mean status?)

$ cypher-brain wallet adress
error: wallet: expected create | address | balance, got: adress (did you mean address?)

$ cypher-brain verify --level remtoe --in x.age
error: --level must be quick, remote or drill (got "remtoe") (did you mean --level remote?)

$ cypher-brain estimate --backend fille --in x.age
error: unknown backend: fille (did you mean file?) — use file|arweave|turbo|rclone|ton|ton-provider

$ cypher-brain wallet create --chain tona
error: wallet: --chain must be arweave or ton, got: "tona" (did you mean ton?)
```

A genuinely unrelated subcommand or enum value still gets no
suggestion, same as #425's own top-level behavior.
