#!/usr/bin/env bash
# `publish-latest` (src/lib/ton-dns.ts) round-trip proof — CI-safe: no real TON network,
# no real seeder box, no real tonapi.io. The seeder is the SAME local-directory-plus-
# PATH-shim technique scripts/selftest-ton.sh uses (read it first — this script reuses
# that setup verbatim for the `push --backend ton` step that produces a real bag id to
# publish), and tonapi.io is scripts/mock-tonapi.mjs (a tiny node:http server) with
# CYPHER_BRAIN_TON_TONAPI_URL pointed at it.
#
# Positive controls are driven to actually FIRE here, not assumed: a non-ton locator
# file, a bag missing from the P2P network, and a missing --yes each have to produce
# their real refusal message before this script passes.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
# cb/start_ton_seeder: shared across scripts/selftest-*.sh, see
# scripts/selftest-lib.sh (#570, #572).
source "$ROOT/scripts/selftest-lib.sh"

TMP="$(mktemp -d)"
SEEDER_PID=""
TONAPI_PID=""
cleanup() {
  # `|| :` on each kill: under `set -e`, a dead PID makes `kill` the last (and
  # failing) command in this `&&` list, which aborts the EXIT trap right
  # here — skipping the remaining cleanup lines below (including rm -rf
  # "$TMP") and leaking the temp dir and/or the sibling mock daemon.
  [ -n "$SEEDER_PID" ] && kill "$SEEDER_PID" 2>/dev/null || :
  [ -n "$TONAPI_PID" ] && kill "$TONAPI_PID" 2>/dev/null || :
  rm -rf "$TMP"
}
trap cleanup EXIT

export CYPHER_BRAIN_HOME="$TMP/keys"

# ---- the "seeder": a mock tonutils-storage daemon on loopback + a home
# directory, reached through PATH-shimmed ssh/scp (same setup
# scripts/selftest-ton.sh uses — publish-latest needs a REAL ton:v1: locator to
# publish, which means pushing through the same mock seeder that script uses).
# start_ton_seeder sets SEEDER_HOME/SEEDER_PID/MOCK_PORT/SHIM as globals;
# SEEDER_PID feeds the cleanup trap above. ----
start_ton_seeder

SRC="$TMP/brain-src"
mkdir -p "$SRC"
printf 'publish-latest selftest marker\n' > "$SRC/note.txt"

echo "== setup: keygen, snapshot, push --backend ton (produces a real bag to publish) =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap.age" >/dev/null
LOC="$(cb push --in "$TMP/snap.age" --backend ton --save-locator "$TMP/loc.tsv")"
printf '%s' "$LOC" | grep -Eq '^ton:v1:[0-9a-f]{64}$' || { echo "[FAIL] setup push did not produce a ton:v1 locator: $LOC"; exit 1; }
BAG_ID="${LOC#ton:v1:}"
echo "[setup] bag id: $BAG_ID"

# ---- the mock tonapi.io: domain -> NFT address, and DNS resolve polling ----
MOCK_ADDR="$(node "$ROOT/scripts/print-mock-ton-address.mjs")"
TONAPI_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
MOCK_TONAPI_ADDRESS="$MOCK_ADDR" MOCK_TONAPI_BAG_ID="$BAG_ID" MOCK_TONAPI_FLIP_AFTER=2 \
  node "$ROOT/scripts/mock-tonapi.mjs" --port "$TONAPI_PORT" &
TONAPI_PID=$!
READY=0
for _ in $(seq 1 50); do
  # -f: mock-tonapi.mjs always replies 200 for this route once it is routing
  # requests, so an HTTP error (>=400) here means something other than
  # "still starting up". --max-time: bound each probe so a hung connection
  # cannot stall this loop indefinitely (worst case ~100s across all 50
  # probes, vs. the near-instant per-probe failure a real "not up yet"
  # connection refusal gives).
  if curl -sf --max-time 2 "http://127.0.0.1:$TONAPI_PORT/v2/dns/test.ton" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.2
done
[ "$READY" = 1 ] || { echo "[FAIL] mock tonapi server did not come up on port $TONAPI_PORT"; exit 1; }
export CYPHER_BRAIN_TON_TONAPI_URL="http://127.0.0.1:$TONAPI_PORT"

echo "== happy path: publish-latest --yes --wait sees the mock DNS record flip to the bag id =="
DEEPLINK="$(cb publish-latest --domain test.ton --from-locator-file "$TMP/loc.tsv" --yes --wait 25 2>"$TMP/happy.err")"
printf '%s' "$DEEPLINK" | grep -Eq '^https://app\.tonkeeper\.com/transfer/' || { echo "[FAIL] stdout is not a Tonkeeper deeplink: $DEEPLINK"; cat "$TMP/happy.err"; exit 1; }
echo "[PASS] stdout is a Tonkeeper transfer deeplink"
printf '%s' "$DEEPLINK" | grep -Fq "https://app.tonkeeper.com/transfer/$MOCK_ADDR?" || { echo "[FAIL] deeplink destination is not the mock NFT address: $DEEPLINK"; exit 1; }
echo "[PASS] deeplink destination equals the resolved (mock) NFT address"
printf '%s' "$DEEPLINK" | grep -Fq 'amount=20000000' || { echo "[FAIL] deeplink amount is not 20000000 nanoTON (0.02 TON): $DEEPLINK"; exit 1; }
echo "[PASS] deeplink amount is 20000000 nanoTON (0.02 TON gas)"
grep -q "Domain: test.ton" "$TMP/happy.err" || { echo "[FAIL] domain not printed"; exit 1; }
grep -qF "NFT address: $MOCK_ADDR" "$TMP/happy.err" || { echo "[FAIL] resolved NFT address not printed"; exit 1; }
grep -q "Bag id: $BAG_ID" "$TMP/happy.err" || { echo "[FAIL] bag id not printed"; exit 1; }
grep -q 'cypher-brain never signs transactions' "$TMP/happy.err" || { echo "[FAIL] never-signs disclosure missing"; exit 1; }
echo "[PASS] domain, NFT address, bag id and the never-signs disclosure were all printed"
grep -qF "view on tonviewer: https://tonviewer.com/$MOCK_ADDR" "$TMP/happy.err" || { echo "[FAIL] default tonviewer.com cross-check link not printed"; cat "$TMP/happy.err"; exit 1; }
grep -qF "against https://tonviewer.com/$MOCK_ADDR, a different service" "$TMP/happy.err" || { echo "[FAIL] default tonviewer.com link missing from the cross-check warning"; cat "$TMP/happy.err"; exit 1; }
echo "[PASS] default (unset CYPHER_BRAIN_TON_TONVIEWER_URL) cross-check link is https://tonviewer.com"
grep -q "CONFIRMED: test.ton's DNS storage record now resolves to $BAG_ID" "$TMP/happy.err" || { echo "[FAIL] --wait did not report CONFIRMED"; cat "$TMP/happy.err"; exit 1; }
echo "[PASS] --wait polled the mock resolve endpoint until it flipped, then reported CONFIRMED"

echo "== happy path: decoded deeplink BOC carries op 0x4eb1f0f9 and the bag id bytes =="
node "$ROOT/scripts/decode-tonkeeper-deeplink.mjs" "$DEEPLINK" "$BAG_ID"

echo "== positive control (#693): CYPHER_BRAIN_TON_TONVIEWER_URL overrides the printed cross-check link =="
TESTNET_TONVIEWER="https://testnet.tonviewer.com"
CYPHER_BRAIN_TON_TONVIEWER_URL="$TESTNET_TONVIEWER" \
  cb publish-latest --domain test.ton --from-locator-file "$TMP/loc.tsv" --yes >/dev/null 2>"$TMP/tonviewer-override.err"
grep -qF "view on tonviewer: $TESTNET_TONVIEWER/$MOCK_ADDR" "$TMP/tonviewer-override.err" || { echo "[FAIL] CYPHER_BRAIN_TON_TONVIEWER_URL override not reflected in the printed link"; cat "$TMP/tonviewer-override.err"; exit 1; }
grep -qF "against $TESTNET_TONVIEWER/$MOCK_ADDR, a different service" "$TMP/tonviewer-override.err" || { echo "[FAIL] CYPHER_BRAIN_TON_TONVIEWER_URL override not reflected in the cross-check warning"; cat "$TMP/tonviewer-override.err"; exit 1; }
if grep -qF "https://tonviewer.com/$MOCK_ADDR" "$TMP/tonviewer-override.err"; then
  echo "[FAIL] mainnet tonviewer.com link still printed despite CYPHER_BRAIN_TON_TONVIEWER_URL override"; cat "$TMP/tonviewer-override.err"; exit 1
fi
echo "[PASS] CYPHER_BRAIN_TON_TONVIEWER_URL overrides the printed cross-check link (e.g. to testnet.tonviewer.com)"

echo "== positive control: non-ton locator file is REFUSED =="
printf 'fake-arweave-tx-id\tarweave\tdeadbeef\n' > "$TMP/nonton-loc.tsv"
if cb publish-latest --domain test.ton --from-locator-file "$TMP/nonton-loc.tsv" --yes 2>"$TMP/nonton.err"; then
  echo "[FAIL] a non-ton locator file was accepted"; exit 1
fi
grep -q 'publish-latest only works with the ton backend' "$TMP/nonton.err" || { echo "[FAIL] wrong non-ton refusal message"; cat "$TMP/nonton.err"; exit 1; }
echo "[PASS] non-ton locator file refused"

echo "== positive control: missing --yes refuses BEFORE printing the deeplink =="
if OUT="$(cb publish-latest --domain test.ton --from-locator-file "$TMP/loc.tsv" 2>"$TMP/noyes.err")"; then
  echo "[FAIL] publish-latest without --yes exited 0"; exit 1
fi
[ -z "$OUT" ] || { echo "[FAIL] stdout carried something without --yes: $OUT"; exit 1; }
grep -q 'confirm you want to see it' "$TMP/noyes.err" || { echo "[FAIL] wrong missing-yes refusal message"; cat "$TMP/noyes.err"; exit 1; }
echo "[PASS] missing --yes refused before the deeplink was printed"

echo "== positive control: bag gone from the P2P network -> availability gate refuses =="
node -e 'require("fs").writeFileSync(process.argv[1], "{}")' "$MOCK_TON_STORE/registry.json"
if GONE_OUT="$(cb publish-latest --domain test.ton --from-locator-file "$TMP/loc.tsv" --yes 2>"$TMP/gone.err")"; then
  echo "[FAIL] publish-latest succeeded against an unavailable bag"; exit 1
fi
grep -q 'DNS must never point at an unavailable bag' "$TMP/gone.err" || { echo "[FAIL] wrong unavailable-bag refusal message"; cat "$TMP/gone.err"; exit 1; }
echo "[PASS] availability gate fired for a bag missing from the network"
# The gate runs BEFORE the domain is even resolved, let alone a deeplink built — a
# regression that printed the deeplink before failing must fail this test (multi-model
# review W4), not just print the right message alongside a leaked stdout.
[ -z "$GONE_OUT" ] || { echo "[FAIL] stdout carried something even though the availability gate refused: $GONE_OUT"; exit 1; }
echo "[PASS] stdout stayed empty when the availability gate refused"

echo "== positive control: malformed --domain is REFUSED =="
if cb publish-latest --domain "Test.TON" --from-locator-file "$TMP/loc.tsv" --yes 2>"$TMP/baddomain.err"; then
  echo "[FAIL] an uppercase/malformed --domain was accepted"; exit 1
fi
grep -q '\-\-domain must be a lowercase \.ton domain' "$TMP/baddomain.err" || { echo "[FAIL] wrong malformed-domain refusal message"; cat "$TMP/baddomain.err"; exit 1; }
echo "[PASS] malformed --domain refused"

echo "== positive control: malformed --wait is REFUSED =="
if cb publish-latest --domain test.ton --from-locator-file "$TMP/loc.tsv" --yes --wait "-5" 2>"$TMP/badwait.err"; then
  echo "[FAIL] a negative --wait was accepted"; exit 1
fi
grep -q -- '--wait must be a non-negative whole number of seconds' "$TMP/badwait.err" || { echo "[FAIL] wrong malformed-wait refusal message"; cat "$TMP/badwait.err"; exit 1; }
echo "[PASS] malformed --wait refused"

echo "== positive control (#482): missing --from-locator-file is REFUSED with a distinct message =="
MISSING_LOC="$TMP/does-not-exist.tsv"
if cb publish-latest --domain test.ton --from-locator-file "$MISSING_LOC" --yes 2>"$TMP/missingloc.err"; then
  echo "[FAIL] a nonexistent --from-locator-file was accepted"; exit 1
fi
grep -qF "no such locator file: $MISSING_LOC" "$TMP/missingloc.err" || { echo "[FAIL] wrong missing-file refusal message"; cat "$TMP/missingloc.err"; exit 1; }
echo "[PASS] missing locator file refused with 'no such locator file'"

echo "== positive control (#482): locator file with no locator line is REFUSED with a distinct message =="
EMPTY_LOC="$TMP/empty-loc.tsv"
printf '# just a comment, no locator line\n' > "$EMPTY_LOC"
if cb publish-latest --domain test.ton --from-locator-file "$EMPTY_LOC" --yes 2>"$TMP/emptyloc.err"; then
  echo "[FAIL] a locator file with no locator line was accepted"; exit 1
fi
grep -qF "$EMPTY_LOC has no locator line" "$TMP/emptyloc.err" || { echo "[FAIL] wrong no-locator-line refusal message"; cat "$TMP/emptyloc.err"; exit 1; }
grep -qF 'run a push with --save-locator first, and point --from-locator-file at the file it wrote' "$TMP/emptyloc.err" || { echo "[FAIL] no-locator-line refusal is missing the recovery guidance"; cat "$TMP/emptyloc.err"; exit 1; }
echo "[PASS] locator file with no locator line refused with 'has no locator line' + recovery guidance, distinct from the missing-file message"

echo "== skipped control: missing @ton/ton install advice (not testable here) =="
echo "  @ton/ton is a real, installed optionalDependency in this checkout (moved here from"
echo "  devDependencies) — there is no way to make the dynamic import() fail without"
echo "  uninstalling it from node_modules, which would break every OTHER selftest/build in"
echo "  this run too. sdkImportAdvice() itself (the shared helper) already has its own"
echo "  coverage via selftest:sdk-advice; not re-proven here."

echo "== ton-dns selftest: ALL PASS =="
