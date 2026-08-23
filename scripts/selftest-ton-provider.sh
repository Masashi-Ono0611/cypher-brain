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

cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# A fixed, syntactically-valid ProviderKey pubkey — this script's mytonprovider.org mock
# and its notify-response mock must agree on it (real code cross-checks pubkey shape but
# not its cryptographic validity — see ton-provider.ts's field notes on why the pubkey,
# not the wallet address, is the on-chain identifier).
PROVIDER_PUBKEY="abababababababababababababababababababababababababababababababab"
PROVIDER_WALLET="UQCCrKrQHLpB75vvrd5js78eB7qK6v7Cpz4WJpV2DoZnY-GC"

# ---- mock mytonprovider.org: POST /api/v1/providers/search -> one live candidate ----
cat > "$TMP/mock-mytonprovider.mjs" <<'MOCKEOF'
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
const port = Number(process.argv[2]);
const pubkey = process.argv[3];
const address = process.argv[4];
const emptyFlagPath = process.argv[5]; // if this file exists, respond with zero candidates
const badSpanFlagPath = process.argv[6]; // if this file exists, min_span rounds up past max_span
createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const empty = emptyFlagPath && existsSync(emptyFlagPath);
    const badSpan = badSpanFlagPath && existsSync(badSpanFlagPath);
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
                price: 4915200000, // -> rate 800 nanoTON/MB/day (price / (1024*200*30))
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
node "$TMP/mock-mytonprovider.mjs" "$MYTONPROVIDER_PORT" "$PROVIDER_PUBKEY" "$PROVIDER_WALLET" "$TMP/empty-providers-flag" "$TMP/bad-span-flag" &
MYTONPROVIDER_PID=$!
export CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL="http://127.0.0.1:$MYTONPROVIDER_PORT"

# ---- mock tonapi: GET /v2/blockchain/accounts/<addr> -> always 'active' ----
cat > "$TMP/mock-tonapi.mjs" <<'MOCKEOF'
import { createServer } from 'node:http';
const port = Number(process.argv[2]);
createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'active', balance: 5000000000 }));
}).listen(port, '127.0.0.1');
MOCKEOF
TONAPI_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
node "$TMP/mock-tonapi.mjs" "$TONAPI_PORT" &
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
echo "== notify response =="
echo "  status:     active"
echo "  reason:     ok"
echo "  downloaded: \$(cat "\$STATE" 2>/dev/null || echo 0) bytes"
EOF
chmod +x "$SHIM/fake-notify"
export CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN="$SHIM/fake-notify"

export CYPHER_BRAIN_TON_PROVIDER_OWNER="0:0000000000000000000000000000000000000000000000000000000000000001"
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

echo "== push --backend ton-provider (deploy -> wait active -> notify-until-full) =="
echo "$SIZE" > "$TMP/notify-downloaded" # first notify call already reports "fully downloaded" — the common case
LOC=$(cb push --in "$TMP/snap.age" --backend ton-provider --save-locator "$TMP/loc.tsv" 2>"$TMP/push.err")
printf '%s' "$LOC" | grep -Eq '^ton-provider:v1:[0-9a-f]{64}$' || { echo "[FAIL] locator shape: $LOC"; exit 1; }
echo "[PASS] locator matches ton-provider:v1:<64-hex>"
grep -q "selected provider $PROVIDER_PUBKEY" "$TMP/push.err" || { echo "[FAIL] did not report the selected provider"; exit 1; }
echo "[PASS] provider selection ran against the mock registry"

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
grep -q 'bytes so far — waiting' "$TMP/partial.err" || { echo "[FAIL] push did not report partial-download progress"; exit 1; }
grep -Eq 'did not (finish fetching the bag|report a full download)' "$TMP/partial.err" || { echo "[FAIL] push did not time out with the expected message"; exit 1; }
echo "$SIZE" > "$TMP/notify-downloaded" # restore for any later runs
echo "[PASS] push correctly waits on a partial provider download instead of declaring success early"

echo "ALL PASS"
