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
source "$ROOT/scripts/selftest-lib.sh" # cb()/sha(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_HOME="$TMP/keys"

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
# Explicit existence check first (same reasoning as selftest-pq.sh's own guard,
# scripts/selftest-lib.sh#sha): sha() returns "" for a missing file. $TMP/snap2.age's own
# existence was already established by the checked `snapshot` above, so without this a
# --force push that exited 0 but silently deleted the remote object without rewriting it
# would still correctly fail the comparison below (against a real hash) — but only by
# accident. Assert the precondition explicitly.
test -f "$OVERWRITE_STORE_PATH" || { echo "[FAIL] --force push exited 0 but left no object at $OVERWRITE_STORE_PATH"; exit 1; }
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
printf '%s' "$EST_OUT" | grep -q "^cost: 0$" || { echo "[FAIL] estimate --backend rclone did not report cost: 0"; echo "$EST_OUT"; exit 1; }
echo "[PASS] estimate --backend rclone reports cost: 0"

echo "== verify --level remote --backend rclone with no --sha256 warns (rclone's locator is a mutable path, not a content hash, #332 review) =="
# rclone's remote:path locator is an operator-chosen destination (src/lib/backends/
# rclone.ts's own doc comment), not derived from content at all — the SAME
# "substituted-object-goes-undetected" risk arweave/turbo already warned about, but
# NON_CONTENT_ADDRESSED_BACKENDS (src/lib/config.ts) did not list rclone until this fix.
VERIFY_REMOTE_OUT=$(cb verify --level remote --locator "$REMOTE" --backend rclone 2>&1)
printf '%s' "$VERIFY_REMOTE_OUT" | grep -q "VERDICT: PASS" || { echo "[FAIL] verify --level remote --backend rclone did not PASS"; echo "$VERIFY_REMOTE_OUT"; exit 1; }
printf '%s' "$VERIFY_REMOTE_OUT" | grep -q "no sha256 pin was applied" \
  && echo "[PASS] verify --level remote --backend rclone with no --sha256 warns (locators are not content hashes)" \
  || { echo "[FAIL] verify --level remote --backend rclone did not warn about the missing sha256 pin"; echo "$VERIFY_REMOTE_OUT"; exit 1; }
printf '%s' "$VERIFY_REMOTE_OUT" | grep -q "rclone" \
  && echo "[PASS] the warning names rclone specifically (not just a generic backend placeholder)" \
  || { echo "[FAIL] the missing-pin warning does not mention rclone"; echo "$VERIFY_REMOTE_OUT"; exit 1; }

echo "== #807: two CONCURRENT pushes to one ABSENT --remote — exactly one uploads, the other refuses =="
# The no-clobber check of #533 is a probe-then-copyto, so before #807 both pushes saw
# "nothing there", both ran `rclone copyto`, and the destination silently kept whichever
# finished last — destroying a distinct snapshot, because an rclone --remote is the one
# locator here that is NOT content-addressed. Two DIFFERENT snapshots (different
# ciphertext, so the surviving bytes name the winner unambiguously) to one fresh path.
RACE_STORE_PATH="$STORE/race/snap.age"
RACE_REMOTE=":local:$RACE_STORE_PATH"
cb snapshot --dir "$SRC" --out "$TMP/race-a.age"
cb snapshot --dir "$SRC" --out "$TMP/race-b.age"
RACE_A_SHA=$(sha "$TMP/race-a.age"); RACE_B_SHA=$(sha "$TMP/race-b.age")
[ "$RACE_A_SHA" != "$RACE_B_SHA" ] || { echo "[FAIL] the two race artifacts are byte-identical — an overwrite would be invisible"; exit 1; }
set +e
cb push --in "$TMP/race-a.age" --backend rclone --remote "$RACE_REMOTE" >"$TMP/rr-a.out" 2>"$TMP/rr-a.err" &
RR_A_PID=$!
cb push --in "$TMP/race-b.age" --backend rclone --remote "$RACE_REMOTE" >"$TMP/rr-b.out" 2>"$TMP/rr-b.err" &
RR_B_PID=$!
wait "$RR_A_PID"; RR_A_RC=$?
wait "$RR_B_PID"; RR_B_RC=$?
set -e
# `if`, not `[ … ] && RR_OK=…`: a false test as the last command of a line exits a
# `set -e` script (scripts/selftest-lib.sh's own hardening notes cover the same trap).
RR_OK=0
if [ "$RR_A_RC" = "0" ]; then RR_OK=$((RR_OK + 1)); fi
if [ "$RR_B_RC" = "0" ]; then RR_OK=$((RR_OK + 1)); fi
[ "$RR_OK" = "1" ] || {
  echo "[FAIL] $RR_OK of 2 concurrent pushes to one absent --remote succeeded (want exactly 1) — both uploaded, one snapshot was destroyed"
  cat "$TMP/rr-a.err" "$TMP/rr-b.err"; exit 1
}
if [ "$RR_A_RC" = "0" ]; then RR_WINNER_SHA="$RACE_A_SHA"; RR_LOSER_ERR="$TMP/rr-b.err"; else RR_WINNER_SHA="$RACE_B_SHA"; RR_LOSER_ERR="$TMP/rr-a.err"; fi
[ "$(sha "$RACE_STORE_PATH")" = "$RR_WINNER_SHA" ] \
  || { echo "[FAIL] the object at the remote is not the winner's bytes — the loser overwrote it"; exit 1; }
# The loser must say WHY: either it waited for the lock and then hit the ordinary #533
# no-clobber refusal, or the winner outlasted the bounded wait and it refused as
# in-flight. Never a silent success.
grep -q -e "already exists — refusing to overwrite" -e "another push is in flight for" "$RR_LOSER_ERR" \
  || { echo "[FAIL] the losing push did not refuse with a no-clobber or in-flight message"; cat "$RR_LOSER_ERR"; exit 1; }
echo "[PASS] concurrent pushes to one absent --remote: exactly one uploaded, the winner's bytes survive, the loser refused"

echo "== #807: a lock held by a LIVE process refuses the push before it can copyto (CB-E028) =="
HELD_STORE_PATH="$STORE/held/snap.age"
HELD_REMOTE=":local:$HELD_STORE_PATH"
HELD_LOCK=$(push_lock_file "$CYPHER_BRAIN_HOME" rclone-remote "$HELD_REMOTE")
# An rclone remote is used as the key verbatim (nothing about "r:/a/../b" can be resolved
# from here) — unlike a --save-locator path, whose directory is canonicalized.
RACE_LOCK=$(push_lock_file "$CYPHER_BRAIN_HOME" rclone-remote "$RACE_REMOTE")
[ ! -f "$RACE_LOCK" ] || { echo "[FAIL] the concurrent pushes left their lock file behind: $RACE_LOCK"; exit 1; }
sleep 120 &
HOLDER_PID=$!
hold_push_lock "$HELD_LOCK" "$HOLDER_PID" rclone-remote "$HELD_REMOTE"
set +e
HELD_ERR=$(cb push --in "$TMP/race-a.age" --backend rclone --remote "$HELD_REMOTE" 2>&1); HELD_RC=$?
set -e
[ "$HELD_RC" != "0" ] || { echo "[FAIL] push ran while another process held the remote's lock"; echo "$HELD_ERR"; exit 1; }
printf '%s' "$HELD_ERR" | grep -q "another push is in flight for" \
  || { echo "[FAIL] the in-flight refusal does not say so"; echo "$HELD_ERR"; exit 1; }
printf '%s' "$HELD_ERR" | grep -q '\[CB-E028\]' || { echo "[FAIL] the in-flight refusal lacks the CB-E028 code"; echo "$HELD_ERR"; exit 1; }
[ ! -f "$HELD_STORE_PATH" ] || { echo "[FAIL] the refused push still uploaded to the remote"; exit 1; }
echo "[PASS] a live holder's lock refuses the rclone push (CB-E028) before any copyto"

echo "== #807: a lock left behind by a CRASHED push is cleared by the next run (no wedged schedule) =="
kill -9 "$HOLDER_PID" 2>/dev/null || true
wait "$HOLDER_PID" 2>/dev/null || true
[ -f "$HELD_LOCK" ] || { echo "[FAIL] the stale lock file vanished on its own — this case is not being exercised"; exit 1; }
cb push --in "$TMP/race-a.age" --backend rclone --remote "$HELD_REMOTE" >/dev/null 2>"$TMP/rclone-stale.err" \
  || { echo "[FAIL] a push blocked on a lock whose holder is dead — the nightly schedule would be wedged"; cat "$TMP/rclone-stale.err"; exit 1; }
grep -q "cleared an abandoned push lock" "$TMP/rclone-stale.err" \
  || { echo "[FAIL] the stale lock was not reported as cleared"; cat "$TMP/rclone-stale.err"; exit 1; }
[ "$(sha "$HELD_STORE_PATH")" = "$RACE_A_SHA" ] || { echo "[FAIL] the recovering push did not upload the artifact"; exit 1; }
[ ! -f "$HELD_LOCK" ] || { echo "[FAIL] the lock file survived the push that took it — it was never released"; exit 1; }
echo "[PASS] a stale rclone-remote lock (dead pid) is cleared, the push proceeds, and the lock is released afterwards"

echo
echo "STORAGE SELFTEST (rclone backend) PASS"
