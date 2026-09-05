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
// one, so a forecast and a receipt can never be silently conflated. #484: ton-provider
// joined arweave/turbo as a third receipt-writing backend — its onReceipt call
// (backends/ton-provider.ts) passes `deploy.amountNano` (the storage cost PLUS deploy
// buffer actually locked into the on-chain transfer, confirmed by the time put()
// returns via waitForContractActive()) as an AUTHORITATIVE figure, same posture as
// arweave's signed tx.reward — not a pre-flight estimate like turbo's.
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RECEIPT_LEDGER } from './config.js';
import { readJsonlLog, syncDirectoryChain } from './util.js';

export const RECEIPT_VERSION = 1;

export interface ReceiptEntry {
  cypher_brain_receipt_version: typeof RECEIPT_VERSION;
  timestamp: string; // ISO 8601 — when the receipt was appended, right after a successful put()
  backend: string; // 'arweave' | 'turbo' | 'ton-provider' today — the only backends that spend real money
  locator: string; // what push() returned/printed for this upload (tx id / data item id / bag id)
  artifact_sha256: string;
  size_bytes: number;
  payer_address: string | null; // best-effort, same lookup plan.ts's payerAddressFor uses
  // The best available native-unit cost figure — authoritative for arweave (the signed
  // tx reward) and ton-provider (the amount actually locked into the confirmed on-chain
  // transfer), a pre-flight estimate for turbo (see this file's header comment); null if
  // the backend could not name one for this upload. Never a forecast — that is
  // estimate.ts's job, and the two are never conflated.
  cost: string | null;
  // #751: 'nanoton' (lowercase) is accepted here too for BACKWARD READ compatibility
  // only — a receipt-ledger.jsonl already on disk from before this fix stored it that
  // way (ton-provider.ts's own onReceipt call now always WRITES 'nanoTON', matching
  // estimate.ts's CostEstimate.unit casing everywhere else this physical unit appears).
  // Never normalized to the new casing on read: this module only reads back what a
  // receipt actually said, verbatim (see this file's header comment on `raw`/`cost`
  // honesty).
  unit: 'winston' | 'winc' | 'nanoton' | 'nanoTON' | null;
  raw: unknown; // the backend's own response — verbatim for turbo, a normalized summary
  // for arweave/ton-provider (see this file's header comment for why they differ)
}

// A single JSON-line append via O_APPEND: POSIX guarantees a write() with O_APPEND on a
// regular file repositions to end-of-file and writes atomically WITHIN that one write()
// syscall (no lost-update race between two processes each doing their own
// open+seek+write) — NOT the PIPE_BUF pipe-atomicity guarantee, a distinct, unrelated
// POSIX contract that applies to pipes/FIFOs, not regular files (an earlier version of
// this comment incorrectly invoked it — Codex review). In practice Node's fs append
// issues one write() syscall for a buffer this small (a receipt line is typically well
// under a few KB), so concurrent appends land as separate, non-interleaved lines on a
// POSIX-compliant filesystem — but this is not a hardened guarantee against an
// arbitrarily large `raw` payload spanning multiple write() syscalls, nor against a
// non-POSIX filesystem. No lock/read-modify-write is used regardless (unlike
// idempotency.ts's log, which must detect REPLAYS — a fundamentally different
// consistency requirement).
//
// fsync'd (util.ts's fsyncPath/syncDirectoryChain), for durability consistency with the
// rest of this cluster (pending-spend.ts's own append; keys.ts/minisign.ts's identity
// writes; idempotency.ts's claim/result files) — an appendFile() that has returned has
// only reached the kernel page cache, not the disk, and this ledger is the ONE place
// backends/ton-provider.ts's settleIntent() can point a pending-spend record's
// `settled` transition at as "verified durable" (see that file's own fsyncPath(
// RECEIPT_LEDGER) call, kept as a second, point-in-time confirmation immediately before
// that transition rather than removed now that every ordinary append also syncs).
export async function appendReceipt(entry: Omit<ReceiptEntry, 'cypher_brain_receipt_version'>): Promise<void> {
  const full: ReceiptEntry = { cypher_brain_receipt_version: RECEIPT_VERSION, ...entry };
  const dir = dirname(RECEIPT_LEDGER);
  const firstCreated = await mkdir(dir, { recursive: true });
  const fh = await open(RECEIPT_LEDGER, 'a');
  try {
    await fh.writeFile(`${JSON.stringify(full)}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncDirectoryChain(dir, firstCreated);
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
// anything" rather than "this tool couldn't check"). The read/ENOENT/split/parse/
// skippedLines scaffolding itself is util.ts's shared readJsonlLog() (#503) — only the
// per-entry shape validation below is specific to a receipt.
export async function readReceipts(): Promise<ReadReceiptsResult> {
  const { items, skippedLines } = await readJsonlLog<ReceiptEntry>(RECEIPT_LEDGER, 'receipt ledger', (parsed) => {
    const p = parsed as Partial<ReceiptEntry> | null;
    if (
      !p ||
      typeof p !== 'object' ||
      p.cypher_brain_receipt_version !== RECEIPT_VERSION ||
      typeof p.timestamp !== 'string' ||
      typeof p.backend !== 'string' ||
      typeof p.locator !== 'string'
    ) {
      return null; // wrong shape (foreign line, future version) — skip, don't crash a read
    }
    return {
      cypher_brain_receipt_version: RECEIPT_VERSION,
      timestamp: p.timestamp,
      backend: p.backend,
      locator: p.locator,
      artifact_sha256: typeof p.artifact_sha256 === 'string' ? p.artifact_sha256 : '',
      size_bytes: typeof p.size_bytes === 'number' ? p.size_bytes : 0,
      payer_address: typeof p.payer_address === 'string' ? p.payer_address : null,
      cost: typeof p.cost === 'string' ? p.cost : null,
      unit: p.unit === 'winston' || p.unit === 'winc' || p.unit === 'nanoton' || p.unit === 'nanoTON' ? p.unit : null,
      raw: p.raw ?? null,
    };
  });
  return { receipts: items, skippedLines };
}
