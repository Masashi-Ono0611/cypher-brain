#!/usr/bin/env bash
# Storage round-trip proof for the ton-provider backend (src/lib/backends/ton-provider.ts,
# issue #396) — CI-safe: no real TON network, no real Tonkeeper signature, no real
# mytonprovider.org query. Three things are mocked:
#   - mytonprovider.org's provider search (a local HTTP server, CYPHER_BRAIN_TON_PROVIDER_
#     MYTONPROVIDER_URL) — returns one fake candidate with a pubkey this script controls.
#   - tonapi's account-state endpoint (CYPHER_BRAIN_TON_TONAPI_URL) — always answers
#     'active', standing in for "a human signed the deeplink and it landed on-chain".
#   - the local ephemeral tonutils-storage daemon AND the notify binary — PATH-shimmed/
#     env-pointed at scripts/mock-tonutils.mjs and a small fake notify script, so the REAL
#     backend code (bag creation, cost math, StorageV1 cell building, on-chain polling,
#     notify-with-retry) all run against those stand-ins.
# What this cannot prove: TON Storage/StorageV1 itself, or that a REAL provider would
# accept the deploy — that is operator-run dogfooding (docs/ton-storage-status.md), not a
# CI-safe selftest. What IS proven here is byte-for-byte in a separate, already-run cross-
# language check against scripts/go/storage-v1-client's tested Go implementation (see
# ton-provider.ts's header comment) — this selftest is about cypher-brain's OWN
# orchestration, not the on-chain cell layout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb()/sha(), see scripts/selftest-lib.sh (#572)

TMP="$(mktemp -d)"
MYTONPROVIDER_PID=""
TONAPI_PID=""
cleanup() {
  [ -n "$MYTONPROVIDER_PID" ] && kill "$MYTONPROVIDER_PID" 2>/dev/null
  [ -n "$TONAPI_PID" ] && kill "$TONAPI_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

export CYPHER_BRAIN_HOME="$TMP/keys"
export MOCK_TON_STORE="$TMP/store"
mkdir -p "$MOCK_TON_STORE"
# Isolates the schedule-eligibility positive controls below (#396 PR2) from the real
# system launchd/cron — same isolation scripts/selftest-schedule.sh uses.
export CYPHER_BRAIN_SCHEDULE_DIR="$TMP/sched"
export CYPHER_BRAIN_LAUNCHD_DIR="$TMP/launchagents"

# A fixed, syntactically-valid ProviderKey pubkey — this script's mytonprovider.org mock
# and its notify-response mock must agree on it (real code cross-checks pubkey shape but
# not its cryptographic validity — see ton-provider.ts's field notes on why the pubkey,
# not the wallet address, is the on-chain identifier).
PROVIDER_PUBKEY="abababababababababababababababababababababababababababababababab"
PROVIDER_WALLET="UQCCrKrQHLpB75vvrd5js78eB7qK6v7Cpz4WJpV2DoZnY-GC"
# Declared here (not down at its export near the push tests) so the tonapi mock
# below can be launched already knowing which address the pre-deploy funds-check
# positive control (#396 Phase B) needs to answer with a low balance.
TON_PROVIDER_OWNER_ADDR="0:0000000000000000000000000000000000000000000000000000000000000001"
LOW_BALANCE_FLAG="$TMP/low-owner-balance-flag"

# ---- mock mytonprovider.org: POST /api/v1/providers/search -> one live candidate ----
cat > "$TMP/mock-mytonprovider.mjs" <<'MOCKEOF'
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
const port = Number(process.argv[2]);
const pubkey = process.argv[3];
const address = process.argv[4];
const emptyFlagPath = process.argv[5]; // if this file exists, respond with zero candidates
const badSpanFlagPath = process.argv[6]; // if this file exists, min_span rounds up past max_span
const highPriceFlagPath = process.argv[7]; // if this file exists, price -> a rate that clears the #403 bounty floor for the high-price test payload
createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const empty = emptyFlagPath && existsSync(emptyFlagPath);
    const badSpan = badSpanFlagPath && existsSync(badSpanFlagPath);
    const highPrice = highPriceFlagPath && existsSync(highPriceFlagPath);
    res.end(
      JSON.stringify({
        providers: empty
          ? []
          : [
              {
                pubkey,
                address,
                uptime: 99.5,
                rating: 20.5,
                // -> rate 800 nanoTON/MB/day (price / (1024*200*30)); the high-price
                // control (#403) uses -> rate 2e8 nanoTON/MB/day instead, comfortably
                // clearing the provider-side bounty floor for that test's ~50KB payload
                // (see estimatedBountyNano()'s comment for the real formula this mirrors).
                price: highPrice ? 1228800000000000 : 4915200000,
                // Normal case: min_span=7 days exactly, well under max_span. Bad-span
                // case: min_span rounds UP to 2 days (ceil(90000/86400)) but max_span is
                // only 1.5 days — exercises spanDaysFor()'s own guard.
                min_span: badSpan ? 90000 : 604800,
                max_span: badSpan ? 129600 : 8294400,
                max_bag_size_bytes: 1073741824,
                status: 0,
              },
            ],
      }),
    );
  });
}).listen(port, '127.0.0.1');
MOCKEOF
MYTONPROVIDER_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node "$TMP/mock-mytonprovider.mjs" "$MYTONPROVIDER_PORT" "$PROVIDER_PUBKEY" "$PROVIDER_WALLET" "$TMP/empty-providers-flag" "$TMP/bad-span-flag" "$TMP/high-price-flag" &
MYTONPROVIDER_PID=$!
export CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL="http://127.0.0.1:$MYTONPROVIDER_PORT"

# ---- mock tonapi: GET /v2/blockchain/accounts/<addr>, PLUS (#396 Phase B) GET
# /v2/rates?... for the USD-estimate line and an owner-specific low-balance mode for
# the pre-deploy funds-check positive control below. The low-balance flag is keyed to
# the EXACT owner address string this script exports as CYPHER_BRAIN_TON_PROVIDER_OWNER
# (already in raw workchain:hex form, so Address.parse(...).toRawString() round-trips
# it unchanged) — any OTHER address keeps returning the generous fixed balance.
# Issue #479: wallet.ts's tonWalletBalance() queries the PLAIN /v2/accounts/<addr>
# endpoint (no blockchain/ prefix — ton-provider.ts's fetchAccountState() above is the
# only caller of the blockchain/ one). This mock distinguishes the two prefixes so a
# never-active-wallet balance check can be exercised deterministically: the unfunded
# flag file's CONTENTS name a single address to answer 'nonexist'/balance:0 for on that
# plain endpoint (matching tonapi.io's real /v2/accounts response for an address that
# has never sent/received a transaction, confirmed directly against the live API), while
# any other /v2/accounts/<addr> query — and every /v2/blockchain/accounts/<addr> one —
# keeps falling through to the generic active/frozen/low-balance/seen-tracking handling
# below.
# Issue #638: an address's FIRST-EVER query (across either prefix) reports 'nonexist',
# and EVERY query after that reports 'active' — unless the frozen/never-active
# overrides below apply, which always take priority regardless of "seen" state. This
# simulates a genuine nonexist -> active transition for a truly fresh deploy (so
# ton-provider.ts's own already-active check, added for #638, sees "not yet funded"
# and proceeds to fund it — exercising the real broadcast/deeplink path, not skipping
# it from the very first push), while a genuine RETRY that derives the SAME contract
# address (same bagId/owner/etc, see buildDeploy()'s own comment) sees 'active'
# immediately on that check, exactly like a real retry against an already-landed
# deploy would from a real tonapi — this is what lets the #638 regression test below
# prove the fix without ever needing a second real broadcast to succeed.
cat > "$TMP/mock-tonapi.mjs" <<'MOCKEOF'
import { createServer } from 'node:http';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
const port = Number(process.argv[2]);
const ownerAddr = process.argv[3];
const lowBalanceFlagPath = process.argv[4];
const frozenAddrFlagPath = process.argv[5]; // if present, its CONTENTS name an address to report 'frozen' for
const seqnoFilePath = process.argv[6]; // if present, its CONTENTS are the seqno to answer /methods/seqno with (default 0)
const broadcastLogPath = process.argv[7]; // every accepted POST /v2/blockchain/message body is appended here, one BOC per line
const neverActiveFlagPath = process.argv[8]; // if present, every NON-owner address (i.e. a just-deployed contract) reports 'uninitialized' forever — issue #480's waitForContractActive() timeout positive control
const unfundedAddrFlagPath = process.argv[9]; // if present, its CONTENTS name an address to report 'nonexist'/balance:0 for on plain /v2/accounts/<addr>
const lookupFailAddrFlagPath = process.argv[10]; // issue #640: if present, its CONTENTS name an address for which GET /v2/blockchain/accounts/<addr> (fetchAccountState's own endpoint) answers HTTP 500 -- a TRANSIENT lookup failure, distinct from every 200-with-status response above (which are all real, non-error account states)

const seenAddrs = new Set(); // issue #638: first-ever query for an address -> 'nonexist'; every query after that -> 'active' (see header comment above)

createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/v2/rates') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rates: { TON: { prices: { USD: 3.5 } } } }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v2/blockchain/message') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (broadcastLogPath) appendFileSync(broadcastLogPath, `${body}\n`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
    });
    return;
  }
  const seqnoMatch = url.pathname.match(/^\/v2\/blockchain\/accounts\/([^/]+)\/methods\/seqno$/);
  if (seqnoMatch) {
    const seqno = seqnoFilePath && existsSync(seqnoFilePath) ? readFileSync(seqnoFilePath, 'utf8').trim() : '0';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, exit_code: 0, decoded: { state: Number(seqno) } }));
    return;
  }
  const blockchainAccountMatch = url.pathname.match(/^\/v2\/blockchain\/accounts\/([^/]+)$/);
  if (blockchainAccountMatch) {
    const lookupFailAddr = lookupFailAddrFlagPath && existsSync(lookupFailAddrFlagPath) ? readFileSync(lookupFailAddrFlagPath, 'utf8').trim() : null;
    if (lookupFailAddr && blockchainAccountMatch[1] === lookupFailAddr) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'simulated transient tonapi failure (issue #640 positive control)' }));
      return;
    }
  }
  const plainAccountMatch = url.pathname.match(/^\/v2\/accounts\/([^/]+)$/);
  if (plainAccountMatch) {
    const unfundedAddr = unfundedAddrFlagPath && existsSync(unfundedAddrFlagPath) ? readFileSync(unfundedAddrFlagPath, 'utf8').trim() : null;
    if (unfundedAddr && plainAccountMatch[1] === unfundedAddr) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ address: unfundedAddr, balance: 0, status: 'nonexist' }));
      return;
    }
  }
  const frozenAddr = frozenAddrFlagPath && existsSync(frozenAddrFlagPath) ? readFileSync(frozenAddrFlagPath, 'utf8').trim() : null;
  const isFrozenTarget = frozenAddr && url.pathname.includes(frozenAddr);
  const lowBalance = lowBalanceFlagPath && existsSync(lowBalanceFlagPath) && url.pathname.includes(ownerAddr);
  const neverActive = neverActiveFlagPath && existsSync(neverActiveFlagPath) && !url.pathname.includes(ownerAddr);
  let status;
  if (isFrozenTarget) {
    status = 'frozen';
  } else {
    // issue #638: see the "seen" tracking header comment above this mock's source.
    // `firstQuery` is computed even when neverActive applies (below), so a GENUINELY
    // fresh address still reads as 'nonexist' on its first-ever query even under the
    // #480 "never confirms" positive control -- otherwise that flag would make ton-
    // provider.ts's own #638 already-non-fresh check see 'uninitialized' (not
    // 'nonexist') on the very FIRST query for a brand-new address too, incorrectly
    // skipping funding before a broadcast ever had a chance to happen.
    const addrMatch = url.pathname.match(/^\/v2\/(?:blockchain\/)?accounts\/([^/]+)$/);
    const addr = addrMatch ? addrMatch[1] : null;
    const firstQuery = addr !== null && !seenAddrs.has(addr);
    if (addr) seenAddrs.add(addr);
    if (firstQuery) {
      status = 'nonexist';
    } else if (neverActive) {
      status = 'uninitialized';
    } else {
      status = 'active';
    }
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status, balance: lowBalance ? 1 : 5000000000 }));
}).listen(port, '127.0.0.1');
MOCKEOF
FROZEN_ADDR_FLAG="$TMP/frozen-addr-flag"
SEQNO_FILE="$TMP/seqno-value"
BROADCAST_LOG="$TMP/broadcast-log"
NEVER_ACTIVE_FLAG="$TMP/never-active-flag"
UNFUNDED_ADDR_FLAG="$TMP/unfunded-addr-flag"
LOOKUP_FAIL_ADDR_FLAG="$TMP/lookup-fail-addr-flag"
TONAPI_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node "$TMP/mock-tonapi.mjs" "$TONAPI_PORT" "$TON_PROVIDER_OWNER_ADDR" "$LOW_BALANCE_FLAG" "$FROZEN_ADDR_FLAG" "$SEQNO_FILE" "$BROADCAST_LOG" "$NEVER_ACTIVE_FLAG" "$UNFUNDED_ADDR_FLAG" "$LOOKUP_FAIL_ADDR_FLAG" &
TONAPI_PID=$!
export CYPHER_BRAIN_TON_TONAPI_URL="http://127.0.0.1:$TONAPI_PORT"

READY=0
for _ in $(seq 1 50); do
  if curl -s "http://127.0.0.1:$MYTONPROVIDER_PORT" >/dev/null 2>&1 && curl -s "http://127.0.0.1:$TONAPI_PORT" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done
[ "$READY" = 1 ] || { echo "[FAIL] mock mytonprovider.org/tonapi servers did not come up on ports $MYTONPROVIDER_PORT/$TONAPI_PORT"; exit 1; }

# ---- PATH shim: tonutils-storage -> the same mock daemon selftest-ton.sh uses ----
SHIM="$TMP/bin"
mkdir -p "$SHIM"
cat > "$SHIM/tonutils-storage" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/scripts/mock-tonutils.mjs" "\$@"
EOF
chmod +x "$SHIM/tonutils-storage"
export PATH="$SHIM:$PATH"

# ---- fake notify binary: mimics scripts/go/storage-v1-client's plain-text output ----
# issue #651: also dispatches on a `rates` subcommand (rates.go) — put()'s
# checkProviderLiveTerms() shells out to it right before every deploy is built, so
# EVERY push test below (not just the dedicated #651 positive controls further down)
# depends on this branch answering with terms permissive enough not to trip that check.
# Defaults (available=true, a rate well under BOTH mock registry prices this script
# ever configures — 800 and 2e8 nanoTON/MB/day, see mock-mytonprovider.mjs above — and
# a span range wide enough to cover every span this script ever computes) are
# deliberately generous so ONLY the dedicated rates-mismatch positive controls below
# (which set one of the three override flags) ever see a refusal.
cat > "$SHIM/fake-notify" <<EOF
#!/usr/bin/env bash
# Args: notify --provider-pubkey <hex> --contract <addr> --mainnet
#    or rates  --provider-pubkey <hex> --size-bytes <n> --mainnet
STATE="$TMP/notify-downloaded"
REASON_FILE="$TMP/notify-reason-override"
RATES_UNAVAILABLE_FLAG="$TMP/rates-unavailable-flag"
RATES_HIGH_RATE_FLAG="$TMP/rates-high-rate-flag"
RATES_NARROW_SPAN_FLAG="$TMP/rates-narrow-span-flag"
SUB="\$1"
if [ "\$SUB" = "rates" ]; then
  printf '%s\n' "\$@" > "$TMP/rates-args.log"
  AVAILABLE=true
  [ -f "\$RATES_UNAVAILABLE_FLAG" ] && AVAILABLE=false
  RATE=750
  [ -f "\$RATES_HIGH_RATE_FLAG" ] && RATE=999999999
  MIN_SPAN=1
  MAX_SPAN=4294967295
  [ -f "\$RATES_NARROW_SPAN_FLAG" ] && MAX_SPAN=100000
  echo "== rates response =="
  echo "  available:            \$AVAILABLE"
  echo "  rate_nano_per_mb_day: \$RATE"
  echo "  min_bounty_nano:      50000000"
  echo "  space_available:      999999999999"
  echo "  min_span:             \$MIN_SPAN"
  echo "  max_span:             \$MAX_SPAN"
  exit 0
fi
# Downloaded byte count is read from a control file this script writes on push, so the
# "wait until fully downloaded" retry loop can be exercised deterministically (see the
# partial-then-full positive control below) instead of only ever answering "done" once.
# issue #404: records the args THIS call received, overwriting each time — the
# network-selection positive controls below check the MOST RECENT call only.
printf '%s\n' "\$@" > "$TMP/notify-args.log"
# issue #561 regression guard: notify.go ALWAYS prints a pre-flight "status:" line
# (its own on-chain account-state check) BEFORE the "== notify response ==" marker,
# with a value that can differ from the real response's status. Mimic that shape here
# — with a deliberately distinct, obviously-wrong value — so ton-provider.ts's
# parseNotifyOutput() greedily matching the FIRST "status:" line in the output (instead
# of the one inside the marked response block) would be caught by this selftest.
echo "  status: preflight-should-be-ignored — some verdict"
echo "== notify response =="
echo "  status:     active"
echo "  reason:     \$(cat "\$REASON_FILE" 2>/dev/null || echo ok)"
# issue #652: an OPTIONAL per-call sequence file (newline-separated byte counts) lets a
# test drive a SPECIFIC, deterministic sequence of downloaded values across successive
# retry-loop calls (e.g. "partial, then a DECREASE, then full") without racing real
# wall-clock timing against a backgrounded push — each call increments a counter and
# reads that line number, falling past the end to the last line. Absent (the common
# case, every OTHER test here), behavior is unchanged: the single static \$STATE value.
SEQ_FILE="$TMP/notify-downloaded-sequence"
if [ -f "\$SEQ_FILE" ]; then
  COUNTER_FILE="$TMP/notify-call-counter"
  N=\$(( \$(cat "\$COUNTER_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "\$N" > "\$COUNTER_FILE"
  DL=\$(sed -n "\${N}p" "\$SEQ_FILE")
  [ -n "\$DL" ] || DL=\$(tail -n1 "\$SEQ_FILE")
else
  DL=\$(cat "\$STATE" 2>/dev/null || echo 0)
fi
echo "  downloaded: \$DL bytes"
EOF
chmod +x "$SHIM/fake-notify"
export CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN="$SHIM/fake-notify"

export CYPHER_BRAIN_TON_PROVIDER_OWNER="$TON_PROVIDER_OWNER_ADDR"
export CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND="5000000000" # 5 TON — generous, well above the tiny test file's computed cost
export CYPHER_BRAIN_YES=1

MARKER="ton-provider-marker-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
SRC="$TMP/brain-src"
mkdir -p "$SRC"
printf '%s\n' "$MARKER" > "$SRC/note.txt"

echo "== snapshot =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap.age"
ORIG=$(sha "$TMP/snap.age")
SIZE=$(stat -f%z "$TMP/snap.age" 2>/dev/null || stat -c%s "$TMP/snap.age")

echo "== estimate --backend ton-provider (real priced query against the mock registry) =="
EST=$(cb estimate --in "$TMP/snap.age" --backend ton-provider --json)
printf '%s' "$EST" | grep -q '"unit":"nanoTON"' || { echo "[FAIL] estimate did not price in nanoTON: $EST"; exit 1; }
echo "[PASS] estimate returns a real nanoTON cost"
# #396 Phase B: usd_estimate is now populated too (tonUsdRate(), estimate.ts), sourced
# from the mock tonapi's /v2/rates handler above (fixed at $3.5/TON) — a real number,
# not the null every OTHER field-completeness gap in this backend used to leave.
printf '%s' "$EST" | grep -q '"usd_estimate":null' && { echo "[FAIL] estimate's usd_estimate is null despite the mock tonapi rates endpoint answering"; echo "$EST"; exit 1; }
printf '%s' "$EST" | grep -Eq '"usd_estimate":[0-9]' || { echo "[FAIL] estimate did not include a numeric usd_estimate: $EST"; exit 1; }
echo "[PASS] estimate --json also carries a real usd_estimate (tonapi rates, #396 Phase B)"

echo "== push --backend ton-provider (deploy -> wait active -> notify-until-full) =="
echo "$SIZE" > "$TMP/notify-downloaded" # first notify call already reports "fully downloaded" — the common case
LOC=$(cb push --in "$TMP/snap.age" --backend ton-provider --save-locator "$TMP/loc.tsv" 2>"$TMP/push.err")
printf '%s' "$LOC" | grep -Eq '^ton-provider:v1:[0-9a-f]{64}$' || { echo "[FAIL] locator shape: $LOC"; exit 1; }
echo "[PASS] locator matches ton-provider:v1:<64-hex>"
grep -q "selected provider $PROVIDER_PUBKEY" "$TMP/push.err" || { echo "[FAIL] did not report the selected provider"; exit 1; }
echo "[PASS] provider selection ran against the mock registry"
# #396 Phase B: the mock tonapi's balance for this owner is generously sufficient
# (5 TON vs. a tiny test snapshot's nanoTON-scale cost) — the advisory funds check
# must stay SILENT here. See the dedicated low-balance positive control below for
# the warning actually firing.
if grep -q 'balance.*looks lower than' "$TMP/push.err"; then
  echo "[FAIL] the funds-check warning fired despite a sufficient mock balance"; cat "$TMP/push.err"; exit 1
fi
echo "[PASS] the pre-deploy funds check stays silent when the owner's balance is sufficient"

# #484: a successful ton-provider push must now write a receipt (previously onReceipt
# was arweave/turbo-only, so ledger's cumulative-cost tracking silently excluded a
# real paid backend with its own MAX_SPEND cap — doctor/audit/estimate/schedule
# already treated ton-provider on par with the other backends; ledger was the one
# place it diverged). Verified three ways: the raw receipt-ledger.jsonl line, `ledger`
# (human), and `ledger --json` — same three-way check selftest-receipt.mjs's own
# arweave/turbo coverage already does.
echo "== push --backend ton-provider writes a receipt, and ledger reports it (#484) =="
RECEIPT_LEDGER_PATH_TP="$CYPHER_BRAIN_HOME/receipt-ledger.jsonl"
[ -f "$RECEIPT_LEDGER_PATH_TP" ] || { echo "[FAIL] no receipt-ledger.jsonl was written by the ton-provider push"; exit 1; }
TP_RECEIPT=$(node -e '
  const fs = require("node:fs");
  const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const r = lines.find((e) => e.backend === "ton-provider");
  if (!r) { console.error("no ton-provider receipt found among " + lines.length + " line(s)"); process.exit(1); }
  console.log(JSON.stringify(r));
' "$RECEIPT_LEDGER_PATH_TP") || { echo "[FAIL] could not find a ton-provider receipt in $RECEIPT_LEDGER_PATH_TP"; cat "$RECEIPT_LEDGER_PATH_TP"; exit 1; }
printf '%s' "$TP_RECEIPT" | grep -q '"unit":"nanoton"' || { echo "[FAIL] ton-provider receipt unit is not nanoton: $TP_RECEIPT"; exit 1; }
printf '%s' "$TP_RECEIPT" | grep -Eq '"cost":"[0-9]+"' || { echo "[FAIL] ton-provider receipt cost is not a plain digit string: $TP_RECEIPT"; exit 1; }
printf '%s' "$TP_RECEIPT" | grep -F "\"locator\":\"$LOC\"" >/dev/null \
  || { echo "[FAIL] ton-provider receipt locator does not match what push printed ($LOC): $TP_RECEIPT"; exit 1; }
echo "[PASS] a successful ton-provider push writes a receipt (backend/locator/nanoton cost all correct)"

LEDGER_HUMAN_TP=$(cb ledger)
printf '%s' "$LEDGER_HUMAN_TP" | grep -q 'ton-provider' || { echo "[FAIL] ledger (human) does not mention ton-provider: $LEDGER_HUMAN_TP"; exit 1; }
printf '%s' "$LEDGER_HUMAN_TP" | grep -q 'nanoton' || { echo "[FAIL] ledger (human) does not show a nanoton cost: $LEDGER_HUMAN_TP"; exit 1; }
echo "[PASS] ledger (human report) includes the ton-provider push"

LEDGER_JSON_TP=$(cb ledger --json)
node -e '
  const j = JSON.parse(process.argv[1]);
  const tp = j.by_backend?.["ton-provider"];
  if (!tp || typeof tp.cost?.nanoton !== "string" || !/^[0-9]+$/.test(tp.cost.nanoton)) {
    console.error("ledger --json by_backend[\"ton-provider\"] missing/malformed: " + JSON.stringify(tp));
    process.exit(1);
  }
  if (tp.count < 1) { console.error("ledger --json ton-provider count is " + tp.count + ", expected >= 1"); process.exit(1); }
' "$LEDGER_JSON_TP" || { echo "[FAIL] ledger --json by_backend.ton-provider is missing or malformed"; echo "$LEDGER_JSON_TP"; exit 1; }
echo "[PASS] ledger --json by_backend.ton-provider reports a real nanoton cost (#484)"

# issue #403: the mock registry's default 800 nanoTON/MB/day rate against this tiny
# test snapshot computes a bounty far below the provider-side floor — the SAME real
# math a live tonutils-storage-provider enforces (verified against its own source,
# see estimatedBountyNano()'s comment). This is the FIRST push above, not a separate
# run — proving the warning fires on an already-exercised, realistic scenario rather
# than one contrived just to trip it.
grep -q 'looks BELOW the' "$TMP/push.err" || { echo "[FAIL] the bounty-floor warning did not fire despite a computed bounty far under 0.05 TON"; cat "$TMP/push.err"; exit 1; }
echo "[PASS] push warns when the computed bounty looks below the provider-side floor (#403)"

echo "== positive control: the bounty-floor warning stays silent when the computed bounty clears the floor =="
mkdir -p "$TMP/high-price-src"
# Padded to ~80KB of RANDOM bytes (not zeros — `cb snapshot` tar.gz's its source before
# encrypting, and gzip crushes a run of zeros down to a few hundred bytes, silently
# undermining the size this test's bounty math depends on) so the #403 bounty math
# clears the floor at a modest rate instead of needing an extreme one that would also
# blow the deploy's own CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND cap (bounty and deploy cost
# both scale with rate).
head -c 80000 /dev/urandom | base64 > "$TMP/high-price-src/note.txt"
cb snapshot --dir "$TMP/high-price-src" --out "$TMP/high-price.age"
HP_SIZE=$(stat -f%z "$TMP/high-price.age" 2>/dev/null || stat -c%s "$TMP/high-price.age")
echo "$HP_SIZE" > "$TMP/notify-downloaded"
touch "$TMP/high-price-flag"
CYPHER_BRAIN_YES=1 cb push --in "$TMP/high-price.age" --backend ton-provider 2>"$TMP/high-bounty.err" >/dev/null \
  || { echo "[FAIL] push failed under the high-price mock"; cat "$TMP/high-bounty.err"; exit 1; }
if grep -q 'looks BELOW the' "$TMP/high-bounty.err"; then
  echo "[FAIL] the bounty-floor warning fired despite a comfortably-above-floor rate"; cat "$TMP/high-bounty.err"; exit 1
fi
echo "[PASS] the bounty-floor warning stays silent once the computed bounty clears the floor"

echo "== estimate --backend ton-provider also carries the bounty-floor warning when under-floor (#403) =="
rm -f "$TMP/high-price-flag" # back to the default (low) rate so this estimate is under-floor
EST2=$(cb estimate --in "$TMP/high-price.age" --backend ton-provider --json)
printf '%s' "$EST2" | grep -q 'looks below the ~0.05 TON floor' || { echo "[FAIL] estimate's note did not carry the bounty-floor warning: $EST2"; exit 1; }
echo "[PASS] estimate warns about an under-floor bounty before any funds move"
echo "$SIZE" > "$TMP/notify-downloaded" # restore for the pull test below

echo "== notify uses --mainnet by default (issue #404, no CYPHER_BRAIN_TON_NETWORK_CONFIG set) =="
grep -qx -- '--mainnet' "$TMP/notify-args.log" || { echo "[FAIL] the default (unset TON_NETWORK_CONFIG) push did not pass --mainnet to notify"; cat "$TMP/notify-args.log"; exit 1; }
echo "[PASS] notify defaults to --mainnet, matching every prior push in this script"

echo "== positive control: CYPHER_BRAIN_TON_NETWORK_CONFIG set -> notify omits --mainnet (issue #404) =="
mkdir -p "$TMP/testnet-src"
printf 'ton-provider testnet-network-selection test payload\n' > "$TMP/testnet-src/note.txt"
cb snapshot --dir "$TMP/testnet-src" --out "$TMP/testnet.age"
TN_SIZE=$(stat -f%z "$TMP/testnet.age" 2>/dev/null || stat -c%s "$TMP/testnet.age")
echo "$TN_SIZE" > "$TMP/notify-downloaded"
CYPHER_BRAIN_TON_NETWORK_CONFIG="$TMP/fake-testnet-global.config.json" CYPHER_BRAIN_YES=1 \
  cb push --in "$TMP/testnet.age" --backend ton-provider 2>"$TMP/testnet-push.err" >/dev/null \
  || { echo "[FAIL] push failed with CYPHER_BRAIN_TON_NETWORK_CONFIG set"; cat "$TMP/testnet-push.err"; exit 1; }
if grep -qx -- '--mainnet' "$TMP/notify-args.log"; then
  echo "[FAIL] notify still received --mainnet despite CYPHER_BRAIN_TON_NETWORK_CONFIG being set"; cat "$TMP/notify-args.log"; exit 1
fi
echo "[PASS] notify omits --mainnet once CYPHER_BRAIN_TON_NETWORK_CONFIG points at a (mock) testnet config, matching startLocalTonDaemon()'s own signal"
echo "$SIZE" > "$TMP/notify-downloaded" # restore for the pull test below

echo "== pull over the (mock) P2P path =="
rm -f "$TMP/snap.age"
cb pull --backend ton-provider --locator "$LOC" --out "$TMP/got.age" 2>"$TMP/pull.err"
[ "$(sha "$TMP/got.age")" = "$ORIG" ] || { echo "[FAIL] pulled bytes differ"; exit 1; }
grep -q 'over the TON Storage P2P network' "$TMP/pull.err" || { echo "[FAIL] pull did not report the P2P path"; exit 1; }
echo "[PASS] P2P pull round-trip"
cb verify --in "$TMP/got.age" >/dev/null
echo "[PASS] pulled ciphertext verifies"

echo "== issue #496: --wait warns (but does not error) for --backend ton-provider, same as file (#465) =="
WAIT_ERR=$(cb pull --backend ton-provider --locator "$LOC" --out "$TMP/wait-warn.age" --wait 2 2>&1); WAIT_RC=$?
[ "$WAIT_RC" = "0" ] || { echo "[FAIL] pull with --wait on ton-provider backend should still succeed when the bag is reachable"; echo "$WAIT_ERR"; exit 1; }
[ "$(sha "$TMP/wait-warn.age")" = "$ORIG" ] || { echo "[FAIL] --wait pull returned wrong bytes"; exit 1; }
printf '%s' "$WAIT_ERR" | grep -q -- '--wait has no effect for --backend ton-provider' || { echo "[FAIL] no --wait/ton-provider warning printed"; echo "$WAIT_ERR"; exit 1; }
echo "[PASS] --wait on the ton-provider backend (which delegates to ton.ts's p2pFetch, throwing a plain Error on a not-yet-retrievable bag) warns"

echo "== positive control: malformed locator is REJECTED (shape guard fires) =="
if cb pull --backend ton-provider --locator "ton-provider:v1:not-a-bag-id" --out "$TMP/never.age" 2>"$TMP/bad-loc.err"; then
  echo "[FAIL] malformed locator was accepted"; exit 1
fi
grep -q 'does not match the expected ton-provider:v1' "$TMP/bad-loc.err" || { echo "[FAIL] wrong rejection message"; exit 1; }
echo "[PASS] locator shape guard fired"

echo "== positive control: missing CYPHER_BRAIN_TON_PROVIDER_OWNER refuses to push =="
if CYPHER_BRAIN_TON_PROVIDER_OWNER= cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/no-owner.err"; then
  echo "[FAIL] push with no owner was accepted"; exit 1
fi
grep -q 'CYPHER_BRAIN_TON_PROVIDER_OWNER' "$TMP/no-owner.err" || { echo "[FAIL] wrong no-owner message"; exit 1; }
echo "[PASS] missing-owner guard fired"

echo "== positive control: CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND=0 refuses to push =="
if CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND=0 cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/no-cap.err"; then
  echo "[FAIL] push with a zero spend cap was accepted"; exit 1
fi
grep -q 'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND must be set' "$TMP/no-cap.err" || { echo "[FAIL] wrong zero-cap message"; exit 1; }
echo "[PASS] zero-spend-cap guard fired"

echo "== positive control: spend cap below the computed cost refuses the deploy =="
if CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND=1 cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/low-cap.err"; then
  echo "[FAIL] push under an impossibly low spend cap was accepted"; exit 1
fi
grep -q 'exceeds the' "$TMP/low-cap.err" || { echo "[FAIL] wrong low-cap message"; exit 1; }
echo "[PASS] under-cap deploy guard fired"

echo "== positive control: no live providers in the registry refuses the push =="
touch "$TMP/empty-providers-flag"
if cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/no-providers.err"; then
  echo "[FAIL] push with zero live providers was accepted"; exit 1
fi
grep -q 'no live mytonprovider.org provider' "$TMP/no-providers.err" || { echo "[FAIL] wrong no-providers message"; exit 1; }
rm -f "$TMP/empty-providers-flag"
echo "[PASS] no-live-providers guard fired"

echo "== positive control: a provider whose rounded-up span exceeds its own max_span is refused =="
touch "$TMP/bad-span-flag"
if cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/bad-span.err"; then
  echo "[FAIL] push with an impossible provider span was accepted"; exit 1
fi
grep -q 'exceeds its own max_span' "$TMP/bad-span.err" || { echo "[FAIL] wrong bad-span message"; exit 1; }
rm -f "$TMP/bad-span-flag"
echo "[PASS] bad-span guard fired"

echo "== positive control: notify binary missing refuses with an actionable message =="
if CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN= cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/no-bin.err"; then
  echo "[FAIL] push with no notify binary configured was accepted"; exit 1
fi
grep -q 'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN is not set' "$TMP/no-bin.err" || { echo "[FAIL] wrong missing-binary message"; exit 1; }
echo "[PASS] missing-notify-binary guard fired"

echo "== positive control: --yes required (no CYPHER_BRAIN_YES, no --yes) =="
if CYPHER_BRAIN_YES= cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/no-yes.err"; then
  echo "[FAIL] push with no consent was accepted"; exit 1
fi
grep -q 'spends real funds' "$TMP/no-yes.err" || { echo "[FAIL] wrong no-consent message"; exit 1; }
echo "[PASS] consent guard fired"

echo "== positive control: partial download makes push wait, not succeed early =="
# macOS ships no `timeout` by default — short-circuit the RETRY loop itself instead of
# racing an external timeout command against it (a known pitfall: relying on a bare
# `timeout` silently no-ops on a stock macOS shell).
echo "1" > "$TMP/notify-downloaded" # far short of $SIZE
if CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS=2000 CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS=500 \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/partial.err"; then
  echo "[FAIL] push returned despite the provider reporting only 1/$SIZE bytes downloaded"; exit 1
fi
# #396 Phase B: this line used to be a bare per-retry console.error; it now goes
# through the SAME shared progress.ts module turbo's upload / rclone's transfer
# use (rate/ETA math, self-limiting cadence) — see backends/ton-provider.ts's
# notifyProviderWithRetry(). Match the component label, not the old exact wording.
grep -q 'ton-provider notify:' "$TMP/partial.err" || { echo "[FAIL] push did not report partial-download progress"; exit 1; }
grep -Eq 'did not (finish fetching the bag|report a full download)' "$TMP/partial.err" || { echo "[FAIL] push did not time out with the expected message"; exit 1; }
echo "$SIZE" > "$TMP/notify-downloaded" # restore for any later runs
echo "[PASS] push correctly waits on a partial provider download instead of declaring success early"

echo "== positive control: the provider's own notify 'reason' is surfaced immediately, not discarded until timeout (#403) =="
echo "1" > "$TMP/notify-downloaded" # partial again, so the retry loop actually runs
printf 'bounty should be at least 0.05 TON to cover fees' > "$TMP/notify-reason-override"
if CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS=2000 CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS=500 \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/reason-surfaced.err"; then
  echo "[FAIL] push returned despite a partial download"; exit 1
fi
grep -q 'notify response so far.*bounty should be at least 0.05 TON to cover fees' "$TMP/reason-surfaced.err" \
  || { echo "[FAIL] the provider's own refusal reason was not surfaced in the retry loop"; cat "$TMP/reason-surfaced.err"; exit 1; }
# dedup check (#403): an UNCHANGED reason across ~4 retries (2000ms/500ms) must print
# ONCE live, not every attempt — a loop that repeats the identical line for the full
# 10min default window in real usage is exactly the noise this fix must not
# reintroduce. Expected count is 2, not 1: warn() (#347) also reprints every recorded
# warning verbatim in the end-of-run "run summary" block, so one live occurrence plus
# one summary occurrence is the CORRECT total — this also incidentally confirms the
# reason warning flows through the same #347 summary mechanism as every other warning.
REASON_COUNT=$(grep -c 'notify response so far.*bounty should be at least 0.05 TON to cover fees' "$TMP/reason-surfaced.err")
[ "$REASON_COUNT" = "2" ] || { echo "[FAIL] the reason line appeared $REASON_COUNT time(s), expected exactly 2 (1 live + 1 run-summary) — dedup or the #347 summary broke"; cat "$TMP/reason-surfaced.err"; exit 1; }
# issue #561 regression guard: the warn() line's status=... must come from the notify
# response block (fake-notify's "active"), never from the pre-flight status line
# fake-notify now also emits ("preflight-should-be-ignored") ahead of the marker.
grep -q 'status=active' "$TMP/reason-surfaced.err" || { echo "[FAIL] parseNotifyOutput did not surface the notify-response status"; cat "$TMP/reason-surfaced.err"; exit 1; }
if grep -q 'status=preflight-should-be-ignored' "$TMP/reason-surfaced.err"; then
  echo "[FAIL] parseNotifyOutput matched the pre-flight status line instead of the notify response (issue #561 regression)"; cat "$TMP/reason-surfaced.err"; exit 1
fi
echo "[PASS] parseNotifyOutput picks the notify-response status, not the pre-flight status line (issue #561)"
rm -f "$TMP/notify-reason-override"
echo "$SIZE" > "$TMP/notify-downloaded" # restore for any later runs
echo "[PASS] the provider's stated reason is surfaced once, immediately, and not repeated while unchanged"

echo "== positive control: an insufficient owner balance WARNS but does not abort the push (advisory funds check, #396 Phase B) =="
touch "$LOW_BALANCE_FLAG"
cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/low-balance.err" >/dev/null \
  || { echo "[FAIL] push aborted on a low-balance warning — the funds check must be advisory only, never a hard block"; cat "$TMP/low-balance.err"; exit 1; }
grep -q 'balance.*looks lower than' "$TMP/low-balance.err" || { echo "[FAIL] the funds-check warning did not fire despite the mocked low owner balance"; cat "$TMP/low-balance.err"; exit 1; }
grep -q 'CYPHER_BRAIN_SKIP_FUNDS_CHECK' "$TMP/low-balance.err" || { echo "[FAIL] the warning does not mention the skip flag"; cat "$TMP/low-balance.err"; exit 1; }
echo "[PASS] a low owner balance prints a warning but still lets the push proceed (a human signs the real deploy either way)"

echo "== positive control: CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 silences the same warning (shared flag with turbo's own funds check) =="
CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/low-balance-skip.err" >/dev/null \
  || { echo "[FAIL] push failed under CYPHER_BRAIN_SKIP_FUNDS_CHECK=1"; cat "$TMP/low-balance-skip.err"; exit 1; }
if grep -q 'balance.*looks lower than' "$TMP/low-balance-skip.err"; then
  echo "[FAIL] CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 did not silence the funds-check warning"; cat "$TMP/low-balance-skip.err"; exit 1
fi
rm -f "$LOW_BALANCE_FLAG"
echo "[PASS] CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 silences the ton-provider funds-check warning too"

# ========================================================================
# PR2 (issue #396): local auto-signing — no Tonkeeper, no human. Everything
# below shares the same mock tonapi/mytonprovider/tonutils-storage/notify
# infrastructure above; only /v2/blockchain/message (broadcast),
# /methods/seqno, and a per-address 'frozen' override are new (see the mock
# tonapi source above).
# ========================================================================

echo "== wallet create/address/balance --chain ton =="
cb wallet create --chain ton --out "$TMP/ton-wallet.json" > "$TMP/ton-wallet-create.out"
TON_WALLET_ADDR=$(cb wallet address --chain ton --wallet "$TMP/ton-wallet.json")
grep -q "$TON_WALLET_ADDR" "$TMP/ton-wallet-create.out" || { echo "[FAIL] wallet create/address --chain ton disagree on the derived address"; exit 1; }
echo "[PASS] wallet create --chain ton writes a mnemonic file; wallet address derives the SAME address"

# Issue #483: the printed address is the bounceable (EQ...) encoding, and first-time TON
# users get no other signal that a UQ... rendering of the SAME account is equivalent —
# `wallet create --chain ton` must say so.
grep -qF 'EQ...' "$TMP/ton-wallet-create.out" || { echo "[FAIL] wallet create --chain ton did not mention the EQ... bounceable encoding (#483)"; cat "$TMP/ton-wallet-create.out"; exit 1; }
grep -qF 'UQ...' "$TMP/ton-wallet-create.out" || { echo "[FAIL] wallet create --chain ton did not mention the UQ... non-bounceable counterpart (#483)"; cat "$TMP/ton-wallet-create.out"; exit 1; }
echo "[PASS] wallet create --chain ton explains the EQ.../UQ... address encoding (#483)"

# Codex review, xhigh pass: prove the REFUSED create left the original mnemonic byte-for-byte
# untouched, not just that it exited non-zero with the right message (a "write then fail"
# clobber would still pass a message-only check).
ORIG_WALLET_SHA=$(sha "$TMP/ton-wallet.json")
if cb wallet create --chain ton --out "$TMP/ton-wallet.json" 2>"$TMP/ton-wallet-clobber.err"; then
  echo "[FAIL] wallet create --chain ton clobbered an existing wallet without --force"; exit 1
fi
grep -q 'already exists' "$TMP/ton-wallet-clobber.err" || { echo "[FAIL] wrong TON wallet no-clobber message"; exit 1; }
[ "$(sha "$TMP/ton-wallet.json")" = "$ORIG_WALLET_SHA" ] || { echo "[FAIL] the refused create modified the existing wallet file"; exit 1; }
echo "[PASS] wallet create --chain ton no-clobber guard fired, original mnemonic byte-identical after the refusal"

BAL=$(cb wallet balance --chain ton --wallet "$TMP/ton-wallet.json" --json)
printf '%s' "$BAL" | grep -q '"balance_nanoton":5000000000' || { echo "[FAIL] wallet balance --chain ton did not read the mock tonapi balance: $BAL"; exit 1; }
echo "[PASS] wallet balance --chain ton reads the (mocked) on-chain balance"

# Issue #479: a freshly generated, never-funded wallet must read as a clean zero
# balance, not a raw HTTP 404 — exactly the case --help documents as the primary use
# case ("no funds needed"). Uses its OWN separate wallet (not $TMP/ton-wallet.json,
# which every OTHER test in this script relies on being reported 'active') so marking
# it 'nonexist' in the mock cannot affect anything else here.
cb wallet create --chain ton --out "$TMP/ton-wallet-fresh.json" > /dev/null
FRESH_ADDR=$(cb wallet address --chain ton --wallet "$TMP/ton-wallet-fresh.json")
printf '%s' "$FRESH_ADDR" > "$UNFUNDED_ADDR_FLAG"
FRESH_BAL=$(cb wallet balance --chain ton --wallet "$TMP/ton-wallet-fresh.json" --json)
printf '%s' "$FRESH_BAL" | grep -q '"balance_nanoton":0' || { echo "[FAIL] a never-active wallet's balance did not read as 0: $FRESH_BAL"; exit 1; }
printf '%s' "$FRESH_BAL" | grep -q '"status":"nonexist"' || { echo "[FAIL] a never-active wallet's status was not 'nonexist': $FRESH_BAL"; exit 1; }
echo "[PASS] wallet balance --chain ton --json reads a never-active wallet as a clean 0, not an error (#479)"
FRESH_BAL_PLAIN=$(cb wallet balance --chain ton --wallet "$TMP/ton-wallet-fresh.json")
printf '%s' "$FRESH_BAL_PLAIN" | grep -q '^balance : 0 nanoTON' || { echo "[FAIL] a never-active wallet's plain balance output was not a clean 0: $FRESH_BAL_PLAIN"; exit 1; }
echo "[PASS] wallet balance --chain ton (plain output) reads a never-active wallet as a clean 0, not an error (#479)"
rm -f "$UNFUNDED_ADDR_FLAG"

# Raw "workchain:hex" form — what ton-provider.ts's fetchAccountState()/fetchWalletSeqno()
# key their tonapi URLs on (Address#toRawString()) — needed to target the frozen-wallet
# mock below with the SAME address the real code will query. Decoded by hand (base64url
# tag(1) + workchain(1, signed) + hash(32) + crc16(2), TEP-2) instead of importing
# @ton/ton: a script under $TMP has no node_modules ancestry to resolve it from (the same
# "run from inside the worktree" constraint ton-provider.ts's own header documents), and
# this format is simple/stable enough not to need the dependency just to invert it.
cat > "$TMP/to-raw-addr.mjs" <<'MOCKEOF'
const buf = Buffer.from(process.argv[2], 'base64url');
const workchain = buf.readInt8(1);
const hash = buf.subarray(2, 34).toString('hex');
console.log(`${workchain}:${hash}`);
MOCKEOF
TON_WALLET_ADDR_RAW=$(node "$TMP/to-raw-addr.mjs" "$TON_WALLET_ADDR")

echo "== auto-sign: a configured CYPHER_BRAIN_TON_WALLET signs+broadcasts, no Tonkeeper deeplink =="
: > "$BROADCAST_LOG"
AUTO_LOC=$(CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/autosign.err")
printf '%s' "$AUTO_LOC" | grep -Eq '^ton-provider:v1:[0-9a-f]{64}$' || { echo "[FAIL] auto-sign locator shape: $AUTO_LOC"; exit 1; }
grep -q "auto-signing with local wallet $TON_WALLET_ADDR" "$TMP/autosign.err" || { echo "[FAIL] did not report auto-signing with the wallet's own address"; cat "$TMP/autosign.err"; exit 1; }
if grep -q 'sign this to deploy the contract' "$TMP/autosign.err"; then
  echo "[FAIL] a Tonkeeper deeplink was printed despite CYPHER_BRAIN_TON_WALLET being configured"; exit 1
fi
# Codex review, xhigh pass: a non-empty log only proves SOME POST landed — check the body
# looks like a real signed BOC (a JSON {"boc":"<base64>"} with a plausible length), not an
# empty/garbage payload the mock would accept just as happily.
grep -Eq '"boc":"[A-Za-z0-9+/=]{200,}"' "$BROADCAST_LOG" || {
  echo "[FAIL] auto-sign's broadcast body doesn't look like a real signed BOC"; cat "$BROADCAST_LOG"; exit 1
}
echo "[PASS] auto-sign path: owner derived from the wallet, deploy broadcast (no deeplink, no human)"

# ========================================================================
# issue #651: checkProviderLiveTerms() must refuse BEFORE any funds move (i.e. before
# the auto-sign broadcast below ever fires) when the provider's LIVE ADNL rates
# disagree with the mytonprovider.org registry snapshot the deploy was built from. Run
# on the auto-sign path (not the manual Tonkeeper-deeplink path) so BROADCAST_LOG
# actually proves "never reached broadcast", not just "push exited non-zero".
# ========================================================================

echo "== live-rates check: provider reports itself NOT available -> refuses before broadcast (#651) =="
touch "$TMP/rates-unavailable-flag"
: > "$BROADCAST_LOG"
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/rates-unavailable.err"; then
  echo "[FAIL] push succeeded despite the provider's live rates reporting itself unavailable"; exit 1
fi
grep -q 'reports itself as NOT available' "$TMP/rates-unavailable.err" || { echo "[FAIL] wrong rates-unavailable message"; cat "$TMP/rates-unavailable.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] push reached broadcast despite the live-rates check refusing first"; exit 1; }
rm -f "$TMP/rates-unavailable-flag"
echo "[PASS] a provider reporting itself unavailable via live ADNL rates refuses the push before any funds move"

echo "== live-rates check: provider's LIVE rate exceeds what the registry snapshot assumed -> refuses (#651) =="
touch "$TMP/rates-high-rate-flag"
: > "$BROADCAST_LOG"
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/rates-high-rate.err"; then
  echo "[FAIL] push succeeded despite the provider's live rate exceeding the registry-derived rate"; exit 1
fi
grep -q 'LIVE rate' "$TMP/rates-high-rate.err" || { echo "[FAIL] wrong high-rate message"; cat "$TMP/rates-high-rate.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] push reached broadcast despite the live rate being higher than assumed"; exit 1; }
rm -f "$TMP/rates-high-rate-flag"
echo "[PASS] a live rate higher than the registry snapshot refuses the push before any funds move"

echo "== live-rates check: provider's LIVE span range no longer covers the chosen span -> refuses (#651) =="
touch "$TMP/rates-narrow-span-flag"
: > "$BROADCAST_LOG"
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/rates-narrow-span.err"; then
  echo "[FAIL] push succeeded despite the provider's live span range excluding the chosen span"; exit 1
fi
grep -q 'LIVE span range' "$TMP/rates-narrow-span.err" || { echo "[FAIL] wrong narrow-span message"; cat "$TMP/rates-narrow-span.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] push reached broadcast despite the live span range excluding the chosen span"; exit 1; }
rm -f "$TMP/rates-narrow-span-flag"
echo "[PASS] a live span range that excludes the chosen span refuses the push before any funds move"

echo "== live-rates check: a permissive live-rates response (the default mock) still lets push proceed (#651 control) =="
# issue #638: got.age's own (auto-sign-wallet, unset-owner) contract address was
# already broadcast by the "auto-sign path" test above — tonapi's mock now reports it
# 'active' on every subsequent query (see the mock's "seen" tracking header comment) —
# so reusing got.age here would trip the #638 already-active guard and skip
# broadcasting, defeating this control's own point (does a permissive live-rates
# response actually let a genuinely FRESH push reach broadcast?). Use a distinct,
# never-before-pushed source instead, same pattern high-price.age/testnet.age/
# issue638.age already establish elsewhere in this script.
mkdir -p "$TMP/rates-ok-src"
printf 'ton-provider #651 control payload (must derive a not-yet-active contract)\n' > "$TMP/rates-ok-src/note.txt"
cb snapshot --dir "$TMP/rates-ok-src" --out "$TMP/rates-ok.age"
RATES_OK_SIZE=$(stat -f%z "$TMP/rates-ok.age" 2>/dev/null || stat -c%s "$TMP/rates-ok.age")
echo "$RATES_OK_SIZE" > "$TMP/notify-downloaded"
: > "$BROADCAST_LOG"
CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/rates-ok.age" --backend ton-provider 2>"$TMP/rates-ok.err" >/dev/null \
  || { echo "[FAIL] push failed under a permissive live-rates response"; cat "$TMP/rates-ok.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] || { echo "[FAIL] push never reached broadcast despite a permissive live-rates response"; exit 1; }
echo "[PASS] a permissive live-rates response does not block the push (the three refusals above are specific to their own override flags)"

# ========================================================================
# issue #652: a provider's notify `downloaded` figure is self-reported, never
# cryptographically verified — notifyProviderWithRetry() now flags two signals: an
# immediate full-size claim on the FIRST response (every push above already exercises
# this, since the default mock reports the full size on the very first call), and a
# LATER response that reports FEWER bytes than a previously reported value (internally
# inconsistent — a real download cannot un-download bytes).
# ========================================================================

echo "== notify self-report: an immediate full-size FIRST response is flagged, not silently trusted (#652) =="
grep -q 'reported the FULL bag' "$TMP/rates-ok.err" || { echo "[FAIL] the immediate-full-report warning did not fire on the very first notify response"; cat "$TMP/rates-ok.err"; exit 1; }
grep -q "provider's own self-report, not independently verified" "$TMP/rates-ok.err" || { echo "[FAIL] the self-report caveat wording is missing"; cat "$TMP/rates-ok.err"; exit 1; }
grep -q 'reports the full bag downloaded — stopping the local seed' "$TMP/rates-ok.err" || { echo "[FAIL] the stop-seeding line lost its self-report caveat wording"; cat "$TMP/rates-ok.err"; exit 1; }
echo "[PASS] a first-response full-size claim is flagged as unverified self-report, and the stop-seeding line carries the same caveat"

echo "== notify self-report: a downloaded count that DECREASES between retries is flagged as inconsistent (#652) =="
# Deterministic per-call sequence (see fake-notify's own comment above): call 1 a
# partial value well short of $SIZE, call 2 a DECREASE from that high-water mark, call
# 3+ full — driven by fake-notify's own call counter, not real-time timing, so this
# cannot be flaky. Fractions of $SIZE, not hardcoded bytes, since a tiny test snapshot's
# actual size is unknown ahead of time (it only needs HALF < SIZE and HALF > 1).
HALF_SIZE=$((SIZE / 2))
printf '%s\n1\n%s\n' "$HALF_SIZE" "$SIZE" > "$TMP/notify-downloaded-sequence"
rm -f "$TMP/notify-call-counter"
CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS=5000 CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS=100 \
  CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/downloaded-decrease.err" >/dev/null \
  || { echo "[FAIL] push did not complete once the sequence reached full"; cat "$TMP/downloaded-decrease.err"; exit 1; }
grep -q 'DECREASED between' "$TMP/downloaded-decrease.err" || { echo "[FAIL] the decreasing-downloaded warning did not fire"; cat "$TMP/downloaded-decrease.err"; exit 1; }
grep -q 'internally inconsistent' "$TMP/downloaded-decrease.err" || { echo "[FAIL] the decreasing-downloaded warning is missing its inconsistency wording"; cat "$TMP/downloaded-decrease.err"; exit 1; }
echo "[PASS] a downloaded count that decreases between notify retries is flagged as internally inconsistent"
rm -f "$TMP/notify-downloaded-sequence" "$TMP/notify-call-counter"
echo "$SIZE" > "$TMP/notify-downloaded" # restore the static value for any later runs

echo "== auto-sign: a mismatched CYPHER_BRAIN_TON_PROVIDER_OWNER is a HARD ERROR, not a silent override (Codex review, xhigh pass: unattended reachability means nobody may be watching a warning) =="
MISMATCHED_OWNER="0:0000000000000000000000000000000000000000000000000000000000000002"
: > "$BROADCAST_LOG"
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER="$MISMATCHED_OWNER" \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/mismatch.err" >/dev/null; then
  echo "[FAIL] push succeeded despite a mismatched CYPHER_BRAIN_TON_PROVIDER_OWNER — it must refuse, not silently override"; cat "$TMP/mismatch.err"; exit 1
fi
grep -q "CYPHER_BRAIN_TON_PROVIDER_OWNER ($MISMATCHED_OWNER) is set but does not match" "$TMP/mismatch.err" || { echo "[FAIL] mismatch error did not fire"; cat "$TMP/mismatch.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] mismatched-owner push reached broadcast despite being refused"; exit 1; }
echo "[PASS] owner-mismatch guard: refuses to proceed with an ambiguous owner (no silent override, no broadcast)"

echo "== auto-sign: unsetting the stale CYPHER_BRAIN_TON_PROVIDER_OWNER lets the SAME push succeed (the operator-facing fix the error message above points at) =="
# issue #638: this specific auto-sign wallet + "$TMP/got.age" combination already
# derived and successfully deployed a contract a few lines above ("no Tonkeeper
# deeplink needed" test) — reusing got.age here would now correctly trip the #638
# already-active guard and skip re-funding, which would make THIS test's real point
# (does fixing the owner mismatch let a genuinely fresh auto-sign push broadcast?)
# untestable. Use high-price.age instead — same wallet, but a combination never used
# before, so it derives a brand-new, not-yet-active contract address.
echo "$HP_SIZE" > "$TMP/notify-downloaded"
: > "$BROADCAST_LOG"
CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/high-price.age" --backend ton-provider 2>"$TMP/mismatch-fixed.err" >/dev/null \
  || { echo "[FAIL] push failed after unsetting the stale owner"; cat "$TMP/mismatch-fixed.err"; exit 1; }
grep -q "auto-signing with local wallet $TON_WALLET_ADDR" "$TMP/mismatch-fixed.err" || { echo "[FAIL] did not auto-sign as the wallet's own address"; cat "$TMP/mismatch-fixed.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] || { echo "[FAIL] push never reached broadcast after unsetting the stale owner"; exit 1; }
echo "[PASS] unsetting CYPHER_BRAIN_TON_PROVIDER_OWNER resolves the ambiguity and lets auto-sign proceed"
echo "$SIZE" > "$TMP/notify-downloaded" # restore

echo "== auto-sign: a frozen local wallet refuses to sign (no silent spend attempt from a wallet that cannot act) =="
# issue #638: same reasoning as above — a fresh wallet+file combination (testnet.age,
# never pushed with this auto-sign wallet before) so the #638 already-active guard
# does not skip this run before the frozen-wallet check (inside
# autoSignAndBroadcastDeploy) ever gets a chance to run. This push never reaches
# notify (the frozen check throws first), so notify-downloaded does not need touching.
printf '%s' "$TON_WALLET_ADDR_RAW" > "$FROZEN_ADDR_FLAG"
: > "$BROADCAST_LOG" # Codex review, xhigh pass: prove the refusal happens BEFORE broadcast, not just that push exits non-zero
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/testnet.age" --backend ton-provider 2>"$TMP/frozen.err"; then
  echo "[FAIL] push succeeded despite the local wallet being frozen on-chain"; exit 1
fi
grep -q 'is frozen on-chain' "$TMP/frozen.err" || { echo "[FAIL] wrong frozen-wallet message"; cat "$TMP/frozen.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] a frozen wallet still reached broadcast before being refused"; exit 1; }
rm -f "$FROZEN_ADDR_FLAG"
echo "[PASS] frozen-wallet guard fired before any broadcast attempt"

echo "== issue #640: a TRANSIENT tonapi lookup failure on the auto-sign wallet's own account-state check must NOT be treated as 'unused wallet, seqno 0' — it must fail loudly instead =="
# issue #638: same reasoning as the #651 control fix above (and the frozen-wallet
# test's own testnet.age choice below it originally) — got.age's (auto-sign-wallet,
# unset-owner) contract is no longer fresh by this point in the script, so the
# already-active guard would skip autoSignAndBroadcastDeploy() entirely — which is
# exactly where this lookup-failure check lives — never exercising what this test
# exists to prove. Use a distinct, never-before-pushed source instead.
mkdir -p "$TMP/lookup-fail-src"
printf 'ton-provider #640 lookup-failure payload (must derive a not-yet-active contract)\n' > "$TMP/lookup-fail-src/note.txt"
cb snapshot --dir "$TMP/lookup-fail-src" --out "$TMP/lookup-fail.age"
LOOKUP_FAIL_SIZE=$(stat -f%z "$TMP/lookup-fail.age" 2>/dev/null || stat -c%s "$TMP/lookup-fail.age")
echo "$LOOKUP_FAIL_SIZE" > "$TMP/notify-downloaded"
printf '%s' "$TON_WALLET_ADDR_RAW" > "$LOOKUP_FAIL_ADDR_FLAG"
: > "$BROADCAST_LOG" # the whole point of this guard is that broadcast must never be reached on a lookup failure
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/lookup-fail.age" --backend ton-provider 2>"$TMP/lookup-fail.err"; then
  echo "[FAIL] push succeeded despite a transient tonapi lookup failure on the wallet's own account state"; cat "$TMP/lookup-fail.err"; exit 1
fi
grep -q 'could not look up local wallet' "$TMP/lookup-fail.err" || { echo "[FAIL] wrong lookup-failure message"; cat "$TMP/lookup-fail.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] a wallet whose lookup failed still reached broadcast — this would have signed with a GUESSED seqno"; exit 1; }
rm -f "$LOOKUP_FAIL_ADDR_FLAG"
echo "$SIZE" > "$TMP/notify-downloaded" # restore
echo "[PASS] transient tonapi lookup failure refuses the push instead of guessing seqno 0"

echo "== issue #638: retrying an already-active StorageV1 contract does NOT re-fund it (money-safety fix) =="
mkdir -p "$TMP/issue638-src"
printf 'ton-provider issue #638 already-active retry test payload\n' > "$TMP/issue638-src/note.txt"
cb snapshot --dir "$TMP/issue638-src" --out "$TMP/issue638.age"
I638_SIZE=$(stat -f%z "$TMP/issue638.age" 2>/dev/null || stat -c%s "$TMP/issue638.age")
echo "$I638_SIZE" > "$TMP/notify-downloaded"

: > "$BROADCAST_LOG"
FIRST_LOC=$(CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/issue638.age" --backend ton-provider 2>"$TMP/issue638-first.err") \
  || { echo "[FAIL] issue #638 setup: the first (fresh) push failed"; cat "$TMP/issue638-first.err"; exit 1; }
printf '%s' "$FIRST_LOC" | grep -Eq '^ton-provider:v1:[0-9a-f]{64}$' || { echo "[FAIL] issue #638 setup: first push did not return a locator: $FIRST_LOC"; exit 1; }
FIRST_BROADCASTS=$(grep -c '"boc"' "$BROADCAST_LOG" || true)
[ "$FIRST_BROADCASTS" = "1" ] || { echo "[FAIL] issue #638 setup: expected exactly 1 broadcast on the first (fresh) push, got $FIRST_BROADCASTS"; cat "$BROADCAST_LOG"; exit 1; }
echo "[PASS] first push against a fresh contract broadcasts exactly once (baseline)"

# The retry: SAME wallet, SAME file -> buildDeploy() derives the IDENTICAL contract
# address (bagId/owner/dataSizeBytes/pieceSize/merkleHash are all unchanged — see
# buildDeploy()'s own `data` cell) — simulating an operator (or an agent) retrying
# after a lost/ambiguous result from the first push, exactly the scenario issue #638
# describes. BEFORE the fix, this unconditionally re-sent `amountNano` a second time
# to an address that is ALREADY active on-chain (a genuine double-payment). AFTER the
# fix, the retry must detect the contract is already active, skip re-funding, and
# still succeed (going straight to notify).
SECOND_LOC=$(CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/issue638.age" --backend ton-provider 2>"$TMP/issue638-retry.err") \
  || { echo "[FAIL] the retry push failed outright instead of detecting the already-active contract and skipping re-funding"; cat "$TMP/issue638-retry.err"; exit 1; }
printf '%s' "$SECOND_LOC" | grep -Eq '^ton-provider:v1:[0-9a-f]{64}$' || { echo "[FAIL] issue #638 retry did not return a locator: $SECOND_LOC"; exit 1; }
[ "$FIRST_LOC" = "$SECOND_LOC" ] || { echo "[FAIL] the retry derived a DIFFERENT locator than the first push ($FIRST_LOC vs $SECOND_LOC) — test setup is not actually retrying the same bag"; exit 1; }
SECOND_BROADCASTS=$(grep -c '"boc"' "$BROADCAST_LOG" || true)
[ "$SECOND_BROADCASTS" = "1" ] || { echo "[FAIL] issue #638 REGRESSION: the retry sent a SECOND broadcast against an already-active contract (double-funding) — broadcast count is now $SECOND_BROADCASTS, expected still 1"; cat "$BROADCAST_LOG"; exit 1; }
grep -q 'already shows on-chain activity' "$TMP/issue638-retry.err" || { echo "[FAIL] the retry did not report that the contract was already active/skipped"; cat "$TMP/issue638-retry.err"; exit 1; }
echo "[PASS] issue #638: retrying an already-active StorageV1 contract skips re-funding (broadcast count stayed at 1, not 2)"
echo "$SIZE" > "$TMP/notify-downloaded" # restore

echo "== issue #654: a notify failure AFTER funding is confirmed still persists the receipt (PushFundingConfirmedButIncompleteError) =="
# A DISTINCT, never-before-pushed source (not issue638.age/got.age — same reasoning as
# the #651/#640 fixes above: reusing an address this script has already broadcast
# against would trip the #638 already-active guard before this test ever reaches the
# notify-timeout path it exists to prove).
mkdir -p "$TMP/issue654-src"
printf 'ton-provider issue #654 receipt-on-confirmed-funding test payload\n' > "$TMP/issue654-src/note.txt"
cb snapshot --dir "$TMP/issue654-src" --out "$TMP/issue654.age"
I654_SIZE=$(stat -f%z "$TMP/issue654.age" 2>/dev/null || stat -c%s "$TMP/issue654.age")
echo "1" > "$TMP/notify-downloaded" # far short of I654_SIZE — notify will never confirm within the short retry window below

RECEIPT_COUNT_BEFORE_654=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
: > "$BROADCAST_LOG"
set +e
I654_ERR=$(CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  CYPHER_BRAIN_TON_PROVIDER_NOTIFY_RETRY_MS=1500 CYPHER_BRAIN_TON_PROVIDER_NOTIFY_INTERVAL_MS=300 \
  cb push --in "$TMP/issue654.age" --backend ton-provider 2>&1 >/dev/null); I654_RC=$?
set -e
[ "$I654_RC" != "0" ] \
  || { echo "[FAIL] push succeeded despite the provider never confirming the download within the retry window"; echo "$I654_ERR"; exit 1; }
printf '%s' "$I654_ERR" | grep -q 'funding is CONFIRMED on-chain' \
  || { echo "[FAIL] the notify-timeout error did not report confirmed funding"; echo "$I654_ERR"; exit 1; }
printf '%s' "$I654_ERR" | grep -q 'already recorded in the receipt ledger' \
  || { echo "[FAIL] the notify-timeout error did not point at the receipt ledger"; echo "$I654_ERR"; exit 1; }
[ -s "$BROADCAST_LOG" ] \
  || { echo "[FAIL] the funding never actually broadcast (test setup is not exercising a REAL confirmed-funding scenario)"; exit 1; }
RECEIPT_COUNT_AFTER_654=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
[ "$((RECEIPT_COUNT_AFTER_654 - RECEIPT_COUNT_BEFORE_654))" = "1" ] \
  || { echo "[FAIL] expected exactly ONE new ton-provider receipt despite the notify failure (the funding IS confirmed on-chain) — got $((RECEIPT_COUNT_AFTER_654 - RECEIPT_COUNT_BEFORE_654))"; exit 1; }
echo "[PASS] issue #654: a notify failure after confirmed funding still persists the receipt, and the thrown error names the confirmed-funding + ledger fact"

echo "== issue #654: retrying the same (now already-active) contract and letting notify succeed does NOT add a second receipt =="
echo "$I654_SIZE" > "$TMP/notify-downloaded" # restore full size so notify confirms this time
CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/issue654.age" --backend ton-provider >/dev/null 2>"$TMP/issue654-retry.err" \
  || { echo "[FAIL] the retry push failed despite notify now able to confirm the full download"; cat "$TMP/issue654-retry.err"; exit 1; }
grep -q 'already shows on-chain activity' "$TMP/issue654-retry.err" \
  || { echo "[FAIL] the retry did not report the contract as already active/skipped"; cat "$TMP/issue654-retry.err"; exit 1; }
RECEIPT_COUNT_AFTER_RETRY_654=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
[ "$RECEIPT_COUNT_AFTER_RETRY_654" = "$RECEIPT_COUNT_AFTER_654" ] \
  || { echo "[FAIL] the retry that completed notify added a SECOND receipt for the SAME on-chain spend (double-counted) — count went from $RECEIPT_COUNT_AFTER_654 to $RECEIPT_COUNT_AFTER_RETRY_654"; exit 1; }
echo "[PASS] issue #654: completing notify on a retry of an already-active contract does not double-count the receipt ledger"
echo "$SIZE" > "$TMP/notify-downloaded" # restore for any later runs

echo "== issue #654 (MCP-level): a snapshot_now notify timeout classifies as funding_confirmed, not a generic partial-success bucket =="
# Reuses this run's ALREADY-RUNNING tonapi/mytonprovider/notify mocks (env vars
# exported above) — the dedicated companion script only adds the MCP stdio/JSON-RPC
# plumbing, not a second copy of the mock infrastructure. Runs against dist/mcp.mjs,
# same as scripts/mcp-smoke.mjs — requires `npm run build` to have already run (true
# for both `npm run verify:suite`'s own ordering and this script's own top-of-file
# assumption that node_modules/dist are current).
MCP_PARTIAL_TEST_TMP="$TMP" \
  MCP_PARTIAL_TEST_TON_WALLET="$TMP/ton-wallet.json" \
  MCP_PARTIAL_TEST_NOTIFY_DOWNLOADED="$TMP/notify-downloaded" \
  MCP_PARTIAL_TEST_RECIPIENT="$CYPHER_BRAIN_HOME/recipient.txt" \
  node scripts/selftest-ton-provider-mcp-partial.mjs

# ========================================================================
# issue #480: waitForContractActive()'s timeout message must match the path that
# actually ran (auto-sign vs. Tonkeeper-deeplink) instead of always pointing at "the
# deeplink printed above" — which the auto-sign path never prints. Both runs below use
# the CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_* test-only overrides (config.ts) so this
# exercises the REAL 20-minute-bounded poll loop, just on a millisecond timescale, against
# the mock tonapi's never-active-flag (added above) instead of a live 20-minute wait.
# ========================================================================
# Exported (not prefixed per-invocation, since bash only recognizes literal `NAME=value`
# tokens written directly before the command as prefix assignments — NOT tokens produced
# by expanding an array/variable at runtime) so both pushes below pick them up; unset
# again right after this section so it cannot leak into any later test.
export CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS=1500
export CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS=200
export CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS=400

# issue #638: both pushes below need a GENUINELY FRESH contract address (never queried
# before in this script run) — the mock's "seen" tracking (see header comment above the
# mock's source) makes a non-fresh address's FIRST query report 'uninitialized' (not
# 'nonexist') once NEVER_ACTIVE_FLAG is set below, which would trip ton-provider.ts's
# own #638 already-non-fresh check and skip funding BEFORE ever reaching the code path
# each of these tests actually wants to exercise (the real auto-sign broadcast / the
# real deeplink print). got.age (reused throughout this script) is NOT fresh by this
# point — two brand-new, never-before-pushed files avoid the collision.
mkdir -p "$TMP/autosign-timeout-src" "$TMP/manual-timeout-src"
printf 'ton-provider #480 auto-sign timeout test payload\n' > "$TMP/autosign-timeout-src/note.txt"
printf 'ton-provider #480 manual (deeplink) timeout test payload\n' > "$TMP/manual-timeout-src/note.txt"
cb snapshot --dir "$TMP/autosign-timeout-src" --out "$TMP/autosign-timeout.age"
cb snapshot --dir "$TMP/manual-timeout-src" --out "$TMP/manual-timeout.age"

echo "== auto-sign: a deploy that never confirms on-chain times out with auto-sign-appropriate guidance, NOT the Tonkeeper-deeplink instruction (#480) =="
touch "$NEVER_ACTIVE_FLAG"
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/autosign-timeout.age" --backend ton-provider 2>"$TMP/autosign-timeout.err"; then
  echo "[FAIL] push succeeded despite the mock tonapi reporting the contract as never-active"; exit 1
fi
grep -q 'did not become active on-chain within' "$TMP/autosign-timeout.err" || { echo "[FAIL] the deploy-confirm timeout did not fire"; cat "$TMP/autosign-timeout.err"; exit 1; }
if grep -q 'sign the deeplink printed above' "$TMP/autosign-timeout.err"; then
  echo "[FAIL] the auto-sign timeout wrongly told the operator to sign a deeplink that was never printed (issue #480)"; cat "$TMP/autosign-timeout.err"; exit 1
fi
grep -q "TON balance" "$TMP/autosign-timeout.err" || { echo "[FAIL] the auto-sign timeout did not give auto-sign-appropriate guidance"; cat "$TMP/autosign-timeout.err"; exit 1; }
echo "[PASS] auto-sign timeout gives auto-sign-appropriate guidance, not the Tonkeeper-deeplink instruction"

echo "== auto-sign: the same timeout wait prints periodic progress instead of staying silent for its whole duration (#480) =="
PROGRESS_LINES=$(grep -c 'still waiting for contract' "$TMP/autosign-timeout.err")
[ "$PROGRESS_LINES" -ge 1 ] || { echo "[FAIL] no progress line was printed during the deploy-confirm wait"; cat "$TMP/autosign-timeout.err"; exit 1; }
grep -Eq 'still waiting for contract .+ to become active on-chain \([0-9]+s elapsed\)' "$TMP/autosign-timeout.err" || { echo "[FAIL] progress line has the wrong shape"; cat "$TMP/autosign-timeout.err"; exit 1; }
echo "[PASS] the deploy-confirm wait prints periodic progress ($PROGRESS_LINES line(s) in a ${CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS}ms window)"

echo "== Tonkeeper-deeplink path: the SAME timeout keeps the original 'sign the deeplink' guidance (positive control — #480 must not have broken the manual path) =="
if cb push --in "$TMP/manual-timeout.age" --backend ton-provider 2>"$TMP/manual-timeout.err"; then
  echo "[FAIL] push succeeded despite the mock tonapi reporting the contract as never-active"; exit 1
fi
grep -q 'sign the deeplink printed above' "$TMP/manual-timeout.err" || { echo "[FAIL] the Tonkeeper-deeplink path lost its original timeout guidance"; cat "$TMP/manual-timeout.err"; exit 1; }
if grep -q "TON balance" "$TMP/manual-timeout.err"; then
  echo "[FAIL] the Tonkeeper-deeplink path wrongly printed the auto-sign-only guidance"; cat "$TMP/manual-timeout.err"; exit 1
fi
echo "[PASS] the Tonkeeper-deeplink path's timeout guidance is unchanged"
rm -f "$NEVER_ACTIVE_FLAG"
unset CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_TIMEOUT_MS CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_POLL_MS CYPHER_BRAIN_TON_PROVIDER_DEPLOY_CONFIRM_PROGRESS_MS

echo "== schedule install --backend ton-provider is eligible ONLY when a TON wallet is configured (#396 PR2) =="
if CYPHER_BRAIN_TON_WALLET= cb schedule install --backend ton-provider --dir "$SRC" --no-load \
  > "$TMP/schedule-no-wallet.out" 2>"$TMP/schedule-no-wallet.err"; then
  echo "[FAIL] schedule install accepted ton-provider with no TON wallet configured"; exit 1
fi
# #434: this now gets its own specific message (not the generic "unknown backend" —
# ton-provider IS a recognized name, it just needs CYPHER_BRAIN_TON_WALLET set).
grep -Fq "ton-provider requires CYPHER_BRAIN_TON_WALLET=<path> — see 'wallet create --chain ton'" "$TMP/schedule-no-wallet.err" \
  || { echo "[FAIL] wrong rejection for schedule install without a wallet"; cat "$TMP/schedule-no-wallet.err"; exit 1; }
echo "[PASS] schedule install rejects ton-provider with no TON wallet configured"
CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" cb schedule install --backend ton-provider --dir "$SRC" --no-load \
  > "$TMP/schedule-with-wallet.out" 2>"$TMP/schedule-with-wallet.err" \
  || { echo "[FAIL] schedule install refused ton-provider WITH a TON wallet configured"; cat "$TMP/schedule-with-wallet.err"; exit 1; }
echo "[PASS] schedule install accepts ton-provider once a TON wallet is configured"

echo "== schedule install --backend ton-provider ALSO requires its own spend cap + notify binary (Codex review, xhigh pass) =="
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND= \
  cb schedule install --backend ton-provider --dir "$SRC" --no-load 2>"$TMP/schedule-no-cap.err"; then
  echo "[FAIL] schedule install accepted ton-provider with no CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND"; exit 1
fi
grep -q 'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND' "$TMP/schedule-no-cap.err" || { echo "[FAIL] wrong rejection for schedule install with no spend cap"; cat "$TMP/schedule-no-cap.err"; exit 1; }
echo "[PASS] schedule install rejects ton-provider with no spend cap configured"
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN= \
  cb schedule install --backend ton-provider --dir "$SRC" --no-load 2>"$TMP/schedule-no-notify.err"; then
  echo "[FAIL] schedule install accepted ton-provider with no CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN"; exit 1
fi
grep -q 'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN' "$TMP/schedule-no-notify.err" || { echo "[FAIL] wrong rejection for schedule install with no notify binary"; cat "$TMP/schedule-no-notify.err"; exit 1; }
echo "[PASS] schedule install rejects ton-provider with no notify binary configured"

echo "== the installed runner actually CARRIES the ton-provider env vars a nightly push needs (Codex review: install-time checks are worthless if the runner doesn't also get what it checked for) =="
RUNNER="$CYPHER_BRAIN_SCHEDULE_DIR/nightly.sh"
[ -f "$RUNNER" ] || { echo "[FAIL] no runner script found at $RUNNER after schedule install"; exit 1; }
for needle in 'CYPHER_BRAIN_TON_WALLET=' 'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND=' 'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN='; do
  grep -q "$needle" "$RUNNER" || { echo "[FAIL] generated runner is missing $needle"; cat "$RUNNER"; exit 1; }
done
echo "[PASS] the generated nightly runner carries CYPHER_BRAIN_TON_WALLET/_MAX_SPEND/_NOTIFY_BIN"

# ========================================================================
# issue #639: a SIGNED push calls put() TWICE (ciphertext, then its ".minisig" sidecar),
# each deploying its OWN StorageV1 contract — CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND must
# bound what BOTH deploys spend TOGETHER, not check each in isolation. Run last (not
# earlier, alongside the many unsigned pushes above): enabling a signing key here makes
# EVERY `cb snapshot` from this point on emit a ".minisig" sidecar, which would change
# every push() call after it — safe only because nothing else in this script runs after.
echo "== issue #639: combined ciphertext+signature spend is checked against ONE cap, not two independent ones =="
cb keygen --sign >/dev/null
mkdir -p "$TMP/combined-spend-src"
printf 'ton-provider combined-spend (#639) selftest payload\n' > "$TMP/combined-spend-src/note.txt"
cb snapshot --dir "$TMP/combined-spend-src" --out "$TMP/combined-spend.age" >/dev/null
[ -f "$TMP/combined-spend.age.minisig" ] || { echo "[FAIL] cb keygen --sign did not make snapshot write a .minisig sidecar"; exit 1; }
CS_SIZE=$(stat -f%z "$TMP/combined-spend.age" 2>/dev/null || stat -c%s "$TMP/combined-spend.age")
echo "$CS_SIZE" > "$TMP/notify-downloaded" # >= both files' sizes; the SAME control file backs both put() calls this push makes
# Both the ciphertext and its tiny .minisig sidecar fall under buildDeploy()'s 0.1MB
# MIN_SIZE_MB_BYTES floor, so — against the SAME selected provider/rate/span — each
# deploy's own amountNano (a PER-CALL, single-deploy computation) works out to the
# SAME value X. A cap of exactly X therefore lets the FIRST (ciphertext) deploy through
# on its own merits while leaving NO room for the second (signature) deploy — exactly
# the "each deploy clears the cap in isolation, their sum does not" shape #639 reports.
X=$(cb estimate --in "$TMP/combined-spend.age" --backend ton-provider --json | node -e '
  const j = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
  if (typeof j.cost !== "string" || !/^[0-9]+$/.test(j.cost)) { console.error("no numeric cost in estimate: " + JSON.stringify(j)); process.exit(1); }
  console.log(j.cost);
')

echo "-- a cap equal to ONE deploy's cost lets the ciphertext through, then refuses the signature deploy (no budget left) --"
RECEIPT_COUNT_BEFORE=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
if CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND="$X" cb push --in "$TMP/combined-spend.age" --backend ton-provider \
  >/dev/null 2>"$TMP/combined-spend-under.err"; then
  echo "[FAIL] push succeeded despite the combined ciphertext+signature spend exceeding a cap of exactly one deploy's cost"; cat "$TMP/combined-spend-under.err"; exit 1
fi
grep -q 'ciphertext upload succeeded' "$TMP/combined-spend-under.err" \
  || { echo "[FAIL] expected the ciphertext deploy to have already succeeded before the signature deploy was refused"; cat "$TMP/combined-spend-under.err"; exit 1; }
grep -q "already committed $X nanoTON toward CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND=$X nanoTON" "$TMP/combined-spend-under.err" \
  || { echo "[FAIL] the combined-spend guard's own message did not fire"; cat "$TMP/combined-spend-under.err"; exit 1; }
RECEIPT_COUNT_AFTER=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
[ "$((RECEIPT_COUNT_AFTER - RECEIPT_COUNT_BEFORE))" = "1" ] \
  || { echo "[FAIL] expected exactly ONE new ton-provider receipt (the ciphertext deploy only) — got $((RECEIPT_COUNT_AFTER - RECEIPT_COUNT_BEFORE))"; exit 1; }
echo "[PASS] combined-spend guard refuses the signature deploy once the ciphertext deploy already spent the whole cap, and only ONE deploy's worth was actually spent"

echo "-- a cap covering BOTH deploys combined lets the whole signed push succeed --"
OVER_CAP=$(node -e 'console.log((BigInt(process.argv[1]) * 3n).toString())' "$X") # comfortably >= 2X
CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND="$OVER_CAP" cb push --in "$TMP/combined-spend.age" --backend ton-provider \
  >/dev/null 2>"$TMP/combined-spend-ok.err" \
  || { echo "[FAIL] signed push failed despite a cap comfortably covering BOTH deploys combined"; cat "$TMP/combined-spend-ok.err"; exit 1; }
grep -q "pushed $TMP/combined-spend.age.minisig -> ton-provider:" "$TMP/combined-spend-ok.err" \
  || { echo "[FAIL] expected the .minisig sidecar to also be pushed once the combined cap allows it"; cat "$TMP/combined-spend-ok.err"; exit 1; }
echo "[PASS] a cap covering the combined ciphertext+signature spend lets both deploys succeed"

echo "== regression (rebase-introduced): retrying an ALREADY fully-deployed signed push must not be refused by the spend cap =="
# This exact combination did not exist in either #638 or #639 individually — it only
# became reachable once both were merged together (this backend now has BOTH a shared
# spendTracker across a signed push's two put() calls, #639, AND a per-call
# already-active skip that must charge NOTHING when a deploy is skipped, #638). The
# OVER_CAP push just above already made combined-spend.age's ciphertext AND its
# .minisig sidecar both fully active on-chain. Retrying the EXACT SAME file now must be
# a pure no-op for BOTH deploys (both already-active, no funds move) — even under a
# spend cap far too small to cover either deploy's real amountNano, since nothing is
# actually being spent this time. Before the charge was moved to only fire on the
# !alreadyActive branch, the tracker was charged the deploy's FULL amountNano the
# moment it was computed, regardless of whether the deploy turned out to be
# already-active and skipped — so the ciphertext's phantom "spend" of X against the cap
# left zero budget for the sidecar's OWN remainingMaxSpendNano check inside
# buildDeploy(), wrongly refusing a retry that does not need to spend anything at all.
# Cap set to exactly X (one deploy's own cost, computed above) — enough for a single
# deploy taken alone (so buildDeploy()'s own per-deploy cap check never itself refuses
# either deploy on its individual merits) but, pre-fix, not enough for a SECOND deploy
# once the first one's phantom charge wrongly ate the whole cap. A cap smaller than X
# would be refused by buildDeploy()'s own check regardless of this fix and would not
# isolate the bug this test exists to catch.
RECEIPT_COUNT_BEFORE_RETRY=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND="$X" cb push --in "$TMP/combined-spend.age" --backend ton-provider \
  >/dev/null 2>"$TMP/combined-spend-retry.err" \
  || { echo "[FAIL] retrying an already-fully-deployed signed push was refused under a cap equal to only ONE deploy's cost (both sides should skip, spending nothing)"; cat "$TMP/combined-spend-retry.err"; exit 1; }
# warn() (src/lib/warn.ts) prints each warning immediately AND repeats it in an
# end-of-run summary block — so a genuinely-once-per-deploy warning naturally appears
# TWICE in stderr per deploy. Count DISTINCT contract addresses named in the
# already-active warning, not raw line occurrences, so this assertion is not coupled
# to warn()'s own print-then-summarize formatting.
ALREADY_ACTIVE_ADDR_COUNT=$(grep -o 'contract [0-9]*:[0-9a-f]\{64\} already shows on-chain activity' "$TMP/combined-spend-retry.err" | sort -u | wc -l | tr -d ' ')
[ "$ALREADY_ACTIVE_ADDR_COUNT" = "2" ] \
  || { echo "[FAIL] expected BOTH the ciphertext and signature deploys (2 distinct contract addresses) to report already-active/skipped on retry, got $ALREADY_ACTIVE_ADDR_COUNT"; cat "$TMP/combined-spend-retry.err"; exit 1; }
RECEIPT_COUNT_AFTER_RETRY=$(grep -c '"backend":"ton-provider"' "$RECEIPT_LEDGER_PATH_TP" 2>/dev/null || echo 0)
[ "$RECEIPT_COUNT_AFTER_RETRY" = "$RECEIPT_COUNT_BEFORE_RETRY" ] \
  || { echo "[FAIL] expected NO new receipt from a fully-skipped retry (no real spend occurred) — count went from $RECEIPT_COUNT_BEFORE_RETRY to $RECEIPT_COUNT_AFTER_RETRY"; exit 1; }
echo "[PASS] retrying an already-fully-deployed signed push succeeds under a tiny cap (both deploys skip re-funding, spending nothing, no new receipt)"

echo "ALL PASS"
