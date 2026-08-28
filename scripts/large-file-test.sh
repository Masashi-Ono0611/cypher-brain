#!/usr/bin/env bash
# Large-file / multi-chunk round-trip (issue #8), operator-run. Confirms the
# streaming snapshot and the file backend hold at scale.
#
# Config: CB_SIZE_MB (default 256).
set -euo pipefail

SIZE_MB="${CB_SIZE_MB:-256}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb()/sha(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_HOME="$TMP/keys"
export CYPHER_BRAIN_FILE_DIR="$TMP/store"
now() { date +%s; }

echo "== build a ${SIZE_MB} MB synthetic brain (incompressible) =="
SRC="$TMP/brain"; mkdir -p "$SRC"
dd if=/dev/urandom of="$SRC/blob.bin" bs=1048576 count="$SIZE_MB" 2>/dev/null
printf 'large-marker-%s\n' "$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')" > "$SRC/note.txt"
cb keygen >/dev/null

echo "== snapshot (measure time + node peak RSS to prove it streams, not buffers) =="
T0=$(now)
/usr/bin/time -l node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/big.age" 2>"$TMP/rss.txt" 1>/dev/null
T1=$(now)
RSS_BYTES=$(grep -i 'maximum resident set size' "$TMP/rss.txt" | grep -oE '[0-9]+' | head -1)
RSS_MB=$(( ${RSS_BYTES:-0} / 1048576 ))
AGE_MB=$(( $(stat -f%z "$TMP/big.age") / 1048576 ))
echo "snapshot: $((T1-T0))s, node peak RSS ~${RSS_MB} MB, ciphertext ${AGE_MB} MB"
# streaming proof = node RSS stays well below the input as the input grows. Only
# meaningful once the input clearly exceeds Node's fixed ~60-70 MB baseline RSS.
if [ "$SIZE_MB" -ge 128 ]; then
  [ "$RSS_MB" -lt "$SIZE_MB" ] && echo "[PASS] node RSS (${RSS_MB} MB) << input (${SIZE_MB} MB) -> streaming (tar|age), not buffered" \
    || { echo "[FAIL] node RSS not < input — possible buffering"; exit 1; }
else
  echo "[SKIP] streaming RSS assert — size < 128 MB is below Node's baseline RSS; run at >=256 MB to prove it"
fi
ORIG=$(sha "$TMP/big.age")

echo "== file backend: push -> (delete original) -> pull -> decrypt at size =="
T0=$(now); LOC=$(cb push --in "$TMP/big.age" --backend file); T1=$(now)
rm -f "$TMP/big.age"
T2=$(now); cb pull --locator "$LOC" --backend file --out "$TMP/got.age"; T3=$(now)
[ "$(sha "$TMP/got.age")" = "$ORIG" ] && echo "[PASS] file backend round-trip byte-identical (push $((T1-T0))s pull $((T3-T2))s)" \
  || { echo "[FAIL] file backend byte mismatch"; exit 1; }
cb restore --in "$TMP/got.age" --out-dir "$TMP/out" >/dev/null
tar -xzf "$TMP/out/brain.tar.gz" -C "$TMP/out"
diff -r "$SRC" "$TMP/out/brain" >/dev/null && echo "[PASS] decrypt + restore byte-identical at ${SIZE_MB} MB" \
  || { echo "[FAIL] restore mismatch"; exit 1; }

echo
echo "LARGE-FILE TEST PASS (${SIZE_MB} MB)"
