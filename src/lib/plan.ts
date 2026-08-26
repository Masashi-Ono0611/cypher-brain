// Terraform-style plan/apply for paid pushes (#231): `estimate --out <plan.json>`
// pins down what a push would cost and against what artifact/backend/payer, and
// `push --plan <plan.json>` re-validates that plan against the CURRENT state before
// proceeding — so what an operator (or an unattended CI/MCP caller) reviewed is
// provably the same thing that executes, even if time passed and the price moved in
// between. This is an ADDITIONAL gate, not a replacement for the existing --yes/
// CYPHER_BRAIN_YES consent check: a validated plan still has to clear that gate too,
// exactly as an unplanned push does (pushpull.ts's own consent logic is untouched).
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
  return {
    cypher_brain_plan_version: PLAN_VERSION,
    backend: p.backend,
    artifact_sha256: p.artifact_sha256,
    size_bytes: p.size_bytes,
    recipients_fingerprint: typeof p.recipients_fingerprint === 'string' ? p.recipients_fingerprint : null,
    payer_address: typeof p.payer_address === 'string' ? p.payer_address : null,
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
export function validatePlan(
  plan: PushPlan,
  current: {
    backend: string;
    artifactSha256: string;
    freshEstimate: CostEstimate;
    payerAddress: string | null;
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
  if (Number.isNaN(expiresAt.getTime()) || now.getTime() > expiresAt.getTime()) {
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
  return { ok: true };
}
