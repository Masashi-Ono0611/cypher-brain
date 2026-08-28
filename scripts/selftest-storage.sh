#!/usr/bin/env bash
# Storage round-trip proof for the FILE backend (issue #2), daemon-free so CI can
# gate push/pull: snapshot -> push -> (delete original) -> pull -> verify -> restore.
# Asserts the locator is content-addressed (not the source path), the stored bytes
# match, the pulled bytes round-trip and decrypt, and an absent locator errors.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_HOME="$TMP/keys"
export CYPHER_BRAIN_FILE_DIR="$TMP/store"
cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

MARKER="secret-thought-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
SRC="$TMP/brain-src"; mkdir -p "$SRC"
printf '%s\n' "$MARKER" > "$SRC/note.txt"
head -c 524288 /dev/urandom > "$SRC/blob.bin"

echo "== snapshot =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap.age"
ORIG=$(sha "$TMP/snap.age")

echo "== push (file backend) =="
LOC=$(cb push --in "$TMP/snap.age" --backend file)
[ "$LOC" != "$TMP/snap.age" ] && echo "[PASS] locator != source path" || { echo "[FAIL] locator == source"; exit 1; }
case "$LOC" in "$CYPHER_BRAIN_FILE_DIR"/*) echo "[PASS] object lives in the store";; *) echo "[FAIL] not in store: $LOC"; exit 1;; esac
[ "$(sha "$LOC")" = "$ORIG" ] && echo "[PASS] stored bytes == source" || { echo "[FAIL] store byte mismatch"; exit 1; }

echo "== pull (after deleting the original, so it MUST come from the store) =="
rm -f "$TMP/snap.age"
cb pull --locator "$LOC" --backend file --out "$TMP/got.age"
[ "$(sha "$TMP/got.age")" = "$ORIG" ] && echo "[PASS] pulled bytes == original" || { echo "[FAIL] pulled byte mismatch"; exit 1; }

echo "== verify + decrypt the pulled ciphertext =="
cb verify --in "$TMP/got.age" | grep -q "VERDICT: PASS" && echo "[PASS] verify VERDICT PASS on pulled" || { echo "[FAIL] verify"; exit 1; }
cb restore --in "$TMP/got.age" --out-dir "$TMP/out"
tar -xzf "$TMP/out/brain-src.tar.gz" -C "$TMP/out"
diff -r "$SRC" "$TMP/out/brain-src"
echo "[PASS] decrypt + restore byte-identical to source"

echo "== pull --sha256: correct hash passes, wrong hash fail-closes (deletes --out) =="
cb pull --locator "$LOC" --backend file --out "$TMP/got-ok.age" --sha256 "$ORIG"
[ "$(sha "$TMP/got-ok.age")" = "$ORIG" ] && echo "[PASS] pull --sha256 (correct) kept the bytes" || { echo "[FAIL] correct --sha256 rejected"; exit 1; }
WRONG="0000000000000000000000000000000000000000000000000000000000000000"
set +e
SHA_ERR=$(cb pull --locator "$LOC" --backend file --out "$TMP/got-bad.age" --sha256 "$WRONG" 2>&1); SHA_RC=$?
set -e
if [ "$SHA_RC" = "0" ]; then echo "[FAIL] pull --sha256 accepted a mismatching hash"; exit 1; fi
test ! -f "$TMP/got-bad.age"   # fail-closed: the bad artifact must not be left at --out
echo "[PASS] pull --sha256 (wrong) errored and deleted --out"

echo "== issue #212: a --sha256 mismatch carries the CB-E001 error code + doc reference =="
printf '%s' "$SHA_ERR" | grep -q '\[CB-E001\]' || { echo "[FAIL] sha256 mismatch error lacks the CB-E001 code"; echo "$SHA_ERR"; exit 1; }
printf '%s' "$SHA_ERR" | grep -q 'MANAGEMENT.md#error-codes' || { echo "[FAIL] sha256 mismatch error lacks the doc reference"; echo "$SHA_ERR"; exit 1; }
echo "[PASS] sha256 mismatch error carries [CB-E001] + MANAGEMENT.md#error-codes"

echo "== issue #107: pull refuses to overwrite an existing --out by default =="
printf 'pre-existing bytes, must survive the refusal\n' > "$TMP/collide.age"
COLLIDE_BEFORE=$(sha "$TMP/collide.age")
if cb pull --locator "$LOC" --backend file --out "$TMP/collide.age" 2>"$TMP/collide.err"; then
  echo "[FAIL] pull overwrote an existing --out without --force"; exit 1
fi
grep -q "already exists" "$TMP/collide.err" || { echo "[FAIL] no-clobber error message missing 'already exists'"; cat "$TMP/collide.err"; exit 1; }
[ "$(sha "$TMP/collide.age")" = "$COLLIDE_BEFORE" ] || { echo "[FAIL] the pre-existing --out was modified despite the no-clobber refusal"; exit 1; }
echo "[PASS] pull refuses to overwrite an existing --out, which survives byte-identical"
grep -q '\[CB-E009\]' "$TMP/collide.err" || { echo "[FAIL] no-clobber error lacks the CB-E009 code"; cat "$TMP/collide.err"; exit 1; }
echo "[PASS] no-clobber error carries [CB-E009]"

echo "== issue #107: pull --force overwrites an existing --out =="
cb pull --locator "$LOC" --backend file --out "$TMP/collide.age" --force
[ "$(sha "$TMP/collide.age")" = "$ORIG" ] || { echo "[FAIL] pull --force did not overwrite with the fetched bytes"; exit 1; }
echo "[PASS] pull --force overwrites an existing --out"

echo "== issue #107: a --sha256 mismatch never touches a PRE-EXISTING --out (verified before promotion) =="
printf 'pre-existing bytes, must survive a hash mismatch too\n' > "$TMP/collide2.age"
COLLIDE2_BEFORE=$(sha "$TMP/collide2.age")
if cb pull --locator "$LOC" --backend file --out "$TMP/collide2.age" --force --sha256 "$WRONG" 2>/dev/null; then
  echo "[FAIL] pull --force --sha256 (wrong) unexpectedly succeeded"; exit 1
fi
[ "$(sha "$TMP/collide2.age")" = "$COLLIDE2_BEFORE" ] || { echo "[FAIL] a --sha256 mismatch modified a pre-existing --out (the fetch must land in a temp part, never --out itself, until verified)"; exit 1; }
echo "[PASS] a --sha256 mismatch leaves a pre-existing --out completely untouched"

echo "== issue #107: no stray pull .part temp files are left behind =="
if find "$TMP" -maxdepth 1 -name '*.part' | grep -q .; then
  echo "[FAIL] a stray pull .part temp file was left in \$TMP"; find "$TMP" -maxdepth 1 -name '*.part'; exit 1
fi
echo "[PASS] no stray pull .part temp files left behind"

echo "== negative control: an absent locator must fail =="
if cb pull --locator "$CYPHER_BRAIN_FILE_DIR/deadbeef.age" --backend file --out "$TMP/no.age" 2>/dev/null; then
  echo "[FAIL] absent locator returned bytes"; exit 1
fi
echo "[PASS] absent locator errors"

echo "== #465: --wait is a no-op for the file backend, but must now WARN instead of silently ignoring it =="
# Same absent-locator repro as the negative control above, but with --wait 6: the file
# backend's "no object at ..." is a plain Error (not RetryableError, src/lib/util.ts),
# so pull's retry loop (src/lib/pushpull.ts) never engages here — proven below by timing
# the run well under the 6s --wait budget, not just checking the exit code. The 3s
# failure threshold (half the budget) leaves generous slack for process startup on a
# loaded CI runner while still failing hard if a retry actually engaged (which would
# take the full 6s minimum, not a few hundred ms — Codex review, #465).
set +e
WAIT_START=$(date +%s)
WAIT_OUT=$(cb pull --wait 6 --locator "$CYPHER_BRAIN_FILE_DIR/deadbeef.age" --backend file --out "$TMP/wait-no.age" 2>&1); WAIT_RC=$?
WAIT_ELAPSED=$(( $(date +%s) - WAIT_START ))
set -e
[ "$WAIT_RC" != "0" ] || { echo "[FAIL] --wait 6 against an absent locator unexpectedly succeeded"; exit 1; }
test ! -f "$TMP/wait-no.age"
if [ "$WAIT_ELAPSED" -ge 3 ]; then
  echo "[FAIL] pull --wait 6 took ${WAIT_ELAPSED}s against the file backend — it should fail immediately, not actually retry"
  exit 1
fi
echo "[PASS] pull --wait 6 against an absent file-backend locator still fails immediately (${WAIT_ELAPSED}s, not ~6s)"
printf '%s' "$WAIT_OUT" | grep -q 'wait has no effect on the "file" backend' \
  || { echo "[FAIL] expected a warning that --wait has no effect on the file backend"; echo "$WAIT_OUT"; exit 1; }
echo "[PASS] pull --wait warns that it has no effect on the file backend"

# Negative control for the warning itself: WITHOUT --wait (the pre-#465 default),
# the same absent-locator failure must NOT print that warning — proves it is gated on
# --wait > 0, not printed unconditionally for the file backend.
NOWAIT_OUT=$(cb pull --locator "$CYPHER_BRAIN_FILE_DIR/deadbeef.age" --backend file --out "$TMP/nowait-no.age" 2>&1) && true
if printf '%s' "$NOWAIT_OUT" | grep -q 'wait has no effect'; then
  echo "[FAIL] the --wait warning fired even though --wait was not passed"; echo "$NOWAIT_OUT"; exit 1
fi
echo "[PASS] no --wait warning when --wait was not passed"

echo "== issue #93: a locator outside FILE_DIR must be rejected (path traversal / arbitrary local file read) =="
touch "$TMP/outside.age"
set +e
TRAVERSAL_ERR=$(cb pull --locator "$TMP/outside.age" --backend file --out "$TMP/leak1.age" 2>&1); TRAVERSAL_RC=$?
set -e
if [ "$TRAVERSAL_RC" = "0" ]; then echo "[FAIL] locator outside FILE_DIR was read"; exit 1; fi
test ! -f "$TMP/leak1.age"
echo "[PASS] locator outside FILE_DIR is rejected"
printf '%s' "$TRAVERSAL_ERR" | grep -q '\[CB-E010\]' || { echo "[FAIL] path-traversal error lacks the CB-E010 code"; echo "$TRAVERSAL_ERR"; exit 1; }
echo "[PASS] path-traversal error carries [CB-E010]"

if cb pull --locator "$CYPHER_BRAIN_FILE_DIR/../outside.age" --backend file --out "$TMP/leak2.age" 2>/dev/null; then
  echo "[FAIL] relative traversal out of FILE_DIR was read"; exit 1
fi
test ! -f "$TMP/leak2.age"
echo "[PASS] relative traversal (../) out of FILE_DIR is rejected"

echo "== issue #93: a locator inside FILE_DIR with the wrong shape (not <sha256>.age) must be rejected =="
cp "$TMP/outside.age" "$CYPHER_BRAIN_FILE_DIR/notasha.age"
if cb pull --locator "$CYPHER_BRAIN_FILE_DIR/notasha.age" --backend file --out "$TMP/leak3.age" 2>/dev/null; then
  echo "[FAIL] wrong-shape locator inside FILE_DIR was read"; exit 1
fi
test ! -f "$TMP/leak3.age"
echo "[PASS] wrong-shape locator inside FILE_DIR is rejected"

echo "== backend is required (no silent default) =="
if cb push --in "$TMP/got.age" 2>/dev/null; then echo "[FAIL] push ran with no --backend"; exit 1; fi
echo "[PASS] push without --backend is rejected"

# ── same-hash skip (#70): the skip signal is the PLAINTEXT content digest sidecar ──
# (age ciphertext hashes differ every run — ephemeral file key — so only the
# plaintext-side digest can say "unchanged") PLUS (round 2) a recipients fingerprint
# sidecar, so a changed --recipient set is never masked by unchanged plaintext.
umask 022   # deterministic tar-extraction permission bits for the chmod test below

echo "== digest sidecar: mtime-independent, content-sensitive =="
SRC2="$TMP/skip-src"; mkdir -p "$SRC2"
printf 'alpha\n' > "$SRC2/a.txt"
printf 'beta\n'  > "$SRC2/b.txt"
cb snapshot --dir "$SRC2" --out "$TMP/s1.age"
[ -f "$TMP/s1.age.digest" ] || { echo "[FAIL] no digest sidecar next to s1.age"; exit 1; }
D1=$(cat "$TMP/s1.age.digest")
# unchanged content, but every mtime moved — the digest must not move with it
touch -t 202001010101 "$SRC2/a.txt" "$SRC2/b.txt" "$SRC2"
cb snapshot --dir "$SRC2" --out "$TMP/s2.age"
D2=$(cat "$TMP/s2.age.digest")
[ "$D1" = "$D2" ] || { echo "[FAIL] digest changed on an mtime-only change: $D1 vs $D2"; exit 1; }
echo "[PASS] unchanged content (mtimes touched) -> identical digest"
printf 'Alpha\n' > "$SRC2/a.txt"   # one changed byte
cb snapshot --dir "$SRC2" --out "$TMP/s3.age"
D3=$(cat "$TMP/s3.age.digest")
[ "$D1" != "$D3" ] || { echo "[FAIL] digest identical after a one-byte content change"; exit 1; }
echo "[PASS] one changed byte -> different digest"

echo "== #70 review fix 1: content_digest reflects the ARCHIVED bytes, not a stale independent pre-tar read =="
# Race-style repro: mutate the source WHILE snapshot is (possibly) still tar/gzip-ing
# it. Big + incompressible so the archive step takes measurable wall-clock time,
# widening the window. The assertion below must hold no matter which content wins
# the race -- it directly checks the invariant fix 1 provides: the digest can never
# describe content other than what actually got archived (previously the digest was
# a SEPARATE, independent walk of the live source taken BEFORE tar read it).
SRC4="$TMP/race-src"; mkdir -p "$SRC4"
head -c 8000000 /dev/urandom > "$SRC4/big.bin"
cb snapshot --dir "$SRC4" --out "$TMP/race.age" &
SNAP_PID=$!
sleep 0.05
head -c 8000000 /dev/urandom > "$SRC4/big.bin"   # mutate mid-flight
wait "$SNAP_PID"
[ -f "$TMP/race.age.digest" ] || { echo "[FAIL] no digest sidecar for the race snapshot"; exit 1; }
cb restore --in "$TMP/race.age" --out-dir "$TMP/race-restored" >/dev/null
# -p (preserve-permissions): the SAME flag the production re-read (src/lib/snapshot.ts)
# now uses (round 3, fix 2) -- without it this manual re-extraction's directory/file
# modes would be masked by this script's own umask instead of reflecting the archive's
# stored bits, and this recomputation would stop matching production's digest.
tar -xzf "$TMP/race-restored/race-src.tar.gz" -C "$TMP/race-restored" -p
# the per-COMPONENT content_digest (manifest.json, what fix 1 computes) must match a
# recomputation from what was ACTUALLY archived (the restored/extracted bytes) --
# exactly, regardless of which content won the race.
COMPONENT_DIGEST=$(node -e "console.log(JSON.parse(require('node:fs').readFileSync('$TMP/race-restored/manifest.json','utf8')).components[0].content_digest)")
BIG_SHA=$(sha "$TMP/race-restored/race-src/big.bin")
BIG_SIZE=$(wc -c < "$TMP/race-restored/race-src/big.bin" | tr -d ' ')
# per-file tuple now carries a trailing octal mode field (round 2, permission-bit fix)
BIG_MODE=$(node -e "console.log((require('node:fs').statSync('$TMP/race-restored/race-src/big.bin').mode & 0o777).toString(8).padStart(3,'0'))")
# the top-level dir also contributes its OWN "." tuple line now (round 3, fix 3)
DIR_MODE=$(node -e "console.log((require('node:fs').statSync('$TMP/race-restored/race-src').mode & 0o777).toString(8).padStart(3,'0'))")
EXPECTED=$(printf '.\td\t-\t0\t%s\nbig.bin\tf\t%s\t%s\t%s\n' "$DIR_MODE" "$BIG_SHA" "$BIG_SIZE" "$BIG_MODE" | LC_ALL=C sort | shasum -a 256 | cut -d' ' -f1)
[ "$COMPONENT_DIGEST" = "$EXPECTED" ] || { echo "[FAIL] component digest does not match a recomputation from the archived bytes: $COMPONENT_DIGEST vs $EXPECTED"; exit 1; }
echo "[PASS] component digest matches the archived bytes exactly, even with a source mutation racing the tar read"

echo "== #70 review fix 2: a top-level symlinked --dir source hashes the LINK's identity, not its target's content =="
# tar archives an explicit symlink argument AS the link (not dereferenced) -- same
# class of bug profiles.mjs's realpath-dereference comment fixes for --vault/--zip.
# Swapping the target to a DIFFERENT path, even one with byte-identical content,
# must change the digest: the archived representation (a symlink recording that
# target) changed, even though a naive content-follow would see no difference.
mkdir -p "$TMP/symtargetA" "$TMP/symtargetB"
printf 'identical content\n' > "$TMP/symtargetA/f.txt"
printf 'identical content\n' > "$TMP/symtargetB/f.txt"
ln -s "$TMP/symtargetA" "$TMP/symlinked-dir"
cb snapshot --dir "$TMP/symlinked-dir" --out "$TMP/sym1.age"
[ -f "$TMP/sym1.age.digest" ] || { echo "[FAIL] no digest sidecar for the symlinked --dir snapshot"; exit 1; }
SYM_D1=$(cat "$TMP/sym1.age.digest")
rm -f "$TMP/symlinked-dir"
ln -s "$TMP/symtargetB" "$TMP/symlinked-dir"   # same link name, byte-identical target content, DIFFERENT target path
cb snapshot --dir "$TMP/symlinked-dir" --out "$TMP/sym2.age"
SYM_D2=$(cat "$TMP/sym2.age.digest")
[ "$SYM_D1" != "$SYM_D2" ] || { echo "[FAIL] digest unchanged after swapping the symlink's target (byte-identical content masked a real archived-representation change)"; exit 1; }
echo "[PASS] swapping a top-level symlink's target changes the digest, even though the pointed-to content is byte-identical"

echo "== #70 review fix 3: identical bytes under a DIFFERENT declared --dir path/name change the combined digest =="
# Renaming/moving a --dir source with byte-identical content must not look
# "unchanged": the restored manifest/archive still labels things under the OLD
# name/path, so --skip-unchanged returning the old locator would be a correctness
# violation, not an optimization.
mkdir -p "$TMP/named-a" "$TMP/named-b"
printf 'identical bytes\n' > "$TMP/named-a/f.txt"
printf 'identical bytes\n' > "$TMP/named-b/f.txt"
cb snapshot --dir "$TMP/named-a" --out "$TMP/id1.age"
D_ID1=$(cat "$TMP/id1.age.digest")
cb snapshot --dir "$TMP/named-b" --out "$TMP/id2.age"
D_ID2=$(cat "$TMP/id2.age.digest")
[ "$D_ID1" != "$D_ID2" ] || { echo "[FAIL] identically-byted components under different declared names produced the SAME digest"; exit 1; }
echo "[PASS] same bytes, different declared --dir name -> different digest"
IDLOCFILE="$TMP/identity-locator.tsv"
cb push --in "$TMP/id1.age" --backend file --save-locator "$IDLOCFILE" >/dev/null
cb push --in "$TMP/id2.age" --backend file --save-locator "$IDLOCFILE" --skip-unchanged 2>"$TMP/id.err" >/dev/null
if grep -q "SKIPPED" "$TMP/id.err"; then echo "[FAIL] --skip-unchanged skipped a differently-named/sourced component with identical bytes"; exit 1; fi
echo "[PASS] --skip-unchanged does not skip when the declared source/name differs (even with identical bytes)"

echo "== #70 review round 2, issue 1: adding a --recipient must NOT let --skip-unchanged return a stale locator =="
# A second, independent identity (the "offline recovery key" MANAGEMENT.md's
# single-recipient warning tells operators to add) -- its recipient.txt is a valid
# --recipient FILE argument, same as any recipients file.
CYPHER_BRAIN_HOME="$TMP/keys2" cb keygen >/dev/null
RECIP2="$TMP/keys2/recipient.txt"
DEFAULT_RECIP="$TMP/keys/recipient.txt"

SRC5="$TMP/rcpt-src"; mkdir -p "$SRC5"
printf 'same plaintext across a recipient change\n' > "$SRC5/f.txt"
RLOC="$TMP/rcpt-locator.tsv"
cb snapshot --dir "$SRC5" --out "$TMP/r1.age"                                    # default single recipient
LOC_R1=$(cb push --in "$TMP/r1.age" --backend file --save-locator "$RLOC")

# same plaintext, but a SECOND recipient (the recovery key) is now ALSO encrypted to
# -- byte-identical content_digest, but a DIFFERENT recipients_fingerprint.
cb snapshot --dir "$SRC5" --out "$TMP/r2.age" --recipient "$DEFAULT_RECIP" --recipient "$RECIP2"
[ "$(cat "$TMP/r1.age.digest")" = "$(cat "$TMP/r2.age.digest")" ] || { echo "[FAIL] test setup: r1/r2 content digests differ, they must be identical for this to test the recipients signal"; exit 1; }
[ "$(cat "$TMP/r1.age.recipients-fingerprint")" != "$(cat "$TMP/r2.age.recipients-fingerprint")" ] || { echo "[FAIL] test setup: recipients-fingerprint did not change after adding a --recipient"; exit 1; }
OUT_R2=$(cb push --in "$TMP/r2.age" --backend file --save-locator "$RLOC" --skip-unchanged 2>"$TMP/r2.err")
if grep -q "SKIPPED" "$TMP/r2.err"; then echo "[FAIL] --skip-unchanged skipped after the recipient set changed (added a recovery key)"; exit 1; fi
[ "$OUT_R2" != "$LOC_R1" ] || { echo "[FAIL] push after a recipient-set change returned the OLD locator"; exit 1; }
echo "[PASS] adding a --recipient with unchanged plaintext -> --skip-unchanged does NOT skip (proceeds, new locator)"

echo "== #70 review round 2 (no regression): unchanged plaintext AND unchanged recipient set still SKIPs =="
BLOC="$TMP/same-rcpt-locator.tsv"
LOC_R1B=$(cb push --in "$TMP/r1.age" --backend file --save-locator "$BLOC")
cb snapshot --dir "$SRC5" --out "$TMP/r3.age"   # SAME plaintext, SAME default single-recipient set as r1
OUT_R3=$(cb push --in "$TMP/r3.age" --backend file --save-locator "$BLOC" --skip-unchanged 2>"$TMP/r3.err")
grep -q "SKIPPED" "$TMP/r3.err" || { echo "[FAIL] --skip-unchanged did not skip when both content AND recipient set are unchanged (regression)"; exit 1; }
[ "$OUT_R3" = "$LOC_R1B" ] || { echo "[FAIL] skip did not return the previous locator: $OUT_R3"; exit 1; }
echo "[PASS] content unchanged + recipients unchanged -> --skip-unchanged still skips (core feature intact)"

echo "== #70 review round 2, issue 2: chmod'd file permissions must NOT be masked by --skip-unchanged =="
SRC6="$TMP/mode-src"; mkdir -p "$SRC6"
printf '#!/bin/sh\necho hi\n' > "$SRC6/script.sh"
chmod 644 "$SRC6/script.sh"
cb snapshot --dir "$SRC6" --out "$TMP/m1.age"
D_M1=$(cat "$TMP/m1.age.digest")
MLOC="$TMP/mode-locator.tsv"
LOC_M1=$(cb push --in "$TMP/m1.age" --backend file --save-locator "$MLOC")
chmod 755 "$SRC6/script.sh"   # executable bit flipped -- byte content unchanged
cb snapshot --dir "$SRC6" --out "$TMP/m2.age"
D_M2=$(cat "$TMP/m2.age.digest")
[ "$D_M1" != "$D_M2" ] || { echo "[FAIL] digest unchanged after chmod +x (permission bits not folded into the digest)"; exit 1; }
echo "[PASS] chmod +x on a --dir source file changes the content digest"
OUT_M2=$(cb push --in "$TMP/m2.age" --backend file --save-locator "$MLOC" --skip-unchanged 2>"$TMP/m2.err")
if grep -q "SKIPPED" "$TMP/m2.err"; then echo "[FAIL] --skip-unchanged skipped a snapshot whose only change was a file's permission bits"; exit 1; fi
[ "$OUT_M2" != "$LOC_M1" ] || { echo "[FAIL] chmod-only-change push returned the OLD locator"; exit 1; }
echo "[PASS] chmod +x on a --dir source file -> --skip-unchanged does NOT skip"

echo "== #70 review round 3, fix 1: a single-file (non-dir) source's chmod-only change must NOT be masked by --skip-unchanged =="
SINGLEFILE="$TMP/single.txt"
printf 'single file content\n' > "$SINGLEFILE"
chmod 644 "$SINGLEFILE"
cb snapshot --dir "$SINGLEFILE" --out "$TMP/sf1.age"
D_SF1=$(cat "$TMP/sf1.age.digest")
SFLOC="$TMP/singlefile-locator.tsv"
LOC_SF1=$(cb push --in "$TMP/sf1.age" --backend file --save-locator "$SFLOC")
chmod 600 "$SINGLEFILE"   # permission-only change, byte content unchanged
cb snapshot --dir "$SINGLEFILE" --out "$TMP/sf2.age"
D_SF2=$(cat "$TMP/sf2.age.digest")
[ "$D_SF1" != "$D_SF2" ] || { echo "[FAIL] digest unchanged after chmod on a single-file (non-dir) source"; exit 1; }
echo "[PASS] chmod on a single-file source changes the content digest"
OUT_SF2=$(cb push --in "$TMP/sf2.age" --backend file --save-locator "$SFLOC" --skip-unchanged 2>"$TMP/sf2.err")
if grep -q "SKIPPED" "$TMP/sf2.err"; then echo "[FAIL] --skip-unchanged skipped a single-file source whose only change was permission bits"; exit 1; fi
[ "$OUT_SF2" != "$LOC_SF1" ] || { echo "[FAIL] chmod-only single-file push returned the OLD locator"; exit 1; }
echo "[PASS] chmod on a single-file source -> --skip-unchanged does NOT skip"

echo "== #70 review round 3, fix 2: a restrictive umask during the tar-extraction digest re-read must NOT mask a source mode change =="
# Plain 'tar -xzf' (no -p) applies the calling process's umask on extraction, so under
# a restrictive umask a mode-only source change (e.g. 0644 -> 0600) could extract to
# the SAME mode both times even though the archive's own header bytes differ -- the
# fix re-reads with -p (preserve-permissions) so the umask in effect during snapshot
# never gets a vote. Wrap the run in umask 077 (tighter than the file's own mode) so a
# masking bug, if reintroduced, would reproduce here.
SRC8="$TMP/umask-src"; mkdir -p "$SRC8"
printf 'content unaffected by mode\n' > "$SRC8/f.txt"
chmod 644 "$SRC8/f.txt"
(umask 077 && cb snapshot --dir "$SRC8" --out "$TMP/u1.age")
D_U1=$(cat "$TMP/u1.age.digest")
chmod 600 "$SRC8/f.txt"   # mode-only change; under umask 077 a masked re-read would extract 0600 either way
(umask 077 && cb snapshot --dir "$SRC8" --out "$TMP/u2.age")
D_U2=$(cat "$TMP/u2.age.digest")
[ "$D_U1" != "$D_U2" ] || { echo "[FAIL] digest unchanged after a 0644->0600 source mode change under a restrictive umask (extraction re-read masked the permission bits)"; exit 1; }
echo "[PASS] a source mode change still changes the digest even when snapshotting under a restrictive umask"

echo "== #70 review round 3, fix 3: directory-only permission changes (subdirectory AND the top-level --dir itself) change the digest =="
SRC9="$TMP/dirmode-src"; mkdir -p "$SRC9/sub"
printf 'unrelated content\n' > "$SRC9/sub/f.txt"
chmod 755 "$SRC9"
chmod 755 "$SRC9/sub"
cb snapshot --dir "$SRC9" --out "$TMP/dm1.age"
D_DM1=$(cat "$TMP/dm1.age.digest")
chmod 700 "$SRC9/sub"   # SUBDIRECTORY's own permissions change -- no file content or file mode touched
cb snapshot --dir "$SRC9" --out "$TMP/dm2.age"
D_DM2=$(cat "$TMP/dm2.age.digest")
[ "$D_DM1" != "$D_DM2" ] || { echo "[FAIL] digest unchanged after a subdirectory-only permission change"; exit 1; }
echo "[PASS] a subdirectory-only permission change changes the digest"
chmod 755 "$SRC9/sub"   # restore, isolate the next assertion to the TOP-LEVEL dir's own mode
chmod 700 "$SRC9"       # the --dir arg's OWN permissions change -- no file/subdirectory touched
cb snapshot --dir "$SRC9" --out "$TMP/dm3.age"
D_DM3=$(cat "$TMP/dm3.age.digest")
[ "$D_DM1" != "$D_DM3" ] || { echo "[FAIL] digest unchanged after the top-level --dir's own permission change"; exit 1; }
echo "[PASS] the top-level --dir's own permission change changes the digest"
chmod 755 "$SRC9"   # leave a predictable mode behind

echo "== #70 review round 4: a top-level FIFO (--dir arg itself a special file) must not hang, and hashes identity not content =="
# A FIFO only yields bytes once something writes to the other end -- with no writer,
# sha256()-ing it would block forever. The fix (src/lib/snapshot.ts contentDigestOfPath)
# must detect this at the TOP level the same way the nested-file-walk already does for a
# special file found inside a --dir, and hash a bare kind marker instead of reading it.
# with_timeout bounds the snapshot call itself: a regression here must FAIL LOUDLY, not
# hang the whole suite (rules/shell-ops.md -- poll/gate loops need their own deadline,
# not just an outer one).
with_timeout() {
  local s=$1; shift
  "$@" & local c=$!
  ( sleep "$s"; kill -9 "$c" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$c" 2>/dev/null; local rc=$?
  kill -9 "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}
FIFO="$TMP/special.fifo"
mkfifo "$FIFO"
with_timeout 15 cb snapshot --dir "$FIFO" --out "$TMP/fifo1.age" || { echo "[FAIL] snapshot on a top-level FIFO timed out or errored (may be blocked reading FIFO content)"; exit 1; }
[ -f "$TMP/fifo1.age.digest" ] || { echo "[FAIL] no digest sidecar for the top-level FIFO snapshot"; exit 1; }
D_FIFO1=$(cat "$TMP/fifo1.age.digest")
echo "[PASS] snapshot on a top-level FIFO completed promptly (did not hang trying to read FIFO content)"
with_timeout 15 cb snapshot --dir "$FIFO" --out "$TMP/fifo2.age" || { echo "[FAIL] second snapshot on the same top-level FIFO timed out or errored"; exit 1; }
D_FIFO2=$(cat "$TMP/fifo2.age.digest")
[ "$D_FIFO1" = "$D_FIFO2" ] || { echo "[FAIL] FIFO digest not stable across repeated snapshots of the same path: $D_FIFO1 vs $D_FIFO2"; exit 1; }
echo "[PASS] repeated snapshots of the same top-level FIFO produce an identical (stable) digest -- the FIFO's special-file identity, not its (unreadable) content"
cb verify --in "$TMP/fifo1.age" | grep -q "VERDICT: PASS" && echo "[PASS] verify VERDICT PASS on a snapshot whose sole --dir source is a FIFO" || { echo "[FAIL] verify failed on the FIFO snapshot"; exit 1; }

echo "== push --save-locator writes the 5-field line (locator/backend/sha256/content_digest/recipients_fingerprint) =="
[ -f "$TMP/s1.age.recipients-fingerprint" ] || { echo "[FAIL] no recipients-fingerprint sidecar next to s1.age"; exit 1; }
RF1=$(cat "$TMP/s1.age.recipients-fingerprint")
LOCFILE="$TMP/latest-locator.tsv"
LOC1=$(cb push --in "$TMP/s1.age" --backend file --save-locator "$LOCFILE")
NF=$(awk -F'\t' 'NR==1{print NF}' "$LOCFILE")
[ "$NF" = "5" ] || { echo "[FAIL] save-locator line has $NF fields, want 5"; exit 1; }
[ "$(cut -f4 "$LOCFILE")" = "$D1" ] || { echo "[FAIL] 4th field != content digest sidecar"; exit 1; }
[ "$(cut -f5 "$LOCFILE")" = "$RF1" ] || { echo "[FAIL] 5th field != recipients-fingerprint sidecar"; exit 1; }
echo "[PASS] save-locator line has 5 fields; 4th == content digest, 5th == recipients fingerprint"

echo "== push #2 (unchanged content) --skip-unchanged: SKIPs, previous locator, exit 0, no new object =="
COUNT_BEFORE=$(ls "$CYPHER_BRAIN_FILE_DIR" | wc -l | tr -d ' ')
OUT2=$(cb push --in "$TMP/s2.age" --backend file --save-locator "$LOCFILE" --skip-unchanged 2>"$TMP/skip.err")
grep -q "SKIPPED" "$TMP/skip.err" || { echo "[FAIL] no SKIPPED line on stderr"; cat "$TMP/skip.err"; exit 1; }
[ "$OUT2" = "$LOC1" ] || { echo "[FAIL] skip did not print the previous locator: $OUT2"; exit 1; }
COUNT_AFTER=$(ls "$CYPHER_BRAIN_FILE_DIR" | wc -l | tr -d ' ')
[ "$COUNT_BEFORE" = "$COUNT_AFTER" ] || { echo "[FAIL] the store gained an object on a skipped push"; exit 1; }
echo "[PASS] unchanged push skipped: SKIPPED line, previous locator on stdout, store untouched"

echo "== --force pushes anyway =="
LOC_F=$(cb push --in "$TMP/s2.age" --backend file --save-locator "$LOCFILE" --skip-unchanged --force)
[ "$LOC_F" != "$LOC1" ] || { echo "[FAIL] --force returned the old locator"; exit 1; }
COUNT_FORCE=$(ls "$CYPHER_BRAIN_FILE_DIR" | wc -l | tr -d ' ')
[ "$COUNT_FORCE" = "$((COUNT_AFTER + 1))" ] || { echo "[FAIL] --force did not add a store object"; exit 1; }
echo "[PASS] --force uploaded despite an identical content digest"

echo "== legacy 3-field save-locator: pull still works AND --skip-unchanged does not skip =="
LEGACY="$TMP/legacy-locator.tsv"
printf '%s\t%s\t%s\n' "$LOC1" file "$(sha "$TMP/s1.age")" > "$LEGACY"
cb pull --from-locator-file "$LEGACY" --out "$TMP/legacy-got.age"
[ "$(sha "$TMP/legacy-got.age")" = "$(sha "$TMP/s1.age")" ] || { echo "[FAIL] legacy 3-field pull bytes mismatch"; exit 1; }
echo "[PASS] pull --from-locator-file accepts a legacy 3-field line (recovery unbroken)"
cb push --in "$TMP/s2.age" --backend file --save-locator "$LEGACY" --skip-unchanged >"$TMP/legacy.out" 2>"$TMP/legacy.err"
if grep -q "SKIPPED" "$TMP/legacy.err"; then echo "[FAIL] skipped off a legacy 3-field line (no digest to compare)"; exit 1; fi
NF_LEGACY=$(awk -F'\t' 'NR==1{print NF}' "$LEGACY")
[ "$NF_LEGACY" = "5" ] || { echo "[FAIL] proceeding push did not upgrade the legacy file to 5 fields"; exit 1; }
echo "[PASS] legacy 3-field line: push proceeded (no skip) and rewrote a 5-field line"

echo "== changed content with --skip-unchanged: proceeds and rewrites the save-locator line =="
COUNT_E=$(ls "$CYPHER_BRAIN_FILE_DIR" | wc -l | tr -d ' ')
cb push --in "$TMP/s3.age" --backend file --save-locator "$LOCFILE" --skip-unchanged >"$TMP/e.out" 2>"$TMP/e.err"
if grep -q "SKIPPED" "$TMP/e.err"; then echo "[FAIL] changed content was skipped"; exit 1; fi
COUNT_E2=$(ls "$CYPHER_BRAIN_FILE_DIR" | wc -l | tr -d ' ')
[ "$COUNT_E2" = "$((COUNT_E + 1))" ] || { echo "[FAIL] changed-content push added no store object"; exit 1; }
[ "$(cut -f4 "$LOCFILE")" = "$D3" ] || { echo "[FAIL] save-locator 4th field was not rewritten to the new digest"; exit 1; }
echo "[PASS] changed content pushed; save-locator now carries the new digest"

echo "== --skip-unchanged without a sidecar: proceeds (skip is an optimization, never a gate) =="
cp "$TMP/s2.age" "$TMP/nosidecar.age"   # same content digest as LOC1's, but NO sidecar next to it
cb push --in "$TMP/nosidecar.age" --backend file --save-locator "$LOCFILE" --skip-unchanged >"$TMP/ns.out" 2>"$TMP/ns.err"
if grep -q "SKIPPED" "$TMP/ns.err"; then echo "[FAIL] skipped without any digest source"; exit 1; fi
echo "[PASS] no sidecar and no --digest -> pushed normally"

echo "== --skip-unchanged requires --save-locator =="
if cb push --in "$TMP/s2.age" --backend file --skip-unchanged 2>/dev/null; then
  echo "[FAIL] --skip-unchanged ran without --save-locator"; exit 1
fi
echo "[PASS] --skip-unchanged without --save-locator is rejected"

echo "== issue #212: push refuses non-ciphertext with the CB-E008 error code =="
printf 'plainly not age ciphertext\n' > "$TMP/plaintext.age"
set +e
NONCT_ERR=$(cb push --in "$TMP/plaintext.age" --backend file 2>&1); NONCT_RC=$?
set -e
if [ "$NONCT_RC" = "0" ]; then echo "[FAIL] push accepted a non-ciphertext --in"; exit 1; fi
printf '%s' "$NONCT_ERR" | grep -q "not age ciphertext" || { echo "[FAIL] push did not report the non-ciphertext refusal"; echo "$NONCT_ERR"; exit 1; }
printf '%s' "$NONCT_ERR" | grep -q '\[CB-E008\]' || { echo "[FAIL] non-ciphertext push error lacks the CB-E008 code"; echo "$NONCT_ERR"; exit 1; }
echo "[PASS] push refuses non-ciphertext, error carries [CB-E008]"

echo "== issue #212: unknown --backend name carries the CB-E013 error code =="
set +e
BADBACKEND_ERR=$(cb push --in "$TMP/s2.age" --backend bogus 2>&1); BADBACKEND_RC=$?
set -e
if [ "$BADBACKEND_RC" = "0" ]; then echo "[FAIL] push accepted an unknown --backend"; exit 1; fi
printf '%s' "$BADBACKEND_ERR" | grep -q '\[CB-E013\]' || { echo "[FAIL] unknown-backend error lacks the CB-E013 code"; echo "$BADBACKEND_ERR"; exit 1; }
echo "[PASS] unknown --backend error carries [CB-E013]"

echo
echo "STORAGE SELFTEST (file backend) PASS"
