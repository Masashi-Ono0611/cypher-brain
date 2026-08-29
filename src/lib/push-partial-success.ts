// PushPartialSuccessError and its subclasses live in their OWN leaf module (no imports
// from pushpull.ts or backends/index.ts) so that a BACKEND (backends/ton-provider.ts)
// can throw one directly without creating an import cycle: pushpull.ts imports
// backendFor() from backends/index.ts, which imports ton-provider.ts — if ton-provider.ts
// then imported these classes from pushpull.ts, that would close the cycle. pushpull.ts
// re-exports everything below unchanged, so existing `from './pushpull.js'` imports
// (mcp.ts, wizard.ts) do not need to change.

// Thrown for any push() failure that happens AFTER backend.put() (the actual,
// possibly PAID/PERMANENT ciphertext upload) already succeeded — the point of no
// return already passed. This is the shape every caller must treat completely
// differently from every OTHER push() error: the remote ciphertext already exists
// (and, on arweave/turbo/ton-provider, money was already spent) — a caller that reacts
// to ANY push() rejection by assuming "nothing happened yet" (e.g. deleting the only
// identity that can decrypt what was just uploaded, or an MCP idempotency-key
// caller concluding nothing needs to be remembered for a retry) would turn a mere
// AFTERMATH failure into permanent, unrecoverable loss or a real double-spend.
// `locator` (the ciphertext's) is carried on every subclass because it is the one
// value a caller can still act on once push() has otherwise failed to persist it
// anywhere; `sigLocator` is carried too, set only when the ".minisig" sidecar
// upload had ALSO already succeeded before the later failure occurred —
// PushSignatureUploadError never has one (its own failure IS that upload),
// PushLocatorWriteError does when a signed push's sidecar landed before the
// separate --save-locator bookkeeping then failed, and
// PushFundingConfirmedButIncompleteError never has one either (it fires from inside a
// single backend.put() call, before the ".minisig" sidecar's own, separate put() call
// ever starts).
export abstract class PushPartialSuccessError extends Error {
  readonly locator: string;
  readonly sigLocator: string | undefined;
  constructor(message: string, locator: string, sigLocator: string | undefined) {
    super(message);
    this.locator = locator;
    this.sigLocator = sigLocator;
  }
}

// The ciphertext uploaded, but the ".minisig" authenticity sidecar (#214) that
// snapshot() wrote alongside it then failed to upload (a network blip on the SECOND
// backend.put() call below — the first, for the ciphertext, already returned). Distinct
// from PushLocatorWriteError: nothing about --save-locator has even been reached yet,
// so unlike that error this one never carries a sigLocator (there is no "it uploaded,
// only the bookkeeping after it failed" story here — the sidecar upload itself is what
// failed).
export class PushSignatureUploadError extends PushPartialSuccessError {
  constructor(locator: string, cause: unknown) {
    super(
      `ciphertext upload succeeded (locator: ${locator}) but uploading the .minisig signature sidecar failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      locator,
      undefined,
    );
    this.name = 'PushSignatureUploadError';
  }
}

// Thrown when the ciphertext (and, if the artifact is signed, its ".minisig" sidecar)
// already uploaded but the LOCAL --save-locator bookkeeping afterward (mkdir, digest,
// the temp-write+rename) then threw.
export class PushLocatorWriteError extends PushPartialSuccessError {
  constructor(locator: string, sigLocator: string | undefined, cause: unknown) {
    super(
      `upload succeeded (locator: ${locator}) but writing --save-locator failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      locator,
      sigLocator,
    );
    this.name = 'PushLocatorWriteError';
  }
}

// issue #654: ton-provider ONLY. A StorageV1 deploy's storage-cost transfer is
// IRREVERSIBLE the moment waitForContractActive() confirms the contract on-chain — but
// the push as a whole is not "complete" until notifyProviderWithRetry() also succeeds.
// Before this error existed, a notify failure after that confirmation made put() throw
// a plain Error, indistinguishable from "nothing was spent" — the receipt (this file's
// sibling concern, an ACCOUNTING record) is ATTEMPTED separately, right at the
// confirmation checkpoint via the locator-aware onReceipt callback (see types.ts's
// PutOpts doc comment and backends/ton-provider.ts's own call site) — but the CALLER
// (an MCP idempotency-key retry, wizard.ts's own push() catch, a human reading stderr)
// still needs a distinct signal that "funding already happened, only the provider
// handshake remains" rather than treating this as an ordinary, nothing-happened
// failure a retry can freely resend from scratch. The message deliberately says the
// ledger write was ATTEMPTED, not that it definitely succeeded (Codex review): a
// receipt-persist failure (disk full, permissions) is swallowed and only warned about
// — see pushpull.ts's own `persistReceipt()` — so this error alone cannot promise the
// ledger entry actually landed; an operator who needs certainty should check
// `cypher-brain ledger` directly.
//
// `sigLocator` is undefined for a STANDALONE deploy (ton-provider.ts's own throw
// site). It carries the SIDECAR's own confirmed locator when this error is instead
// RE-THROWN from pushpull.ts's ".minisig" sidecar catch block (Codex review: a naive
// `catch { throw new PushSignatureUploadError(...) }` there would have discarded this
// error's identity entirely for a signed ton-provider push whose sidecar deploy hits
// this exact scenario, misreporting a confirmed-funding notify failure as a plain
// upload failure and losing the sidecar's own locator). In that re-thrown case,
// `locator` is the CIPHERTEXT's (already-durably-uploaded) locator — matching every
// other PushPartialSuccessError subclass's own convention — not the sidecar's.
export class PushFundingConfirmedButIncompleteError extends PushPartialSuccessError {
  readonly stage = 'provider_notify' as const;
  readonly fundingConfirmed = true as const;
  constructor(locator: string, cause: unknown, sigLocator?: string) {
    super(
      `ton-provider: contract funding is CONFIRMED on-chain (locator: ${sigLocator ?? locator}) but notifying the ` +
        `storage provider failed: ${cause instanceof Error ? cause.message : String(cause)} — the deploy transfer ` +
        'already happened and a receipt-ledger entry was attempted for it; retry to resume notifying the provider ' +
        '(the retry will detect the contract is already active and skip re-funding, per issue #638). If you need ' +
        'to confirm the ledger entry actually landed, check `cypher-brain ledger`.',
      locator,
      sigLocator,
    );
    this.name = 'PushFundingConfirmedButIncompleteError';
  }
}
