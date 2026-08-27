---
"cypher-brain": patch
---

A typo'd command or flag now suggests what you probably meant:

```
$ cypher-brain snapsho
error: unknown command: snapsho (did you mean snapshot?)

$ cypher-brain snapshot --dir x --out y --recipiant foo
error: unknown flag: --recipiant (did you mean --recipient? — ...)
```

A genuinely unrelated typo still gets no suggestion, rather than a
misleading guess.
