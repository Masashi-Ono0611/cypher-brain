#!/usr/bin/env bash
# Storage round-trip proof for the RCLONE backend (issue #204): cypher-brain never
# implements a cloud storage API itself — it shells out to `rclone copyto`, the same
# "delegate to rclone" pattern restic/kopia use, and the locator IS the "<remote>:
# <path>" string itself. Exercised here against rclone's built-in, config-less
# `:local:` on-the-fly remote (a real rclone backend, just pointed at a local temp
# dir) — proving the actual `rclone` binary is invoked end-to-end, with NO real
# cloud storage or rclone.conf entry involved.
#
# Auto-SKIPs (exit 0) when the `rclone` binary is absent — same posture as
# selftest-interop.sh's `age`-binary check: the point of this backend is that
# operators bring their own rclone, so CI (which does not install it) skips the
# live round-trip and only the environment doesn't have it can't otherwise prove.
set -euo pipefail

if ! command -v rclone >/dev/null 2>&1; then
  echo "[SKIP] rclone selftest: no \`rclone\` binary on PATH — install rclone (https://rclone.org/downloads/) to exercise the rclone backend round-trip"
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_HOME="$TMP/keys"
cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# rclone's built-in `:local:` connection-string syntax addresses the local
# filesystem AS a real rclone remote/backend — no rclone.conf entry needed — so this
# proof never touches actual cloud storage while still driving the real `rclone`
# binary through its normal remote-resolution path (not a cypher-brain-side stub).
STORE="$TMP/rclone-store"; mkdir -p "$STORE"
REMOTE=":local:$STORE/snap.age"

MARKER="rclone-marker-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
SRC="$TMP/brain-src"; mkdir -p "$SRC"
printf '%s\n' "$MARKER" > "$SRC/note.txt"

echo "== snapshot =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap.age"
ORIG=$(sha "$TMP/snap.age")

echo "== push --backend rclone --remote (locator IS the --remote string) =="
LOC=$(cb push --in "$TMP/snap.age" --backend rclone --remote "$REMOTE")
[ "$LOC" = "$REMOTE" ] || { echo "[FAIL] locator != --remote: $LOC"; exit 1; }
echo "[PASS] locator == --remote string"
[ -f "$STORE/snap.age" ] || { echo "[FAIL] rclone copyto did not land the object at $STORE/snap.age"; exit 1; }
[ "$(sha "$STORE/snap.age")" = "$ORIG" ] && echo "[PASS] object at the rclone remote == source bytes" || { echo "[FAIL] remote byte mismatch"; exit 1; }

echo "== pull --backend rclone --remote (after deleting the original, so it MUST come from the remote) =="
rm -f "$TMP/snap.age"
cb pull --backend rclone --remote "$REMOTE" --out "$TMP/got.age"
[ "$(sha "$TMP/got.age")" = "$ORIG" ] && echo "[PASS] pulled bytes == original (via --remote)" || { echo "[FAIL] pulled byte mismatch"; exit 1; }

echo "== pull --backend rclone --locator (the SAME string also works via the generic --locator flag) =="
cb pull --backend rclone --locator "$REMOTE" --out "$TMP/got-via-locator.age"
[ "$(sha "$TMP/got-via-locator.age")" = "$ORIG" ] && echo "[PASS] pulled bytes == original (via --locator)" || { echo "[FAIL] pulled byte mismatch via --locator"; exit 1; }

echo "== verify + decrypt the pulled ciphertext =="
cb verify --in "$TMP/got.age" | grep -q "VERDICT: PASS" && echo "[PASS] verify VERDICT PASS on pulled" || { echo "[FAIL] verify"; exit 1; }
cb restore --in "$TMP/got.age" --out-dir "$TMP/out"
tar -xzf "$TMP/out/brain-src.tar.gz" -C "$TMP/out"
diff -r "$SRC" "$TMP/out/brain-src"
echo "[PASS] decrypt + restore byte-identical to source"

echo "== push --save-locator + pull --from-locator-file (recovery path) =="
LOCFILE="$TMP/rclone-locator.tsv"
# Re-push the already-pulled artifact (still on disk as $TMP/got.age, byte-identical
# to the original) with --save-locator so --from-locator-file has a real file to
# recover from below. $REMOTE already holds an object (the push at the top of this
# script) — #533's no-clobber check refuses that by default, so --force here is the
# deliberate opt-in, not a workaround; the dedicated #533 checks further below cover
# the refusal itself.
cb push --in "$TMP/got.age" --backend rclone --remote "$REMOTE" --save-locator "$LOCFILE" --force >/dev/null
cb pull --from-locator-file "$LOCFILE" --out "$TMP/recovered.age"
[ "$(sha "$TMP/recovered.age")" = "$ORIG" ] && echo "[PASS] --from-locator-file recovery round-trips (backend read back from the saved locator file)" || { echo "[FAIL] recovery byte mismatch"; exit 1; }
grep -q "^${REMOTE//./\\.}"$'\t'"rclone"$'\t' "$LOCFILE" || { echo "[FAIL] save-locator file did not record backend=rclone"; cat "$LOCFILE"; exit 1; }
echo "[PASS] save-locator file records backend=rclone"

echo "== pull refuses to overwrite an existing --out by default (no-clobber, same as every backend) =="
printf 'pre-existing bytes, must survive the refusal\n' > "$TMP/collide.age"
COLLIDE_BEFORE=$(sha "$TMP/collide.age")
if cb pull --backend rclone --remote "$REMOTE" --out "$TMP/collide.age" 2>"$TMP/collide.err"; then
  echo "[FAIL] pull overwrote an existing --out without --force"; exit 1
fi
grep -q "already exists" "$TMP/collide.err" || { echo "[FAIL] no-clobber error message missing 'already exists'"; cat "$TMP/collide.err"; exit 1; }
[ "$(sha "$TMP/collide.age")" = "$COLLIDE_BEFORE" ] || { echo "[FAIL] the pre-existing --out was modified despite the no-clobber refusal"; exit 1; }
echo "[PASS] pull refuses to overwrite an existing --out, which survives byte-identical"

echo "== push refuses to overwrite an existing --remote object without --force (#533) =="
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1"; }
OVERWRITE_STORE_PATH="$STORE/overwrite-test.age"
OVERWRITE_REMOTE=":local:$OVERWRITE_STORE_PATH"
# First push: establishes an object at this remote path (an ordinary push — nothing
# there yet, so no --force needed).
cb push --in "$TMP/got.age" --backend rclone --remote "$OVERWRITE_REMOTE" >/dev/null
OVERWRITE_BEFORE_SHA=$(sha "$OVERWRITE_STORE_PATH")
OVERWRITE_BEFORE_MTIME=$(mtime "$OVERWRITE_STORE_PATH")
sleep 1 # so a wrongly-applied overwrite would show a distinguishable mtime below
# A DIFFERENT snapshot (age's ephemeral file key makes even byte-identical plaintext
# encrypt to different ciphertext bytes every run, per pushpull.ts's own comment) to
# the SAME --remote path, deliberately with NO --force.
cb snapshot --dir "$SRC" --out "$TMP/snap2.age" >/dev/null
if cb push --in "$TMP/snap2.age" --backend rclone --remote "$OVERWRITE_REMOTE" 2>"$TMP/overwrite-noforce.err"; then
  echo "[FAIL] push overwrote an existing --remote object without --force"; exit 1
fi
grep -q "already exists — refusing to overwrite" "$TMP/overwrite-noforce.err" \
  || { echo "[FAIL] no-clobber error message missing 'already exists — refusing to overwrite'"; cat "$TMP/overwrite-noforce.err"; exit 1; }
[ "$(sha "$OVERWRITE_STORE_PATH")" = "$OVERWRITE_BEFORE_SHA" ] || { echo "[FAIL] the existing remote object's BYTES changed despite the no-clobber refusal — an upload was attempted"; exit 1; }
[ "$(mtime "$OVERWRITE_STORE_PATH")" = "$OVERWRITE_BEFORE_MTIME" ] || { echo "[FAIL] the existing remote object's MTIME changed despite the no-clobber refusal — an upload was attempted"; exit 1; }
echo "[PASS] push refuses to overwrite an existing --remote object without --force; the object survives byte- and mtime-identical (no upload was attempted)"

echo "== the SAME push WITH --force succeeds and overwrites (#533 — no regression to --force's existing --skip-unchanged meaning) =="
cb push --in "$TMP/snap2.age" --backend rclone --remote "$OVERWRITE_REMOTE" --force >/dev/null
[ "$(sha "$OVERWRITE_STORE_PATH")" = "$(sha "$TMP/snap2.age")" ] && echo "[PASS] --force overwrites the existing --remote object, same as before this fix" || { echo "[FAIL] --force did not overwrite the remote object"; exit 1; }

echo "== push to a genuinely NEW/empty --remote path still succeeds without --force (no false-positive refusal, #533) =="
FRESH_STORE_PATH="$STORE/fresh/brand-new-path/snap.age"
FRESH_REMOTE=":local:$FRESH_STORE_PATH"
cb push --in "$TMP/got.age" --backend rclone --remote "$FRESH_REMOTE" >/dev/null
[ -f "$FRESH_STORE_PATH" ] && [ "$(sha "$FRESH_STORE_PATH")" = "$ORIG" ] \
  && echo "[PASS] push to a brand-new --remote path succeeds without --force" \
  || { echo "[FAIL] push to a brand-new --remote path failed, or landed the wrong bytes"; exit 1; }

echo "== pull of a nonexistent --remote object gives a clean 'no object at' error, not raw rclone passthrough (#539) =="
MISSING_REMOTE=":local:$STORE/does/not/exist.age"
if cb pull --backend rclone --remote "$MISSING_REMOTE" --out "$TMP/missing-pull.age" 2>"$TMP/missing-pull.err"; then
  echo "[FAIL] pull of a nonexistent remote object succeeded"; exit 1
fi
[ -f "$TMP/missing-pull.age" ] && { echo "[FAIL] pull wrote --out despite the remote object not existing"; exit 1; }
grep -q "no object at" "$TMP/missing-pull.err" || { echo "[FAIL] missing-object error does not use the clean 'no object at' framing"; cat "$TMP/missing-pull.err"; exit 1; }
if grep -qi "directory not found" "$TMP/missing-pull.err" || grep -q "Attempt [0-9]*/3" "$TMP/missing-pull.err"; then
  echo "[FAIL] missing-object error still leaks rclone's raw retry-loop text"; cat "$TMP/missing-pull.err"; exit 1
fi
echo "[PASS] pull of a nonexistent --remote object gives a clean, non-repetitive 'no object at' error"

echo "== push --backend rclone without --remote is rejected with an actionable message =="
if cb push --in "$TMP/got.age" --backend rclone 2>"$TMP/noremote.err"; then
  echo "[FAIL] push ran with no --remote"; exit 1
fi
grep -q -- "--remote" "$TMP/noremote.err" || { echo "[FAIL] missing-remote error does not mention --remote"; cat "$TMP/noremote.err"; exit 1; }
echo "[PASS] push --backend rclone without --remote is rejected"

echo "== a missing rclone binary produces an actionable error (not a bare ENOENT) =="
if CYPHER_BRAIN_RCLONE_BIN="$TMP/no-such-rclone-binary" cb push --in "$TMP/got.age" --backend rclone --remote "$REMOTE" 2>"$TMP/missingbin.err"; then
  echo "[FAIL] push succeeded with a nonexistent rclone binary"; exit 1
fi
grep -qi "not found on PATH" "$TMP/missingbin.err" || { echo "[FAIL] missing-binary error is not actionable"; cat "$TMP/missingbin.err"; exit 1; }
echo "[PASS] a missing rclone binary (CYPHER_BRAIN_RCLONE_BIN override) produces an actionable error"

echo "== --remote containing a tab is rejected (would corrupt the tab-delimited save-locator file) =="
BAD_REMOTE="$(printf ':local:%s\tevil' "$STORE")"
if cb push --in "$TMP/got.age" --backend rclone --remote "$BAD_REMOTE" 2>"$TMP/badremote.err"; then
  echo "[FAIL] push accepted a --remote containing a tab"; exit 1
fi
grep -qi "tab or newline" "$TMP/badremote.err" || { echo "[FAIL] tab-in-remote error does not mention 'tab or newline'"; cat "$TMP/badremote.err"; exit 1; }
echo "[PASS] a --remote containing a tab is rejected with an actionable error"

echo "== estimate --backend rclone: free (cost: 0), notes the transfer cost is the operator's own remote/contract =="
EST_OUT=$(cb estimate --in "$TMP/got.age" --backend rclone)
echo "$EST_OUT" | grep -q "^cost: 0$" || { echo "[FAIL] estimate --backend rclone did not report cost: 0"; echo "$EST_OUT"; exit 1; }
echo "[PASS] estimate --backend rclone reports cost: 0"

echo "== verify --level remote --backend rclone with no --sha256 warns (rclone's locator is a mutable path, not a content hash, #332 review) =="
# rclone's remote:path locator is an operator-chosen destination (src/lib/backends/
# rclone.ts's own doc comment), not derived from content at all — the SAME
# "substituted-object-goes-undetected" risk arweave/turbo already warned about, but
# NON_CONTENT_ADDRESSED_BACKENDS (src/lib/config.ts) did not list rclone until this fix.
VERIFY_REMOTE_OUT=$(cb verify --level remote --locator "$REMOTE" --backend rclone 2>&1)
echo "$VERIFY_REMOTE_OUT" | grep -q "VERDICT: PASS" || { echo "[FAIL] verify --level remote --backend rclone did not PASS"; echo "$VERIFY_REMOTE_OUT"; exit 1; }
echo "$VERIFY_REMOTE_OUT" | grep -q "no sha256 pin was applied" \
  && echo "[PASS] verify --level remote --backend rclone with no --sha256 warns (locators are not content hashes)" \
  || { echo "[FAIL] verify --level remote --backend rclone did not warn about the missing sha256 pin"; echo "$VERIFY_REMOTE_OUT"; exit 1; }
echo "$VERIFY_REMOTE_OUT" | grep -q "rclone" \
  && echo "[PASS] the warning names rclone specifically (not just a generic backend placeholder)" \
  || { echo "[FAIL] the missing-pin warning does not mention rclone"; echo "$VERIFY_REMOTE_OUT"; exit 1; }

echo
echo "STORAGE SELFTEST (rclone backend) PASS"
