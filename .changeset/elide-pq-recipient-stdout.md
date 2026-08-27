---
"cypher-brain": patch
---

`keygen --pq`'s recipient is now elided on stdout (e.g.
`age1pq1fkj5uqzt0d33q…j0y5cjwnpugzzv7maufn (1959 bytes, full value written to
recipient.txt)`) instead of printing the full ~1960-byte hybrid recipient as a single
unbroken line that line-wraps across the entire terminal for dozens of rows (#424).
`recipient.txt` still receives the full, untruncated value unaffected — this only
changes what gets printed. Plain (non-`--pq`) `keygen` output is unchanged.
