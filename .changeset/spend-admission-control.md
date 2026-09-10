---
'cypher-brain': minor
---

Add optional daily and monthly spend caps for paid pushes: `CYPHER_BRAIN_MAX_SPEND_DAILY` / `CYPHER_BRAIN_MAX_SPEND_MONTHLY` for arweave/turbo, and `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_DAILY` / `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND_MONTHLY` for nanoTON. Each uses UTC calendar windows; 0/unset disables the cap.

Concurrent calls sharing one local receipt ledger now reserve budget before uploading. These single-machine caps add to the existing per-push limits, which must be positive to provide a reservation upper bound. Successful uploads reconcile to recorded receipt costs; uncertain uploads and crashes keep their reservations charged until resolved. Scheduled runners capture the new settings when installed.
