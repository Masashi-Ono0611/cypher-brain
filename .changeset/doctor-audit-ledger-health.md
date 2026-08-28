---
'cypher-brain': patch
---

`doctor` now checks the audit log's hash-chain integrity and the receipt ledger's
readability (#456) — previously it could report a healthy 100/100 PASS in the same
`$CYPHER_BRAIN_HOME` where `cypher-brain audit` reported `VERDICT: FAIL` on a tampered
hash chain, even though `doctor --help` already documented `CYPHER_BRAIN_AUDIT_LOG`/
`CYPHER_BRAIN_RECEIPT_LEDGER` in its Storage/env section.

Two new checks, both reusing the existing `audit.ts`/`receipt.ts` reading and
hash-chain-verification logic rather than re-implementing it, so they can never disagree
with what `cypher-brain audit`/`ledger` themselves report:

- `audit-chain-integrity`: FAILs if the audit log's hash chain is broken, or if any line
  in it is unreadable (an unreadable line could hide a deleted/altered entry — the same
  security-critical trust-boundary break `cypher-brain audit` itself treats as FAIL).
- `receipt-ledger-readability`: WARNs (not FAILs) if the receipt ledger has unreadable
  lines — a data-quality issue (totals may undercount), not a broken security boundary.

Neither file existing yet (a machine that has never run push/restore/verify, or never
made a paid arweave/turbo push) is SKIP, matching doctor's existing posture for other
optional-until-used state. `doctor --help` now documents both checks.
