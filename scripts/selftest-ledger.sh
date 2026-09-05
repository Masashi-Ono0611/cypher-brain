#!/usr/bin/env bash
# Selftest for `cypher-brain ledger` / `ledger --json` / `ledger --csv` (#571): the
# audit/observability command src/lib/ledger.ts implements, previously touched only
# incidentally (2 lines inside selftest-ton-provider.sh, and `ledger --csv` was never
# exercised anywhere in the suite at all).
#
# Covers, in order:
#   (a) an empty ledger (no receipt-ledger.jsonl written yet): human output says "no
#       receipts yet", --json is an all-zero summary with empty groupings/receipts, and
#       --csv is exactly the header row with no data rows.
#   (b) multi-backend aggregation across 3 backends (arweave/turbo/ton-provider) PLUS
#       the edge cases summarizeLedger()/readReceipts() specifically guard: an unpriced
#       receipt (cost/unit null — counted in by_backend but excluded from every cost
#       sum), an undated receipt (priced but an unparseable timestamp — counted in
#       by_backend, excluded from by_day/by_month), and a malformed ledger line (not
#       JSON at all — counted as skipped_lines, never crashes the read). Checked across
#       all three output modes (human/--json/--csv).
#   (c) --csv wins when both --json and --csv are given (documented mutual exclusivity).
#   (d) #766: a shape-valid-but-calendrically-impossible timestamp (Feb 31; a month 99)
#       is excluded from by_day/by_month (counted as undated, not bucketed as if it
#       were a real day) — the digit-placement-only regex used to accept both.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }

echo "== (a) empty ledger: no receipt-ledger.jsonl written yet =="
export CYPHER_BRAIN_HOME="$TMP/empty-home"
mkdir -p "$CYPHER_BRAIN_HOME"
[ ! -e "$CYPHER_BRAIN_HOME/receipt-ledger.jsonl" ] || { echo "[FAIL] test setup: receipt-ledger.jsonl already exists"; exit 1; }

LEDGER_EMPTY=$(cb ledger)
printf '%s' "$LEDGER_EMPTY" | grep -q 'no receipts yet' \
  || { echo "[FAIL] empty ledger (human) did not print the 'no receipts yet' message: $LEDGER_EMPTY"; exit 1; }
echo "[PASS] empty ledger (human): 'no receipts yet' message"

LEDGER_EMPTY_JSON=$(cb ledger --json)
node -e '
  const j = JSON.parse(process.argv[1]);
  if (j.total_receipts !== 0) throw new Error("expected total_receipts 0, got " + j.total_receipts);
  if (j.unpriced_receipts !== 0) throw new Error("expected unpriced_receipts 0, got " + j.unpriced_receipts);
  if (j.undated_receipts !== 0) throw new Error("expected undated_receipts 0, got " + j.undated_receipts);
  if (j.skipped_lines !== 0) throw new Error("expected skipped_lines 0, got " + j.skipped_lines);
  if (Object.keys(j.by_backend).length !== 0) throw new Error("expected empty by_backend, got " + JSON.stringify(j.by_backend));
  if (Object.keys(j.by_day).length !== 0) throw new Error("expected empty by_day, got " + JSON.stringify(j.by_day));
  if (Object.keys(j.by_month).length !== 0) throw new Error("expected empty by_month, got " + JSON.stringify(j.by_month));
  if (!Array.isArray(j.receipts) || j.receipts.length !== 0) throw new Error("expected an empty receipts array, got " + JSON.stringify(j.receipts));
' "$LEDGER_EMPTY_JSON" || { echo "[FAIL] ledger --json on an empty ledger has an unexpected shape"; echo "$LEDGER_EMPTY_JSON"; exit 1; }
echo "[PASS] empty ledger --json: all-zero summary, empty groupings, empty receipts array"

LEDGER_EMPTY_CSV=$(cb ledger --csv)
EXPECTED_HEADER='timestamp,backend,locator,artifact_sha256,size_bytes,payer_address,cost,unit,raw'
[ "$LEDGER_EMPTY_CSV" = "$EXPECTED_HEADER" ] \
  || { echo "[FAIL] empty ledger --csv expected exactly the header row, got: $LEDGER_EMPTY_CSV"; exit 1; }
echo "[PASS] empty ledger --csv: header row only, no data rows (#571)"

echo "== (b) multi-backend aggregation + unpriced/undated/malformed edge cases (#571) =="
export CYPHER_BRAIN_HOME="$TMP/multi-home"
node --experimental-strip-types --import "$ROOT/scripts/dev-cli-loader.mjs" -e "
import('$ROOT/src/lib/receipt.ts').then(async (m) => {
  // priced + dated: arweave, January
  await m.appendReceipt({
    timestamp: '2026-01-15T00:00:00.000Z',
    backend: 'arweave',
    locator: 'ar-loc-1',
    artifact_sha256: 'a'.repeat(64),
    size_bytes: 111,
    payer_address: 'ar-payer',
    cost: '1000',
    unit: 'winston',
    raw: { note: 'arweave receipt' },
  });
  // priced + dated: turbo, February — a different backend AND a different month, so
  // by_backend/by_day/by_month all have something to actually distinguish.
  await m.appendReceipt({
    timestamp: '2026-02-20T00:00:00.000Z',
    backend: 'turbo',
    locator: 'turbo-loc-1',
    artifact_sha256: 'b'.repeat(64),
    size_bytes: 222,
    payer_address: null,
    cost: '500',
    unit: 'winc',
    raw: { note: 'turbo receipt' },
  });
  // unpriced (cost/unit null): must count toward by_backend.arweave.count but be
  // excluded from EVERY cost sum (ledger.ts's summarizeLedger()) and from --csv is
  // NOT excluded (--csv is a raw per-receipt export, not a summary).
  await m.appendReceipt({
    timestamp: '2026-02-21T00:00:00.000Z',
    backend: 'arweave',
    locator: 'ar-loc-unpriced',
    artifact_sha256: 'c'.repeat(64),
    size_bytes: 333,
    payer_address: null,
    cost: null,
    unit: null,
    raw: { note: 'unpriced arweave receipt' },
  });
  // undated (priced, but an unparseable timestamp): must still land in by_backend
  // (ton-provider), but must NOT create a by_day/by_month bucket. Also the LEGACY
  // lowercase 'nanoton' casing (receipt.ts accepts it for backward-read compatibility —
  // see the next receipt below, which uses the current 'nanoTON' casing for the SAME
  // backend, to prove the two get merged rather than reported as two separate units).
  await m.appendReceipt({
    timestamp: 'not-a-valid-timestamp',
    backend: 'ton-provider',
    locator: 'tp-loc-undated',
    artifact_sha256: 'd'.repeat(64),
    size_bytes: 444,
    payer_address: null,
    cost: '77',
    unit: 'nanoton',
    raw: { note: 'undated ton-provider receipt' },
  });
  // #751 follow-up (Codex review): priced + dated, SAME backend (ton-provider) as the
  // receipt above but with the CURRENT 'nanoTON' casing — a ledger spanning the casing
  // fix must aggregate both under ONE key (by_backend/by_day/by_month), not report the
  // same physical unit split across 'nanoton' and 'nanoTON'.
  await m.appendReceipt({
    timestamp: '2026-03-05T00:00:00.000Z',
    backend: 'ton-provider',
    locator: 'tp-loc-dated-nanoTON',
    artifact_sha256: 'e'.repeat(64),
    size_bytes: 555,
    payer_address: null,
    cost: '23',
    unit: 'nanoTON',
    raw: { note: 'dated ton-provider receipt, current casing' },
  });
});
"
RECEIPT_LEDGER_PATH="$CYPHER_BRAIN_HOME/receipt-ledger.jsonl"
[ -f "$RECEIPT_LEDGER_PATH" ] || { echo "[FAIL] test setup: $RECEIPT_LEDGER_PATH was not written"; exit 1; }
# A malformed line (not JSON at all) — readReceipts() must count it as skipped_lines
# and keep going, never crash the read or silently miscount as a 5th receipt.
printf 'not json at all\n' >> "$RECEIPT_LEDGER_PATH"

LEDGER_JSON=$(cb ledger --json)
node -e '
  const j = JSON.parse(process.argv[1]);
  if (j.total_receipts !== 5) throw new Error("expected total_receipts 5 (the malformed line is not a receipt), got " + j.total_receipts);
  if (j.skipped_lines !== 1) throw new Error("expected skipped_lines 1, got " + j.skipped_lines);
  if (j.unpriced_receipts !== 1) throw new Error("expected unpriced_receipts 1, got " + j.unpriced_receipts);
  if (j.undated_receipts !== 1) throw new Error("expected undated_receipts 1, got " + j.undated_receipts);
  const ar = j.by_backend.arweave;
  if (!ar || ar.count !== 2) throw new Error("expected by_backend.arweave.count 2 (1 priced + 1 unpriced), got " + JSON.stringify(ar));
  if (ar.cost.winston !== "1000") throw new Error("expected by_backend.arweave.cost.winston 1000 (unpriced receipt excluded from the sum), got " + JSON.stringify(ar));
  const tb = j.by_backend.turbo;
  if (!tb || tb.count !== 1 || tb.cost.winc !== "500") throw new Error("expected by_backend.turbo count 1 / cost.winc 500, got " + JSON.stringify(tb));
  // #751 follow-up (Codex review): one receipt was written with the legacy lowercase
  // "nanoton" and one with the current "nanoTON" — summarizeLedger() must merge them
  // under the SINGLE canonical "nanoTON" key (77 + 23 = 100), never report the same
  // physical unit split across two keys, and never leave the legacy "nanoton" key
  // present at all in the aggregated view.
  const tp = j.by_backend["ton-provider"];
  if (!tp || tp.count !== 2) throw new Error("expected by_backend[ton-provider].count 2 (one legacy-cased + one current-cased receipt), got " + JSON.stringify(tp));
  if (tp.cost.nanoTON !== "100") throw new Error("expected by_backend[ton-provider].cost.nanoTON 100 (77 legacy-cased + 23 current-cased, merged), got " + JSON.stringify(tp));
  if ("nanoton" in tp.cost) throw new Error("by_backend[ton-provider].cost still has a separate legacy \"nanoton\" key (not merged): " + JSON.stringify(tp));
  if (j.by_day["2026-01-15"]?.winston !== "1000") throw new Error("expected by_day[2026-01-15].winston 1000, got " + JSON.stringify(j.by_day));
  if (j.by_month["2026-01"]?.winston !== "1000") throw new Error("expected by_month[2026-01].winston 1000, got " + JSON.stringify(j.by_month));
  if (j.by_day["2026-02-20"]?.winc !== "500") throw new Error("expected by_day[2026-02-20].winc 500, got " + JSON.stringify(j.by_day));
  if (j.by_day["2026-03-05"]?.nanoTON !== "23") throw new Error("expected by_day[2026-03-05].nanoTON 23, got " + JSON.stringify(j.by_day));
  if (j.by_month["2026-03"]?.nanoTON !== "23") throw new Error("expected by_month[2026-03].nanoTON 23, got " + JSON.stringify(j.by_month));
  if (Object.keys(j.by_day).length !== 3) throw new Error("expected exactly 3 by_day buckets (the undated receipt must not create a 4th), got " + JSON.stringify(j.by_day));
  if (Object.keys(j.by_month).length !== 3) throw new Error("expected exactly 3 by_month buckets (the undated receipt must not create a 4th), got " + JSON.stringify(j.by_month));
  if (j.receipts.length !== 5) throw new Error("expected the receipts array to have all 5 valid receipts, got " + j.receipts.length);
  // The raw receipts array is verbatim, unlike the aggregated sums above — it must
  // still show the ORIGINAL "nanoton" casing for the receipt that was actually written
  // that way (receipt.ts never normalizes what a receipt says on read).
  const rawUndated = j.receipts.find((r) => r.locator === "tp-loc-undated");
  if (!rawUndated || rawUndated.unit !== "nanoton") throw new Error("expected the raw receipts array to preserve the legacy \"nanoton\" casing verbatim, got " + JSON.stringify(rawUndated));
' "$LEDGER_JSON" || { echo "[FAIL] ledger --json multi-backend/unpriced/undated aggregation is wrong"; echo "$LEDGER_JSON"; exit 1; }
echo "[PASS] ledger --json: 3 backends aggregated correctly; unpriced receipt counted but excluded from cost sums; undated-but-priced receipt counted in by_backend but excluded from by_day/by_month; malformed line counted as skipped_lines; legacy/current nanoTON casing merged in aggregation but preserved verbatim in the raw receipts array (#571, #751)"

LEDGER_HUMAN=$(cb ledger)
printf '%s' "$LEDGER_HUMAN" | grep -q 'arweave' || { echo "[FAIL] ledger (human) does not mention arweave: $LEDGER_HUMAN"; exit 1; }
printf '%s' "$LEDGER_HUMAN" | grep -q 'turbo' || { echo "[FAIL] ledger (human) does not mention turbo: $LEDGER_HUMAN"; exit 1; }
printf '%s' "$LEDGER_HUMAN" | grep -q 'ton-provider' || { echo "[FAIL] ledger (human) does not mention ton-provider: $LEDGER_HUMAN"; exit 1; }
printf '%s' "$LEDGER_HUMAN" | grep -q '1 unpriced' || { echo "[FAIL] ledger (human) does not report 1 unpriced receipt: $LEDGER_HUMAN"; exit 1; }
printf '%s' "$LEDGER_HUMAN" | grep -q '1 undated' || { echo "[FAIL] ledger (human) does not report 1 undated receipt: $LEDGER_HUMAN"; exit 1; }
printf '%s' "$LEDGER_HUMAN" | grep -q '1 unreadable line' || { echo "[FAIL] ledger (human) does not report 1 unreadable skipped line: $LEDGER_HUMAN"; exit 1; }
echo "[PASS] ledger (human report) surfaces all 3 backends plus the unpriced/undated/skipped-line caveats (#571)"

LEDGER_CSV=$(cb ledger --csv)
CSV_FIRST_LINE=$(printf '%s\n' "$LEDGER_CSV" | head -1)
[ "$CSV_FIRST_LINE" = "$EXPECTED_HEADER" ] \
  || { echo "[FAIL] ledger --csv header row is wrong: $CSV_FIRST_LINE"; exit 1; }
CSV_LINES=$(printf '%s\n' "$LEDGER_CSV" | wc -l | tr -d ' ')
[ "$CSV_LINES" = "6" ] \
  || { echo "[FAIL] expected 6 csv lines (1 header + 5 receipts, the malformed line excluded), got $CSV_LINES"; echo "$LEDGER_CSV"; exit 1; }
printf '%s' "$LEDGER_CSV" | grep -q 'ar-loc-1' || { echo "[FAIL] ledger --csv missing the arweave receipt's locator: $LEDGER_CSV"; exit 1; }
printf '%s' "$LEDGER_CSV" | grep -q 'turbo-loc-1' || { echo "[FAIL] ledger --csv missing the turbo receipt's locator: $LEDGER_CSV"; exit 1; }
printf '%s' "$LEDGER_CSV" | grep -q 'tp-loc-undated' || { echo "[FAIL] ledger --csv missing the undated ton-provider receipt's locator: $LEDGER_CSV"; exit 1; }
printf '%s' "$LEDGER_CSV" | grep -q 'tp-loc-dated-nanoTON' || { echo "[FAIL] ledger --csv missing the current-cased ton-provider receipt's locator: $LEDGER_CSV"; exit 1; }
printf '%s' "$LEDGER_CSV" | grep -q 'ar-loc-unpriced' \
  || { echo "[FAIL] ledger --csv missing the unpriced receipt's locator (--csv is a raw export, unpriced receipts ARE included): $LEDGER_CSV"; exit 1; }
# --csv is a raw per-receipt export (unlike --json's aggregated sums above) — it must
# show each receipt's ORIGINAL unit casing verbatim, including the legacy "nanoton".
printf '%s' "$LEDGER_CSV" | grep 'tp-loc-undated' | grep -q ',77,nanoton,' \
  || { echo "[FAIL] ledger --csv did not preserve the legacy 'nanoton' casing verbatim for tp-loc-undated: $LEDGER_CSV"; exit 1; }
echo "[PASS] ledger --csv: one row per receipt (5), correct header, malformed line not included, legacy unit casing preserved verbatim (#571, #751)"

echo "== (c) --csv wins when both --json and --csv are given (documented mutual exclusivity) =="
LEDGER_BOTH=$(cb ledger --json --csv)
printf '%s\n' "$LEDGER_BOTH" | head -1 | grep -qF 'timestamp,backend,locator' \
  || { echo "[FAIL] ledger --json --csv did not produce CSV output (--csv should win): $(printf '%s\n' "$LEDGER_BOTH" | head -1)"; exit 1; }
echo "[PASS] --csv takes precedence over --json when both flags are given"

echo "== (d) shape-valid but calendrically impossible timestamps are undated, not bucketed (#766) =="
export CYPHER_BRAIN_HOME="$TMP/dates-home"
mkdir -p "$CYPHER_BRAIN_HOME"
node --experimental-strip-types --import "$ROOT/scripts/dev-cli-loader.mjs" -e "
import('$ROOT/src/lib/receipt.ts').then(async (m) => {
  // A real, valid day — must survive and be bucketed normally.
  await m.appendReceipt({
    timestamp: '2026-03-10T00:00:00.000Z',
    backend: 'arweave',
    locator: 'ar-loc-real',
    artifact_sha256: 'e'.repeat(64),
    size_bytes: 100,
    payer_address: null,
    cost: '10',
    unit: 'winston',
    raw: {},
  });
  // Shape-valid (matches ISO_UTC_PATTERN's digit-placement-only check) but a day that
  // does not exist in February.
  await m.appendReceipt({
    timestamp: '2026-02-31T00:00:00.000Z',
    backend: 'arweave',
    locator: 'ar-loc-feb31',
    artifact_sha256: 'f'.repeat(64),
    size_bytes: 100,
    payer_address: null,
    cost: '20',
    unit: 'winston',
    raw: {},
  });
  // Shape-valid but a month that does not exist at all.
  await m.appendReceipt({
    timestamp: '9999-99-99T00:00:00.000Z',
    backend: 'arweave',
    locator: 'ar-loc-badmonth',
    artifact_sha256: '0'.repeat(64),
    size_bytes: 100,
    payer_address: null,
    cost: '30',
    unit: 'winston',
    raw: {},
  });
  // Positive control (Codex review): a GENUINELY valid, shape-matching timestamp
  // whose year happens to fall in 0-99 must NOT be misclassified as undated.
  // Date.UTC()'s multi-arg form (like the Date constructor) special-cases a 0-99
  // 'year' argument by adding 1900 to it, which — if used directly instead of via
  // setUTCFullYear() — would make this exact receipt fail the round-trip check for
  // the wrong reason and get wrongly excluded from by_day.
  await m.appendReceipt({
    timestamp: '0000-01-01T00:00:00.000Z',
    backend: 'arweave',
    locator: 'ar-loc-year-zero',
    artifact_sha256: '1'.repeat(64),
    size_bytes: 100,
    payer_address: null,
    cost: '40',
    unit: 'winston',
    raw: {},
  });
});
"
LEDGER_DATES_JSON=$(cb ledger --json)
node -e '
  const j = JSON.parse(process.argv[1]);
  if (j.total_receipts !== 4) throw new Error("expected total_receipts 4, got " + j.total_receipts);
  // Before #766, both impossible timestamps passed the digit-placement-only regex and
  // were treated as real dated receipts — undated_receipts would be 0 here, not 2.
  if (j.undated_receipts !== 2) throw new Error("expected undated_receipts 2 (the two calendrically impossible timestamps), got " + j.undated_receipts);
  if (Object.keys(j.by_day).length !== 2) throw new Error("expected exactly 2 by_day buckets (the real day plus the year-0000 receipt), got " + JSON.stringify(j.by_day));
  if (j.by_day["2026-03-10"]?.winston !== "10") throw new Error("expected the real days by_day bucket to be present and correct, got " + JSON.stringify(j.by_day));
  if (j.by_day["0000-01-01"]?.winston !== "40") throw new Error("expected the year-0000 receipt to be bucketed normally, not misclassified as undated, got " + JSON.stringify(j.by_day));
  if ("2026-02-31" in j.by_day) throw new Error("2026-02-31 (not a real calendar day) must NOT appear in by_day, got " + JSON.stringify(j.by_day));
  if ("9999-99-99" in j.by_day) throw new Error("9999-99-99 (not a real calendar month) must NOT appear in by_day, got " + JSON.stringify(j.by_day));
  // All 4 receipts ARE priced, so all 4 must still be counted in by_backend (undated
  // only excludes a receipt from by_day/by_month, never from by_backend).
  if (j.by_backend.arweave?.count !== 4) throw new Error("expected by_backend.arweave.count 4 (undated-but-priced receipts are still counted here), got " + JSON.stringify(j.by_backend));
' "$LEDGER_DATES_JSON" || { echo "[FAIL] ledger --json did not treat shape-valid-but-calendrically-impossible timestamps as undated (#766)"; echo "$LEDGER_DATES_JSON"; exit 1; }
echo "[PASS] ledger --json: Feb 31 and month-99 timestamps are excluded from by_day and counted as undated; a genuinely valid year-0000 timestamp is still bucketed normally (#766)"

echo "== (e) issue #737: ledger --json survives a downstream reader closing its pipe early (EPIPE on stdout) =="
# printJson() (src/lib/ui.ts) used to install its no-op EPIPE 'error' listener only on
# process.stderr — right for every OTHER writer in that file (all stderr-only
# decoration), but wrong for printJson() itself, which puts its output on STDOUT. A
# payload comfortably bigger than one pipe buffer's worth (commonly 64 KiB) run
# through a reader that closes almost immediately (`head -c 1`) reproduces the
# original bug report's "64 MiB payload piped to head -c 1" repro at a much smaller,
# selftest-friendly scale — cb was still mid-write when the reader's end closed, and
# the resulting async EPIPE 'error' event on stdout crashed the process with an
# uncaught exception before this fix.
export CYPHER_BRAIN_HOME="$TMP/epipe-home"
mkdir -p "$CYPHER_BRAIN_HOME"
# 2500 valid receipts (~780 KB) — comfortably past a typical 64 KiB pipe buffer,
# empirically confirmed (against the pre-#737-fix code, before this test existed) to
# reliably reproduce the crash at this size on this machine. cypher_brain_receipt_version
# must match RECEIPT_VERSION (receipt.ts) or readReceipts() discards the line as
# wrong-shape, which would make the --json payload tiny again and silently defeat the
# whole point of this test.
node -e '
  const fs = require("fs");
  const lines = [];
  for (let i = 0; i < 2500; i++) {
    lines.push(JSON.stringify({
      cypher_brain_receipt_version: 1,
      timestamp: "2026-01-15T00:00:00.000Z",
      backend: "arweave",
      locator: "epipe-loc-" + i,
      artifact_sha256: "a".repeat(64),
      size_bytes: 1000,
      payer_address: "0x" + "b".repeat(40),
      cost: "0.001",
      unit: "AR",
    }));
  }
  fs.writeFileSync(process.argv[1], lines.join("\n") + "\n");
' "$CYPHER_BRAIN_HOME/receipt-ledger.jsonl"
# Confirm the UNPIPED payload actually is all 2500 receipts, comfortably past a typical
# 64 KiB pipe buffer, BEFORE trusting the piped run below (Codex review): "no EPIPE
# error, exit 0" also describes a regression that silently truncated/rejected most of
# the 2500 fixture receipts — a payload small enough to fit inside one pipe buffer read
# would never trigger the async EPIPE this test exists to guard against, so it would
# report [PASS] for having nothing to prove instead of for surviving the real hazard.
cb ledger --json > "$TMP/epipe-full.json"
grep -q '"total_receipts":2500' "$TMP/epipe-full.json" \
  || { echo "[FAIL] ledger --json (unpiped) did not report all 2500 fixture receipts — the EPIPE check below would prove nothing"; exit 1; }
EPIPE_FULL_SIZE=$(wc -c < "$TMP/epipe-full.json" | tr -d ' ')
[ "$EPIPE_FULL_SIZE" -gt 100000 ] \
  || { echo "[FAIL] ledger --json (unpiped) payload is only $EPIPE_FULL_SIZE bytes — too small to reliably exercise the EPIPE this test exists to guard"; exit 1; }
echo "[PASS] ledger --json emits all 2500 fixture receipts ($EPIPE_FULL_SIZE bytes) before the piped EPIPE check"
set +e
set +o pipefail
cb ledger --json 2> "$TMP/epipe-err.log" | head -c 1 > /dev/null
EPIPE_PIPE_RC="${PIPESTATUS[0]}"
set -o pipefail
set -e
[ "$EPIPE_PIPE_RC" = "0" ] \
  || { echo "[FAIL] ledger --json exited $EPIPE_PIPE_RC when piped through 'head -c 1' (uncaught EPIPE?)"; cat "$TMP/epipe-err.log"; exit 1; }
grep -qi 'epipe' "$TMP/epipe-err.log" \
  && { echo "[FAIL] ledger --json printed an EPIPE error to stderr when piped through 'head -c 1':"; cat "$TMP/epipe-err.log"; exit 1; }
echo "[PASS] ledger --json survives a downstream reader closing its pipe early (#737 EPIPE guard now covers stdout)"

echo "[PASS] all ledger selftest checks passed"
