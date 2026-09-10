---
'cypher-brain': patch
---

UX fixes found by dogfooding #907/#908 (cumulative spend admission) and #902/#909
(recovery/crypto policy enforcement) after merge, no behavior/refusal-condition change:

- `restore`'s `--require-signature`-style refusal always said "--require-signature was
  given", even when `CYPHER_BRAIN_REQUIRE_SIGNATURE=1` (not the flag) is what actually
  triggered it — misleading an operator into hunting for a flag that was never on their
  command line. Now names both possible sources and the `--no-require-signature`
  escape hatch.
- `snapshot`'s `CYPHER_BRAIN_REQUIRE_RECIPIENT`/`CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS`
  refusals stated the rule but not the concrete repair — now name the missing/offending
  recipient(s) and the exact fix (`--recipient <key>`, or `keygen --pq`).
- MANAGEMENT.md's CB-E006 entry only described the per-push `CYPHER_BRAIN_MAX_SPEND`/
  insufficient-balance causes; a cumulative daily/monthly cap refusal (#907) also
  carries this code but needs different remediation (raising the per-push cap does not
  help). The table now separates all three causes and their distinct next actions.
