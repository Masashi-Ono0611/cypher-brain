---
'cypher-brain': patch
---

`doctor` is hardened against four independent robustness/security gaps found in
dogfooding round 4:

- Every health check now runs in isolation (#742): a single check's own uncaught I/O
  failure (e.g. an unreadable `identity.age`) no longer aborts `computeDoctorReport()`
  for every OTHER check — it FAILs just that one check id, and every independent check
  still runs and is reported. `recipient.txt` is also confirmed a regular file before
  it is ever read, mirroring the existing `identity.age` guard, so a FIFO with no
  writer there fails fast instead of hanging the whole run.
- `doctor`'s schedule check can no longer hang the whole run (#743): the shared
  `spawnSync()` helper `schedule.ts` uses for `launchctl`/`crontab` now carries a bounded
  timeout (SIGKILL on expiry), and the newest nightly log is stat()'d for regular-file
  type and a sane size cap before being read whole into memory.
- A structurally malformed `doctor-state.json` entry (e.g. a hand-edited `since: null`)
  is now validated and skipped independently, instead of crashing report assembly for
  every check that already ran successfully (#763).
- Values embedded in the plain-text report (environment-derived strings like
  `GBRAIN_HOME`, check messages) are now sanitized against embedded newlines and ANSI
  escape sequences before being printed, closing a gap where `--json` output was
  already safe (JSON.stringify escapes control characters by construction) but the
  human-readable renderer was not — a crafted env value could forge a convincing extra
  report line or manipulate the terminal (#764).
