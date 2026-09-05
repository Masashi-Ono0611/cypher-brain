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
import { UsageError } from './errors.js';
import { acquirePushLock, saveLocatorLockKey } from './push-lock.js';
import type { CliOptions, ReceiptEvent } from './types.js';
import type { SpendTracker } from './spend-tracker.js';
import {
  PushPartialSuccessError,
  PushSignatureUploadError,
  PushLocatorWriteError,
  PushFundingConfirmedButIncompleteError,
  PushUploadConfirmedResponseLostError,
} from './push-partial-success.js';
import { PushUncertainSpendError } from './push-uncertain-spend.js';
// Re-exported unchanged so existing `from './pushpull.js'` imports (mcp.ts, wizard.ts)
// keep working — see push-partial-success.ts's own header comment for why these
// classes live in a separate, import-cycle-free module in the first place.
export {
  PushPartialSuccessError,
  PushSignatureUploadError,
  PushLocatorWriteError,
  PushFundingConfirmedButIncompleteError,
  PushUploadConfirmedResponseLostError,
} from './push-partial-success.js';
export { PushUncertainSpendError } from './push-uncertain-spend.js';

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
  remote: string | undefined; // the rclone `--remote <name>:<path>` destination this push used, if any
}

// Parse the FIRST locator line of a save-locator file into its (up to 8) fields.
// Returns null when the file is missing/empty — callers treat that as "no previous
// push recorded". The 3-field legacy format, the 4-field one (+content_digest), the
// 5-field one (+recipients_fingerprint), the 6-field one (+sig_locator, #214), the
// 7-field one (+sign_key_id, #250) and the 8-field one (+remote, rclone-destination
// change detection) all parse here identically.
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
  const [locator, backend, sha, contentDigest, recipientsFingerprint, sigLocator, signKeyId, remote] = line.split('\t');
  return { locator, backend, sha, contentDigest, recipientsFingerprint, sigLocator, signKeyId, remote };
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
//   4. the RCLONE DESTINATION (elevated-caution review): for --backend rclone, the
//      --remote <name>:<path> the ciphertext actually lands at. Without this check,
//      reusing one --save-locator file after CHANGING --remote (a different rclone
//      remote name, or the same remote with a different path) would report SKIPPED
//      using the OLD locator even though nothing was ever backed up to the NEW
//      destination — the same "the recovery pointer names somewhere the backup
//      never actually went" class of gap #806/#807 closed for the concurrent case,
//      here for the sequential one. Irrelevant to every other backend (their put()
//      ignores --remote entirely — see assertRemoteRequiresRcloneBackend above), so
//      it never blocks a skip for arweave/turbo/ton-provider/file/ton.
// All four are compared against the current --save-locator file's fields (4th =
// content_digest, 5th = recipients_fingerprint, 6th = sig_locator, 7th =
// sign_key_id, 8th = remote). Any missing piece on EITHER side (no sidecar/--digest,
// a legacy 3/4/5/6/7-field file, a different backend) proceeds normally: skip is an
// optimization that only fires when EVERY signal is known and equal — an unknown
// signal must never be treated as "unchanged". --force pushes anyway. Checked before
// the paid-backend consent gate: a skipped push contacts nothing and spends nothing.
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
  // Only rclone reads --remote at all (see the comment above this function), so every
  // other backend's destination cannot have "changed" — true unconditionally there.
  // For rclone, both sides must be KNOWN and equal: a legacy save-locator file with no
  // 8th field is treated the same as an unknown signal everywhere else in this
  // function — unknown must never read as "unchanged", or the very bug this closes
  // (a stale --save-locator surviving a --remote change) would resurface for exactly
  // the files written before this field existed.
  const remoteUnchanged = o.backend !== 'rclone' || !!(o.remote && prev?.remote && prev.remote === o.remote);
  if (contentUnchanged && recipientsUnchanged && signingUnchanged && remoteUnchanged && prev) {
    console.error(
      `SKIPPED: content, recipients and signing unchanged (digest ${cur}) — already pushed to ${o.backend} as ${prev.locator} (--force to push anyway)`,
    );
    console.log(prev.locator); // stdout contract unchanged: a script still captures a valid locator
    return { skip: true, locator: prev.locator, sigLocator: prev.sigLocator ?? null };
  }
  return { skip: false };
}

// --remote <name>:<path> is read ONLY by the rclone backend's put() (src/lib/backends/
// rclone.ts's own required-remote check, and estimate.ts's #468 check just above pin the
// OPPOSITE direction: rclone REQUIRES --remote). Every OTHER backend's put() ignores it
// entirely (src/lib/types.ts's PutOpts.remote doc comment says exactly this) — so `push
// --backend file --remote foo:/bar` used to parse fine and silently drop --remote,
// writing to the file backend's normal default store path with no warning that --remote
// had no effect (#655). Same "flag accepted, never honored" bug class #253/#277/#307/
// #525/#526 already refuse elsewhere in this codebase (see profiles.ts's
// assertVaultRequiresObsidianProfile/assertPgFiltersRequirePg for the same shape: a
// companion flag refused unless the OTHER flag it depends on has the one matching
// value). Refused here, before backendFor()/put() ever runs, so the mistake is caught
// at the point it was made — e.g. an operator copy-pasting a push invocation between
// backends (rclone -> file for a quick local test) and forgetting to drop --remote.
// #779: UsageError — a flag-combination refusal is the same "command line itself was
// malformed" class as an unrecognized command/enum value or a missing required flag,
// pure argument validation with no I/O involved.
function assertRemoteRequiresRcloneBackend(o: CliOptions): void {
  if (o.remote === undefined) return;
  if (o.backend === 'rclone') return;
  throw new UsageError(
    `--remote <name>:<path> only applies to --backend rclone (it is the rclone destination "<remote>:<path>" that backend's put() writes to) — ` +
      `this run's --backend is "${o.backend}", which does not read --remote. ` +
      `Use --backend rclone to actually use --remote, or drop --remote if you meant --backend ${o.backend} on its own.`,
  );
}

// #723: --digest <hex> is read by contentDigestFor() above, which has exactly TWO call
// sites — resolveSkipUnchanged()'s own comparison (already unreachable without
// --save-locator, since that function throws its own "requires --save-locator" first)
// and the "if (o.save_locator)" recording block later in this file, which writes
// contentDigestFor()'s result into the save-locator file's content_digest field for a
// LATER --skip-unchanged run to compare against. Both readers require --save-locator —
// given without it, --digest parses fine and is then silently dropped (verified: `push
// --digest <hex> --yes` with no --save-locator produces byte-identical stdout/output to
// the same push without --digest). Same "flag accepted, never honored" bug class
// assertRemoteRequiresRcloneBackend just above already refuses.
//
// Deliberately requires --save-locator, NOT --skip-unchanged (the flag issue #723 itself
// names): `--digest <hex> --save-locator <file>` WITHOUT --skip-unchanged is a real,
// working invocation — it seeds the save-locator file's content_digest for a future
// --skip-unchanged run to compare against, on a push that has no previous locator to
// compare against yet (e.g. the very first push of a foreign, non-cypher-brain-produced
// artifact with no "<in>.digest" sidecar). Requiring --skip-unchanged too would refuse
// that working case for no reason — verified by pushing with exactly this combination
// and reading back the digest --save-locator recorded.
function assertDigestRequiresSaveLocator(o: CliOptions): void {
  if (!o.digest) return;
  if (o.save_locator) return;
  throw new UsageError(
    `--digest <hex> only applies with --save-locator <file> (it becomes the content_digest THIS push records there, read back by a later --skip-unchanged run) — ` +
      `no --save-locator was given, so --digest would otherwise be silently ignored. ` +
      `Add --save-locator <file>, or drop --digest if you did not mean to seed a future --skip-unchanged comparison.`,
  );
}

// #724: the ton/ton-provider backends' own put() already returns a locator with the
// backend name baked in (e.g. "ton:v1:<64-hex>", "ton-provider:v1:<64-hex>" — see
// util.ts's makeBagLocator()), unlike file/arweave/turbo, whose returned locator (a
// content hash / tx id / data item id) carries no such prefix. Every "pushed/pulled ->
// <backend>:<locator>" log line below used to prepend "${backend}:" unconditionally,
// which doubled it for exactly those two backends ("ton:ton:v1:<64-hex>") while staying
// correct for the others. Guard here instead of re-deriving per-backend prefix knowledge
// at each call site: a locator that already starts with "<backend>:" is shown as-is.
function displayLocator(backend: string, locator: string): string {
  const prefix = `${backend}:`;
  return locator.startsWith(prefix) ? locator : `${prefix}${locator}`;
}

// #806: --save-locator's lookup -> pay -> commit sequence, serialized across processes.
//
// Two pushes sharing one --save-locator file used to race in two distinct ways, and one
// lock closes both: with --skip-unchanged they could each read "nothing recorded yet",
// each pay for the same content, and each rewrite the file (the second discarding the
// first's locator); WITHOUT --skip-unchanged the wholesale rewrite at the end of
// pushCoreLocked is still a lost update on its own — the second writer's line replaces
// the first's, so one of the two real, paid-for locators is left recorded nowhere except
// receipt-ledger.jsonl. That is why the lock is taken for EVERY --save-locator push, not
// only the --skip-unchanged ones.
//
// The loser does not have to be told anything special: it waits for the winner inside
// acquirePushLock, and by the time it gets the lock the winner's pointer is already
// committed, so its own resolveSkipUnchanged() below reads it and prints the ordinary
// SKIPPED line. Only a winner still running when that bounded wait expires produces the
// PushLockHeldError refusal (CB-E028) — which costs nothing, unlike paying twice.
//
// Held around the WHOLE of pushCoreLocked rather than started just before the lookup:
// the sequence being protected ends with the save-locator rewrite, and everything
// between is what makes the window wide. Argument validation runs inside it too, which
// is harmless (a UsageError releases the lock on its way out through the `finally`).
//
// writeReplayedSavedLocator() further down takes the SAME lock, for the same reason: it
// is another writer of the same file, and an MCP replay that rewrote it unlocked while a
// push was committing would discard the locator that push had just paid for.
async function pushCore(
  o: CliOptions,
  digestBox?: { value: string | null },
): Promise<{ success: boolean; locator: string | null; sigLocator: string | null }> {
  if (!o.save_locator) return pushCoreLocked(o, digestBox);
  const release = await acquirePushLock('save-locator', await saveLocatorLockKey(o.save_locator));
  try {
    return await pushCoreLocked(o, digestBox);
  } finally {
    await release();
  }
}

async function pushCoreLocked(
  o: CliOptions,
  digestBox?: { value: string | null },
): Promise<{ success: boolean; locator: string | null; sigLocator: string | null }> {
  // #779: a required flag simply being absent is the same UsageError class as above.
  if (!o.in) throw new UsageError('--in <file.age> required');
  if (!o.backend) throw new UsageError('--backend <file|arweave|turbo|rclone|ton> required'); // no silent default
  assertRemoteRequiresRcloneBackend(o); // #655 — see the function's own doc comment (supersedes #658's warn-only version, since a hard refusal here makes that warn path unreachable)
  assertDigestRequiresSaveLocator(o); // #723 — see the function's own doc comment
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
      sizeBytes,
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
    // #639 (ton-provider), extended to arweave/turbo by #797: on EVERY paid backend a
    // signed push spends twice — once for the ciphertext, once for the ".minisig"
    // sidecar — and the per-run cap bounds their SUM (each backend's put() enforces this
    // via the shared spendTracker passed below). So a signed push's pre-consent display
    // must also show the sidecar's own estimate and the combined total, or an operator
    // could consent against a number the actual combined spend goes on to exceed.
    // Best-effort only, same staleness caveat as the ciphertext estimate above: a real,
    // independent price query, not a shared computation with put()'s own.
    if (await exists(`${o.in}.minisig`)) {
      const { size: sigSizeBytes } = await stat(`${o.in}.minisig`);
      const sigEst = await estimateCost(o.backend, sigSizeBytes);
      const secondUnit =
        o.backend === 'ton-provider' ? 'as a SECOND contract' : 'as a SECOND, separately-priced paid upload';
      console.error(
        `${o.backend}: a ".minisig" signature sidecar will ALSO be uploaded, ${secondUnit} — its own cost estimate:`,
      );
      for (const line of formatEstimate(sigEst)) console.error(`  ${line}`);
      if (est.cost !== null && sigEst.cost !== null) {
        const capVar = o.backend === 'ton-provider' ? 'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND' : 'CYPHER_BRAIN_MAX_SPEND';
        console.error(
          `${o.backend}: combined ciphertext+signature spend is checked TOGETHER against ` +
            `${capVar} (≈${BigInt(est.cost) + BigInt(sigEst.cost)} ${sigEst.unit ?? est.unit ?? 'units'} total). ` +
            // Enforcement stays inside each backend's put() (see the block comment above
            // — this early estimate can go stale before signing, and a second
            // enforcement point would have to be kept in sync). The consequence is worth
            // stating out loud rather than leaving the operator to discover it: if this
            // total is over the cap, the ciphertext is uploaded and PAID FOR and the
            // sidecar is then refused, leaving a signed artifact whose signature never
            // reached the store (Codex review).
            `If that total is over your cap, the ciphertext still uploads and the sidecar is then refused — ` +
            `raise ${capVar} or re-snapshot without --sign first if you do not want that.`,
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
  // #232: persist a receipt for the ACTUAL cost a paid backend just charged, separate
  // from estimate.ts's pre-flight forecast printed above. issue #654: called directly
  // FROM INSIDE the backend's onReceipt callback (awaited by the backend itself), not
  // deferred until after backend.put() resolves — a backend calls onReceipt at the
  // moment its spend becomes IRREVERSIBLE, which for ton-provider can be well before
  // put() itself finishes (notifyProviderWithRetry() still has to run afterward, and
  // can still throw). Deferring persistence until put() resolves would silently drop
  // the receipt for exactly that failure shape — the whole point of #654's fix (see
  // backends/ton-provider.ts's own onReceipt call site and its PushFundingConfirmed-
  // ButIncompleteError). A receipt-write failure (disk full, permissions) must NEVER
  // retroactively fail an already-irreversible spend (that would misrepresent it as a
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
  // Same TS narrowing-reset reasoning as `backendName` above: `if (!o.in) throw` at the
  // top of this function does not carry through into the `onReceipt: (event) => ...`
  // closure below (a NEW closure boundary), so `o.in` alone reads back as
  // `string | undefined` there even though it is provably a `string` by this point.
  const inPath = o.in;
  const persistReceipt = async (uploadedPath: string, event: ReceiptEvent): Promise<void> => {
    try {
      const [artifactSha256, payerAddress] = await Promise.all([sha256(uploadedPath), payerAddressFor(backendName, o)]);
      const { size: sizeBytes } = await stat(uploadedPath);
      await appendReceipt({
        timestamp: new Date().toISOString(),
        backend: backendName,
        locator: event.locator,
        artifact_sha256: artifactSha256,
        size_bytes: sizeBytes,
        payer_address: payerAddress,
        cost: event.cost?.amount ?? null,
        unit: event.cost?.unit ?? null,
        raw: event.raw,
      });
    } catch (e) {
      warn(
        `${backendName}: could not persist the upload receipt (${errMsg(e)}) — the underlying spend already happened (locator ${event.locator} is real); cumulative-cost ledger will be missing this entry`,
      );
    }
  };

  // `remote` is only meaningful to the rclone backend (its --remote <name>:<path>
  // destination — types.ts's PutOpts) — every other backend's put() ignores it, same
  // as `yes` is only meaningful to arweave/turbo/ton-provider. `onReceipt` (#232, and
  // #484 for ton-provider, #654 for its locator-aware/async shape) is likewise only
  // ever called by arweave/turbo/ton-provider — every other backend never calls it, so
  // persistReceipt() above is simply never invoked for it. `force` (#533) is likewise
  // rclone-only — its own no-clobber check over an existing --remote object,
  // deliberately the SAME o.force that opted resolveSkipUnchanged() past the digest
  // check above, not a second flag.
  //
  // `spendTracker` (#639, extended to arweave/turbo by #797) — a mutable box passed BY
  // REFERENCE to this call and the ".minisig" sidecar's put() call further down, so each
  // paid backend can enforce its own per-run cap against their COMBINED spend rather than
  // checking each upload in isolation. Free backends ignore it. The two put() calls are
  // strictly sequential (the sidecar's only starts once this one has resolved), which is
  // what the tracker's non-atomic check-then-charge contract requires.
  const spendTracker: SpendTracker = { spent: 0n };
  // #226/TOCTOU fix (multi-model review round 2 — Codex review): read the digest as
  // late as this function can make it — immediately before backend.put() below, the
  // actual point where `o.in`'s bytes are read for upload — rather than any earlier
  // point in this function (argument validation, --plan validation, the paid-backend
  // price estimate's own network round trip, the --yes/CYPHER_BRAIN_YES consent check).
  // All of those can take real time (a network call, a lock wait in pushCore() above),
  // and a digest taken before them describes the artifact as it was at THAT earlier
  // moment, not necessarily what backend.put() is about to actually read. This does not
  // make the two reads atomic — `o.in` could still change in the gap between this read
  // and backend.put()'s own internal read of the same path, since every backend opens
  // the file itself rather than accepting an already-open descriptor or these exact
  // bytes — but it is the closest this function can get without restructuring every
  // backend's put() to accept a pinned descriptor (out of scope for this fix: six
  // separate backend implementations — file/arweave/turbo/rclone/ton/ton-provider —
  // would each need to change how they read their upload source). The gap is not merely
  // theoretical scheduling slack, either (Codex review round 2): rclone.ts's own put()
  // does a remote-object existence probe (an rclone subprocess round trip) before it
  // ever reads `file`, so even THIS backend's own internal steps can widen the window
  // further. Best-effort, same fallback recordAudit() itself used to apply: an --in that
  // fails to hash here is not a NEW failure mode, since backend.put() immediately below
  // would fail the exact same read moments later anyway.
  if (digestBox) digestBox.value = await sha256(o.in).catch(() => null);
  const locator = await backend.put(o.in, {
    yes,
    remote: o.remote,
    force: o.force,
    spendTracker,
    onReceipt: (event) => persistReceipt(inPath, event),
  });
  console.error(`pushed ${o.in} -> ${displayLocator(o.backend, locator)}`);
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
        // #639/#797: the SAME spendTracker reference the ciphertext upload above used —
        // this is what lets the backend see the ciphertext upload's already-committed
        // spend and enforce its cap against the combined total.
        spendTracker,
        onReceipt: (event) => persistReceipt(sigPath, event),
      });
    } catch (e) {
      // issue #654 (Codex review): a signed ton-provider push's SIDECAR deploy can hit
      // the exact same "funding confirmed, notify incomplete" scenario the ciphertext
      // deploy can — ton-provider.ts's put() (called again here, for sigPath) throws
      // its OWN PushFundingConfirmedButIncompleteError in that case. Unconditionally
      // wrapping it as PushSignatureUploadError below would discard that identity
      // entirely: the sidecar's own already-confirmed locator would be lost (this
      // error's own doc comment: `sigLocator` is what a caller needs to hand-record
      // it), and the MCP idempotency classification (mcp.ts's `e instanceof
      // PushFundingConfirmedButIncompleteError` branch) would never fire, misreporting
      // a confirmed on-chain spend as an ordinary signature-upload failure. Re-thrown
      // with the CIPHERTEXT's own locator (matching every other PushPartialSuccessError
      // subclass's convention) and the sidecar's confirmed locator as sigLocator.
      if (e instanceof PushFundingConfirmedButIncompleteError) {
        throw new PushFundingConfirmedButIncompleteError(locator, e, e.locator);
      }
      // #802: the arweave equivalent, and the same reasoning verbatim — the sidecar's own
      // L1 POST can lose its response after the transaction was accepted, so the sidecar
      // ALSO already spent. Wrapping it as PushSignatureUploadError would report a
      // confirmed spend as a plain "the sidecar failed to upload", discard the sidecar's
      // confirmed tx id, and lose the identity mcp.ts classifies on.
      if (e instanceof PushUploadConfirmedResponseLostError) {
        throw new PushUploadConfirmedResponseLostError(locator, e, e.locator);
      }
      // #818: the SIDECAR's own paid step can end ambiguously too (its L1 POST lost its
      // response and the follow-up probe found nothing; its ton-provider deploy broadcast
      // left this process and could not be confirmed). Keeps its own identity rather than
      // being wrapped as PushSignatureUploadError, which would report a possible spend as
      // a plain "the sidecar failed to upload" and discard `checkIdentifier` — the id an
      // operator settles the ambiguity with.
      //
      // But NOT re-thrown untouched (multi-model review, Critical): the CIPHERTEXT above
      // uploaded successfully and its locator is confirmed. Losing it here would make the
      // documented recovery ("verify, then use a NEW key") re-upload — and on a paid
      // backend re-pay for — bytes that are already stored. Relying on push()'s own
      // "pushed <in> -> <locator>" stderr line is not enough: mcp.ts persists and replays
      // the STRUCTURED payload, and that line is not in it.
      if (e instanceof PushUncertainSpendError) throw e.withConfirmedCiphertextLocator(locator);
      // The ciphertext (above) already durably uploaded — see PushPartialSuccessError's
      // own doc comment for why this must never be reported the same way as an
      // ordinary push() failure (a caller assuming "nothing happened" here would be
      // wrong, and an MCP idempotency-key caller must still remember this call as
      // having spent, not treat a retry as the first attempt).
      throw new PushSignatureUploadError(locator, e);
    }
    sigLocator = justUploaded;
    console.error(`pushed ${sigPath} -> ${displayLocator(o.backend, justUploaded)}`);
    // #232: a signed push to a paid backend is TWO separate uploads (ciphertext +
    // sidecar), each its own charge — the sidecar's own onReceipt (above) already
    // persisted its receipt from inside backend.put(), same as the ciphertext's own;
    // without this, the ledger silently understated every signed arweave/turbo push's
    // true total cost (Codex review).
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
      // "signing just got enabled" or "the signing key was rotated". The 8th
      // (elevated-caution review) is the rclone --remote destination this push
      // actually used (empty for every other backend), so the next --skip-unchanged
      // can tell a --remote change apart from an unchanged destination (see
      // resolveSkipUnchanged's own comment for the gap this closes).
      // This is a POSITIONAL format, so a later field can only occupy its slot if the
      // earlier ones exist too — when contentDigest/recipientsFingerprint are
      // themselves missing (an --in not produced by this cypher-brain's own snapshot,
      // e.g. a foreign or pre-digest-era artifact) they're written as empty fields
      // rather than omitted, so the later ones still land in their correct positions
      // instead of silently being dropped (readSavedLocatorLine's positional
      // destructuring reads an empty field as falsy, same as a genuinely-absent one,
      // for --skip-unchanged). Trailing empties are dropped, so an unsigned,
      // non-rclone push still writes exactly the 5-field line it wrote before #214.
      const digest = await sha256(o.in);
      const contentDigest = await contentDigestFor(o);
      const recipientsFingerprint = await recipientsFingerprintFor(o);
      const writtenSigning = sigLocator ? await signingStateFor(o) : null;
      const signKeyId = writtenSigning?.signed ? writtenSigning.keyId : null;
      const remoteField = o.backend === 'rclone' ? (o.remote ?? '') : '';
      const optional = [
        contentDigest ?? '',
        recipientsFingerprint ?? '',
        sigLocator ?? '',
        signKeyId ?? '',
        remoteField,
      ];
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
// `digestBox` (multi-model review round 2 — Codex review): the FIRST version of this
// fix read the digest here, in push(), before calling pushCore() at all — closer to
// pushCore() than recordAudit()'s old reopen-after-everything, but still not close to
// the actual upload: pushCoreLocked() below can spend real time on lock acquisition
// (--save-locator's cross-process lock), a paid backend's own network price query, and
// the --yes/CYPHER_BRAIN_YES consent check between that early read and backend.put()'s
// own — an artifact replaced with different-but-still-valid ciphertext in that window
// would upload the NEW bytes while the audit trail recorded the OLD digest. Moved to
// pushCoreLocked() instead (see its own comment at the digestBox.value assignment,
// right before backend.put()) — this box is how that later-computed value gets back out
// to both recordAudit() calls below, since pushCoreLocked() can throw (a partial
// failure, a signature-upload failure, …) after already setting it.
export async function push(o: CliOptions): Promise<boolean> {
  const startedAt = Date.now();
  const digestBox: { value: string | null } = { value: null };
  try {
    const result = await pushCore(o, digestBox);
    await recordAudit({
      command: 'push',
      o,
      backend: o.backend ?? null,
      locator: result.locator,
      artifactSha256: digestBox.value,
      exitCode: 0,
      startedAt,
    });
    return result.success;
  } catch (e) {
    // #818: PushUncertainSpendError is deliberately NOT a PushPartialSuccessError (see
    // that class's own doc comment), so the branch above alone misses it entirely and
    // records `locator: null` — discarding the one field (confirmedCiphertextLocator)
    // it carries specifically for the case where the CIPHERTEXT upload already
    // succeeded and only the ".minisig" sidecar's spend went ambiguous. The error
    // message and mcp.ts's own idempotency handling already carry this pointer
    // independently, so this only closes the same gap in the audit trail.
    const locator =
      e instanceof PushPartialSuccessError
        ? e.locator
        : e instanceof PushUncertainSpendError
          ? (e.confirmedCiphertextLocator ?? null)
          : null;
    await recordAudit({
      command: 'push',
      o,
      backend: o.backend ?? null,
      locator,
      artifactSha256: digestBox.value,
      exitCode: 1,
      startedAt,
    });
    throw e;
  }
}

// Used only by cypher-brain-mcp's idempotency-key replay path (#220, multi-model review
// P2): a repeat snapshot_now call carrying a DIFFERENT locator_file than the original
// call must still get the recovery pointer written to ITS requested path, even though a
// replay re-uploads nothing. `fields` is deliberately minimal — locator/backend/sha256
// only, NOT the content-digest/recipients-fingerprint/signing/remote fields the full
// save-locator write above derives by re-reading the sidecars next to `o.in` at push
// TIME. Re-deriving those here would mean re-reading whatever currently sits at the
// ORIGINAL call's `out` path, which the idempotency log does not itself vouch is still
// the same file an agent could have since overwritten with something unrelated. The
// three fields in `fields` are exactly the ones the idempotency log already recorded at
// the time of the original successful push, so there is nothing to re-derive or risk
// going stale from THIS function's inputs — but when the target file already records
// the SAME locator (a real push already ran and wrote those richer fields), this does
// NOT discard them: see writeReplayedSavedLocatorLocked's own comment for why a
// downgrade would be its own regression.
export async function writeReplayedSavedLocator(
  savedLocatorPath: string,
  fields: { locator: string; backend: string; sha256: string },
): Promise<void> {
  // #806: this rewrites the same file pushCore's own commit does, so it takes the same
  // lock — a replay that wrote unlocked would be exactly the lost update the lock exists
  // to stop, and an atomic rename prevents a torn file, not a discarded one. If the lock
  // cannot be taken, this REFUSES (CB-E028) rather than writing anyway: the replay itself
  // uploaded and paid nothing, the recorded result stays in the idempotency log, and the
  // caller can retry the same key once the other push finishes — whereas an unlocked
  // write can permanently discard the locator that push just paid for.
  const release = await acquirePushLock('save-locator', await saveLocatorLockKey(savedLocatorPath));
  try {
    // Serializing an unconditional overwrite is not enough on its own: a replay that
    // simply waits its turn and then rewrites the file would still discard a locator a
    // push committed while it waited — the same lost update, just tidier. So the write is
    // CONDITIONAL under the lock: absent, or already naming this same locator, it goes
    // ahead; anything else means this file is now the pointer for a different artifact,
    // and overwriting it would destroy that record.
    const existing = await readSavedLocatorLine(savedLocatorPath);
    if (existing?.locator && existing.locator !== fields.locator) {
      throw new Error(
        `${savedLocatorPath} already records a different locator (${existing.locator}) than this replayed call's ` +
          `(${fields.locator}) — refusing to overwrite it, since nothing about this replay re-uploaded anything. ` +
          'Point locator_file at a path of its own, or remove that file if the record it holds is no longer wanted.',
      );
    }
    // Elevated-caution review, round 2: a matching LOCATOR alone is not sufficient
    // grounds to trust `existing`'s other fields enough to carry them forward — refuse
    // (rather than silently combine two disagreeing records into one) if the same
    // locator is somehow already recorded under a DIFFERENT backend or a DIFFERENT
    // ciphertext sha256 than this replay's own. That combination should be unreachable
    // in ordinary operation (a locator's own schema prefix ties it to one backend, and
    // the same locator string with a different sha would mean two uploads collided on
    // one name), but writeReplayedSavedLocatorLocked's preservation logic below trusts
    // `existing` precisely BECAUSE the locator matched — if backend/sha do not also
    // match, that trust is unfounded, and preserving `existing`'s optional fields
    // alongside `fields`'s own backend/sha would fabricate a record naming a
    // combination that never actually existed.
    if (
      existing &&
      existing.locator === fields.locator &&
      (existing.backend !== fields.backend || existing.sha !== fields.sha256)
    ) {
      throw new Error(
        `${savedLocatorPath} already records locator ${JSON.stringify(fields.locator)} under backend=` +
          `${JSON.stringify(existing.backend)}/sha256=${JSON.stringify(existing.sha)}, which does not match this ` +
          `replayed call's backend=${JSON.stringify(fields.backend)}/sha256=${JSON.stringify(fields.sha256)} — ` +
          'refusing to combine the two into one record. This should not happen under normal operation; inspect ' +
          'the file by hand.',
      );
    }
    await writeReplayedSavedLocatorLocked(savedLocatorPath, fields, existing);
  } finally {
    await release();
  }
}

async function writeReplayedSavedLocatorLocked(
  savedLocatorPath: string,
  fields: { locator: string; backend: string; sha256: string },
  existing: SavedLocator | null,
): Promise<void> {
  await mkdir(dirname(resolve(savedLocatorPath)), { recursive: true });
  // Elevated-caution review: a replay whose locator MATCHES what is already recorded
  // (the only case reaching this point — the caller above already refused a mismatch)
  // must not DOWNGRADE richer metadata a real push already wrote here. content_digest/
  // recipients_fingerprint/sig_locator/sign_key_id/remote are exactly what a later
  // --skip-unchanged run compares against (resolveSkipUnchanged above), and this
  // replay uploaded nothing new to re-derive them from — see this function's own doc
  // comment for why they are not re-derived here. Truncating the line back down to 3
  // bare fields would silently discard that optimization (and, for a signed/rclone
  // push, force an unnecessary and possibly PAID re-push the next time --skip-
  // unchanged runs) even though nothing about the underlying push actually changed.
  const preserved =
    existing?.locator === fields.locator
      ? [
          existing.contentDigest ?? '',
          existing.recipientsFingerprint ?? '',
          existing.sigLocator ?? '',
          existing.signKeyId ?? '',
          existing.remote ?? '',
        ]
      : [];
  while (preserved.length > 0 && preserved[preserved.length - 1] === '') preserved.pop();
  const allFields = [fields.locator, fields.backend, fields.sha256, ...preserved];
  const tmp = `${savedLocatorPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${allFields.join('\t')}\n`, { flag: 'w' });
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
  // #779: required-flag-missing is the same UsageError class as pushCore()'s own
  // --in/--backend checks above.
  if (!o.backend) throw new UsageError('--backend <file|arweave|turbo|rclone|ton> required');
  // #677: reciprocal of push's own #655 refusal (assertRemoteRequiresRcloneBackend,
  // above) — pull's rclone-locator shortcut just above only CONSUMES --remote when
  // --backend IS rclone; for every other backend it was silently dropped with zero
  // signal (e.g. an operator copy-pasting a push invocation, or a leftover --remote
  // after switching --backend for local testing). Placed FIRST among pull's required-
  // flag checks — right after the --backend-required check above, so o.backend is
  // guaranteed defined here (mirroring pushCore's placement of the same call right
  // after ITS --backend-required check) — and before --locator/--out below, so a
  // --remote/--backend mismatch is always refused with the specific, actionable
  // message, never masked by a generic "--locator required"/"--out required" error
  // when those are ALSO missing. --locator is still checked before --out, preserving
  // their original relative order (unrelated to this fix) for every other case.
  assertRemoteRequiresRcloneBackend(o);
  if (!o.locator)
    throw new UsageError('--locator <id> required (or --from-locator-file <path>, or --remote for rclone)');
  if (!o.out) throw new UsageError('--out <file.age> required');
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
  console.error(`pulled ${displayLocator(o.backend, o.locator)} -> ${o.out}`);
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
        console.error(`pulled ${displayLocator(o.backend, o.sig_locator)} -> ${sigOut}`);
      } catch (e) {
        console.error(
          `warning: could not fetch the authenticity signature (${displayLocator(o.backend, o.sig_locator)} -> ${sigOut}): ${errMsg(e)}`,
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
