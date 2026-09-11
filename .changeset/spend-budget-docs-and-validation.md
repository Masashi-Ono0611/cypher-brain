---
'cypher-brain': patch
---

Three spend-budget rough edges (#924, #928). `--help` (for `push`/`estimate`/`schedule
install`), README.md and MANAGEMENT.md now state explicitly that
`CYPHER_BRAIN_MAX_SPEND_DAILY`/`_MONTHLY` (and the `TON_PROVIDER` pair) only apply to
`arweave`/`turbo`/`ton-provider` — a `file`/`rclone` push has no admission check at all
and will always succeed regardless of how low these caps are set, which was previously
undocumented and easy to mistake for "the caps are working" when testing against the
free backend. An enabled `_MONTHLY` cap smaller than its enabled `_DAILY` cap (for
either pair) is now refused outright at startup, since a UTC month always contains a
full UTC day and the daily cap could then never be the actual binding constraint — this
was previously silently accepted and only the smaller (monthly) figure was ever
enforced. And a malformed `CYPHER_BRAIN_MAX_SPEND*` value no longer blocks `--help`/
`-h`/`--version`/`-V` themselves (bare or on a subcommand) — an operator who fat-fingers
one of these still needs `--help` to find out how to fix it; a real command still
refuses with the same clear error as before.
