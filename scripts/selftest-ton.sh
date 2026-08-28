#!/usr/bin/env bash
# Storage round-trip proof for the TON backend (src/lib/backends/ton.ts) — CI-safe:
# no real TON network, no real seeder box. The seeder is a local directory reached
# through PATH-shimmed `ssh`/`scp` (so the REAL backend code runs its REAL remote
# command lines), and both tonutils-storage daemons are scripts/mock-tonutils.mjs
# (so the REAL HTTP client, ephemeral-daemon startup dance and poll loops all run).
# What this cannot prove is TON Storage itself — that is scripts/ton-dogfood.mjs,
# operator-run against the real network.
#
# Positive controls are the point of half of this file: the fallback warning, the
# no-fallback refusal and the locator-shape rejection are each DRIVEN TO FIRE here,
# not assumed — a guard nobody has seen fire is not yet a guard.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
# cb/sha/start_ton_seeder: shared across scripts/selftest-*.sh, see
# scripts/selftest-lib.sh (#570, #572).
source "$ROOT/scripts/selftest-lib.sh"

TMP="$(mktemp -d)"
SEEDER_PID=""
cleanup() {
  [ -n "$SEEDER_PID" ] && kill "$SEEDER_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

export CYPHER_BRAIN_HOME="$TMP/keys"

# ---- the "seeder": a mock daemon on loopback + a home directory, reached
# through PATH-shimmed ssh/scp (start_ton_seeder sets SEEDER_HOME/SEEDER_PID/
# MOCK_PORT/SHIM as globals; SEEDER_PID feeds the cleanup trap above) ----
start_ton_seeder

MARKER="ton-marker-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
SRC="$TMP/brain-src"
mkdir -p "$SRC"
printf '%s\n' "$MARKER" > "$SRC/note.txt"

echo "== snapshot =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap.age"
ORIG=$(sha "$TMP/snap.age")

echo "== push --backend ton (bag born on the seeder; locator = ton:v1:<bag-id>) =="
LOC=$(cb push --in "$TMP/snap.age" --backend ton --save-locator "$TMP/loc.tsv")
printf '%s' "$LOC" | grep -Eq '^ton:v1:[0-9a-f]{64}$' || { echo "[FAIL] locator shape: $LOC"; exit 1; }
echo "[PASS] locator matches ton:v1:<64-hex>"
BAG_FILE=$(ls "$SEEDER_HOME"/cypher-brain-ton/bags/*/snapshot.age 2>/dev/null | head -1)
[ -n "$BAG_FILE" ] || { echo "[FAIL] no snapshot.age landed under the seeder bags dir"; exit 1; }
[ "$(sha "$BAG_FILE")" = "$ORIG" ] || { echo "[FAIL] seeder-side bytes differ from source"; exit 1; }
echo "[PASS] seeder holds the exact pushed bytes"
grep -qs -- "$LOC" "$SEEDER_HOME"/cypher-brain-ton/inventory/*.locator || { echo "[FAIL] inventory does not record the locator"; exit 1; }
echo "[PASS] seeder inventory records the locator"

echo "== idempotent re-push (same ciphertext -> same locator, no second bag) =="
LOC2=$(cb push --in "$TMP/snap.age" --backend ton 2>"$TMP/repush.err")
[ "$LOC2" = "$LOC" ] || { echo "[FAIL] re-push returned a different locator: $LOC2"; exit 1; }
grep -q 'idempotent re-push' "$TMP/repush.err" || { echo "[FAIL] re-push did not report the idempotent path"; exit 1; }
[ "$(ls "$SEEDER_HOME"/cypher-brain-ton/bags | wc -l | tr -d ' ')" = "1" ] || { echo "[FAIL] re-push created a second bag dir"; exit 1; }
echo "[PASS] re-push is idempotent"

echo "== pull over the (mock) P2P path — the primary read path, no ssh involved =="
rm -f "$TMP/snap.age"
cb pull --backend ton --locator "$LOC" --out "$TMP/got.age" 2>"$TMP/pull.err"
[ "$(sha "$TMP/got.age")" = "$ORIG" ] || { echo "[FAIL] pulled bytes differ"; exit 1; }
grep -q 'over the TON Storage P2P network' "$TMP/pull.err" || { echo "[FAIL] pull did not report the P2P path (did it silently fall back?)"; exit 1; }
echo "[PASS] P2P pull round-trip"
cb verify --in "$TMP/got.age" >/dev/null
echo "[PASS] pulled ciphertext verifies"

echo "== issue #496: --wait warns (but does not error) for --backend ton, same as file (#465) =="
WAIT_ERR=$(cb pull --backend ton --locator "$LOC" --out "$TMP/wait-warn.age" --wait 2 2>&1); WAIT_RC=$?
[ "$WAIT_RC" = "0" ] || { echo "[FAIL] pull with --wait on ton backend should still succeed when the bag is reachable"; echo "$WAIT_ERR"; exit 1; }
[ "$(sha "$TMP/wait-warn.age")" = "$ORIG" ] || { echo "[FAIL] --wait pull returned wrong bytes"; exit 1; }
printf '%s' "$WAIT_ERR" | grep -q -- '--wait has no effect for --backend ton' || { echo "[FAIL] no --wait/ton warning printed"; echo "$WAIT_ERR"; exit 1; }
echo "[PASS] --wait on the ton backend (which throws a plain Error, not RetryableError, on a not-yet-retrievable bag) warns"

echo "== positive control: malformed locator is REJECTED (shape guard fires) =="
if cb pull --backend ton --locator "ton:v1:not-a-bag-id" --out "$TMP/never.age" 2>"$TMP/bad-loc.err"; then
  echo "[FAIL] malformed locator was accepted"; exit 1
fi
grep -q 'does not match the expected ton:v1' "$TMP/bad-loc.err" || { echo "[FAIL] wrong rejection message"; exit 1; }
echo "[PASS] locator shape guard fired"

echo "== positive control: wrong --sha256 pin FAILS the pull =="
WRONG_SHA=$(printf 'x%.0s' $(seq 1 64) | tr 'x' '0')
if cb pull --backend ton --locator "$LOC" --out "$TMP/pinned.age" --sha256 "$WRONG_SHA" 2>"$TMP/pin.err"; then
  echo "[FAIL] wrong sha256 pin was accepted"; exit 1
fi
echo "[PASS] sha256 pin guard fired"

echo "== positive control: bag gone from the network -> LOUD seeder fallback fires =="
node -e 'require("fs").writeFileSync(process.argv[1], "{}")' "$MOCK_TON_STORE/registry.json"
cb pull --backend ton --locator "$LOC" --out "$TMP/fallback.age" 2>"$TMP/fallback.err"
[ "$(sha "$TMP/fallback.age")" = "$ORIG" ] || { echo "[FAIL] fallback bytes differ"; exit 1; }
grep -q 'falling back to a direct copy from the seeder' "$TMP/fallback.err" || { echo "[FAIL] fallback did not announce itself"; exit 1; }
grep -q 'NOT proven' "$TMP/fallback.err" || { echo "[FAIL] fallback did not disclaim P2P availability"; exit 1; }
echo "[PASS] fallback fired, loudly"

echo "== positive control: CYPHER_BRAIN_TON_NO_FALLBACK=1 fail-closes instead =="
if CYPHER_BRAIN_TON_NO_FALLBACK=1 cb pull --backend ton --locator "$LOC" --out "$TMP/strict.age" 2>"$TMP/strict.err"; then
  echo "[FAIL] no-fallback pull unexpectedly succeeded"; exit 1
fi
grep -q 'forbids the seeder fallback' "$TMP/strict.err" || { echo "[FAIL] wrong no-fallback message"; exit 1; }
[ ! -f "$TMP/strict.age" ] || { echo "[FAIL] no-fallback pull still wrote an output file"; exit 1; }
echo "[PASS] no-fallback mode fail-closed"

echo "== positive control: hostile remote-dir values are REFUSED before any remote command =="
if CYPHER_BRAIN_TON_REMOTE_DIR='dir with space; rm x' cb push --in "$TMP/got.age" --backend ton 2>"$TMP/hostile.err"; then
  echo "[FAIL] hostile remote dir was accepted"; exit 1
fi
grep -q 'refuses to place in a remote command' "$TMP/hostile.err" || { echo "[FAIL] wrong hostile-dir message"; exit 1; }
if CYPHER_BRAIN_TON_REMOTE_DIR='~/tilde-root' cb push --in "$TMP/got.age" --backend ton 2>"$TMP/tilde.err"; then
  echo "[FAIL] tilde remote dir was accepted (ssh-quoting vs scp-expansion divergence)"; exit 1
fi
grep -q 'refuses to place in a remote command' "$TMP/tilde.err" || { echo "[FAIL] wrong tilde-dir message"; exit 1; }
echo "[PASS] remote-dir allowlist guard fired (space/metachars and tilde)"

echo "== positive control: invalid CYPHER_BRAIN_TON_HTTP_TIMEOUT warns and falls back to the default =="
CYPHER_BRAIN_TON_HTTP_TIMEOUT='not-a-number' cb estimate --in "$TMP/got.age" --backend ton >/dev/null 2>"$TMP/timeout.err"
grep -q 'CYPHER_BRAIN_TON_HTTP_TIMEOUT must be a positive integer' "$TMP/timeout.err" || { echo "[FAIL] invalid timeout did not warn"; exit 1; }
echo "[PASS] invalid timeout value warned instead of silently degrading pulls"

echo "== ton selftest: ALL PASS =="
