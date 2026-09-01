// CLI `ledger` command (#232): read every receipt src/lib/receipt.ts has ever appended
// (arweave/turbo paid pushes only) and report cumulative cost — by backend, by day, and
// by month. Every sum is per-NATIVE-UNIT (winston/winc are different currencies; never
// added together) and computed with BigInt (native-unit magnitudes routinely exceed
// Number's safe integer range). This is audit/observability only: it reads
// receipt-ledger.jsonl, never writes it, and has no effect on any push.
import { printJson } from './ui.js';
import { readReceipts, type ReceiptEntry } from './receipt.js';
import { warn } from './warn.js';
import type { CliOptions } from './types.js';

// Group key -> unit -> summed cost (as a decimal string — never re-parsed to Number,
// which would reintroduce the precision problem BigInt exists to avoid here).
type CostByUnit = Record<string, string>;

export interface LedgerSummary {
  total_receipts: number;
  // Receipts with no priceable cost (cost/unit missing or malformed) — excluded from
  // EVERY sum below (by_backend included).
  unpriced_receipts: number;
  // Receipts that HAD a priceable cost (and so ARE counted in by_backend) but whose
  // timestamp could not be trusted for day/month bucketing — excluded from by_day/
  // by_month only. Kept as its own counter, distinct from unpriced_receipts: conflating
  // the two mislabeled a genuinely priced receipt as "unpriced" and, worse, let its cost
  // land in by_backend while the same receipt was excluded from by_day/by_month with no
  // explanation for the disagreement between the two views (Codex review).
  undated_receipts: number;
  // Lines in the ledger file that could not be read as a receipt at all (malformed
  // JSON, wrong shape, a future version) — src/lib/receipt.ts's own readReceipts()
  // count, surfaced here so "0 receipts" can never be silently confused with "N lines
  // exist but none were readable".
  skipped_lines: number;
  by_backend: Record<string, { count: number; cost: CostByUnit }>;
  by_day: Record<string, CostByUnit>; // key: the receipt timestamp's UTC YYYY-MM-DD
  by_month: Record<string, CostByUnit>; // key: the receipt timestamp's UTC YYYY-MM
}

const COST_PATTERN = /^\d+$/;
// The EXACT shape every receipt this codebase writes has (receipt.ts's appendReceipt()
// always stamps `new Date().toISOString()`) — matched literally rather than trusting
// `new Date(str)`'s permissive parser, which accepts many loose/ambiguous formats and
// can silently normalize a malformed or timezone-less string into the WRONG UTC day
// (Codex review). A hand-edited or foreign-tool-produced line in a non-canonical format
// is treated as undated rather than guessed at.
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// #766: ISO_UTC_PATTERN above checks digit PLACEMENT only — it accepts a
// shape-conforming but calendrically impossible value (`2026-02-31T...`, a day that
// does not exist in February; `9999-99-99T...`, a month that does not exist at all)
// just as readily as a real timestamp. Both then sort lexically ABOVE every genuine
// recent day (see the `sort().slice(-14)` in ledger()'s "by day" report below), so one
// bad line silently evicts a real day from the truncated human view. This does NOT
// reintroduce the `new Date(str)` permissiveness the comment above warns against —
// the string has already been forced through the exact canonical shape by the regex,
// so there is no ambiguous/loose format left for a lenient parser to guess at; this
// only asks whether the exact digits present name a real calendar moment. Deliberately
// NOT a plain `Number.isNaN(Date.parse(ts))` check either: per the ECMA-262 grammar,
// `Date.parse` treats a day up to 31 as syntactically valid regardless of the month
// (Feb 31 SILENTLY NORMALIZES to March 3 instead of failing to parse), so `9999-99-99`
// (an out-of-range month) would be caught but `2026-02-31` (the issue's own other
// repro case) would not be. Round-tripping and comparing every field back against the
// digits that were passed in catches both: an overflowing day/month rolls the result
// into a different month/year, which the equality check below then fails.
//
// NOT `Date.UTC(year, month - 1, day, ...)` directly either (Codex review): its
// multi-arg form special-cases a two-digit-range `year` (0-99) by adding 1900 to it —
// the SAME legacy behavior `new Date(year, month, ...)` has (`new Date(0, 0)` is 1900,
// not year 0) — which would silently turn a genuinely valid, ISO_UTC_PATTERN-matching
// `0000-...`/`0099-...` timestamp into 1900/1999 internally, fail the
// `getUTCFullYear() === year` check below, and wrongly report a REAL calendar instant
// as impossible. Anchoring at a safely-out-of-range year (2000) for the initial
// construction, then overwriting the year via `setUTCFullYear()` — which has NO such
// special case, and (per the Date spec) still fully RE-normalizes month/day against
// the real year it is given, so a Feb-29-only-valid-in-a-leap-year case is still
// caught correctly — sidesteps the quirk while keeping every other overflow check
// exactly as strict (verified against a leap/non-leap/century-boundary battery).
function isRealCalendarInstant(ts: string): boolean {
  const year = Number(ts.slice(0, 4));
  const month = Number(ts.slice(5, 7));
  const day = Number(ts.slice(8, 10));
  const hour = Number(ts.slice(11, 13));
  const minute = Number(ts.slice(14, 16));
  const second = Number(ts.slice(17, 19));
  const ms = Number(ts.slice(20, 23));
  const t = Date.UTC(2000, month - 1, day, hour, minute, second, ms);
  if (!Number.isFinite(t)) return false;
  const d = new Date(t);
  d.setUTCFullYear(year);
  return (
    d.getUTCFullYear() === year &&
    d.getUTCMonth() === month - 1 &&
    d.getUTCDate() === day &&
    d.getUTCHours() === hour &&
    d.getUTCMinutes() === minute &&
    d.getUTCSeconds() === second &&
    d.getUTCMilliseconds() === ms
  );
}

// The full check a receipt timestamp must pass to be bucketed by day/month: the exact
// canonical shape (ISO_UTC_PATTERN) AND a real calendar instant (isRealCalendarInstant,
// #766) — either alone is insufficient (see each function's own doc comment).
function isValidReceiptTimestamp(ts: string): boolean {
  return ISO_UTC_PATTERN.test(ts) && isRealCalendarInstant(ts);
}

function addCost(sums: Record<string, bigint>, unit: string, amount: string): void {
  sums[unit] = (sums[unit] ?? 0n) + BigInt(amount);
}

function toCostByUnit(sums: Record<string, bigint>): CostByUnit {
  const out: CostByUnit = {};
  for (const [unit, total] of Object.entries(sums)) out[unit] = total.toString();
  return out;
}

export function summarizeLedger(receipts: ReceiptEntry[]): Omit<LedgerSummary, 'skipped_lines'> {
  const byBackend: Record<string, { count: number; sums: Record<string, bigint> }> = {};
  const byDay: Record<string, Record<string, bigint>> = {};
  const byMonth: Record<string, Record<string, bigint>> = {};
  let unpriced = 0;
  let undated = 0;

  for (const r of receipts) {
    if (!byBackend[r.backend]) byBackend[r.backend] = { count: 0, sums: {} };
    byBackend[r.backend].count++;

    // A receipt with no priceable cost (unit/cost missing, or a malformed cost string —
    // defensive against a hand-edited or foreign-version ledger line) is counted but
    // excluded from EVERY sum below, same "refuse to silently misreport" posture
    // plan.ts's validatePlan takes on the same class of input. This is the ONLY branch
    // that increments `unpriced` — a receipt that reaches past this point always has a
    // real, addable cost.
    if (r.cost === null || r.unit === null || !COST_PATTERN.test(r.cost)) {
      unpriced++;
      continue;
    }
    // Priced -> counted in by_backend regardless of whether it can also be dated below
    // (by_backend has no date concept to fail). Moved to run AFTER the cost check above
    // but BEFORE the date check: by_backend's sum must include every priced receipt,
    // whether or not it can be placed in a day/month bucket.
    addCost(byBackend[r.backend].sums, r.unit, r.cost);

    if (!isValidReceiptTimestamp(r.timestamp)) {
      undated++; // priced, but cannot be safely bucketed by day/month — a SEPARATE
      // count from `unpriced` (this receipt DID get added to by_backend just above).
      // #766: a shape-valid but calendrically impossible timestamp (e.g. a Feb 31, or
      // a month 99) is undated too, not just a wrong-shape one — see
      // isValidReceiptTimestamp's own doc comment for why the shape check alone is
      // insufficient.
      continue;
    }
    const day = r.timestamp.slice(0, 10); // YYYY-MM-DD (UTC) — safe: isValidReceiptTimestamp already confirmed this is a real calendar day
    const month = day.slice(0, 7); // YYYY-MM (UTC)
    if (!byDay[day]) byDay[day] = {};
    if (!byMonth[month]) byMonth[month] = {};
    addCost(byDay[day], r.unit, r.cost);
    addCost(byMonth[month], r.unit, r.cost);
  }

  return {
    total_receipts: receipts.length,
    unpriced_receipts: unpriced,
    undated_receipts: undated,
    by_backend: Object.fromEntries(
      Object.entries(byBackend).map(([backend, v]) => [backend, { count: v.count, cost: toCostByUnit(v.sums) }]),
    ),
    by_day: Object.fromEntries(Object.entries(byDay).map(([day, sums]) => [day, toCostByUnit(sums)])),
    by_month: Object.fromEntries(Object.entries(byMonth).map(([month, sums]) => [month, toCostByUnit(sums)])),
  };
}

// One receipt per CSV row — the closest thing to a raw export the issue's "via
// JSONL/CSV" asks for beyond the ledger file itself (which already IS the JSONL export
// — receipt-ledger.jsonl is one JSON object per line, nothing extra to build there).
// RFC 4180 minimal quoting: only fields that need it (contain a comma, quote, CR, or
// LF) are quoted, with internal quotes doubled — `raw` is a full JSON blob and
// routinely contains all four (Codex review: the original test omitted CR).
function csvField(v: string): string {
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

const CSV_HEADER = [
  'timestamp',
  'backend',
  'locator',
  'artifact_sha256',
  'size_bytes',
  'payer_address',
  'cost',
  'unit',
  'raw',
];

function csvRow(values: string[]): string {
  return values.map(csvField).join(',');
}

// Awaits backpressure (Codex review): `Writable.write()` returning `false` means its
// internal buffer is already at/over highWaterMark — writing MORE anyway (as a bare,
// un-awaited `out.write()` loop does) just keeps queuing every remaining row into that
// buffer instead of onto the wire, which for a slow consumer (a pipe into something
// that reads slowly) silently re-creates the exact "the whole export sits in memory at
// once" problem this streaming rewrite exists to avoid — just moved from this
// process's own arrays into the stream's internal buffer instead. Waiting for 'drain'
// whenever write() reports the buffer is full keeps memory bounded to roughly one
// buffer's worth, regardless of how slow the consumer is.
function writeChunk(out: NodeJS.WritableStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ok = out.write(chunk, (err) => {
      if (err) reject(err);
    });
    if (ok) resolve();
    else out.once('drain', resolve);
  });
}

// #765: writes each row directly to `out` as it is rendered, instead of building an
// array of every rendered row and THEN joining that into one complete CSV string (the
// previous shape of this function). For a large receipt ledger, holding all of
// {the parsed receipts array (readReceipts() has already materialized this — not this
// function's to avoid), the rendered-row array, AND the final joined string} in memory
// at once is exactly what issue #765 measured multiplying peak memory several times
// over the raw log size (100k receipts, 1 KiB `raw` payload each: csv_mib=110.3,
// rss_delta_mib=334.8) — enough to OOM-kill a modestly constrained process, and large
// enough exports can also hit V8's own single-string length ceiling. Streaming the
// write (via writeChunk, above) removes the two EXTRA full copies this function used
// to add on top of the receipts array, while still respecting backpressure.
async function writeCsv(receipts: ReceiptEntry[], out: NodeJS.WritableStream): Promise<void> {
  await writeChunk(out, `${csvRow(CSV_HEADER)}\n`);
  for (const r of receipts) {
    await writeChunk(
      out,
      `${csvRow([
        r.timestamp,
        r.backend,
        r.locator,
        r.artifact_sha256,
        String(r.size_bytes),
        r.payer_address ?? '',
        r.cost ?? '',
        r.unit ?? '',
        JSON.stringify(r.raw),
      ])}\n`,
    );
  }
}

// CLI `ledger [--json] [--csv]`. Human mode (default): a short report. --json: the full
// LedgerSummary object PLUS the raw receipts array (so a script gets both the
// aggregates and the source records in one call, without a second --csv pass). --csv:
// one row per receipt, ignoring --json (a raw export, not a summary) — the two are
// mutually exclusive outputs, so --csv wins if both are given, same "last flag settles
// it" spirit as this codebase's other either/or flag pairs.
export async function ledger(o: CliOptions): Promise<void> {
  const { receipts, skippedLines } = await readReceipts();
  if (skippedLines > 0) {
    warn(
      `ledger: ${skippedLines} line(s) in the receipt ledger could not be read (malformed/wrong-shape/future-version) — totals below may undercount actual spend`,
    );
  }
  if (o.csv) {
    await writeCsv(receipts, process.stdout);
    return;
  }
  const summary: LedgerSummary = { ...summarizeLedger(receipts), skipped_lines: skippedLines };
  if (o.json) {
    printJson({ ...summary, receipts });
    return;
  }
  if (receipts.length === 0) {
    // #457: a ledger with 0 READABLE receipts is not necessarily a ledger with 0
    // receipts — skippedLines > 0 means the file has content that could not be parsed
    // (see the warn() above), which is a materially different situation from a
    // genuinely-empty/never-created ledger and must not be reported with the SAME
    // sentence (the exact confusion audit.ts's own total/skipped/VERDICT split already
    // avoids for the equivalent "all lines garbage" case — see audit()).
    if (skippedLines > 0) {
      console.log(
        `0 of ${skippedLines} receipt line(s) could be read (${skippedLines} skipped as unreadable/malformed) — this is not necessarily an empty ledger, see the warning above`,
      );
    } else {
      console.log('no receipts yet — receipts are written by a successful `push --backend arweave|turbo`');
    }
    return;
  }
  const caveats: string[] = [];
  if (summary.unpriced_receipts) caveats.push(`${summary.unpriced_receipts} unpriced`);
  if (summary.undated_receipts)
    caveats.push(`${summary.undated_receipts} undated (priced, excluded from by-day/by-month)`);
  if (summary.skipped_lines) caveats.push(`${summary.skipped_lines} unreadable line(s) skipped`);
  console.log(`${summary.total_receipts} receipt(s)${caveats.length ? ` (${caveats.join(', ')})` : ''}`);
  console.log('');
  console.log('by backend:');
  for (const [backend, v] of Object.entries(summary.by_backend)) {
    const cost = Object.entries(v.cost)
      .map(([unit, amount]) => `${amount} ${unit}`)
      .join(', ');
    console.log(`  ${backend}: ${v.count} push(es)${cost ? ` — ${cost}` : ''}`);
  }
  console.log('');
  console.log('by month (UTC):');
  for (const month of Object.keys(summary.by_month).sort()) {
    const cost = Object.entries(summary.by_month[month])
      .map(([unit, amount]) => `${amount} ${unit}`)
      .join(', ');
    console.log(`  ${month}: ${cost}`);
  }
  console.log('');
  console.log('by day (UTC, most recent 14):');
  for (const day of Object.keys(summary.by_day).sort().slice(-14)) {
    const cost = Object.entries(summary.by_day[day])
      .map(([unit, amount]) => `${amount} ${unit}`)
      .join(', ');
    console.log(`  ${day}: ${cost}`);
  }
}
