---
'cypher-brain': patch
---

Three spend-budget rough edges (#924, #928). `--help` (for `push`/`estimate`/`schedule
install`), README.md and MANAGEMENT.md now state explicitly that
`CYPHER_BRAIN_MAX_SPEND_DAILY`/`_MONTHLY` (and the `TON_PROVIDER` pair) only apply to
`arweave`/`turbo`/`ton-provider` — a `file`/`rclone` push has no admission check at all,
so a *well-formed* pair of caps never counts against or blocks it, which was previously
undocumented and easy to mistake for "the caps are working" when testing against the
free backend. An enabled `_MONTHLY` cap smaller than its enabled `_DAILY` cap (for
either pair) is now refused outright at startup for every command, including
`file`/`rclone` pushes — since a UTC month always contains a full UTC day, the daily
cap could then never be the actual binding constraint, and this combination was
previously silently accepted with only the smaller (monthly) figure ever enforced. And
a malformed `CYPHER_BRAIN_MAX_SPEND*` value no longer blocks a bare `--help`/`-h`/`help`
or `<command> --help` request, nor a bare `--version`/`-V` (the only forms this CLI
recognizes as version requests) — an operator who fat-fingers one of these still needs
`--help` to find out how to fix it; every other invocation still refuses with the same
clear error as before.
