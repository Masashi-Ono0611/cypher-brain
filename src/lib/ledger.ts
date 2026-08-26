// CLI `ledger` command (#232): read every receipt src/lib/receipt.ts has ever appended
// (arweave/turbo paid pushes only) and report cumulative cost — by backend, by day, and
// by month. Every sum is per-NATIVE-UNIT (winston/winc are different currencies; never
// added together) and computed with BigInt (native-unit magnitudes routinely exceed
// Number's safe integer range). This is audit/observability only: it reads
// receipt-ledger.jsonl, never writes it, and has no effect on any push.
import { printJson } from './ui.js';
import { readReceipts, type ReceiptEntry } from './receipt.js';
import type { CliOptions } from './types.js';

// Group key -> unit -> summed cost (as a decimal string — never re-parsed to Number,
// which would reintroduce the precision problem BigInt exists to avoid here).
type CostByUnit = Record<string, string>;

export interface LedgerSummary {
  total_receipts: number;
  // Receipts this summary could not price (cost or unit missing/malformed) — reported
  // so a reader can tell "no cost" from "we forgot to check" (same #268 shape estimate.ts
  // already uses: an unpriceable entry is a REAL count, never silently dropped).
  unpriced_receipts: number;
  by_backend: Record<string, { count: number; cost: CostByUnit }>;
  by_day: Record<string, CostByUnit>; // key: the receipt timestamp's UTC YYYY-MM-DD
  by_month: Record<string, CostByUnit>; // key: the receipt timestamp's UTC YYYY-MM
}

const COST_PATTERN = /^\d+$/;

function addCost(sums: Record<string, bigint>, unit: string, amount: string): void {
  sums[unit] = (sums[unit] ?? 0n) + BigInt(amount);
}

function toCostByUnit(sums: Record<string, bigint>): CostByUnit {
  const out: CostByUnit = {};
  for (const [unit, total] of Object.entries(sums)) out[unit] = total.toString();
  return out;
}

export function summarizeLedger(receipts: ReceiptEntry[]): LedgerSummary {
  const byBackend: Record<string, { count: number; sums: Record<string, bigint> }> = {};
  const byDay: Record<string, Record<string, bigint>> = {};
  const byMonth: Record<string, Record<string, bigint>> = {};
  let unpriced = 0;

  for (const r of receipts) {
    if (!byBackend[r.backend]) byBackend[r.backend] = { count: 0, sums: {} };
    byBackend[r.backend].count++;

    // A receipt with no priceable cost (unit/cost missing, or a malformed cost string —
    // defensive against a hand-edited or foreign-version ledger line) is counted but
    // excluded from every sum below, same "refuse to silently misreport" posture
    // plan.ts's validatePlan takes on the same class of input.
    if (r.cost === null || r.unit === null || !COST_PATTERN.test(r.cost)) {
      unpriced++;
      continue;
    }
    addCost(byBackend[r.backend].sums, r.unit, r.cost);

    const d = new Date(r.timestamp);
    if (Number.isNaN(d.getTime())) {
      unpriced++; // an unparseable timestamp can't be bucketed by day/month either
      continue;
    }
    const day = d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
    const month = day.slice(0, 7); // YYYY-MM (UTC)
    if (!byDay[day]) byDay[day] = {};
    if (!byMonth[month]) byMonth[month] = {};
    addCost(byDay[day], r.unit, r.cost);
    addCost(byMonth[month], r.unit, r.cost);
  }

  return {
    total_receipts: receipts.length,
    unpriced_receipts: unpriced,
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
// RFC 4180 minimal quoting: only fields that need it (contain a comma, quote, or
// newline) are quoted, with internal quotes doubled — `raw` is a full JSON blob and
// routinely contains all three.
function csvField(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
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
  const receipts = await readReceipts();
  if (o.csv) {
    console.log(toCsv(receipts));
    return;
  }
  const summary = summarizeLedger(receipts);
  if (o.json) {
    printJson({ ...summary, receipts });
    return;
  }
  if (receipts.length === 0) {
    console.log('no receipts yet — receipts are written by a successful `push --backend arweave|turbo`');
    return;
  }
  console.log(
    `${summary.total_receipts} receipt(s)${summary.unpriced_receipts ? ` (${summary.unpriced_receipts} unpriced)` : ''}`,
  );
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
