// Terraform-style plan/apply for paid pushes (#231): `estimate --out <plan.json>`
// pins down what a push would cost and against what artifact/backend/payer/remote, and
// `push --plan <plan.json>` re-validates that plan against the CURRENT state before
// proceeding — refusing on a mismatch instead of silently spending against stale
// numbers. This is an ADDITIONAL gate, not a replacement for the existing --yes/
// CYPHER_BRAIN_YES consent check: a validated plan still has to clear that gate too,
// exactly as an unplanned push does (pushpull.ts's own consent logic is untouched).
//
// Two honest limits on what this guarantees (Codex review, #231):
// 1. Trust boundary: a plan.json is a plain, unsigned local file — anyone who can edit
//    it (or skip --plan and push unplanned) has the same access as the operator's own
//    wallet/identity key files already sitting on disk. This is a strict-CONSISTENCY
//    check against accidental drift (an old plan, a moved artifact, a price swing, a
//    changed wallet), not a cryptographic authenticity guarantee against a local
//    attacker who can already read those keys.
// 2. TOCTOU: validation happens once, right before push()'s own paid-backend estimate
//    display and the --yes/CYPHER_BRAIN_YES check — both effectively instantaneous, no
//    interactive wait — but backend.put() (arweave.ts/turbo.ts) still runs its OWN
//    independent, authoritative price query moments later, same as it always has.
//    CYPHER_BRAIN_MAX_SPEND, enforced INSIDE put(), remains the sole hard cap on actual
//    spend (#105) — --plan narrows what price/identity was reviewed, it does not
//    replace that final backstop.
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CostEstimate } from './estimate.js';
import { errMsg, sameWalletAddress } from './util.js';

export const PLAN_VERSION = 1;

// Mirrors pushpull.ts's own private recipientsFingerprintFor exactly, as a second,
// tiny copy rather than a shared import: pushpull.ts statically imports estimate.ts
// (for estimateCost/formatEstimate), and this is needed at PLAN-BUILD time (inside
// estimate.ts's `estimate()`), so importing pushpull.ts's version back from there
// would be circular — the same tradeoff wallet.ts's payerAddressFor doc comment
// describes, and estimate.ts's own existing tonWalletConfigured() inline already
// makes elsewhere in this codebase. Never throws: a missing/unreadable sidecar just
// means "unknown", recorded as null — informational only (see PushPlan's own field
// comment for why this is never re-gated on at apply time).
export async function readRecipientsFingerprint(inPath: string): Promise<string | null> {
  try {
    const line = (await readFile(`${inPath}.recipients-fingerprint`, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#'));
    return line ? line.toLowerCase() : null;
  } catch {
    return null;
  }
}

// How long a plan stays valid after creation. Not configurable in v1 — long enough
// to actually review the plan before applying it, short enough that a plan left
// lying around doesn't quietly authorize a much-later price. Revisit via a
// dedicated flag if a real workflow needs a different window.
export const PLAN_DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

// How much the re-checked cost is allowed to differ from the planned cost before
// `push --plan` refuses and asks for a fresh plan. A plain relative tolerance on the
// native-unit cost — deliberately not backend-specific, since every backend's
// estimate is already priced in ITS OWN native unit by the time this compares two
// numbers from the SAME backend (the plan/current backend match is checked first).
export const PLAN_DRIFT_TOLERANCE = 0.1; // 10%

export interface PushPlan {
  cypher_brain_plan_version: typeof PLAN_VERSION;
  backend: string;
  artifact_sha256: string;
  size_bytes: number;
  // Informational only, carried through for audit — NOT re-checked independently at
  // apply time. Once artifact_sha256 matches, the recipients it was encrypted to are
  // implied by those exact bytes; re-gating on this field would only ever agree with
  // (or, if it somehow disagreed, contradict) the sha256 check, never add a real guarantee.
  recipients_fingerprint: string | null;
  // Best-effort: the wallet/address that would pay, if one was configured when the
  // plan was built (null when none was — e.g. planning before funding a wallet).
  payer_address: string | null;
  // The backend-specific execution target, when the backend has one (rclone's --remote
  // <name>:<path>; null for every other backend — none of them take a destination
  // selector). Only the backend NAME is meaningful to compare for file/arweave/turbo/
  // ton/ton-provider (Codex review, #231): without this field, a plan validated for
  // one rclone remote could silently apply against a DIFFERENT one — same backend name,
  // different execution target than what was reviewed.
  remote: string | null;
  estimate: CostEstimate;
  created_at: string; // ISO 8601
  expires_at: string; // ISO 8601, created_at + PLAN_DEFAULT_TTL_MS
}

export function buildPlan(args: {
  backend: string;
  artifactSha256: string;
  sizeBytes: number;
  recipientsFingerprint: string | null;
  payerAddress: string | null;
  remote: string | null;
  estimate: CostEstimate;
  now?: Date; // test hook — real callers omit this and get the actual clock
}): PushPlan {
  const now = args.now ?? new Date();
  return {
    cypher_brain_plan_version: PLAN_VERSION,
    backend: args.backend,
    artifact_sha256: args.artifactSha256,
    size_bytes: args.sizeBytes,
    recipients_fingerprint: args.recipientsFingerprint,
    payer_address: args.payerAddress,
    remote: args.remote,
    estimate: args.estimate,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + PLAN_DEFAULT_TTL_MS).toISOString(),
  };
}

// Atomic write (tmp + rename), same pattern push()'s own --save-locator uses
// (pushpull.ts) — a crash/ENOSPC mid-write must never leave a half-written plan
// file that a later `push --plan` could misread as valid.
export async function writePlanFile(path: string, plan: PushPlan): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'w' });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

// Parses and shape-checks a plan file. Deliberately strict — a plan is a consent
// artifact, not a casual config file, so a malformed or foreign-shaped one refuses
// outright rather than silently proceeding with `undefined` fields.
export async function readPlanFile(path: string): Promise<PushPlan> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    throw new Error(`--plan ${path}: cannot read plan file: ${errMsg(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`--plan ${path}: not valid JSON: ${errMsg(e)}`);
  }
  const p = parsed as Partial<PushPlan> | null;
  if (
    !p ||
    typeof p !== 'object' ||
    p.cypher_brain_plan_version !== PLAN_VERSION ||
    typeof p.backend !== 'string' ||
    typeof p.artifact_sha256 !== 'string' ||
    typeof p.size_bytes !== 'number' ||
    typeof p.created_at !== 'string' ||
    typeof p.expires_at !== 'string' ||
    typeof p.estimate !== 'object' ||
    p.estimate === null
  ) {
    throw new Error(
      `--plan ${path}: does not look like a cypher-brain plan file (created by "estimate --out <path>") — ` +
        `missing or wrong-typed required field(s)`,
    );
  }
  // Internal consistency, not tamper-proofing (plan.ts's header comment documents the
  // real trust boundary): expires_at must be exactly created_at + PLAN_DEFAULT_TTL_MS,
  // the same relationship buildPlan() always produces. This catches a naive edit (only
  // expires_at bumped to push the deadline out) without requiring signing — Codex review.
  const expectedExpiry = new Date(new Date(p.created_at).getTime() + PLAN_DEFAULT_TTL_MS).toISOString();
  if (Number.isNaN(new Date(p.created_at).getTime()) || p.expires_at !== expectedExpiry) {
    throw new Error(
      `--plan ${path}: created_at/expires_at are inconsistent (expected expires_at = created_at + ${PLAN_DEFAULT_TTL_MS}ms) — ` +
        `this plan was not produced by "estimate --out" or has been edited, re-run "estimate --out" for a fresh one`,
    );
  }
  return {
    cypher_brain_plan_version: PLAN_VERSION,
    backend: p.backend,
    artifact_sha256: p.artifact_sha256,
    size_bytes: p.size_bytes,
    recipients_fingerprint: typeof p.recipients_fingerprint === 'string' ? p.recipients_fingerprint : null,
    payer_address: typeof p.payer_address === 'string' ? p.payer_address : null,
    remote: typeof p.remote === 'string' ? p.remote : null,
    estimate: p.estimate as CostEstimate,
    created_at: p.created_at,
    expires_at: p.expires_at,
  };
}

export type PlanValidation = { ok: true } | { ok: false; reason: string };

// Re-validates a plan against the state a real push is about to act on. Every check
// here is a REFUSAL on mismatch/uncertainty, never a warning — the whole point of
// --plan is a stricter guarantee than the existing --yes gate, so "probably still
// fine" is not good enough. Returns a reason string rather than throwing so the
// caller (push()) can format it consistently with its other refusal messages.
// Every CostEstimate.cost this codebase ever produces is either null ("unavailable",
// an estimate.ts *_estimate: never a deliberate "free" signal — file/rclone/ton all use
// the literal string "0") or a plain non-negative base-10 integer string (estimate.ts's
// arweave branch regex-validates its own; ton-provider's is a bigint's .toString();
// turbo's comes from the SDK unvalidated). validatePlan defends against BOTH a
// hand-edited plan.json AND an SDK quirk producing something BigInt() can't parse —
// Codex review: an uncaught throw here would crash push() instead of cleanly refusing.
const COST_PATTERN = /^\d+$/;

export function validatePlan(
  plan: PushPlan,
  current: {
    backend: string;
    artifactSha256: string;
    freshEstimate: CostEstimate;
    payerAddress: string | null;
    remote: string | null;
    now?: Date; // test hook
  },
): PlanValidation {
  if (plan.backend !== current.backend) {
    return {
      ok: false,
      reason: `plan is for backend "${plan.backend}", this push targets "${current.backend}" — re-run "estimate --out" for the backend you actually intend to push to`,
    };
  }
  if (plan.artifact_sha256 !== current.artifactSha256) {
    return {
      ok: false,
      reason: `plan was built for a different artifact (sha256 ${plan.artifact_sha256}), --in now hashes to ${current.artifactSha256} — re-run "estimate --out" against the artifact you are actually pushing`,
    };
  }
  const now = current.now ?? new Date();
  const expiresAt = new Date(plan.expires_at);
  // >= (not >): a plan is treated as expired AT its exact expiry instant, not one
  // moment after (Codex review — a boundary nit, but "strictly" only holds if the
  // boundary itself is closed).
  if (Number.isNaN(expiresAt.getTime()) || now.getTime() >= expiresAt.getTime()) {
    return {
      ok: false,
      reason: `plan expired at ${plan.expires_at} (now: ${now.toISOString()}) — re-run "estimate --out" for a fresh one`,
    };
  }
  if (plan.estimate.cost === null || current.freshEstimate.cost === null) {
    return {
      ok: false,
      reason:
        'cannot confirm the price has not drifted — the plan or the current cost estimate is unavailable ' +
        `(planned: ${plan.estimate.cost ?? 'unavailable'}, current: ${current.freshEstimate.cost ?? 'unavailable'})`,
    };
  }
  if (!COST_PATTERN.test(plan.estimate.cost) || !COST_PATTERN.test(current.freshEstimate.cost)) {
    return {
      ok: false,
      reason:
        'cannot confirm the price has not drifted — a recorded cost is not a plain non-negative integer ' +
        `(planned: ${JSON.stringify(plan.estimate.cost)}, current: ${JSON.stringify(current.freshEstimate.cost)})`,
    };
  }
  if (plan.estimate.unit !== current.freshEstimate.unit) {
    return {
      ok: false,
      reason: `plan's cost unit "${plan.estimate.unit}" does not match the current unit "${current.freshEstimate.unit}" — re-run "estimate --out"`,
    };
  }
  const planned = BigInt(plan.estimate.cost);
  const fresh = BigInt(current.freshEstimate.cost);
  if (planned > 0n) {
    const diff = fresh > planned ? fresh - planned : planned - fresh;
    // Integer-safe relative comparison (diff/planned > tolerance), avoiding a
    // float division that could misround at the huge native-unit magnitudes these
    // costs are expressed in (winc/winston/nanoTON, routinely > 1e9).
    const toleranceMilli = BigInt(Math.round(PLAN_DRIFT_TOLERANCE * 1000));
    if (diff * 1000n > planned * toleranceMilli) {
      const pct = (Number(diff) / Number(planned)) * 100;
      return {
        ok: false,
        reason:
          `price drifted ${pct.toFixed(1)}% since the plan was made (planned: ${plan.estimate.cost} ` +
          `${plan.estimate.unit ?? ''}, now: ${current.freshEstimate.cost} ${current.freshEstimate.unit ?? ''}) — ` +
          `exceeds the ${(PLAN_DRIFT_TOLERANCE * 100).toFixed(0)}% tolerance, re-run "estimate --out" for a fresh plan`,
      };
    }
  } else if (fresh !== 0n) {
    // planned cost was exactly 0 (a free backend, or a genuinely free-tier price) —
    // any nonzero current cost is by definition more than a 10%-of-zero tolerance
    // could ever express, so this is handled as its own branch rather than a
    // division by zero.
    return {
      ok: false,
      reason: `plan was for a free push (cost 0), current cost is ${current.freshEstimate.cost} ${current.freshEstimate.unit ?? ''} — re-run "estimate --out" for a fresh plan`,
    };
  }
  // Every combination except "both null" (never configured, either time — nothing to
  // compare) and "both non-null and equal" is a refusal. Comparing ONLY when both sides
  // are non-null (the original logic) let either direction of null<->address silently
  // pass — including a plan built with NO payer configured being applied against a
  // NOW-configured wallet with zero scrutiny, while still printing a success message
  // that claimed the payer matched (Codex review — a real bypass, not just a nit).
  if (plan.payer_address === null && current.payerAddress !== null) {
    return {
      ok: false,
      reason: `plan was built with no payer configured, the current push has payer ${current.payerAddress} — re-run "estimate --out" with that wallet configured so the plan actually reviews it`,
    };
  }
  if (plan.payer_address !== null && current.payerAddress === null) {
    return {
      ok: false,
      reason: `plan was built for payer ${plan.payer_address}, the current push has no payer configured — re-run "estimate --out" (or reconfigure the wallet you intend to pay from)`,
    };
  }
  if (
    plan.payer_address !== null &&
    current.payerAddress !== null &&
    !sameWalletAddress(plan.payer_address, current.payerAddress)
  ) {
    return {
      ok: false,
      reason: `plan was built for payer ${plan.payer_address}, the current configured payer is ${current.payerAddress} — re-run "estimate --out" with the wallet you actually intend to pay from`,
    };
  }
  // Same null-handling philosophy as payer_address above, but a plain string-equality
  // compare (remote is an opaque rclone destination string, not a wallet address with
  // case-folding rules) — Codex review: only the backend NAME was pinned before this,
  // so a plan validated for one rclone --remote could silently apply against another.
  if (plan.remote !== current.remote) {
    return {
      ok: false,
      reason: `plan was built for --remote ${JSON.stringify(plan.remote)}, this push targets ${JSON.stringify(current.remote)} — re-run "estimate --out" for the remote you actually intend to push to`,
    };
  }
  return { ok: true };
}
