// One push, one budget.
//
// A SIGNED push calls backend.put() TWICE — once for the ciphertext, once for its
// ".minisig" sidecar — and on every paid backend each of those is its own real charge.
// #639 established that the per-run spend cap has to bound their SUM: checking each
// upload against the whole cap in isolation lets two uploads that each clear the cap
// spend twice it, against a consent screen that only ever showed the first one's
// estimate. That fix was written inline in ton-provider.ts and applied to nanoTON only;
// arweave (winston) and turbo (winc) kept the per-upload behaviour.
//
// The arithmetic is identical for all three — the unit is whatever that backend's cap is
// denominated in — so it lives here once, as a leaf module no backend has to import a
// sibling backend for.
//
// CONTRACT (unchanged from #639, restated because it now binds three backends): the
// check-then-charge below is NOT atomic. A caller must never run two put() calls against
// the SAME tracker concurrently — await each to completion before starting the next — or
// two in-flight calls can both read the same `spent` and both pass under the cap.
// pushpull.ts's push() is the only caller and does this correctly.

export interface SpendTracker {
  // Native units of whichever backend is spending: nanoTON, winston or winc. A tracker
  // is created per push() call and only ever seen by one backend, so the unit is never
  // ambiguous within a tracker's life.
  spent: bigint;
}

// What this push has already committed. `undefined` (a caller that passes no tracker —
// every non-push entry point) means nothing has been spent yet.
export function spentSoFar(tracker?: SpendTracker): bigint {
  return tracker?.spent ?? 0n;
}

// How much of `cap` is left for the upload about to happen. Can go zero or negative,
// which callers must treat as "refuse" rather than "unlimited".
export function remainingSpendBudget(cap: bigint, tracker?: SpendTracker): bigint {
  return cap - spentSoFar(tracker);
}

// Charge an amount that is known to be within budget AND actually about to be spent.
// Deliberately separate from the check: a backend that decides not to spend after all
// (ton-provider's already-active skip) must not charge the budget for a transfer it
// never made.
export function chargeSpendTracker(tracker: SpendTracker | undefined, amount: bigint): void {
  if (tracker) tracker.spent += amount;
}

// The refusal text for "this push has already used up the cap before the current upload
// even starts". Shared so all three backends explain the combined-spend rule the same
// way — the operator's confusion here is always "but my file is smaller than the cap".
export function budgetExhaustedMessage(backend: string, capEnvVar: string, cap: bigint, spent: bigint): string {
  // Worded so the runtime string still reads "... exceeds <CAP ENV VAR>=<n> ...", the
  // shape errors.ts's CB-E006 pattern matches — this branch is an over-cap refusal like
  // any other, and must carry the same code. (The literal the selftest greps for lives in
  // arweave.ts/turbo.ts, which name the variable directly; here it is a parameter.)
  return (
    `${backend}: this upload exceeds ${capEnvVar}=${cap} — the push already committed ${spent} toward it ` +
    '(the ciphertext and its ".minisig" signature sidecar are two separate paid uploads, checked TOGETHER), ' +
    'so no budget remains'
  );
}
