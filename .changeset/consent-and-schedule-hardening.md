---
'cypher-brain': patch
---

Four fixes found by a Codex agentic security/architecture audit (2026-09-02):

- `CYPHER_BRAIN_YES` now only grants consent when it is exactly `1` — `CYPHER_BRAIN_YES=0`
  (or any other non-empty spelling) used to pass JS truthiness and silently grant the
  same consent a paid upload (`push --backend arweave/turbo/ton-provider`) or a
  destructive `restore --pg` requires (#794).
- `schedule install --backend ton-provider` now bakes `CYPHER_BRAIN_YES=1` into the
  generated nightly runner, the same way `arweave`/`turbo` already do — before this,
  `install` reported success for a schedule that failed the paid-upload consent gate on
  every single scheduled run (#798).
- The generated Linux cron entry now shell-quotes the runner path with the same `shq()`
  helper every other generated shell fragment in `schedule.ts` uses, instead of plain
  double quotes — a `CYPHER_BRAIN_SCHEDULE_DIR`/`CYPHER_BRAIN_HOME` containing a shell
  metacharacter (`$(...)`, a backtick) could otherwise be expanded by cron's shell on
  every run (#801).
- The schedule dir tree (`nightly.sh`, `schedule.json`, and the `schedule`/`logs`/
  `snapshots` directories) is now created owner-only (`0700` dirs/runner, `0600`
  `schedule.json`) instead of the previous world/group-readable default — both files
  carry install-time secrets (wallet paths, spend caps) (#803).

Also: `--help`'s description of `schedule status --json`'s "not installed" response
now matches the actual behavior since #426 (`{"installed":false}`, exit 0) instead of
the pre-#426 `{error, code: "CB-E014", exit_code}` shape (#804).
