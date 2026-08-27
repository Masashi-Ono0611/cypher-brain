---
"cypher-brain": patch
---

An unknown flag written in the `--flag=value` form (e.g. `--dir=docs`) now hints at
the space-separated form when `--dir` (or whichever part comes before the `=`) is a
real, recognized flag — instead of an "unknown flag: --dir=docs" reply that names the
whole token with no indication the flag itself is valid. A value flag gets `did you
mean '--dir docs' (space-separated, not '=')?`; a flag that takes no value at all
(e.g. `--pq`) gets `did you mean '--pq' (it takes no value — drop the '=')?` instead
of a nonsensical `--pq true` suggestion. A token that merely contains `=` without
matching a real flag name before it (e.g. `--totallybogus=x`) is unaffected — no
false hint (#441). `--flag=value` itself is still not accepted as input; this only
makes the rejection more useful.
