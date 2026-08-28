---
"cypher-brain": patch
---

Fixes #537: `nearestName()`'s "did you mean" matcher (`src/lib/suggest.ts`)
now uses restricted Damerau-Levenshtein edit distance instead of plain
Levenshtein, so a common adjacent-letter transposition typo — one of the
most frequent kinds of human typo — is caught instead of silently getting
no suggestion.

```
$ cypher-brain verify --in snap.age --level quikc
error: --level must be quick, remote or drill (got "quikc") (did you mean --level quick?)
```

Previously plain Levenshtein charged a transposed pair 2 (a delete plus an
insert, or two substitutions), which pushed `quikc` outside `nearEnough()`'s
1-edit threshold for the 5-letter `quick` and produced no suggestion at all,
even though `verify --level QUICK` (a case typo, distance 1 either way)
already suggested correctly. The restricted/"optimal string alignment"
variant charges an adjacent transposition 1, matching how people actually
mistype, while leaving every other case (substitution, insertion, deletion,
case-insensitive match, the `out` → `out_dir` prefix-extension rule) exactly
as before. This is the same shared utility used across `--backend`,
`--chain`, `--level`, schedule subcommands, `--profile`, and unknown
flags/commands, so the fix applies everywhere `nearestName()` is used.
