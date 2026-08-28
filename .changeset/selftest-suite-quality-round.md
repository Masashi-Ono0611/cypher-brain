---
'cypher-brain': patch
---

Four independent selftest-suite quality fixes found during a dogfooding pass (#571,
#573, #574, #575), no runtime behavior change:

- Added `scripts/selftest-ledger.sh` (wired into `verify:suite` as `selftest:ledger`):
  `ledger`/`ledger --json`/`ledger --csv` had no dedicated coverage, and `--csv` was
  never exercised anywhere in the suite. It now covers an empty ledger, multi-backend
  aggregation across 3 backends, unpriced/undated receipts, and a malformed ledger line
  (#571).
- `scripts/selftest.sh`'s mid-snapshot race-condition test now asserts the staging
  directory actually appeared before treating the race as set up, matching the
  READY/APPEARED pattern used elsewhere in the suite — previously a silently exhausted
  wait loop could let the test proceed without exercising the intended
  link()+EEXIST exclusive-promote path (#573).
- `scripts/selftest-rclone.sh` (4 sites) and `scripts/selftest-ton-provider.sh` (12
  sites) now use `printf '%s' "$VAR" | grep` instead of `echo "$VAR" | grep`, matching
  the safe idiom already used elsewhere in the suite (#574).
- `scripts/selftest-plan.sh`'s mock arweave price server now asks the OS for an
  ephemeral port instead of binding a hardcoded `18765`, matching the pattern used by
  every other mock daemon in the suite (#575).
