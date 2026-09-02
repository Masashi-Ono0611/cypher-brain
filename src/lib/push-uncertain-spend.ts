// PushUncertainSpendError lives in its OWN leaf module (no imports at all) for the same
// reason push-partial-success.ts does: a BACKEND (backends/arweave.ts,
// backends/ton-provider.ts) has to throw it directly, and importing it from pushpull.ts
// would close an import cycle (pushpull.ts -> backends/index.ts -> the backend).
// pushpull.ts re-exports it unchanged, so callers keep importing from './pushpull.js'.

/**
 * Which kind of identifier the operator has to look up to settle whether the money
 * actually moved. Not free text: mcp.ts persists it in the idempotency log and an agent
 * branches on it, so the set of values is closed and each names exactly one lookup.
 */
export type UncertainSpendCheckKind = 'arweave_tx_id' | 'ton_contract_address';

/**
 * Issue #818: the paid work MAY have happened and nothing available to this process can
 * say whether it did — an arweave L1 POST that never answered (or was refused) whose
 * follow-up probe found nothing, or a ton-provider deploy broadcast that failed after the
 * signed BOC had already left this process and whose contract-address probe stayed
 * inconclusive. Absence of an observation is NOT proof of absence: a just-posted
 * transaction is not immediately indexed, and a broadcast tonapi accepted can lose its
 * response.
 *
 * Deliberately NOT a subclass of PushPartialSuccessError, even though both are "do not
 * blindly retry" outcomes. That class asserts two things this one cannot: that the spend
 * is CONFIRMED, and that `locator` is a usable pointer to durably-stored bytes. Here the
 * spend is unknown and there is no locator to give — inheriting one would hand every
 * existing `instanceof PushPartialSuccessError` caller (mcp.ts's idempotency recorder,
 * wizard.ts's push() catch) a `pushed: true` result and a locator for an upload that may
 * never have existed, which is a worse lie than the "nothing happened" reading this error
 * exists to replace. Hence no `locator` field at all, and a separate `catch` arm in every
 * caller that distinguishes the two.
 *
 * `checkIdentifier` is what an operator (or an agent) resolves the ambiguity WITH — the
 * signed tx id, or the derived contract address — and is the one value that must survive
 * this failure. Losing it is what made the original bug expensive: the retry had nothing
 * to check against and simply paid again.
 */
export class PushUncertainSpendError extends Error {
  /** The backend whose paid step ended ambiguously ("arweave", "ton-provider"). */
  readonly backend: string;
  /** Which lookup settles it — see UncertainSpendCheckKind. */
  readonly checkKind: UncertainSpendCheckKind;
  /** The identifier to look up: the signed Arweave tx id, or the TON contract address. */
  readonly checkIdentifier: string;
  constructor(opts: {
    backend: string;
    checkKind: UncertainSpendCheckKind;
    checkIdentifier: string;
    /** Backend-specific description of WHAT went ambiguous, without the shared verdict below. */
    detail: string;
    /** Optional backend-specific pointer to where the identifier can be looked up. */
    verifyHint?: string;
    cause?: unknown;
  }) {
    // The literal "the outcome is UNCERTAIN" is load-bearing, not prose: errors.ts's
    // CB-E027 entry matches on it (and scripts/selftest-error-codes.mjs asserts it still
    // exists under src/), so every uncertain-spend refusal keeps carrying [CB-E027].
    // Composed HERE rather than at each throw site so there is ONE copy of it to keep in
    // sync — the arweave and ton-provider wordings that preceded this class had drifted
    // apart already (one of them split across a template concatenation, which is exactly
    // the shape a substring pattern cannot match).
    super(
      `${opts.backend}: ${opts.detail} — the outcome is UNCERTAIN: the payment may already have happened. ` +
        `Check ${opts.checkKind === 'arweave_tx_id' ? 'Arweave transaction' : 'TON contract'} ` +
        `${opts.checkIdentifier}${opts.verifyHint ? ` (${opts.verifyHint})` : ''} BEFORE re-running push or ` +
        'retrying with a new idempotency key: if the first attempt did land, a retry pays for a second one.',
      opts.cause === undefined ? undefined : { cause: opts.cause },
    );
    this.name = 'PushUncertainSpendError';
    this.backend = opts.backend;
    this.checkKind = opts.checkKind;
    this.checkIdentifier = opts.checkIdentifier;
  }
}
