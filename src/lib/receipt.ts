// Persist a "receipt" — the ACTUAL storage-provider response for a completed paid
// push — separately from estimate.ts's pre-flight forecast (#232). Turbo's official
// receipt-persistence recommendation (https://docs.ar.io/build/upload/receipts/) is to
// keep the SDK's raw upload response as-is; the raw arweave L1 backend has no such
// SDK-provided receipt object, so this records the actually-signed tx reward instead —
// the one real cost figure that backend produces. estimate.ts's CostEstimate stays what
// it always was, a forecast: this module never reads it, and validatePlan/estimateCost
// never read this one, so a forecast and an actual can never be silently conflated.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RECEIPT_LEDGER } from './config.js';

export const RECEIPT_VERSION = 1;

export interface ReceiptEntry {
  cypher_brain_receipt_version: typeof RECEIPT_VERSION;
  timestamp: string; // ISO 8601 — when the receipt was appended, right after a successful put()
  backend: string; // 'arweave' | 'turbo' today — the only backends that spend real money
  locator: string; // what push() returned/printed for this upload (tx id / data item id)
  artifact_sha256: string;
  size_bytes: number;
  payer_address: string | null; // best-effort, same lookup plan.ts's payerAddressFor uses
  cost: string | null; // ACTUAL native-unit cost paid (winston/winc), null if the backend
  // could not name one for this upload (never a forecast — that is estimate.ts's job)
  unit: 'winston' | 'winc' | null;
  raw: unknown; // the backend's own response object, persisted AS-IS — never reshaped
}

// A single JSON-line append. POSIX O_APPEND makes a write up to PIPE_BUF (commonly
// 4KiB+ — comfortably more than one of these lines) atomic against concurrent
// appenders, so no lock or read-modify-write is needed here, unlike idempotency.ts's
// log (which must detect REPLAYS, not just record events — a fundamentally different
// consistency requirement).
export async function appendReceipt(entry: Omit<ReceiptEntry, 'cypher_brain_receipt_version'>): Promise<void> {
  const full: ReceiptEntry = { cypher_brain_receipt_version: RECEIPT_VERSION, ...entry };
  await mkdir(dirname(RECEIPT_LEDGER), { recursive: true });
  await appendFile(RECEIPT_LEDGER, `${JSON.stringify(full)}\n`, { flag: 'a' });
}

// Reads every receipt ever appended. No ledger yet -> an empty array, not an error (a
// machine that has never done a paid push has zero receipts, which is a normal state,
// not a missing-file failure). A corrupted/truncated LINE (a crash mid-append) is
// skipped rather than failing the whole read: this is an audit ledger, not a
// replay-detection log, so losing one bad historical line is an acceptable degrade —
// idempotency.ts's stricter fail-closed posture (ERR_IDEMPOTENCY_STORE_UNREADABLE)
// protects a spend-safety guarantee this ledger does not make.
export async function readReceipts(): Promise<ReceiptEntry[]> {
  let text: string;
  try {
    text = await readFile(RECEIPT_LEDGER, 'utf8');
  } catch {
    return [];
  }
  const out: ReceiptEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<ReceiptEntry> | null;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        parsed.cypher_brain_receipt_version !== RECEIPT_VERSION ||
        typeof parsed.timestamp !== 'string' ||
        typeof parsed.backend !== 'string' ||
        typeof parsed.locator !== 'string'
      ) {
        continue; // wrong shape (foreign line, future version) — skip, don't crash a read
      }
      out.push({
        cypher_brain_receipt_version: RECEIPT_VERSION,
        timestamp: parsed.timestamp,
        backend: parsed.backend,
        locator: parsed.locator,
        artifact_sha256: typeof parsed.artifact_sha256 === 'string' ? parsed.artifact_sha256 : '',
        size_bytes: typeof parsed.size_bytes === 'number' ? parsed.size_bytes : 0,
        payer_address: typeof parsed.payer_address === 'string' ? parsed.payer_address : null,
        cost: typeof parsed.cost === 'string' ? parsed.cost : null,
        unit: parsed.unit === 'winston' || parsed.unit === 'winc' ? parsed.unit : null,
        raw: parsed.raw ?? null,
      });
    } catch {
      // malformed JSON on this one line — skip it, keep reading the rest
    }
  }
  return out;
}
