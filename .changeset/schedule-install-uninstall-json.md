---
'cypher-brain': patch
---

`schedule install --json` and `schedule uninstall --json` were accepted without any
error and silently ignored — `install()` and `uninstall()` (`src/lib/schedule.ts`) never
read `o.json` at all, unlike `schedule status`, which fully implements it (#672). A
caller expecting the same uniform `--json` contract `schedule status` provides got
unstructured plain-text output instead, with no signal that `--json` was never honored.
Same bug class as `push`/`pull`/`wallet address --json` (#647), left uncovered by that
fix because it did not touch the `schedule` sub-verb family. `schedule install` and
`schedule uninstall` now refuse `--json` upfront via the CLI's flag-relevance deny-list,
the same "clear error" `wallet address --json` already gets — `schedule status --json`,
which genuinely implements JSON output, is unaffected.
