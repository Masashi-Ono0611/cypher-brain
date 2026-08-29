// push/pull move the ciphertext to/from a storage backend. The verb is a dumb
// primitive against ONE backend endpoint; proving "fetched from elsewhere" (a
// second, independent node) is the operator script's job, not the verb's.
import { mkdir, writeFile, rm, readFile, rename, link, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AGE_MAGIC, CIPHER_YES, readEnv, WAIT_RETRY_BACKENDS } from './config.js';
import { exists, requireFile, sleep, sha256, readHead, errMsg, RetryableError } from './util.js';
import { backendFor } from './backends/index.js';
import { estimateCost, formatEstimate } from './estimate.js';
import { signatureKeyIdHex } from './minisign.js';
import { tonWalletConfigured, payerAddressFor } from './wallet.js';
import { readPlanFile, validatePlan } from './plan.js';
import { appendReceipt } from './receipt.js';
import { recordAudit } from './audit.js';
import { warn } from './warn.js';
import type { CliOptions } from './types.js';

// The plaintext content digest for the artifact being pushed: an explicit --digest
// wins, else the "<in>.digest" sidecar snapshot writes next to its output. Returns
// lowercased hex or null — never throws: the digest only powers the --skip-unchanged
// optimization and the 4th save-locator field, so a missing/unreadable piece must
// degrade to "no digest" (proceed normally), never to an error.
async function contentDigestFor(o: CliOptions): Promise<string | null> {
  if (o.digest) return String(o.digest).trim().toLowerCase();
  try {
    const line = (await readFile(`${o.in}.digest`, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    return line ? line.toLowerCase() : null;
  } catch {
    return null;
  }
}

// The recipients fingerprint for the artifact being pushed: read from the
// "<in>.recipients-fingerprint" sidecar snapshot writes next to its output. Mirrors
// contentDigestFor's contract exactly (never throws — a missing/unreadable sidecar
// just means "unknown", not an error). This is the SEPARATE signal (alongside, never
// mixed into, content_digest) that --skip-unchanged additionally requires to match:
// without it, an unchanged plaintext re-encrypted to a DIFFERENT recipient set (a
// newly added offline recovery key, or a removed/revoked key) would still return the
// OLD locator — the new key could never decrypt it, and/or a revoked key still could
// (#70 review round 2, a real security regression, not just a correctness nit).
async function recipientsFingerprintFor(o: CliOptions): Promise<string | null> {
  try {
    const line = (await readFile(`${o.in}.recipients-fingerprint`, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    return line ? line.toLowerCase() : null;
  } catch {
    return null;
  }
}

// Thrown for any push() failure that happens AFTER backend.put() (the actual,
// possibly PAID/PERMANENT ciphertext upload) already succeeded — the point of no
// return already passed. This is the shape every caller must treat completely
// differently from every OTHER push() error: the remote ciphertext already exists
// (and, on arweave/turbo, money was already spent) — a caller that reacts to ANY
// push() rejection by assuming "nothing happened yet" (e.g. deleting the only
// identity that can decrypt what was just uploaded, or an MCP idempotency-key
// caller concluding nothing needs to be remembered for a retry) would turn a mere
// AFTERMATH failure into permanent, unrecoverable loss or a real double-spend.
// `locator` (the ciphertext's) is carried on every subclass because it is the one
// value a caller can still act on once push() has otherwise failed to persist it
// anywhere; `sigLocator` is carried too, set only when the ".minisig" sidecar
// upload (below) had ALSO already succeeded before the later failure occurred —
// PushSignatureUploadError never has one (its own failure IS that upload),
// PushLocatorWriteError does when a signed push's sidecar landed before the
// separate --save-locator bookkeeping then failed.
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

// The signing state of the artifact being pushed (#250). THREE distinct outcomes,
// not two — collapsing them would be a real bug:
//   { signed: false }        no "<in>.minisig" at all. A KNOWN state, and the one
//                            that lets --skip-unchanged tell "still unsigned, as
//                            before" apart from "signing was just enabled".
//   { keyId }                a sidecar that parses, carrying its claimed key id.
//   null                     a sidecar EXISTS but could not be read or parsed.
//                            Genuinely unknown — the caller must never skip on it,
//                            or a corrupt signature next to unchanged content would
//                            be silently accepted as "unsigned, same as last time"
//                            and never re-pushed.
// Never throws: an unreadable/malformed sidecar is reported as unknown, not raised,
// so it degrades the optimization rather than failing the push.
type SigningState = { signed: false } | { signed: true; keyId: string };
async function signingStateFor(o: CliOptions): Promise<SigningState | null> {
  const sigPath = `${o.in}.minisig`;
  if (!(await exists(sigPath))) return { signed: false };
  try {
    return { signed: true, keyId: await signatureKeyIdHex(sigPath) };
  } catch {
    return null; // present but unreadable/malformed — unknown, never "unsigned"
  }
}

export interface SavedLocator {
  locator: string;
  backend: string;
  sha: string | undefined;
  contentDigest: string | undefined;
  recipientsFingerprint: string | undefined;
  sigLocator: string | undefined; // #214: where the "<in>.minisig" sidecar was pushed, if any
  signKeyId: string | undefined; // #250: which signing key produced that sidecar
}

// Parse the FIRST locator line of a save-locator file into its (up to 7) fields.
// Returns null when the file is missing/empty — callers treat that as "no previous
// push recorded". The 3-field legacy format, the 4-field one (+content_digest), the
// 5-field one (+recipients_fingerprint), the 6-field one (+sig_locator, #214) and the
// 7-field one (+sign_key_id, #250) all parse here identically.
export async function readSavedLocatorLine(path: string): Promise<SavedLocator | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) return null;
  const [locator, backend, sha, contentDigest, recipientsFingerprint, sigLocator, signKeyId] = line.split('\t');
  return { locator, backend, sha, contentDigest, recipientsFingerprint, sigLocator, signKeyId };
}

// Returns whether an upload actually happened: false for the --skip-unchanged
// early return below (nothing was pushed), true once backend.put() has really
// run. cli.ts uses this (not the raw --backend flag alone) to decide whether a
// push actually reached a paid backend — issue #195: a SKIPPED push must never
// be treated as "an upload succeeded". Also returns the locator (null on a SKIPPED
// push) so the public push() wrapper below can record it in the audit trail (#226)
// without re-parsing stdout or depending on --save-locator having been passed.
//
// --skip-unchanged (#510, extracted from pushCore): don't re-push (and, on arweave/
// turbo, re-pay for) content that has not changed since the previous push. THREE
// independent signals must ALL match the current --save-locator entry for the same
// backend before a skip fires:
//   1. the PLAINTEXT content digest (the "<out>.digest" sidecar) — it can never be
//      the ciphertext hash, because age's ephemeral file key makes identical content
//      encrypt to different bytes every run;
//   2. the recipients fingerprint (the "<out>.recipients-fingerprint" sidecar) — the
//      set of age1… keys THIS ciphertext was actually encrypted to. Without this
//      second check, re-snapshotting unchanged plaintext under a CHANGED recipient
//      set (a newly added offline recovery key, or a removed/revoked one) would
//      still skip and return the OLD locator — whose ciphertext the new key can
//      never decrypt, and/or a revoked key still can (#70 review round 2, a real
//      security regression, not just a correctness nit);
//   3. the SIGNING state (#250) — whether this artifact carries a "<in>.minisig"
//      and, if so, which signing key id produced it. Without this third check,
//      running `keygen --sign` (signing newly enabled) or `keygen --sign --force`
//      (key rotated) over otherwise-unchanged content skipped silently, leaving the
//      remote copy unsigned, or signed with the OLD key — less protected than the
//      operator now expects, with nothing said about it. Neither case lets tampered
//      content ACCEPT (the invalid-signature checks in restore/verify are
//      untouched); the gap is that the store quietly keeps a stale-authenticity
//      copy.
// All three are compared against the current --save-locator file's fields (4th =
// content_digest, 5th = recipients_fingerprint, 6th = sig_locator, 7th =
// sign_key_id). Any missing piece on EITHER side (no sidecar/--digest, a legacy
// 3/4-field file, a different backend) proceeds normally: skip is an optimization
// that only fires when EVERY signal is known and equal — an unknown signal must
// never be treated as "unchanged". --force pushes anyway. Checked before the
// paid-backend consent gate: a skipped push contacts nothing and spends nothing.
async function resolveSkipUnchanged(
  o: CliOptions,
): Promise<{ skip: true; locator: string; sigLocator: string | null } | { skip: false }> {
  if (!o.skip_unchanged) return { skip: false };
  if (!o.save_locator)
    throw new Error(
      '--skip-unchanged requires --save-locator <file> (the previous content digest, recipients fingerprint and signing key id live in its 4th/5th/7th fields)',
    );
  if (o.force) return { skip: false };
  const cur = await contentDigestFor(o);
  const curRecipients = await recipientsFingerprintFor(o);
  const curSigning = await signingStateFor(o);
  const prev = await readSavedLocatorLine(o.save_locator);
  const contentUnchanged = !!(
    cur &&
    prev?.locator &&
    prev.backend === o.backend &&
    prev.contentDigest &&
    prev.contentDigest.toLowerCase() === cur
  );
  const recipientsUnchanged = !!(
    curRecipients &&
    prev?.recipientsFingerprint &&
    prev.recipientsFingerprint.toLowerCase() === curRecipients
  );
  // "Was the previous push signed?" is answered by the 6th field (sig_locator),
  // which push has written since #214 whenever it uploaded a sidecar — so an
  // artifact pushed before #250 (or before #214) is correctly read as UNSIGNED
  // rather than as unknown, and an unsigned setup — the pre-#214 default — keeps
  // skipping exactly as it did. The 7th field only has to answer the narrower
  // "signed by WHICH key", and its absence on a signed previous push (a 6-field
  // line written between #214 and #250) is genuinely unknown: don't skip, then
  // the re-push records it and the next run compares normally. A curSigning of
  // null is the same kind of unknown on the current side (a sidecar that exists
  // but does not parse) and likewise never skips.
  const prevSigned = !!prev?.sigLocator;
  const signingUnchanged = !curSigning
    ? false
    : curSigning.signed
      ? prevSigned && !!prev?.signKeyId && prev.signKeyId.toLowerCase() === curSigning.keyId
      : !prevSigned;
  if (contentUnchanged && recipientsUnchanged && signingUnchanged && prev) {
    console.error(
      `SKIPPED: content, recipients and signing unchanged (digest ${cur}) — already pushed to ${o.backend} as ${prev.locator} (--force to push anyway)`,
    );
    console.log(prev.locator); // stdout contract unchanged: a script still captures a valid locator
    return { skip: true, locator: prev.locator, sigLocator: prev.sigLocator ?? null };
  }
  return { skip: false };
}

async function pushCore(
  o: CliOptions,
): Promise<{ success: boolean; locator: string | null; sigLocator: string | null }> {
  if (!o.in) throw new Error('--in <file.age> required');
  if (!o.backend) throw new Error('--backend <file|arweave|turbo|rclone|ton> required'); // no silent default
  // #655: --remote is read ONLY by the rclone backend (backends/rclone.ts's put()) —
  // every other backend's put() ignores it entirely (file/arweave/turbo/ton/ton-provider
  // ignore o.remote outright; see FLAG_IRRELEVANT's `push: []` entry in cli.ts, which is
  // about flags no OTHER command reads at all — a different, backend-conditional case
  // from this one, same distinction pull's own "--wait has no effect for --backend ..."
  // warning further down already draws for its own flag). An operator copy-pasting a
  // push invocation between backends (e.g. switching from rclone to file for a quick
  // local test) got no signal that --remote did nothing — warn here, before any upload
  // work, rather than leaving it silently dropped.
  if (o.remote !== undefined && o.backend !== 'rclone') {
    warn(
      `--remote is only used by --backend rclone (this push targets --backend ${o.backend}) — ` +
        `the value ${JSON.stringify(o.remote)} will be ignored`,
    );
  }
  await requireFile(o.in); // #267: one shared check/wording across every command
  // storage must only ever see ciphertext — refuse to push a non-age artifact
  // (e.g. an accidental plaintext path), which would be the last gate before a
  // backend can publish bytes externally.
  if (!(await readHead(o.in, 64)).startsWith(AGE_MAGIC)) {
    throw new Error(`${o.in} is not age ciphertext (header mismatch) — refusing to push non-ciphertext to storage`);
  }
  const skipResult = await resolveSkipUnchanged(o);
  if (skipResult.skip) {
    return { success: false, locator: skipResult.locator, sigLocator: skipResult.sigLocator };
  }
  // --plan <path.json> (#231): re-validate a plan written by "estimate --out" against
  // the state THIS push is about to act on — refuses BEFORE the estimate display and
  // consent gate below if the artifact, backend, price (within tolerance), payer or
  // remote no longer match what was reviewed. Additive: a validated plan still has to
  // clear the ordinary --yes/CYPHER_BRAIN_YES gate below too, same as an unplanned push
  // — this is a stricter guarantee bolted on top, not a replacement for that gate, and
  // NOT a replacement for CYPHER_BRAIN_MAX_SPEND either: that cap, enforced INSIDE
  // backend.put() below, remains the sole hard authority on actual spend (#105) — this
  // block only narrows what price/identity/destination was reviewed before getting
  // there (plan.ts's header comment documents this trust/TOCTOU boundary in full).
  // Runs its own fresh estimateCost() query rather than sharing the paid-backend-only
  // display block a few lines down (which only runs for arweave/turbo/ton-provider,
  // while a plan can be built and validated for ANY backend) — a second price query
  // only when --plan is actually used, traded deliberately for leaving that existing,
  // carefully-tuned display block completely untouched.
  if (o.plan) {
    const plan = await readPlanFile(o.plan);
    const { size: sizeBytes } = await stat(o.in);
    const remote = o.remote ?? null;
    const [artifactSha256, freshEstimate, payerAddress, recipientsFingerprint] = await Promise.all([
      sha256(o.in),
      estimateCost(o.backend, sizeBytes),
      payerAddressFor(o.backend, o),
      recipientsFingerprintFor(o),
    ]);
    const result = validatePlan(plan, {
      backend: o.backend,
      artifactSha256,
      freshEstimate,
      payerAddress,
      remote,
      recipientsFingerprint,
    });
    if (!result.ok) throw new Error(`--plan ${o.plan}: ${result.reason}`);
    // Only claim a signal "matched" when it was actually non-null on the PLAN side too
    // — otherwise "both null, nothing to compare" (a legitimate pass) would print the
    // same success text as a genuine comparison, overstating what was checked (Codex
    // review, same root cause as the payer-bypass fix above). recipients follows suit
    // (#469): validatePlan above now actually checks it, so it earns the same claim.
    const checked = [
      payerAddress && plan.payer_address ? 'payer' : null,
      remote && plan.remote ? 'remote' : null,
      recipientsFingerprint && plan.recipients_fingerprint ? 'recipients' : null,
    ].filter((s): s is string => s !== null);
    console.error(
      `--plan ${o.plan}: validated (artifact, backend and price within tolerance` +
        `${checked.length ? `, ${checked.join(' and ')}` : ''} all match the plan)`,
    );
  }
  // arweave and turbo are paid, permanent stores. #160: the cost estimate must be
  // VISIBLE in the SAME terminal output the --yes/CYPHER_BRAIN_YES consent decision is
  // made against — previously push() asked "this spends real funds, confirm?" with no
  // number attached, and the actual estimate (ar.transactions.getPrice() in
  // arweave.ts / getUploadCosts() in turbo.ts) only ran INSIDE backend.put(), i.e. only
  // AFTER the operator had already said yes. Compute + print it FIRST here, using the
  // exact estimateCost() math the `estimate` command and the MCP estimate_cost tool
  // already use (src/lib/estimate.ts, #159) — not a second, divergent computation —
  // so a blind "--yes" is no longer required to learn the amount.
  //
  // This step is deliberately display-only: CYPHER_BRAIN_MAX_SPEND enforcement stays
  // exactly where #105's fail-closed fix left it, INSIDE each backend's put()
  // (arweave.ts/turbo.ts — verified unchanged, git log --grep 105 / -- those files).
  // Duplicating the cap check here would create a second enforcement point to keep in
  // sync, and this early estimate can go stale by the time put() actually signs
  // (a real, independent price query, moments apart) — the backend's own re-check
  // immediately before signing is, and remains, the sole authority on whether an
  // upload proceeds. Skipped for the free `file` backend (no cost, nothing to show).
  if (o.backend === 'arweave' || o.backend === 'turbo' || o.backend === 'ton-provider') {
    const { size: sizeBytes } = await stat(o.in);
    const est = await estimateCost(o.backend, sizeBytes);
    // Wording deliberately avoids the literal substring "--yes"/"CYPHER_BRAIN_YES" here:
    // selftest.sh's "CYPHER_BRAIN_YES=1 no longer hits the gate" check greps stderr for
    // those tokens to detect the ACTUAL consent-gate error below — this informational
    // header must never produce a false match of that check.
    console.error(`${o.backend}: cost estimate (shown before the upload-consent check below):`);
    for (const line of formatEstimate(est)) console.error(`  ${line}`);
    // #639: ton-provider is the ONLY backend where CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND
    // must bound the ciphertext deploy AND (if a signed artifact) the ".minisig" sidecar
    // deploy TOGETHER (ton-provider.ts's put() enforces this via a shared spendTracker
    // passed below) — so a signed push's pre-consent display must also show the
    // sidecar's own estimate and the combined total, or an operator could consent
    // against a number the actual combined spend goes on to exceed. Best-effort only,
    // same staleness caveat as the ciphertext estimate above: a real, independent
    // provider-search query, not a shared computation with put()'s own.
    if (o.backend === 'ton-provider' && (await exists(`${o.in}.minisig`))) {
      const { size: sigSizeBytes } = await stat(`${o.in}.minisig`);
      const sigEst = await estimateCost(o.backend, sigSizeBytes);
      console.error(
        `${o.backend}: a ".minisig" signature sidecar will ALSO be deployed, as a SECOND contract — its own cost estimate:`,
      );
      for (const line of formatEstimate(sigEst)) console.error(`  ${line}`);
      if (est.cost !== null && sigEst.cost !== null) {
        console.error(
          `${o.backend}: combined ciphertext+signature spend is checked TOGETHER against ` +
            `CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (≈${BigInt(est.cost) + BigInt(sigEst.cost)} nanoTON total)`,
        );
      }
    }
  }
  const yes = !!o.yes || CIPHER_YES;
  // arweave and turbo are paid, permanent stores — require an explicit opt-in so
  // an unattended cadence loop doesn't silently accumulate charges. Set CYPHER_BRAIN_YES=1
  // in the nightly script (or pass --yes) to skip this prompt in automation.
  if ((o.backend === 'arweave' || o.backend === 'turbo') && !yes) {
    throw new Error(
      `${o.backend}: uploading to a permanent Arweave store spends real funds — ` +
        `re-run push with --yes or set CYPHER_BRAIN_YES=1 in the environment to confirm`,
    );
  }
  if (o.backend === 'ton-provider' && !yes) {
    const autoSigns = await tonWalletConfigured();
    throw new Error(
      `ton-provider: deploying a TON Storage contract to a paid provider spends real funds — ` +
        `re-run push with --yes or set CYPHER_BRAIN_YES=1 in the environment to confirm ` +
        (autoSigns
          ? '(CYPHER_BRAIN_TON_WALLET is configured — this will auto-sign and broadcast without a human)'
          : '(a human must still sign the resulting Tonkeeper deeplink — set CYPHER_BRAIN_TON_WALLET to auto-sign instead)'),
    );
  }
  const backend = await backendFor(o.backend);
  type ReceiptBox = {
    value: { raw: unknown; cost: { amount: string; unit: 'winston' | 'winc' | 'nanoton' } | null } | null;
  };
  // A mutable PROPERTY, not a bare `let`: TS's control-flow narrowing sees no direct
  // assignment to a box's field itself outside the closure and so keeps its declared
  // union type intact at the `if` check below — a bare `let receipt = null` reassigned
  // only inside the onReceipt closure gets over-narrowed to the literal `null` (the sole
  // assignment CFA can see in this function's own linear flow), making a later
  // `if (receipt)` narrow to `never` rather than the non-null branch.
  const newReceiptBox = (): ReceiptBox => ({ value: null });
  // #232: persist a receipt for the ACTUAL cost a paid backend just charged for
  // `uploadedPath`, separate from estimate.ts's pre-flight forecast printed above. The
  // upload already succeeded and already spent real funds by the time this runs — a
  // receipt-write failure (disk full, permissions) must NEVER retroactively fail an
  // already-completed push (that would misrepresent a successful, paid upload as a
  // failure a caller might retry, risking a double spend) — advisory only, same
  // posture push()'s balance display already takes elsewhere in this file. Shared by
  // both the primary artifact upload below AND the .minisig sidecar upload further
  // down: a signed push to arweave/turbo makes TWO separate paid uploads, and the
  // sidecar's cost was invisible to the ledger before this was factored out (Codex
  // review — understated the total cost of every signed paid push).
  // A plain local `const`, not `o.backend` accessed directly inside the closure below:
  // TS does not carry the `if (!o.backend) throw` narrowing at the top of this function
  // through into a nested arrow function's body (property-access narrowing on a
  // captured object resets inside a closure), so `o.backend` alone reads back as
  // `string | undefined` there even though it is provably a `string` by this point.
  const backendName = o.backend;
  const persistReceiptIfAny = async (uploadedPath: string, uploadedLocator: string, box: ReceiptBox): Promise<void> => {
    const captured = box.value;
    if (!captured) return;
    try {
      const [artifactSha256, payerAddress] = await Promise.all([sha256(uploadedPath), payerAddressFor(backendName, o)]);
      const { size: sizeBytes } = await stat(uploadedPath);
      await appendReceipt({
        timestamp: new Date().toISOString(),
        backend: backendName,
        locator: uploadedLocator,
        artifact_sha256: artifactSha256,
        size_bytes: sizeBytes,
        payer_address: payerAddress,
        cost: captured.cost?.amount ?? null,
        unit: captured.cost?.unit ?? null,
        raw: captured.raw,
      });
    } catch (e) {
      warn(
        `${backendName}: could not persist the upload receipt (${errMsg(e)}) — the push itself succeeded (locator ${uploadedLocator} is real); cumulative-cost ledger will be missing this entry`,
      );
    }
  };

  // `remote` is only meaningful to the rclone backend (its --remote <name>:<path>
  // destination — types.ts's PutOpts) — every other backend's put() ignores it, same
  // as `yes` is only meaningful to arweave/turbo/ton-provider. `onReceipt` (#232, and
  // #484 for ton-provider) is likewise only ever called by arweave/turbo/ton-provider —
  // every other backend's receiptBox stays null, and persistReceiptIfAny() above is
  // then a no-op for it. `force` (#533) is likewise rclone-only — its own no-clobber
  // check over an existing --remote object, deliberately the SAME o.force that opted
  // resolveSkipUnchanged() past the digest check above, not a second flag.
  //
  // `spendTracker` (#639) is ton-provider-only — a mutable box passed BY REFERENCE to
  // this call and the ".minisig" sidecar's put() call further down, so ton-provider.ts
  // can enforce CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND against their COMBINED spend rather
  // than checking each deploy in isolation. Every other backend ignores it.
  const receiptBox = newReceiptBox();
  const spendTracker = { spentNano: 0n };
  const locator = await backend.put(o.in, {
    yes,
    remote: o.remote,
    force: o.force,
    spendTracker,
    onReceipt: (raw, cost) => {
      receiptBox.value = { raw, cost };
    },
  });
  console.error(`pushed ${o.in} -> ${o.backend}:${locator}`);
  await persistReceiptIfAny(o.in, locator, receiptBox);
  // Authenticity sidecar (#214): if snapshot() wrote a "<in>.minisig" next to the
  // ciphertext, upload it too — same backend, same already-granted consent (`yes`
  // covers the whole push() call, not a per-file re-prompt for a few-hundred-byte
  // signature). Automatic whenever the sidecar exists; a pre-#214 push (no sidecar)
  // is byte-for-byte unchanged. The rclone backend needs its OWN distinct --remote
  // destination per file (its locator IS that destination string, unlike every other
  // backend's content-addressed/post-assigned one) — derived here as "<remote>.minisig",
  // a deterministic sibling of the ciphertext's own --remote.
  const sigPath = `${o.in}.minisig`;
  let sigLocator: string | undefined;
  if (await exists(sigPath)) {
    const sigReceiptBox = newReceiptBox();
    // A local `const`, typed plain `string`, not the outer `let sigLocator: string |
    // undefined` — TS cannot narrow the outer variable to non-undefined here (its
    // declaration and assignment sit across a try/catch boundary), and the outer
    // variable is still assigned right below for --save-locator's own later use.
    let justUploaded: string;
    try {
      // #533: the sidecar's OWN no-clobber check (rclone.ts's put(), against
      // "<remote>.minisig") can refuse here even though the ciphertext just above
      // already uploaded successfully — that is not a new failure mode this
      // introduces, just one more reason the catch block below's existing
      // PushSignatureUploadError path (ciphertext-succeeded-sidecar-failed) can
      // fire, same as a network blip or auth failure always could.
      // selftest-push-partial-failure.sh already exercises that partial-success
      // shape end-to-end.
      justUploaded = await backend.put(sigPath, {
        yes,
        remote: o.remote ? `${o.remote}.minisig` : undefined,
        force: o.force,
        // #639: the SAME spendTracker reference the ciphertext upload above used — this
        // is what lets ton-provider.ts see the ciphertext deploy's already-committed
        // spend and enforce the cap against the combined total.
        spendTracker,
        onReceipt: (raw, cost) => {
          sigReceiptBox.value = { raw, cost };
        },
      });
    } catch (e) {
      // The ciphertext (above) already durably uploaded — see PushPartialSuccessError's
      // own doc comment for why this must never be reported the same way as an
      // ordinary push() failure (a caller assuming "nothing happened" here would be
      // wrong, and an MCP idempotency-key caller must still remember this call as
      // having spent, not treat a retry as the first attempt).
      throw new PushSignatureUploadError(locator, e);
    }
    sigLocator = justUploaded;
    console.error(`pushed ${sigPath} -> ${o.backend}:${justUploaded}`);
    // #232: a signed push to a paid backend is TWO separate uploads (ciphertext +
    // sidecar), each its own charge — without this, the ledger silently understated
    // every signed arweave/turbo push's true total cost (Codex review).
    await persistReceiptIfAny(sigPath, justUploaded, sigReceiptBox);
  }
  // --save-locator <path>: persist the returned locator so operators can back it up
  // alongside their identity (the two things a fresh machine needs to restore).
  // The file is rewritten on each push — it always holds the most recent locator.
  // Everything from here on is LOCAL bookkeeping AFTER the upload above already
  // succeeded — the point of no return already passed. Wrap the whole block so any
  // failure here (ENOSPC, a permission error, a directory sitting where the locator
  // file should be, ...) surfaces as PushLocatorWriteError instead of an ordinary
  // Error: a caller must be able to tell "the upload itself never happened" apart
  // from "the upload happened, only recording where it went then failed" — the two
  // demand opposite recovery behavior (see wizard.ts's push() catch for the caller
  // that actually depends on this distinction).
  if (o.save_locator) {
    try {
      await mkdir(dirname(resolve(o.save_locator)), { recursive: true });
      // Record "<locator>\t<backend>\t<sha256>[\t<content_digest>[\t<recipients_fingerprint>[\t<sig_locator>]]]".
      // The sha256 — computed here off the bytes we just pushed — binds the locator to
      // its ciphertext, so a recovery via --from-locator-file is fail-closed: for
      // arweave/turbo (locator != content hash) a gateway/storage attacker can't later
      // serve a substituted, still-age-decryptable artifact. The hash is trustworthy
      // because this file is backed up OFF-BOX (the same trusted-source rule the
      // existing --sha256 pin relies on). The 4th field is the PLAINTEXT content digest
      // (from the "<in>.digest" sidecar / --digest); the 5th is the recipients
      // fingerprint (from the "<in>.recipients-fingerprint" sidecar) — both are the
      // comparison targets for the next push --skip-unchanged. The 6th (#214) is where
      // the "<in>.minisig" sidecar landed, if one was pushed above — pull's
      // --from-locator-file reads it back to also fetch the signature alongside the
      // ciphertext. The 7th (#250) is the signing key id inside that sidecar, so the
      // next --skip-unchanged can tell "still signed by the same key" apart from
      // "signing just got enabled" or "the signing key was rotated".
      // This is a POSITIONAL format, so a later field can only occupy its slot if the
      // earlier ones exist too — when contentDigest/recipientsFingerprint are
      // themselves missing (an --in not produced by this cypher-brain's own snapshot,
      // e.g. a foreign or pre-digest-era artifact) they're written as empty fields
      // rather than omitted, so the later ones still land in their correct positions
      // instead of silently being dropped (readSavedLocatorLine's positional
      // destructuring reads an empty field as falsy, same as a genuinely-absent one,
      // for --skip-unchanged). Trailing empties are dropped, so an unsigned push still
      // writes exactly the 5-field line it wrote before #214.
      const digest = await sha256(o.in);
      const contentDigest = await contentDigestFor(o);
      const recipientsFingerprint = await recipientsFingerprintFor(o);
      const writtenSigning = sigLocator ? await signingStateFor(o) : null;
      const signKeyId = writtenSigning?.signed ? writtenSigning.keyId : null;
      const optional = [contentDigest ?? '', recipientsFingerprint ?? '', sigLocator ?? '', signKeyId ?? ''];
      while (optional.length > 0 && optional[optional.length - 1] === '') optional.pop();
      const fields = [locator, o.backend, digest, ...optional];
      // Atomic write: a crash / ENOSPC mid-rewrite must not leave the recovery pointer
      // empty AND destroy the previous good locator. Write a temp sibling, then rename.
      const tmp = `${o.save_locator}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(tmp, `${fields.join('\t')}\n`, { flag: 'w' });
        await rename(tmp, o.save_locator);
      } catch (e) {
        await rm(tmp, { force: true });
        throw e;
      }
      console.error(`locator saved -> ${o.save_locator}`);
    } catch (e) {
      throw new PushLocatorWriteError(locator, sigLocator, e);
    }
  }
  console.log(locator); // stdout = locator ONLY, so a script can capture it
  return { success: true, locator, sigLocator: sigLocator ?? null };
}

// #226: the public entry point (unchanged signature — every existing caller, cli.ts/
// mcp.ts/wizard.ts, is unaffected). Records an audit-trail entry (src/lib/audit.ts)
// AFTER pushCore() settles, whether it succeeded or threw — never before, and never in
// a way that changes what pushCore() itself did. On failure, the caught error is
// rethrown UNCHANGED (`throw e`, not a new Error wrapping it): PushPartialSuccessError
// instances must survive this wrapper intact, since both wizard.ts's push()-caller and
// mcp.ts's idempotency-replay path do their own `instanceof PushPartialSuccessError`
// checks on whatever push() throws. Audit recording itself is advisory (recordAudit()/
// appendAuditEntry() never throw — see audit.ts) and never delays returning/rethrowing
// pushCore()'s own outcome by more than the recording call itself takes.
export async function push(o: CliOptions): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const result = await pushCore(o);
    await recordAudit({
      command: 'push',
      o,
      backend: o.backend ?? null,
      locator: result.locator,
      exitCode: 0,
      startedAt,
    });
    return result.success;
  } catch (e) {
    const locator = e instanceof PushPartialSuccessError ? e.locator : null;
    await recordAudit({ command: 'push', o, backend: o.backend ?? null, locator, exitCode: 1, startedAt });
    throw e;
  }
}

// Used only by cypher-brain-mcp's idempotency-key replay path (#220, multi-model review
// P2): a repeat snapshot_now call carrying a DIFFERENT locator_file than the original
// call must still get the recovery pointer written to ITS requested path, even though a
// replay re-uploads nothing. Deliberately minimal — locator/backend/sha256 only, NOT the
// content-digest/recipients-fingerprint/signing fields the full save-locator write above
// derives by re-reading the sidecars next to `o.in` at push TIME. Re-deriving those here
// would mean re-reading whatever currently sits at the ORIGINAL call's `out` path, which
// the idempotency log does not itself vouch is still the same file an agent could have
// since overwritten with something unrelated. The three fields written here are exactly
// the ones the idempotency log already recorded at the time of the original successful
// push, so there is nothing to re-derive or risk going stale.
export async function writeReplayedSavedLocator(
  savedLocatorPath: string,
  fields: { locator: string; backend: string; sha256: string },
): Promise<void> {
  await mkdir(dirname(resolve(savedLocatorPath)), { recursive: true });
  const tmp = `${savedLocatorPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${fields.locator}\t${fields.backend}\t${fields.sha256}\n`, { flag: 'w' });
    await rename(tmp, savedLocatorPath);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// Promote a completed pull's temp part to --out, no-clobber (#107). Mirrors
// snapshot.ts's promoteSnapshot exactly: prefer link(), atomic and fails with EEXIST if
// `out` appeared meanwhile — a true exclusive no-clobber even under overlapping pulls.
// Hard links are unsupported on exFAT/FAT and some network/cloud mounts (common backup
// media), where link throws EPERM/ENOTSUP — there, fall back to an exclusive create
// (writeFile with the 'wx' flag) as the no-clobber GATE instead of a racy
// exists()-then-rename() check-then-act: 'wx' atomically fails with EEXIST if `out`
// already exists, so of two overlapping pulls at most one can win the create — the
// loser sees EEXIST and refuses, same as the link() path. The winner then owns `out`
// and folds the real content in via rename() (itself atomic). Residual: an unclean kill
// between the create and the rename can leave an empty placeholder at `out` — but that
// fails SAFE (a later run sees EEXIST and refuses with the same clobberErr) rather than
// a silent, undetectable clobber.
export async function promoteNoClobber(part: string, out: string, what = 'a pull result'): Promise<void> {
  const clobberErr = () =>
    new Error(
      `${out} already exists — refusing to overwrite it with ${what} (move it aside, choose a new --out, or pass --force)`,
    );
  try {
    await link(part, out);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === 'EEXIST') throw clobberErr();
    if (err?.code && ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(err.code)) {
      try {
        await writeFile(out, '', { flag: 'wx' });
      } catch (createErr) {
        const ce = createErr as NodeJS.ErrnoException;
        if (ce && ce.code === 'EEXIST') throw clobberErr();
        throw createErr;
      }
      try {
        await rename(part, out);
      } catch (renameErr) {
        try {
          await rm(out, { force: true });
        } catch {
          /* ignore — never mask the real renameErr */
        }
        throw renameErr;
      }
      return;
    }
    throw e;
  }
  await rm(part, { force: true }); // drop the redundant link; out is the durable copy
}

export async function pull(o: CliOptions): Promise<void> {
  // --from-locator-file <path>: read the locator (and its backend) from a file written
  // by `push --save-locator`. This is the recovery path — a fresh machine that holds
  // only the identity + this one small file (both backed up off-box) can restore the
  // latest snapshot without ever having seen index.tsv. Explicit --locator/--backend
  // still win if both are also given.
  if (o.from_locator_file) {
    if (!(await exists(o.from_locator_file))) throw new Error(`no such locator file: ${o.from_locator_file}`);
    // #502: reuse the same parser push's --skip-unchanged path already relies on
    // (readSavedLocatorLine, above) instead of hand-rolling an identical read+split —
    // it accepts the legacy 3-field line, the 4-field one (a trailing content_digest,
    // written since --skip-unchanged), the 5-field one (+recipients_fingerprint), the
    // 6-field one (+sig_locator, #214) AND the 7-field one (+sign_key_id, #250):
    // recovery of every existing save-locator file must keep working, so extra columns
    // are simply ignored here. sign_key_id in particular is push-side bookkeeping for
    // --skip-unchanged and is deliberately NOT used as a pin on pull: the trustworthy
    // authenticity check is restore/verify against the pinned signing PUBLIC key.
    const saved = await readSavedLocatorLine(o.from_locator_file);
    if (!saved) throw new Error(`locator file ${o.from_locator_file} has no locator line`);
    // A truncated / hand-mangled file missing the backend column would otherwise fall
    // through to the generic "--backend required" error, hiding the real cause.
    if (!saved.locator || !saved.backend) {
      throw new Error(
        `locator file ${o.from_locator_file} must contain "<locator>\\t<backend>[\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]]" — got fields: ${JSON.stringify(saved)}`,
      );
    }
    if (!o.locator) o.locator = saved.locator;
    if (!o.backend) o.backend = saved.backend;
    // Apply the saved integrity pin so recovery is fail-closed (a substituted ciphertext
    // is rejected); an explicit --sha256 still wins if the operator passed one.
    if (!o.sha256 && saved.sha) o.sha256 = saved.sha;
    // Same idea for the authenticity sidecar (#214): if push recorded where "<in>.minisig"
    // landed, fetch it alongside the ciphertext below (best-effort — see the fetch site).
    if (!o.sig_locator && saved.sigLocator) o.sig_locator = saved.sigLocator;
  }
  // rclone backend (#204): its locator IS the "<remote>:<path>" string (see
  // backends/rclone.ts) — --remote is accepted here as the same value --locator
  // would take, so a pull can mirror push's own --remote flag instead of forcing the
  // operator to know that the two happen to be interchangeable for this backend.
  // An explicit --locator still wins if both are somehow given.
  if (o.backend === 'rclone' && !o.locator && o.remote) o.locator = o.remote;
  if (!o.locator) throw new Error('--locator <id> required (or --from-locator-file <path>, or --remote for rclone)');
  if (!o.out) throw new Error('--out <file.age> required');
  if (!o.backend) throw new Error('--backend <file|arweave|turbo|rclone|ton> required');
  // No-clobber (#107): refuse to overwrite an existing --out by default. wizard.ts's
  // printed recovery command reuses a FIXED path ("~/restored.age"), so a second pull
  // (a different backup, or a re-run of the recovery steps) would otherwise destroy
  // whatever the first pull already fetched with no warning — every backend's get()
  // (file.ts's copyFile, arweave.ts's stream-then-rename, which turbo.ts also delegates
  // to) writes unconditionally. Mirrors snapshot.ts's exists() gate on --out
  // (src/lib/snapshot.ts). Checked up front, before the possibly long --wait retry loop
  // below, so a doomed pull fails fast; --force opts into overwriting.
  if (!o.force && (await exists(o.out))) {
    throw new Error(
      `${o.out} already exists — refusing to overwrite it with a pull result (move it aside, choose a new --out, or pass --force)`,
    );
  }
  const backend = await backendFor(o.backend);
  // --wait <seconds>: keep retrying while the item is not yet retrievable. A fresh
  // Turbo/ArDrive upload takes ~5-8 min to propagate to the gateway (bundle -> mine
  // -> index); with --wait 0 (the default) pull fails immediately, preserving the old
  // behavior. CYPHER_BRAIN_PULL_RETRY_MS overrides the 30s retry interval (tests use it).
  const waitMs = (Number(o.wait) || 0) * 1000; // `|| 0` OUTSIDE Number → a non-numeric --wait is 0, not NaN (no infinite loop)
  // #465: --wait only has an effect for backends whose get() can throw RetryableError
  // (WAIT_RETRY_BACKENDS, config.ts) — for every other backend the retry loop below exits
  // on attempt 1 regardless of this value, with nothing said about it before this warning
  // existed. `file` is the explicitly recommended backend for local testing/dogfooding, so
  // this was an easy trap: an operator simulating "not yet retrievable" locally to sanity-
  // check their retry logic would see --wait appear to do nothing and could reasonably
  // conclude the FLAG (not just that backend) was broken.
  if (waitMs > 0 && o.backend && !WAIT_RETRY_BACKENDS.has(o.backend)) {
    warn(
      `--wait has no effect for --backend ${o.backend} — it only retries for ${[...WAIT_RETRY_BACKENDS].join('/')} (a not-yet-retrievable object fails immediately on every other backend)`,
    );
  }
  // Unlike waitMs above (where "unset" and "explicit 0" both correctly mean 0ms — a
  // bare `|| 0` is safe there), retryMs's default (30000) and its explicit-zero value
  // (0, immediate retry — the natural choice for a test avoiding a real sleep) are
  // DIFFERENT, so a bare `Number(env) || 30000` (the #108 bug) breaks: Number("0") is
  // 0, and 0 is falsy, so `|| 30000` silently overrides the very value it was asked to
  // apply. Unset or empty falls back to the 30000ms default; anything else that parses
  // as a number is honored AS GIVEN, including 0.
  const retryMsEnv = readEnv('CYPHER_BRAIN_PULL_RETRY_MS');
  const retryMsNum = retryMsEnv !== undefined && retryMsEnv !== '' ? Number(retryMsEnv) : NaN;
  const retryMs = Number.isFinite(retryMsNum) ? retryMsNum : 30000; // unset/empty/non-numeric -> default; anything else (incl. 0) is respected
  const deadline = Date.now() + waitMs;
  // Fetch into a PER-RUN-UNIQUE temp sibling of --out, never --out itself (#107): this
  // keeps --out completely untouched until the fetched bytes are verified good, so
  // neither a failed/retried attempt nor a --sha256 mismatch below (which previously
  // deleted --out itself) can ever harm a file that was already there. The final
  // promotion is the same atomic no-clobber pattern snapshot.ts's promoteSnapshot uses
  // for its own --out write (promoteNoClobber above).
  const part = `${o.out}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await backend.get(o.locator, part);
        break;
      } catch (e) {
        const remaining = deadline - Date.now();
        if (!(e instanceof RetryableError) || remaining <= 0) throw e; // fatal (bad locator etc.) or out of budget → fail now
        const naptime = Math.min(retryMs, remaining); // honor a budget shorter than the retry interval
        console.error(`pull attempt ${attempt} not ready (${e.message}); retrying in ${Math.round(naptime / 1000)}s…`);
        await sleep(naptime);
      }
    }
    // --sha256 <hex>: bind the fetched bytes to a hash known out-of-band (from a TRUSTED
    // source, e.g. an off-box index.tsv — NOT the maybe-compromised snapshotting box).
    // For the post-assigned-id backends (arweave/turbo) the locator is not a content
    // hash, so without this a gateway/storage attacker could serve a rolled-back or
    // substituted (but still age-decryptable) ciphertext. Checked against the TEMP part
    // (never --out), so a mismatch here can never touch a pre-existing --out.
    if (o.sha256) {
      const got = await sha256(part);
      if (got.toLowerCase() !== String(o.sha256).toLowerCase()) {
        throw new Error(
          `sha256 mismatch: fetched ${got}, expected ${o.sha256} (the storage/gateway served bytes that do not match the pinned hash — nothing was written to ${o.out})`,
        );
      }
      console.error(`sha256 OK: ${got}`);
    }
    // Promote the verified fetch to --out. --force is the explicit opt-in to overwrite
    // (rename() atomically replaces an existing --out on POSIX); without it,
    // promoteNoClobber refuses if --out appeared since the check above (TOCTOU-safe).
    if (o.force) await rename(part, o.out);
    else await promoteNoClobber(part, o.out);
  } catch (e) {
    await rm(part, { force: true });
    throw e;
  }
  console.error(`pulled ${o.backend}:${o.locator} -> ${o.out}`);
  // Authenticity sidecar (#214): --sig-locator (explicit, or read from
  // --from-locator-file's 6th field above) says where push() parked the "<in>.minisig"
  // that was signed alongside this ciphertext — fetch it too, into "<out>.minisig", so
  // restore/verify on THIS machine has something to check. Best-effort and entirely
  // separate from the main fetch's own retry/--sha256/no-clobber machinery above: the
  // ciphertext is already safely at --out by this point, so a problem fetching the
  // (non-essential, additive) signature must only warn, never undo or fail the pull —
  // restore/verify's own "no signature -> WARN, not FAIL" contract (#214) already
  // covers a missing sidecar gracefully.
  const sigOut = `${o.out}.minisig`;
  if (o.sig_locator) {
    // Mirror --out's own --force gate above: --force already replaced --out with a
    // NEW ciphertext, so leaving a STALE .minisig sidecar next to it would make the
    // freshly-pulled artifact fail verification against a signature over the OLD
    // bytes — --force must refresh both together, not just the ciphertext.
    if ((await exists(sigOut)) && !o.force) {
      console.error(`warning: ${sigOut} already exists — not overwriting it with the fetched signature`);
    } else {
      try {
        // 'minisig', not the default 'age': this object is a detached signature, and a
        // backend that validates the shape it received (arweave/turbo) would otherwise
        // refuse a perfectly good sidecar for not being ciphertext — which is exactly what
        // it did before #318, making push --sign + pull impossible to round-trip there.
        await backend.get(o.sig_locator, sigOut, 'minisig');
        console.error(`pulled ${o.backend}:${o.sig_locator} -> ${sigOut}`);
      } catch (e) {
        console.error(
          `warning: could not fetch the authenticity signature (${o.backend}:${o.sig_locator} -> ${sigOut}): ${errMsg(e)}`,
        );
      }
    }
  } else if (o.force && (await exists(sigOut))) {
    // --force with NO sig_locator for THIS pull (the artifact being pulled has no
    // known signature) still just replaced --out's ciphertext — a stale .minisig
    // from a PRIOR pull into the same path would otherwise be silently signed over
    // the OLD bytes, and restore/verify would report a confusing "invalid signature"
    // for content that is simply unsigned. Removing it here is a straight loss of
    // (already-stale) information, never a loss of anything about THIS artifact.
    await rm(sigOut, { force: true });
    console.error(`removed stale ${sigOut} (this pull has no known signature to replace it with)`);
  }
}

// pull()'s own line, verbatim — what signatureGap() below matches against pull()'s
// captured log to tell a deleted/unfetchable signature sidecar apart from an artifact
// that was simply never signed.
const SIG_FETCH_FAILED = 'could not fetch the authenticity signature';

// A URL's userinfo is a credential, and CYPHER_BRAIN_AR_GATEWAYS can legitimately carry
// one (`https://user:token@gateway`). pull() prints a failing gateway's URL to its own
// stderr, which is fine for an operator's own terminal but not for a caller that turns
// pull()'s captured log lines into a returned/printed report (the MCP server's
// `pulled.log`, verify --level remote/drill's `--json` signature field) — redact it there.
export const redactUserinfo = (line: string): string =>
  line.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1<redacted>@');

// An artifact whose authenticity sidecar could not be FETCHED is not the same thing as
// one that was never signed — and runFileChecks (src/lib/restore.ts) cannot tell them
// apart on its own, because it only ever sees the local directory it was handed (#312).
// Only the caller of BOTH pull() and the file checks can, by keeping pull()'s own log
// around — which is why this lives beside pull() rather than in either caller: the
// CLI's `verify --level remote/drill` (src/lib/restore.ts, #209) and the MCP server's
// verify_restore/restore_now tools (src/mcp.ts) both pull first and then check, and both
// now share this one implementation instead of drifting apart on what counts as a
// downgrade.
//
// This matters beyond tidiness: pull()'s sidecar fetch is best-effort by design (#214 —
// a signature it cannot retrieve must warn and continue, never fail the pull), so the
// visible result of a DELETED .minisig is "unsigned (legacy) artifact, authenticity not
// checked" plus a PASS verdict — true of a pre-#214 backup, false here.
//
// Keyed on pull's OWN warning rather than on "sig_locator was recorded and the file is
// missing", which review showed infers too much in two directions. It over-fires: the
// arweave/turbo read promotes a body only if isAgeCiphertext() passes, and a minisign
// sidecar is plaintext, so a perfectly intact signature in that storage can never be
// fetched — the missing-file inference would cry downgrade on every signed arweave pull
// (tracked separately; the sidecar round-trip is only exercised on the file backend
// today). And it claims too much: a recorded sig_locator proves a sidecar OBJECT was
// pushed, not that it holds a valid signature over this ciphertext. Matching the warning
// reports only what actually happened, and carries pull's own reason with it.
export function signatureGap(pullLog: string[], sigLocator: unknown): Record<string, unknown> | undefined {
  const line = pullLog.find((l) => l.includes(SIG_FETCH_FAILED));
  if (!line) return undefined;
  return {
    fetched: false,
    ...(typeof sigLocator === 'string' ? { expected_locator: sigLocator } : {}),
    reason: redactUserinfo(line),
    note:
      'a signature sidecar was recorded for this artifact and could not be fetched, so authenticity was NOT ' +
      'checked. Any "unsigned (legacy) artifact" line in the checks/log below describes a different situation ' +
      'and does not apply here. Read `reason` before concluding anything: a deleted .minisig (the downgrade an ' +
      'attacker gets without forging a signature) and a storage backend that cannot serve sidecars both land ' +
      'here, and they are not the same problem.',
  };
}
