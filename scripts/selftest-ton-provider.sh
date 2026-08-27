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

cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

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

# ---- mock tonapi: GET /v2/blockchain/accounts/<addr> -> always 'active', PLUS
# (#396 Phase B) GET /v2/rates?... for the USD-estimate line and an owner-specific
# low-balance mode for the pre-deploy funds-check positive control below. The
# low-balance flag is keyed to the EXACT owner address string this script exports
# as CYPHER_BRAIN_TON_PROVIDER_OWNER (already in raw workchain:hex form, so
# Address.parse(...).toRawString() round-trips it unchanged) — any OTHER address
# (i.e. the deployed contract's own address, polled by waitForContractActive())
# keeps returning the generous fixed balance, so that polling path is unaffected.
cat > "$TMP/mock-tonapi.mjs" <<'MOCKEOF'
import { createServer } from 'node:http';
import { existsSync, appendFileSync, readFileSync } from 'node:fs';
const port = Number(process.argv[2]);
const ownerAddr = process.argv[3];
const lowBalanceFlagPath = process.argv[4];
const frozenAddrFlagPath = process.argv[5]; // if present, its CONTENTS name an address to report 'frozen' for
const seqnoFilePath = process.argv[6]; // if present, its CONTENTS are the seqno to answer /methods/seqno with (default 0)
const broadcastLogPath = process.argv[7]; // every accepted POST /v2/blockchain/message body is appended here, one BOC per line
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
  const frozenAddr = frozenAddrFlagPath && existsSync(frozenAddrFlagPath) ? readFileSync(frozenAddrFlagPath, 'utf8').trim() : null;
  const isFrozenTarget = frozenAddr && url.pathname.includes(frozenAddr);
  const lowBalance = lowBalanceFlagPath && existsSync(lowBalanceFlagPath) && url.pathname.includes(ownerAddr);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: isFrozenTarget ? 'frozen' : 'active', balance: lowBalance ? 1 : 5000000000 }));
}).listen(port, '127.0.0.1');
MOCKEOF
FROZEN_ADDR_FLAG="$TMP/frozen-addr-flag"
SEQNO_FILE="$TMP/seqno-value"
BROADCAST_LOG="$TMP/broadcast-log"
TONAPI_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node "$TMP/mock-tonapi.mjs" "$TONAPI_PORT" "$TON_PROVIDER_OWNER_ADDR" "$LOW_BALANCE_FLAG" "$FROZEN_ADDR_FLAG" "$SEQNO_FILE" "$BROADCAST_LOG" &
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
cat > "$SHIM/fake-notify" <<EOF
#!/usr/bin/env bash
# Args: notify --provider-pubkey <hex> --contract <addr> --mainnet
# Downloaded byte count is read from a control file this script writes on push, so the
# "wait until fully downloaded" retry loop can be exercised deterministically (see the
# partial-then-full positive control below) instead of only ever answering "done" once.
STATE="$TMP/notify-downloaded"
REASON_FILE="$TMP/notify-reason-override"
# issue #404: records the args THIS call received, overwriting each time — the
# network-selection positive controls below check the MOST RECENT call only.
printf '%s\n' "\$@" > "$TMP/notify-args.log"
echo "== notify response =="
echo "  status:     active"
echo "  reason:     \$(cat "\$REASON_FILE" 2>/dev/null || echo ok)"
echo "  downloaded: \$(cat "\$STATE" 2>/dev/null || echo 0) bytes"
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
echo "$EST" | grep -q '"unit":"nanoTON"' || { echo "[FAIL] estimate did not price in nanoTON: $EST"; exit 1; }
echo "[PASS] estimate returns a real nanoTON cost"
# #396 Phase B: usd_estimate is now populated too (tonUsdRate(), estimate.ts), sourced
# from the mock tonapi's /v2/rates handler above (fixed at $3.5/TON) — a real number,
# not the null every OTHER field-completeness gap in this backend used to leave.
echo "$EST" | grep -q '"usd_estimate":null' && { echo "[FAIL] estimate's usd_estimate is null despite the mock tonapi rates endpoint answering"; echo "$EST"; exit 1; }
echo "$EST" | grep -Eq '"usd_estimate":[0-9]' || { echo "[FAIL] estimate did not include a numeric usd_estimate: $EST"; exit 1; }
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
echo "$EST2" | grep -q 'looks below the ~0.05 TON floor' || { echo "[FAIL] estimate's note did not carry the bounty-floor warning: $EST2"; exit 1; }
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
echo "$BAL" | grep -q '"balance_nanoton":5000000000' || { echo "[FAIL] wallet balance --chain ton did not read the mock tonapi balance: $BAL"; exit 1; }
echo "[PASS] wallet balance --chain ton reads the (mocked) on-chain balance"

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
: > "$BROADCAST_LOG"
CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/mismatch-fixed.err" >/dev/null \
  || { echo "[FAIL] push failed after unsetting the stale owner"; cat "$TMP/mismatch-fixed.err"; exit 1; }
grep -q "auto-signing with local wallet $TON_WALLET_ADDR" "$TMP/mismatch-fixed.err" || { echo "[FAIL] did not auto-sign as the wallet's own address"; cat "$TMP/mismatch-fixed.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] || { echo "[FAIL] push never reached broadcast after unsetting the stale owner"; exit 1; }
echo "[PASS] unsetting CYPHER_BRAIN_TON_PROVIDER_OWNER resolves the ambiguity and lets auto-sign proceed"

echo "== auto-sign: a frozen local wallet refuses to sign (no silent spend attempt from a wallet that cannot act) =="
printf '%s' "$TON_WALLET_ADDR_RAW" > "$FROZEN_ADDR_FLAG"
: > "$BROADCAST_LOG" # Codex review, xhigh pass: prove the refusal happens BEFORE broadcast, not just that push exits non-zero
if CYPHER_BRAIN_TON_WALLET="$TMP/ton-wallet.json" CYPHER_BRAIN_TON_PROVIDER_OWNER= \
  cb push --in "$TMP/got.age" --backend ton-provider 2>"$TMP/frozen.err"; then
  echo "[FAIL] push succeeded despite the local wallet being frozen on-chain"; exit 1
fi
grep -q 'is frozen on-chain' "$TMP/frozen.err" || { echo "[FAIL] wrong frozen-wallet message"; cat "$TMP/frozen.err"; exit 1; }
[ -s "$BROADCAST_LOG" ] && { echo "[FAIL] a frozen wallet still reached broadcast before being refused"; exit 1; }
rm -f "$FROZEN_ADDR_FLAG"
echo "[PASS] frozen-wallet guard fired before any broadcast attempt"

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

echo "ALL PASS"
