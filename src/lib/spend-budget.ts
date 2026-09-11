// Cumulative spend admission (#907), separate from spend-tracker.ts's single-push cap.
// Like pending-spend.ts: append-only, fsync'd intent BEFORE a paid action; last line
// for an id wins. Receipts replace resolved reservations; uncertain/crashed uploads
// remain open indefinitely, even across UTC day/month boundaries.
//
// KNOWN LIMITATION: single-machine only, with all callers using the SAME receipt
// ledger and sidecar paths on a local filesystem. This is not a shared authority
// across machines, separate ledgers, hard-link aliases, or cloud-synced copies.
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import {
  RECEIPT_LEDGER,
  AR_MAX_SPEND,
  AR_MAX_SPEND_DAILY,
  AR_MAX_SPEND_MONTHLY,
  AR_MAX_SPEND_ERROR,
  AR_MAX_SPEND_DAILY_ERROR,
  AR_MAX_SPEND_MONTHLY_ERROR,
  TON_PROVIDER_MAX_SPEND,
  TON_PROVIDER_MAX_SPEND_DAILY,
  TON_PROVIDER_MAX_SPEND_MONTHLY,
  TON_PROVIDER_MAX_SPEND_ERROR,
  TON_PROVIDER_MAX_SPEND_DAILY_ERROR,
  TON_PROVIDER_MAX_SPEND_MONTHLY_ERROR,
} from './config.js';
import { newLockToken, releaseLockFileIfOwned } from './idempotency.js';
import { readReceipts, type ReceiptEntry } from './receipt.js';
import { fsyncPath, readJsonlLog, syncDirectoryChain, sleep, errMsg } from './util.js';
import { warn } from './warn.js';

export const SPEND_BUDGET_LOG = `${RECEIPT_LEDGER}.spend-budget.jsonl`;
export const SPEND_BUDGET_LOCK = `${SPEND_BUDGET_LOG}.lock`;
type UnitFamily = 'ar' | 'ton-provider';
type ReservationState = 'open' | 'settled' | 'abandoned';
export interface BudgetReservation {
  cypher_brain_spend_budget_version: 1;
  reservation_id: string;
  state: ReservationState;
  timestamp: string;
  updated_at: string;
  backend: string;
  amount: string;
}

function familyFor(backend: string): UnitFamily | null {
  return backend === 'arweave' || backend === 'turbo' ? 'ar' : backend === 'ton-provider' ? 'ton-provider' : null;
}

// Reuse idempotency.ts's exclusive-create/ownership-token discipline. Unlike
// push-lock.ts we NEVER steal an old/dead lock: racing stale-lock recovery can let
// two owners in, which is unacceptable for a hard cumulative cap. A crash during
// this short critical section requires an operator to remove the lock with ALL
// writers stopped. The lock lives beside the ledger, so different HOME settings
// sharing one ledger still serialize. No network work is performed while holding it.
async function withBudgetLock<T>(run: () => Promise<T>): Promise<T> {
  const dir = dirname(SPEND_BUDGET_LOG);
  const firstCreated = await mkdir(dir, { recursive: true });
  await syncDirectoryChain(dir, firstCreated);
  const token = newLockToken();
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await writeFile(SPEND_BUDGET_LOCK, token, { flag: 'wx', mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
      if (Date.now() >= deadline) {
        throw new Error(
          `spend budget is locked at ${SPEND_BUDGET_LOCK} — retry after the other caller finishes; ` +
            'if it crashed, stop all writers before removing ONLY this lock (keep the reservations)',
        );
      }
      await sleep(25);
    }
  }
  try {
    return await run();
  } finally {
    await releaseLockFileIfOwned(SPEND_BUDGET_LOCK, token);
    if ((await readFile(SPEND_BUDGET_LOCK, 'utf8').catch(() => null)) === token) {
      warn(`could not release spend-budget lock ${SPEND_BUDGET_LOCK}; stop all writers before removing it`);
    }
  }
}

async function appendReservation(record: BudgetReservation): Promise<void> {
  const dir = dirname(SPEND_BUDGET_LOG);
  const firstCreated = await mkdir(dir, { recursive: true });
  const fh = await open(SPEND_BUDGET_LOG, 'a');
  try {
    await fh.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncDirectoryChain(dir, firstCreated);
}

export async function readBudgetReservations(): Promise<{ reservations: BudgetReservation[]; skippedLines: number }> {
  const { items, skippedLines } = await readJsonlLog<BudgetReservation>(
    SPEND_BUDGET_LOG,
    'spend-budget log',
    (parsed) => {
      const p = parsed as Partial<BudgetReservation> | null;
      if (
        p?.cypher_brain_spend_budget_version !== 1 ||
        typeof p.reservation_id !== 'string' ||
        !p.reservation_id ||
        !['open', 'settled', 'abandoned'].includes(p.state ?? '') ||
        typeof p.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(p.timestamp)) ||
        typeof p.updated_at !== 'string' ||
        !Number.isFinite(Date.parse(p.updated_at)) ||
        typeof p.backend !== 'string' ||
        familyFor(p.backend) === null ||
        typeof p.amount !== 'string' ||
        !/^\d+$/.test(p.amount)
      )
        return null;
      return p as BudgetReservation;
    },
  );
  const folded = new Map<string, BudgetReservation>();
  for (const item of items) folded.set(item.reservation_id, item);
  return { reservations: [...folded.values()], skippedLines };
}

function pricedReceipt(receipt: ReceiptEntry): bigint {
  const expected =
    receipt.backend === 'arweave' ? ['winston'] : receipt.backend === 'turbo' ? ['winc'] : ['nanoTON', 'nanoton'];
  if (receipt.cost === null || !/^\d+$/.test(receipt.cost) || !expected.includes(receipt.unit ?? '')) {
    throw new Error(
      `spend budget cannot price receipt ${receipt.locator} in ${RECEIPT_LEDGER}; reconcile it before pushing`,
    );
  }
  return BigInt(receipt.cost);
}

/** Reserve the backend's enforced upper bound before put(), or do nothing when disabled/free. */
export async function reserveSpendBudget(backend: string, spentThisPush: bigint): Promise<BudgetReservation | null> {
  const family = familyFor(backend);
  if (family === null) return null;
  const ton = family === 'ton-provider';
  const errors = ton
    ? [TON_PROVIDER_MAX_SPEND_ERROR, TON_PROVIDER_MAX_SPEND_DAILY_ERROR, TON_PROVIDER_MAX_SPEND_MONTHLY_ERROR]
    : [AR_MAX_SPEND_ERROR, AR_MAX_SPEND_DAILY_ERROR, AR_MAX_SPEND_MONTHLY_ERROR];
  for (const error of errors) if (error) throw error;
  const daily = ton ? TON_PROVIDER_MAX_SPEND_DAILY : AR_MAX_SPEND_DAILY;
  const monthly = ton ? TON_PROVIDER_MAX_SPEND_MONTHLY : AR_MAX_SPEND_MONTHLY;
  if (daily === 0n && monthly === 0n) return null;
  const cap = ton ? TON_PROVIDER_MAX_SPEND : AR_MAX_SPEND;
  const env = ton ? 'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND' : 'CYPHER_BRAIN_MAX_SPEND';
  // Prices are computed INSIDE put(), and the earlier display estimate can go stale.
  // Reserve the remaining single-push cap instead; each backend already enforces it.
  // A zero/unset cap supplies no finite upper bound, so fail closed when cumulative
  // limits are enabled. This can conservatively refuse a cheaper upload; no second
  // price calculation or change to SpendTracker's per-push behavior is needed.
  if (cap <= 0n)
    throw new Error(`spend budget requires a positive ${env} upper bound when daily/monthly caps are enabled`);
  const amount = cap > spentThisPush ? cap - spentThisPush : 0n;
  return withBudgetLock(async () => {
    const { receipts, skippedLines } = await readReceipts();
    const log = await readBudgetReservations();
    if (skippedLines || log.skippedLines) {
      throw new Error(
        'spend budget cannot verify totals: unreadable receipt/reservation lines; reconcile the logs before pushing',
      );
    }
    const now = new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const dayEnd = dayStart + 86_400_000;
    const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    let daySpent = 0n;
    let monthSpent = 0n;
    for (const receipt of receipts) {
      if (familyFor(receipt.backend) !== family) continue;
      const timestamp = Date.parse(receipt.timestamp);
      if (!Number.isFinite(timestamp)) throw new Error(`spend budget cannot date receipt ${receipt.locator}`);
      const inDay = timestamp >= dayStart && timestamp < dayEnd;
      const inMonth = timestamp >= monthStart && timestamp < monthEnd;
      if (!(daily > 0n && inDay) && !(monthly > 0n && inMonth)) continue;
      const cost = pricedReceipt(receipt);
      if (inDay) daySpent += cost;
      if (inMonth) monthSpent += cost;
    }
    const open = log.reservations
      .filter((r) => r.state === 'open' && familyFor(r.backend) === family)
      .reduce((sum, r) => sum + BigInt(r.amount), 0n);
    for (const [period, cap, spent] of [
      ['DAILY', daily, daySpent],
      ['MONTHLY', monthly, monthSpent],
    ] as const) {
      if (cap > 0n && spent + open + amount > cap) {
        throw new Error(
          `${backend}: upload exceeds ${env}_${period}=${cap} — UTC ${period.toLowerCase()} receipts ${spent} + ` +
            `open reservations ${open} + requested reservation ${amount}; no upload started. ` +
            `Unresolved reservations in ${SPEND_BUDGET_LOG} keep counting until reconciled`,
        );
      }
    }
    const timestamp = now.toISOString();
    const record: BudgetReservation = {
      cypher_brain_spend_budget_version: 1,
      reservation_id: randomBytes(16).toString('hex'),
      state: 'open',
      timestamp,
      updated_at: timestamp,
      backend,
      amount: amount.toString(),
    };
    await appendReservation(record);
    return record;
  });
}

/**
 * Only after a durable, priced receipt, or a known no-spend outcome. A failed update
 * leaves the open record counting; never convert a paid success to a retryable error.
 */
export async function resolveSpendBudget(
  reservation: BudgetReservation | null,
  state: 'settled' | 'abandoned',
): Promise<void> {
  if (!reservation) return;
  try {
    await withBudgetLock(async () => {
      if (state === 'settled') await fsyncPath(RECEIPT_LEDGER);
      await appendReservation({ ...reservation, state, updated_at: new Date().toISOString() });
    });
  } catch (e) {
    warn(
      `spend-budget reservation ${reservation.reservation_id} remains open (${errMsg(e)}); reconcile ${SPEND_BUDGET_LOG}`,
    );
  }
}

export interface SpendUsage {
  /** Which admission-control family this reflects — 'ar' covers BOTH arweave and turbo (they share one cap); 'ton-provider' is separate. */
  family: UnitFamily;
  /** Receipted (settled) spend within the current UTC calendar day, in the family's native unit (winc/winston are pegged 1:1; nanoTON for ton-provider). */
  daySpent: bigint;
  /** Receipted spend within the current UTC calendar month. */
  monthSpent: bigint;
  /** Sum of currently-OPEN (unresolved) reservations for this family — counts against BOTH windows, same as reserveSpendBudget()'s own admission check. */
  openReservations: bigint;
  /** True when a receipt or reservation line was unreadable, or a receipt could not be priced — daySpent/monthSpent/openReservations may UNDERCOUNT actual spend. */
  degraded: boolean;
}

/**
 * Read-only cumulative-spend usage snapshot for `backend`'s admission-control family
 * (#925/#927): how much has been receipted today/this UTC calendar month, plus any
 * still-open reservations — WITHOUT reserving or writing anything, unlike
 * reserveSpendBudget() (which reserves the remaining per-push cap as a side effect).
 * Shares the exact fold/date-window logic reserveSpendBudget() uses above (same UTC
 * day/month boundaries, same "open reservations count against both windows" rule), so a
 * totals-and-caps view (doctor, estimate) can never disagree with what a real push's
 * admission check would compute.
 *
 * Returns null when `backend` has no admission-control family at all (file/rclone/ton)
 * OR when neither family's daily nor monthly cap is configured — mirroring
 * reserveSpendBudget()'s own no-op posture for those two cases, so callers never have to
 * re-derive that decision themselves.
 *
 * Deliberately more lenient than reserveSpendBudget() on bad data: that function fails
 * CLOSED (an unreadable line, or a receipt it cannot price, aborts the whole admission
 * check) because it is gating a REAL spend. This is a passive report with no gate to
 * fail closed on, so it instead sets `degraded: true` and keeps folding whatever it CAN
 * read — the same "warn, do not fail" posture doctor.ts's own receipt-ledger-readability
 * check already takes for the identical class of problem (an unreadable ledger line).
 */
export async function getSpendUsage(backend: string): Promise<SpendUsage | null> {
  const family = familyFor(backend);
  if (family === null) return null;
  const ton = family === 'ton-provider';
  const daily = ton ? TON_PROVIDER_MAX_SPEND_DAILY : AR_MAX_SPEND_DAILY;
  const monthly = ton ? TON_PROVIDER_MAX_SPEND_MONTHLY : AR_MAX_SPEND_MONTHLY;
  if (daily === 0n && monthly === 0n) return null;
  const { receipts, skippedLines: receiptsSkipped } = await readReceipts();
  const log = await readBudgetReservations();
  let degraded = receiptsSkipped > 0 || log.skippedLines > 0;
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const dayEnd = dayStart + 86_400_000;
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  let daySpent = 0n;
  let monthSpent = 0n;
  for (const receipt of receipts) {
    if (familyFor(receipt.backend) !== family) continue;
    const timestamp = Date.parse(receipt.timestamp);
    if (!Number.isFinite(timestamp)) {
      degraded = true;
      continue;
    }
    const inDay = timestamp >= dayStart && timestamp < dayEnd;
    const inMonth = timestamp >= monthStart && timestamp < monthEnd;
    if (!(daily > 0n && inDay) && !(monthly > 0n && inMonth)) continue;
    let cost: bigint;
    try {
      cost = pricedReceipt(receipt);
    } catch {
      degraded = true;
      continue;
    }
    if (inDay) daySpent += cost;
    if (inMonth) monthSpent += cost;
  }
  const openReservations = log.reservations
    .filter((r) => r.state === 'open' && familyFor(r.backend) === family)
    .reduce((sum, r) => sum + BigInt(r.amount), 0n);
  return { family, daySpent, monthSpent, openReservations, degraded };
}
