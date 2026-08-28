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

    if (!ISO_UTC_PATTERN.test(r.timestamp)) {
      undated++; // priced, but cannot be safely bucketed by day/month — a SEPARATE
      // count from `unpriced` (this receipt DID get added to by_backend just above).
      continue;
    }
    const day = r.timestamp.slice(0, 10); // YYYY-MM-DD (UTC) — safe: pattern already validated
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

function toCsv(receipts: ReceiptEntry[]): string {
  const header = [
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
  const rows = receipts.map((r) =>
    [
      r.timestamp,
      r.backend,
      r.locator,
      r.artifact_sha256,
      String(r.size_bytes),
      r.payer_address ?? '',
      r.cost ?? '',
      r.unit ?? '',
      JSON.stringify(r.raw),
    ]
      .map(csvField)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
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
    console.log(toCsv(receipts));
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
