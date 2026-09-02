#!/usr/bin/env bash
# Key-recovery + versioning proof (issue #3), daemon-free so CI can gate it.
# Encrypts a snapshot to a PRIMARY *and* an offline BACKUP key, then shows:
#   - the primary identity restores,
#   - the BACKUP identity restores too (so losing the primary != losing the brain),
#   - an unrelated third identity cannot,
#   - two different snapshots are independently restorable (versioning).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
PRIMARY="$TMP/keys-primary"; BACKUP="$TMP/keys-backup"; THIRD="$TMP/keys-third"
cb() { CYPHER_BRAIN_HOME="$1" node "${BIN_DEV_ARGS[@]}" "$BIN" "${@:2}"; }

echo "== three independent keypairs =="
cb "$PRIMARY" keygen >/dev/null
cb "$BACKUP"  keygen >/dev/null
cb "$THIRD"   keygen >/dev/null

SRC="$TMP/brain"; mkdir -p "$SRC"
printf 'brain-v1-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')" > "$SRC/note.txt"
V1MARK=$(cat "$SRC/note.txt")

echo "== snapshot v1 -> encrypt to PRIMARY *and* BACKUP =="
cb "$PRIMARY" snapshot --dir "$SRC" \
  --recipient "$PRIMARY/recipient.txt" --recipient "$BACKUP/recipient.txt" --out "$TMP/v1.age"

echo "== primary identity restores =="
cb "$PRIMARY" restore --in "$TMP/v1.age" --out-dir "$TMP/r-primary" >/dev/null
tar -xzf "$TMP/r-primary/brain.tar.gz" -C "$TMP/r-primary"
diff -r "$SRC" "$TMP/r-primary/brain" || { echo "[FAIL] primary restore content mismatch"; exit 1; }
echo "[PASS] primary identity restores"

echo "== BACKUP identity restores too (key recovery: primary not needed) =="
cb "$BACKUP" restore --in "$TMP/v1.age" --out-dir "$TMP/r-backup" >/dev/null
tar -xzf "$TMP/r-backup/brain.tar.gz" -C "$TMP/r-backup"
diff -r "$SRC" "$TMP/r-backup/brain" || { echo "[FAIL] backup restore content mismatch"; exit 1; }
echo "[PASS] BACKUP key restores without the primary identity"

echo "== an unrelated third identity cannot restore =="
if cb "$THIRD" restore --in "$TMP/v1.age" --out-dir "$TMP/r-third" 2>/dev/null; then
  echo "[FAIL] a non-recipient identity restored"; exit 1
fi
echo "[PASS] non-recipient identity is rejected"

echo "== versioning: a second snapshot is independently restorable =="
printf 'brain-v2-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')" > "$SRC/note.txt"
V2MARK=$(cat "$SRC/note.txt")
cb "$PRIMARY" snapshot --dir "$SRC" --recipient "$PRIMARY/recipient.txt" --out "$TMP/v2.age"
cb "$PRIMARY" restore --in "$TMP/v1.age" --out-dir "$TMP/rv1" >/dev/null
cb "$PRIMARY" restore --in "$TMP/v2.age" --out-dir "$TMP/rv2" >/dev/null
tar -xzf "$TMP/rv1/brain.tar.gz" -C "$TMP/rv1"; tar -xzf "$TMP/rv2/brain.tar.gz" -C "$TMP/rv2"
grep -q "$V1MARK" "$TMP/rv1/brain/note.txt" && grep -q "$V2MARK" "$TMP/rv2/brain/note.txt" \
  && echo "[PASS] both versions restore to their own content" || { echo "[FAIL] version mismatch"; exit 1; }

echo "== durable locator: a fresh machine with the identity but NO index.tsv recovers via --save-locator =="
# A "latest" snapshot encrypted to BOTH keys (so the off-box backup identity can open it),
# pushed to the file backend with the locator saved off-box. Then simulate disk-death:
# the only things that survive are (a) the BACKUP identity and (b) the saved locator file
# — NOT index.tsv, NOT the store path typed by hand. Recovery must find the bytes from the
# locator file alone.
printf 'brain-latest-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')" > "$SRC/note.txt"
LATESTMARK=$(cat "$SRC/note.txt")
cb "$PRIMARY" snapshot --dir "$SRC" \
  --recipient "$PRIMARY/recipient.txt" --recipient "$BACKUP/recipient.txt" --out "$TMP/latest.age"
STORE="$TMP/store"; LOCFILE="$TMP/offbox/latest-locator.tsv"
CYPHER_BRAIN_FILE_DIR="$STORE" cb "$PRIMARY" push --in "$TMP/latest.age" --backend file \
  --save-locator "$LOCFILE" >/dev/null
test -f "$LOCFILE" || { echo "[FAIL] --save-locator wrote no file"; exit 1; }
# the saved file must carry the backend AND an integrity pin (sha256) so pull needs no
# other knowledge and is fail-closed against a substituted ciphertext.
SAVED_BACKEND=$(cut -f2 "$LOCFILE"); SAVED_SHA=$(cut -f3 "$LOCFILE")
[ "$SAVED_BACKEND" = "file" ] || { echo "[FAIL] locator file backend column != file"; cat "$LOCFILE"; exit 1; }
[ "$SAVED_SHA" = "$(shasum -a 256 "$TMP/latest.age" | cut -d' ' -f1)" ] \
  || { echo "[FAIL] locator file sha256 column does not match the ciphertext"; cat "$LOCFILE"; exit 1; }
echo "[PASS] push --save-locator wrote <locator>\\t<backend>\\t<sha256>"
# fresh machine: BACKUP identity present, index.tsv absent, only the locator file + store
CYPHER_BRAIN_FILE_DIR="$STORE" cb "$BACKUP" pull --from-locator-file "$LOCFILE" --out "$TMP/recovered.age" >/dev/null
cmp -s "$TMP/latest.age" "$TMP/recovered.age" || { echo "[FAIL] --from-locator-file fetched different bytes"; exit 1; }
cb "$BACKUP" restore --in "$TMP/recovered.age" --out-dir "$TMP/r-loc" >/dev/null
tar -xzf "$TMP/r-loc/brain.tar.gz" -C "$TMP/r-loc"
grep -q "$LATESTMARK" "$TMP/r-loc/brain/note.txt" \
  && echo "[PASS] fresh machine recovered latest snapshot from identity + saved locator alone" \
  || { echo "[FAIL] locator-file recovery content mismatch"; exit 1; }
# the saved sha256 must actually fail-close: corrupt the stored object and confirm a
# --from-locator-file pull rejects it (the integrity pin fires) and leaves no --out.
STORED_OBJ=$(cut -f1 "$LOCFILE")
cp "$STORED_OBJ" "$TMP/obj.bak"
printf 'TAMPERED' >> "$STORED_OBJ"   # same locator (path), different bytes
if CYPHER_BRAIN_FILE_DIR="$STORE" cb "$BACKUP" pull --from-locator-file "$LOCFILE" --out "$TMP/tampered.age" 2>/dev/null; then
  echo "[FAIL] recovery accepted a tampered ciphertext (integrity pin did not fire)"; exit 1
fi
test ! -f "$TMP/tampered.age" || { echo "[FAIL] tampered --out was left behind (not fail-closed)"; exit 1; }
cp "$TMP/obj.bak" "$STORED_OBJ"      # restore the good object
echo "[PASS] saved sha256 fail-closes recovery against a substituted ciphertext"
# malformed locator file (no backend column) must error clearly, not fall through to the
# generic "--backend required" message.
printf 'just-a-locator-no-tab\n' > "$TMP/bad-locator.tsv"
set +e
BADOUT=$(CYPHER_BRAIN_FILE_DIR="$STORE" cb "$BACKUP" pull --from-locator-file "$TMP/bad-locator.tsv" --out "$TMP/x.age" 2>&1); BADRC=$?
set -e
[ "$BADRC" != "0" ] || { echo "[FAIL] malformed locator file did not error"; exit 1; }
printf '%s' "$BADOUT" | grep -q "must contain" || { echo "[FAIL] malformed locator file error is not specific"; echo "$BADOUT"; exit 1; }
echo "[PASS] malformed locator file (missing backend) errors clearly"
# --save-locator must be overwrite-only (always the LATEST), not appended
printf 'brain-v3-%s\n' "$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')" > "$SRC/note.txt"
cb "$PRIMARY" snapshot --dir "$SRC" --recipient "$PRIMARY/recipient.txt" --out "$TMP/v3.age"
CYPHER_BRAIN_FILE_DIR="$STORE" cb "$PRIMARY" push --in "$TMP/v3.age" --backend file \
  --save-locator "$LOCFILE" >/dev/null
[ "$(grep -c . "$LOCFILE")" = "1" ] || { echo "[FAIL] locator file has >1 line (should hold only the latest)"; cat "$LOCFILE"; exit 1; }
echo "[PASS] --save-locator holds only the latest locator (overwrite, not append)"

echo "== #721: SIGTERM mid-merge (restore into a PRE-EXISTING --out-dir) leaves no scratch dir or plaintext behind =="
# mergeNoClobber() (restore.ts) incrementally rename()s each of scratchDir's OWN
# top-level entries into a pre-existing --out-dir, one at a time. restoreImpl() used to
# clear the scratch dir's signal-guard registration (setActiveRestoreScratchDir(null))
# the instant its OWN decrypt+extract settled — well BEFORE this merge loop even starts.
# A SIGTERM landing during the merge therefore found NEITHER guard tracking the sibling
# scratch dir: the scratch-dir guard already cleared, the out-dir guard (set for the
# PROMOTION step) unaware a sibling plaintext scratch dir even exists — leaving it, and
# every entry still inside it, on disk forever (#721).
#
# Many small --dir sources (=> many top-level "<name>.tar.gz" entries at scratchDir's own
# root, each its own separate rename() inside mergeNoClobber's loop) turn what would
# otherwise be a near-instantaneous merge into a real window this test can reliably land
# a SIGTERM inside: poll --out-dir's entry count until it is more than the single
# pre-existing marker file but fewer than the total, proving the merge is IN PROGRESS
# (not finished) the instant the signal is sent. --scan-secrets off skips a gitleaks scan
# per source that has nothing to do with what this is testing.
# Shared by the #721 and #741 blocks below. Counts --out-dir's top-level entries with
# bash globs only (no find/wc/tr forks): on a loaded CI runner each fork costs enough
# that a 400-entry merge can complete between two polls.
count_top_entries() {
  local n=0 f
  for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$f" ] || [ -L "$f" ] || continue; n=$((n + 1)); done
  printf '%s' "$n"
}
# Start a restore into a pre-existing --out-dir and SIGTERM it the instant the merge is
# observably in progress (more entries than the pre-seeded ones, fewer than the total).
# Arguments: <age file> <out dir> <pre-seeded entry count> <total entries when complete>
#            <stderr log>. Sets LANDED=1 and MMPID on success.
# Retries the whole attempt (the caller names a reseed function in RESEED that recreates
# --out-dir's pre-existing contents) when the restore exits before the window was seen:
# whether the window is hit is a race against the runner, and one miss must read as
# "try again", not as a product failure. The macOS CI cell missed it once in ~13 s while
# the same script passed locally and on ubuntu.
land_sigterm_mid_merge() {
  local age="$1" out="$2" seeded="$3" total="$4" errlog="$5" attempt deadline settle n rc
  LANDED=0
  for attempt in 1 2 3 4 5; do
    "$RESEED"
    CYPHER_BRAIN_HOME="$PRIMARY" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$age" --out-dir "$out" >/dev/null 2>"$errlog" &
    MMPID=$!
    deadline=$((SECONDS + 120))
    while [ "$SECONDS" -lt "$deadline" ]; do
      kill -0 "$MMPID" 2>/dev/null || break
      n=$(count_top_entries "$out")
      if [ "$n" -gt "$seeded" ] && [ "$n" -lt "$total" ]; then
        # kill can lose the race against a natural exit between the count and here —
        # under set -e that must read as a missed window (retry), not a script abort
        kill -TERM "$MMPID" 2>/dev/null || break
        # The signal can still arrive AFTER the last rename (the count above is already
        # stale by the time the kernel delivers it): the restore then completes normally
        # and the handler, correctly, drops no INCOMPLETE sentinel — the macOS CI cell hit
        # exactly this ("did not drop the INCOMPLETE sentinel"). Wait (bounded, so a
        # handler that blocks — #741's regression case — is still left for the caller to
        # diagnose) and treat "every entry present" as a miss to retry, not as a verdict.
        settle=$((SECONDS + 10))
        while [ "$SECONDS" -lt "$settle" ] && kill -0 "$MMPID" 2>/dev/null; do sleep 0.05; done
        if kill -0 "$MMPID" 2>/dev/null; then LANDED=1; return 0; fi # still alive: caller decides
        n=$(count_top_entries "$out")
        if [ "$n" -ge "$total" ]; then
          wait "$MMPID" 2>/dev/null || true
          echo "  (attempt $attempt: SIGTERM landed after the merge had completed — retrying)"
          continue 2
        fi
        LANDED=1; return 0
      fi
    done
    if kill -0 "$MMPID" 2>/dev/null; then
      echo "[FAIL] restore still running after 120 s without reaching the merge (attempt $attempt)"; cat "$errlog"
      kill -9 "$MMPID" 2>/dev/null || true; exit 1
    fi
    # Only a restore that COMPLETED is a timing miss worth retrying. A non-zero exit is a
    # real failure (bad artifact, refused --out-dir, ...) and must surface as such, not be
    # retried five times and then blamed on the window.
    rc=0; wait "$MMPID" 2>/dev/null || rc=$?
    if [ "$rc" != "0" ]; then
      echo "[FAIL] restore exited $rc before the merge (attempt $attempt) — not a timing miss:"; cat "$errlog"; exit 1
    fi
    echo "  (attempt $attempt: restore finished before a mid-merge state was observed — retrying)"
  done
  echo "[FAIL] restore never observed in a mid-merge state in 5 attempts (test setup) — last restore stderr:"; cat "$errlog"
  exit 1
}

MMTMP="$TMP/mid-merge"; mkdir -p "$MMTMP/src"
MMDIRARGS=(); MMN=400
for i in $(seq 1 "$MMN"); do
  d="$MMTMP/src/d$i"; mkdir -p "$d"; printf 'x' > "$d/f.txt"
  MMDIRARGS+=(--dir "$d")
done
cb "$PRIMARY" snapshot "${MMDIRARGS[@]}" --recipient "$PRIMARY/recipient.txt" --scan-secrets off \
  --out "$MMTMP/v.age" >/dev/null
# pre-existing --out-dir => mergeNoClobber(), not the rename()-whole-tree path
reseed_mm() { rm -rf "$MMTMP/out"; mkdir -p "$MMTMP/out"; touch "$MMTMP/out/.marker"; }
RESEED=reseed_mm land_sigterm_mid_merge "$MMTMP/v.age" "$MMTMP/out" 1 "$((MMN + 1))" "$MMTMP/restore.err"
wait "$MMPID" 2>/dev/null || true # signal exit is non-zero — expected
MMLEFTOVER=$(find "$MMTMP" -maxdepth 1 -name 'out.restore-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$MMLEFTOVER" = "0" ] \
  && echo "[PASS] SIGTERM mid-merge leaves no out.restore-* scratch dir (no plaintext left behind)" \
  || {
    echo "[FAIL] SIGTERM mid-merge leaked $MMLEFTOVER scratch dir(s)"
    # diagnostics for the next occurrence (#826 was undiagnosable from a bare count)
    for d in "$MMTMP"/out.restore-*; do echo "  leftover: $d ($(find "$d" -mindepth 1 | wc -l | tr -d ' ') entries)"; { ls -la "$d" 2>/dev/null | head -5; } || true; done
    echo "  out entries: $(count_top_entries "$MMTMP/out") / expected $((MMN + 1)); sentinel: $([ -f "$MMTMP/out/.cypher-brain-restore-INCOMPLETE" ] && echo present || echo absent)"
    echo "  restore stderr:"; sed 's/^/    /' "$MMTMP/restore.err" 2>/dev/null | tail -20
    exit 1
  }
test -f "$MMTMP/out/.cypher-brain-restore-INCOMPLETE" \
  && echo "[PASS] SIGTERM mid-merge flagged the pre-existing --out-dir as incomplete" \
  || { echo "[FAIL] SIGTERM mid-merge did not drop the INCOMPLETE sentinel into --out-dir"; exit 1; }

echo "== #741: the signal handler must not block forever if the INCOMPLETE-sentinel path is a FIFO =="
# signal-guard.ts's handler drops a '.cypher-brain-restore-INCOMPLETE' sentinel into a
# pre-existing --out-dir via writeFileSync() (it cannot safely DELETE a directory the
# caller already owned). writeFileSync() opens with O_CREAT|O_WRONLY|O_TRUNC — if that
# exact path is already a FIFO (planted by an attacker who predicted the name, or an
# accidental leftover), open() blocks synchronously forever waiting for a reader that
# will never come, since THIS is the signal handler: no later cleanup step ever runs,
# and the process needs SIGKILL to die at all. Same mid-merge setup as #721 above (a
# large --out-dir gives a real window to land the signal in), but this time the
# sentinel path is pre-created as a FIFO before restore ever starts.
FTMP="$TMP/fifo-sentinel"; mkdir -p "$FTMP/src"
FDIRARGS=(); FN=400
for i in $(seq 1 "$FN"); do
  d="$FTMP/src/d$i"; mkdir -p "$d"; printf 'x' > "$d/f.txt"
  FDIRARGS+=(--dir "$d")
done
cb "$PRIMARY" snapshot "${FDIRARGS[@]}" --recipient "$PRIMARY/recipient.txt" --scan-secrets off \
  --out "$FTMP/v.age" >/dev/null
reseed_f() { rm -rf "$FTMP/out"; mkdir -p "$FTMP/out"; mkfifo "$FTMP/out/.cypher-brain-restore-INCOMPLETE"; }
RESEED=reseed_f land_sigterm_mid_merge "$FTMP/v.age" "$FTMP/out" 1 "$((FN + 1))" "$FTMP/restore.err"
FPID=$MMPID
# Bounded wait for exit, NOT an unbounded `wait`: the whole point being tested is that
# the handler must NOT hang, so this loop (not `wait` itself) is what turns "still
# blocked in open()" into an observable, non-hanging [FAIL] instead of wedging this
# selftest script itself.
FDIED=0
for _ in $(seq 1 300); do
  if ! kill -0 "$FPID" 2>/dev/null; then FDIED=1; break; fi
  sleep 0.01
done
if [ "$FDIED" != "1" ]; then
  kill -9 "$FPID" 2>/dev/null || true
  wait "$FPID" 2>/dev/null || true
  echo "[FAIL] process did not exit within 3s of SIGTERM — signal handler is blocked writing the sentinel (FIFO not detected)"
  exit 1
fi
wait "$FPID" 2>/dev/null || true # signal exit is non-zero — expected
echo "[PASS] signal handler exits promptly (does not block) when the sentinel path is a FIFO"
test -p "$FTMP/out/.cypher-brain-restore-INCOMPLETE" \
  && echo "[PASS] the pre-existing FIFO itself is left untouched (never opened for writing)" \
  || { echo "[FAIL] the sentinel path is no longer a FIFO — the handler wrote through/replaced it"; exit 1; }

echo
echo "RECOVERY SELFTEST PASS"
