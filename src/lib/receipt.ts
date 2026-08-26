// Persist a "receipt" — the best available ACTUAL-cost record for a completed paid
// push — separately from estimate.ts's pre-flight forecast (#232). Turbo's official
// receipt-persistence recommendation (https://docs.ar.io/build/upload/receipts/) is to
// keep the SDK's raw upload response as-is, and that response is what `raw` holds for a
// turbo receipt; the raw arweave L1 backend has no such SDK-provided receipt object (no
// single "official" response to defer to), so `raw` there is a small NORMALIZED summary
// of the signed transaction instead (tx id, reward, post status) — see backends/
// arweave.ts's onReceipt call. `cost` has a similar per-backend honesty gap: arweave's
// is the authoritative signed tx.reward, but turbo's is the PRE-FLIGHT estimate that
// gated this specific upload (the SDK response has no separately-confirmed
// charged-amount field to read back) — see backends/turbo.ts's onReceipt call and doc
// comment for why that is the best available figure, not a confirmed post-hoc debit
// (Codex review — an earlier version of this file's docs overclaimed both of these as
// uniformly "as-is"/"actual"). estimate.ts's CostEstimate stays what it always was, a
// forecast: this module never reads it, and validatePlan/estimateCost never read this
// one, so a forecast and a receipt can never be silently conflated.
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RECEIPT_LEDGER } from './config.js';
import { errMsg } from './util.js';

export const RECEIPT_VERSION = 1;

export interface ReceiptEntry {
  cypher_brain_receipt_version: typeof RECEIPT_VERSION;
  timestamp: string; // ISO 8601 — when the receipt was appended, right after a successful put()
  backend: string; // 'arweave' | 'turbo' today — the only backends that spend real money
  locator: string; // what push() returned/printed for this upload (tx id / data item id)
  artifact_sha256: string;
  size_bytes: number;
  payer_address: string | null; // best-effort, same lookup plan.ts's payerAddressFor uses
  // The best available native-unit cost figure — authoritative for arweave (the signed
  // tx reward), a pre-flight estimate for turbo (see this file's header comment); null
  // if the backend could not name one for this upload. Never a forecast — that is
  // estimate.ts's job, and the two are never conflated.
  cost: string | null;
  unit: 'winston' | 'winc' | null;
  raw: unknown; // the backend's own response — verbatim for turbo, a normalized summary
  // for arweave (see this file's header comment for why the two differ)
}

// A single JSON-line append via O_APPEND: POSIX guarantees a write() with O_APPEND on a
// regular file repositions to end-of-file and writes atomically WITHIN that one write()
// syscall (no lost-update race between two processes each doing their own
// open+seek+write) — NOT the PIPE_BUF pipe-atomicity guarantee, a distinct, unrelated
// POSIX contract that applies to pipes/FIFOs, not regular files (an earlier version of
// this comment incorrectly invoked it — Codex review). In practice Node's
// fs.appendFile() issues one write() syscall for a buffer this small (a receipt line is
// typically well under a few KB), so concurrent appends land as separate,
// non-interleaved lines on a POSIX-compliant filesystem — but this is not a hardened
// guarantee against an arbitrarily large `raw` payload spanning multiple write()
// syscalls, nor against a non-POSIX filesystem. No lock/read-modify-write is used
// regardless (unlike idempotency.ts's log, which must detect REPLAYS — a fundamentally
// different consistency requirement).
export async function appendReceipt(entry: Omit<ReceiptEntry, 'cypher_brain_receipt_version'>): Promise<void> {
  const full: ReceiptEntry = { cypher_brain_receipt_version: RECEIPT_VERSION, ...entry };
  await mkdir(dirname(RECEIPT_LEDGER), { recursive: true });
  await appendFile(RECEIPT_LEDGER, `${JSON.stringify(full)}\n`, { flag: 'a' });
}

export interface ReadReceiptsResult {
  receipts: ReceiptEntry[];
  // Lines that existed but could not be used — malformed JSON, wrong shape, or a future
  // version — distinct from `receipts.length`/unpriced counts (ledger.ts's own,
  // ALL-valid-shape concept) so a reader can tell "every receipt we found is accounted
  // for" from "some history is unreadable and the totals below are an undercount"
  // (Codex review — an earlier version dropped this count on the floor entirely).
  skippedLines: number;
}

// Reads every receipt ever appended. No ledger FILE yet -> zero receipts, zero skipped
// lines — a normal state (a machine that has never done a paid push), not a failure.
// Any OTHER read failure (permissions, I/O error, a directory sitting where the file
// should be, ...) THROWS instead of silently reporting an empty ledger: this is an
// audit/cost tool, and "no receipts" must never be indistinguishable from "could not
// read the receipts" (Codex review, Critical — the original version caught every
// readFile error the same way, so a permissions problem read as "you've never spent
// anything" rather than "this tool couldn't check").
export async function readReceipts(): Promise<ReadReceiptsResult> {
  let text: string;
  try {
    text = await readFile(RECEIPT_LEDGER, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return { receipts: [], skippedLines: 0 };
    throw new Error(`cannot read receipt ledger at ${RECEIPT_LEDGER}: ${errMsg(e)}`);
  }
  const receipts: ReceiptEntry[] = [];
  let skippedLines = 0;
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
        skippedLines++; // wrong shape (foreign line, future version) — skip, don't crash a read
        continue;
      }
      receipts.push({
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
      skippedLines++; // malformed JSON on this one line — skip it, keep reading the rest
    }
  }
  return { receipts, skippedLines };
}
