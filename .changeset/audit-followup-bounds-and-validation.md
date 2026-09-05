---
'cypher-brain': patch
---

Follow-up fixes from the `config.ts`/`plan.ts`/`schedule.ts`/`wizard.ts`/`doctor.ts`
audit (#849): every ms-denominated `CYPHER_BRAIN_*` timeout override (`AR_HTTP_TIMEOUT`,
`TON_HTTP_TIMEOUT`, `PIPE_TIMEOUT`, the `TON_PROVIDER_*` notify/deploy-confirm knobs) and
`CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS` now reject an out-of-range value (warn/refuse +
default) instead of silently accepting one large enough to defeat the timer it configures
(Node's setTimeout/AbortSignal.timeout clamp any delay past ~24.8 days to ~1ms) or to
functionally never expire; `schedule.ts`'s `crontab -l` now tells a genuinely empty
crontab (vixie-cron/cronie/bsd-cron's "no crontab for ..." message, or BusyBox's
missing-spool-file error naming the current user) apart from a real failure, instead of
treating every non-zero exit as empty and silently overwriting an unreadable crontab;
`plan.ts`'s `readPlanFile`/`validatePlan` now refuse a plan whose `created_at` is dated
into the future, and cross-validate a plan's recorded `size_bytes` against the artifact
currently at `--in`; `config.ts`'s config-file loader now refuses (rather than silently
dropping) a malformed `CYPHER_BRAIN_*`/`CIPHER_BRAIN_*` config-file line that is missing
its `=` — naming only a key independently verified against the known setting list, never
an arbitrary token or raw value, so a malformed `CYPHER_BRAIN_PASSPHRASE` line (quoted or
not, with or without a base64 value whose own padding could be mistaken for the missing
`=`) cannot leak secret content into the refusal — while leaving a foreign key's
legitimate multi-line quoted value (any of `"`/`'`/`` ` ``, any key shape parseEnv itself
accepts) alone; the older "unknown setting(s)" diagnostic is hardened the same way,
redacting a key that has a secret-bearing setting name as a prefix instead of echoing it
verbatim; and `runbook.ts`'s `extractSection()` now normalizes CRLF line endings before
slicing, so a CRLF-terminated `MANAGEMENT.md` (or any text this shares its
section-slicing logic with) no longer loses its "## Restore runbook" section entirely.
