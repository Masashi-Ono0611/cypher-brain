// Durable "a paid deploy is about to happen / has happened" bookkeeping for the
// ton-provider backend (issue #808).
//
// receipt.ts records a spend that is FINISHED. The gap #808 measured is the window
// BEFORE that: put() confirms the StorageV1 contract is live on-chain (the money is
// irreversibly gone from that instant) and only then hands the receipt to pushpull.ts,
// which hashes a brain-sized ciphertext before anything reaches disk. That is seconds,
// not instructions — a SIGKILL, an OOM kill, a container eviction or a power loss
// inside it leaves a confirmed spend permanently unrecorded, and the later retry takes
// #638's already-active branch, which deliberately writes no receipt (that run moved no
// funds). The ledger is then short forever with nothing reporting it.
//
// An INTENT closes that window from the other side: a record written BEFORE the
// broadcast, carrying everything a later run needs to write the receipt on its behalf
// (contract address, bag id, provider pubkey, the exact amount), which is then advanced
// to `confirmed` once the contract is live and to `settled` once the receipt is
// verifiably on disk. A crash anywhere in between leaves a record that says so.
//
// STORAGE: a SIDECAR file next to receipt-ledger.jsonl, not a new record kind inside
// it. The receipt ledger is read by three consumers (ledger.ts, audit.ts's cost view,
// doctor.ts's receipt-ledger-readability check) through receipt.ts's readReceipts(),
// whose validator returns null — counted as `skippedLines` — for ANY line that is not a
// receipt of the current version. Mixing a second record kind into that file would make
// every intent line register as an unreadable one, which those consumers report as
// "totals below may undercount actual spend" (ledger.ts's warn(), doctor's WARN): a new
// safety record would have manufactured a permanent false alarm about the very numbers
// it exists to keep honest. A sidecar leaves every existing reader byte-identical.
//
// APPEND-ONLY, folded on read (idempotency.ts's log is the shape this follows, not
// pushpull.ts's overwrite-in-place save-locator): a state change appends a NEW line
// carrying the same `intent_id`, and the last line for an id wins. Nothing is ever
// rewritten in place, so a crash mid-write can lose at most the line being appended —
// never the earlier state the previous line already recorded.
import { mkdir, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { RECEIPT_LEDGER } from './config.js';
import { readJsonlLog } from './util.js';

export const SPEND_INTENT_VERSION = 1;

// Deliberately DERIVED from RECEIPT_LEDGER rather than given its own env var: the two
// files are halves of one story ("what was about to be spent" / "what was spent"), and
// an operator who redirects the ledger (CYPHER_BRAIN_RECEIPT_LEDGER) to a different
// disk expects its sidecar to follow rather than to stay behind under the default HOME.
//
// Derived from the ledger's FULL NAME, not just its directory (multi-model review): two
// ledgers configured in one directory would otherwise share one sidecar, and a recovery
// run against ledger B could settle an intent whose receipt belongs in ledger A — leaving
// A permanently short while doctor reports the intent as settled. Naming the sidecar
// after its own ledger makes them a pair by construction.
//
// The suffix is appended to the COMPLETE basename rather than replacing a `.jsonl`
// extension (second review pass): stripping the extension is not injective — `foo` and
// `foo.jsonl` in one directory would map to the same sidecar and reintroduce exactly the
// cross-talk this derivation exists to remove. Verbose beats ambiguous for a file only
// this code and an operator debugging a lost spend ever open.
export const PENDING_SPENDS_LOG = join(dirname(RECEIPT_LEDGER), `${basename(RECEIPT_LEDGER)}.pending-spends.jsonl`);

/**
 * `pending` — the record was written, the transfer has not been confirmed on-chain by
 * the run that wrote it. This is EXACTLY the state a #822 PushUncertainSpendError
 * leaves behind: the money may or may not have moved, and only an operator looking at
 * the contract address can settle it.
 *
 * `confirmed` — the contract was observed live on-chain, so the spend is irreversible,
 * but the receipt is not yet known to be on disk.
 *
 * `settled` — a receipt for this contract address has been VERIFIED present in the
 * receipt ledger. Nothing further is owed for this intent.
 *
 * `abandoned` — the deploy this intent was written for provably never left the process
 * (the broadcast failed before the signed message was submitted), so NO funds moved and
 * nothing is owed. Distinct from `settled`, which asserts a receipt exists: recording
 * "no spend happened" as "the spend is recorded" would be a lie in the log a later run
 * reads. Without this state a refused broadcast would leave a permanent `pending` entry
 * that doctor reports forever and that a later run could mistake for a real spend
 * (multi-model review).
 */
export type SpendIntentState = 'pending' | 'confirmed' | 'settled' | 'abandoned';

export interface SpendIntentRecord {
  cypher_brain_spend_intent_version: typeof SPEND_INTENT_VERSION;
  /** Ties every line for one deploy together; the last line for an id is its state. */
  intent_id: string;
  state: SpendIntentState;
  /** When the intent was FIRST written (carried forward unchanged by every later line). */
  timestamp: string;
  /** When THIS line was appended. */
  updated_at: string;
  backend: string;
  /** The derived StorageV1 contract address, in raw `workchain:hex` form — the join key. */
  contract_address: string;
  bag_id: string;
  /** The provider the deploy was actually built for — #665 resumes notify with THIS. */
  provider_pubkey: string;
  amount_nano: string;
  cost_nano: string;
  deploy_buffer_nano: string;
  locator: string;
}

/** The fields a caller supplies; everything else is stamped by this module. */
export type NewSpendIntent = Omit<
  SpendIntentRecord,
  'cypher_brain_spend_intent_version' | 'intent_id' | 'state' | 'timestamp' | 'updated_at'
>;

const STATES: readonly SpendIntentState[] = ['pending', 'confirmed', 'settled', 'abandoned'];

// fsync'd, unlike receipt.ts's appendReceipt() (multi-model review, Critical). That
// difference is the whole point of this file: a receipt is written AFTER the fact, so
// losing an un-flushed one costs a ledger line, while THIS record is written before an
// irreversible transfer and is the only thing that can account for it afterwards. An
// appendFile() that has returned has reached the kernel page cache, not the disk — a
// power loss between the broadcast and the next flush would discard exactly the record
// this file exists to guarantee, recreating #808 in a form no retry can repair.
//
// Every directory the write depends on is fsync'd too, and that half FAILS CLOSED rather
// than being best-effort (second review pass): an fsync'd file whose CREATION is still
// only in the page cache can come back missing entirely after a crash, which is the same
// unrecorded spend with extra steps. `mkdir(recursive)` reports the FIRST path component
// it created, so every directory created on the way down gets its own parent synced, not
// just the immediate one. Skipped only on win32, where a directory cannot be opened as a
// file handle at all and there is no equivalent call to make.
export async function fsyncPath(path: string): Promise<void> {
  const fh = await open(path, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

async function syncDirectories(dir: string, firstCreated: string | undefined): Promise<void> {
  if (process.platform === 'win32') return;
  // Always the directory holding the file (its entry may be new); plus the parent of
  // every directory `mkdir` just created, walking up from the deepest.
  const toSync = [dir];
  if (firstCreated) {
    for (let d = dir; d !== firstCreated; d = dirname(d)) {
      const parent = dirname(d);
      if (parent === d) break; // reached the filesystem root
      toSync.push(parent);
    }
    // `firstCreated` is itself a newly-created directory (mkdir's own contract: "the
    // first directory path created"), and its own directory ENTRY lives in its
    // parent, exactly like every other level the loop above already walks — the loop
    // stops the instant `d === firstCreated`, one level short of syncing that parent.
    // Without this, the topmost newly-created directory's own entry (e.g. `dir` ===
    // `firstCreated`, when only ONE new directory was created and the loop above never
    // runs at all) is never durably recorded in ITS parent, which can leave that
    // directory — and the fsync'd record inside it — missing entirely after a crash.
    const parentOfFirstCreated = dirname(firstCreated);
    if (parentOfFirstCreated !== firstCreated) toSync.push(parentOfFirstCreated);
  }
  for (const d of toSync) await fsyncPath(d);
}

async function appendLine(record: SpendIntentRecord): Promise<void> {
  const dir = dirname(PENDING_SPENDS_LOG);
  const firstCreated = await mkdir(dir, { recursive: true });
  // Same single-write O_APPEND posture receipt.ts's appendReceipt() documents at
  // length: one small JSON line per write(), so concurrent appends land as separate,
  // non-interleaved lines on a POSIX filesystem. No read-modify-write, no lock — this
  // log is only ever appended to.
  const fh = await open(PENDING_SPENDS_LOG, 'a');
  try {
    await fh.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await syncDirectories(dir, firstCreated);
}

/**
 * Write a new `pending` intent and return it. Throws on an I/O failure — the caller
 * (ton-provider.ts) is expected to treat that as a reason NOT to broadcast, since a
 * spend nothing recorded is the exact failure #808 exists to prevent and no funds have
 * moved yet at that point.
 */
export async function recordSpendIntent(fields: NewSpendIntent): Promise<SpendIntentRecord> {
  const now = new Date().toISOString();
  const record: SpendIntentRecord = {
    cypher_brain_spend_intent_version: SPEND_INTENT_VERSION,
    intent_id: randomBytes(16).toString('hex'),
    state: 'pending',
    timestamp: now,
    updated_at: now,
    ...fields,
  };
  await appendLine(record);
  return record;
}

/**
 * Append the same intent again in a new state. The returned record is what a caller
 * should keep advancing (its `updated_at` moves; `intent_id`/`timestamp` do not).
 */
export async function advanceSpendIntent(
  intent: SpendIntentRecord,
  state: SpendIntentState,
): Promise<SpendIntentRecord> {
  const next: SpendIntentRecord = { ...intent, state, updated_at: new Date().toISOString() };
  await appendLine(next);
  return next;
}

export interface ReadSpendIntentsResult {
  /** One entry per `intent_id` — the LAST line written for it, in first-seen order. */
  intents: SpendIntentRecord[];
  /** Lines that existed but could not be read as an intent (malformed/foreign/future). */
  skippedLines: number;
}

// EVERY v1 field is required, and `amount_nano` must be a bare integer string (second
// review pass). receipt.ts's validator defaults missing fields to ''/0 because a receipt
// is a REPORT — a partly-unreadable one still tells you a push happened. This record is
// an INSTRUCTION to a later run ("write this exact receipt"), so a version-1 line missing
// the amount or the provider cannot be honoured: filling the gap with '' would settle the
// intent against an unpriced receipt while claiming the original amount was preserved.
// Counting it as an unreadable line instead is what makes the callers' fail-closed
// branches (which refuse to recover, and refuse to guess a provider, when any line was
// skipped) actually see it.
function validateIntent(parsed: unknown): SpendIntentRecord | null {
  const p = parsed as Partial<SpendIntentRecord> | null;
  if (
    !p ||
    typeof p !== 'object' ||
    p.cypher_brain_spend_intent_version !== SPEND_INTENT_VERSION ||
    typeof p.intent_id !== 'string' ||
    !p.intent_id ||
    typeof p.timestamp !== 'string' ||
    typeof p.updated_at !== 'string' ||
    typeof p.backend !== 'string' ||
    typeof p.contract_address !== 'string' ||
    !p.contract_address ||
    typeof p.bag_id !== 'string' ||
    typeof p.provider_pubkey !== 'string' ||
    typeof p.cost_nano !== 'string' ||
    typeof p.deploy_buffer_nano !== 'string' ||
    typeof p.locator !== 'string' ||
    typeof p.amount_nano !== 'string' ||
    !/^\d+$/.test(p.amount_nano) ||
    typeof p.state !== 'string' ||
    !STATES.includes(p.state as SpendIntentState)
  ) {
    return null;
  }
  return {
    cypher_brain_spend_intent_version: SPEND_INTENT_VERSION,
    intent_id: p.intent_id,
    state: p.state as SpendIntentState,
    timestamp: p.timestamp,
    updated_at: p.updated_at,
    backend: p.backend,
    contract_address: p.contract_address,
    bag_id: p.bag_id,
    provider_pubkey: p.provider_pubkey,
    amount_nano: p.amount_nano,
    cost_nano: p.cost_nano,
    deploy_buffer_nano: p.deploy_buffer_nano,
    locator: p.locator,
  };
}

/**
 * Every intent, folded to its latest state. Missing file -> no intents (a machine that
 * has never done a ton-provider push), same "ENOENT is a normal state" contract
 * readReceipts() has; any OTHER read failure throws rather than reporting an empty log,
 * because "no pending spends" and "could not check for pending spends" are opposite
 * answers to the only question this file exists to answer.
 */
export async function readSpendIntents(): Promise<ReadSpendIntentsResult> {
  const { items, skippedLines } = await readJsonlLog<SpendIntentRecord>(
    PENDING_SPENDS_LOG,
    'pending-spend log',
    validateIntent,
  );
  const folded = new Map<string, SpendIntentRecord>();
  for (const item of items) folded.set(item.intent_id, item);
  return { intents: [...folded.values()], skippedLines };
}

/**
 * True for an intent that still owes something — a receipt, or an operator's verdict.
 * `abandoned` owes nothing (no funds moved), same as `settled`.
 */
export function isUnsettled(intent: SpendIntentRecord): boolean {
  return intent.state === 'pending' || intent.state === 'confirmed';
}

/**
 * Every UNSETTLED intent for one contract address, newest-updated first. The contract
 * address is the right key rather than the locator: it is what identifies the on-chain
 * spend, it is stable across runs (buildDeploy() derives it from bag id + owner + size +
 * piece size + merkle hash — never from which provider was picked), and it is what an
 * operator checks on an explorer.
 *
 * Returns a LIST, not a best match (multi-model review): one contract address does not
 * prove one spend, so a caller about to write a receipt on an earlier run's behalf has to
 * be able to see that more than one candidate exists and refuse rather than pick.
 */
export function unsettledIntentsForContract(
  intents: readonly SpendIntentRecord[],
  contractAddress: string,
): SpendIntentRecord[] {
  return intents
    .filter((i) => i.contract_address === contractAddress && isUnsettled(i))
    .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
}

/**
 * The DISTINCT provider pubkeys recorded for one contract address — #665's authority (a)
 * for "which provider was this contract actually deployed with", split by how much the
 * record proves.
 *
 * `confirmed` comes from intents whose deploy was actually observed live on-chain
 * (`confirmed`/`settled`). `unconfirmed` comes from `pending` ones, which record only
 * that a transfer was attempted — local append order says nothing about which
 * `modify_providers` message actually won on-chain, so those must never outrank a
 * confirmed record or a receipt (multi-model review). `abandoned` intents are excluded
 * entirely: their deploy provably never left the process.
 */
export function recordedProvidersForContract(
  intents: readonly SpendIntentRecord[],
  contractAddress: string,
): { confirmed: string[]; unconfirmed: string[] } {
  const confirmed = new Set<string>();
  const unconfirmed = new Set<string>();
  for (const i of intents) {
    if (i.contract_address !== contractAddress || !i.provider_pubkey) continue;
    if (i.state === 'confirmed' || i.state === 'settled') confirmed.add(i.provider_pubkey);
    else if (i.state === 'pending') unconfirmed.add(i.provider_pubkey);
  }
  return { confirmed: [...confirmed], unconfirmed: [...unconfirmed] };
}
