#!/usr/bin/env bash
# Local round-trip proof for the cipher layer (issue #1): keygen -> snapshot ->
# verify -> restore, asserting the plaintext is recovered AND the ciphertext
# leaks nothing. No Postgres and no network — exercises the crypto + CLI plumbing
# on a synthetic "brain" directory. The real-data (pg_dump) run happens on the
# machine that holds gbrain.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_HOME="$TMP/keys"
# Mirrors src/lib/restore.ts's sourceDigest() EXACTLY (delegates to node rather than
# re-deriving it in bash) — the FULL, un-truncated 64-hex-char sha256 of the argument
# STRING encoded as 'utf16le' (NOT shasum's default byte-for-byte/utf8 hashing of
# stdin: a bash `printf '%s' | shasum` pipeline would silently drift from restore.ts's
# own encoding choice, which matters — see sourceDigest's doc comment for why 'utf8'
# was rejected). Used below to predict the "<NNN>-<basename>-<digest>" expanded/
# directory name restore.ts builds (#423).
src_digest() { node -e "process.stdout.write(require('node:crypto').createHash('sha256').update(process.argv[1], 'utf16le').digest('hex'))" "$1"; }

MARKER="secret-thought-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
SRC="$TMP/brain-src"
mkdir -p "$SRC"
printf '%s\n' "$MARKER" > "$SRC/note.txt"
head -c 1048576 /dev/urandom > "$SRC/blob.bin"   # 1 MB binary, to exercise streaming

echo "== keygen =="
cb keygen >/dev/null
test -f "$CYPHER_BRAIN_HOME/identity.age"
test -f "$CYPHER_BRAIN_HOME/recipient.txt"

echo "== snapshot =="
cb snapshot --dir "$SRC" --out "$TMP/snap.age"

echo "== verify =="
cb verify --in "$TMP/snap.age"

echo "== verify --sha256: correct hash PASSes, wrong hash FAILs =="
SNAPSHA=$(shasum -a 256 "$TMP/snap.age" | cut -d' ' -f1)
cb verify --in "$TMP/snap.age" --sha256 "$SNAPSHA" | grep -q "VERDICT: PASS" \
  && echo "[PASS] verify --sha256 (correct) is PASS" || { echo "FAIL: correct --sha256 not PASS"; exit 1; }
set +e
OUT=$(cb verify --in "$TMP/snap.age" --sha256 "deadbeef" 2>&1); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: verify --sha256 (wrong) exited 0"; echo "$OUT"; exit 1; fi
printf '%s' "$OUT" | grep -q "VERDICT: FAIL" || { echo "FAIL: wrong --sha256 not VERDICT FAIL"; echo "$OUT"; exit 1; }
echo "[PASS] verify --sha256 (wrong) is FAIL/non-zero"

echo "== issue #211: verify --json prints one machine-readable line, the SAME checks/verdict as the human report =="
JOUT=$(cb verify --in "$TMP/snap.age" --json); RC=$?
[ "$RC" = "0" ] || { echo "FAIL: verify --json (PASS case) exited $RC"; echo "$JOUT"; exit 1; }
LINES=$(printf '%s\n' "$JOUT" | wc -l | tr -d ' ')
[ "$LINES" = "1" ] || { echo "FAIL: verify --json printed $LINES stdout line(s), expected exactly 1 (no mascot/decoration mixed into stdout)"; echo "$JOUT"; exit 1; }
node -e "
const j = JSON.parse(process.argv[1]);
if (j.verdict !== 'PASS') throw new Error('expected verdict PASS, got ' + j.verdict);
if (j.exit_code !== 0) throw new Error('expected exit_code 0, got ' + j.exit_code);
if (j.checks.age_header !== true) throw new Error('expected checks.age_header true');
if (j.checks.sha256_match !== null) throw new Error('expected checks.sha256_match null (no --sha256 passed), got ' + j.checks.sha256_match);
if (j.checks.wrong_key_rejected !== true) throw new Error('expected checks.wrong_key_rejected true');
if (j.checks.positive_control !== 'pass') throw new Error('expected checks.positive_control pass, got ' + j.checks.positive_control);
if (j.file !== process.argv[2]) throw new Error('expected file field to echo --in');
if (typeof j.size_bytes !== 'number' || j.size_bytes <= 0) throw new Error('expected a positive size_bytes');
" "$JOUT" "$TMP/snap.age"
echo "[PASS] verify --json (PASS case): exactly one JSON line; verdict/exit_code/checks all correct"

set +e
JOUT_BAD=$(cb verify --in "$TMP/snap.age" --sha256 "deadbeef" --json); RC=$?
set -e
[ "$RC" = "1" ] || { echo "FAIL: verify --json (wrong --sha256) exited $RC, expected 1"; echo "$JOUT_BAD"; exit 1; }
node -e "
const j = JSON.parse(process.argv[1]);
if (j.verdict !== 'FAIL') throw new Error('expected verdict FAIL, got ' + j.verdict);
if (j.exit_code !== 1) throw new Error('expected exit_code 1, got ' + j.exit_code);
if (j.checks.sha256_match !== false) throw new Error('expected checks.sha256_match false, got ' + j.checks.sha256_match);
" "$JOUT_BAD"
echo "[PASS] verify --json (wrong --sha256): verdict FAIL / exit_code 1 / sha256_match false"

echo "== ciphertext must not leak plaintext =="
if LC_ALL=C grep -a -q "$MARKER" "$TMP/snap.age"; then
  echo "FAIL: plaintext marker found in ciphertext"; exit 1
fi
echo "[PASS] marker absent from ciphertext"

echo "== no-clobber: snapshot refuses to overwrite an existing --out =="
set +e
OUT=$(cb snapshot --dir "$SRC" --out "$TMP/snap.age" 2>&1); RC=$?   # snap.age already exists
set -e
if [ "$RC" = "0" ]; then echo "FAIL: snapshot overwrote an existing --out"; exit 1; fi
printf '%s' "$OUT" | grep -q "already exists" || { echo "FAIL: wrong error for existing --out"; echo "$OUT"; exit 1; }
echo "[PASS] snapshot refused to overwrite an existing snapshot"

echo "== issue #109: snapshot auto-creates a missing --out parent directory =="
NESTED_OUT="$TMP/nested/does/not/exist/yet/new.age"
cb snapshot --dir "$SRC" --out "$NESTED_OUT"
test -f "$NESTED_OUT" || { echo "FAIL: snapshot did not write to the auto-created nested --out path"; exit 1; }
cb verify --in "$NESTED_OUT" | grep -q "VERDICT: PASS" || { echo "FAIL: snapshot at an auto-created nested --out did not verify"; exit 1; }
echo "[PASS] snapshot auto-created the missing --out parent directory chain"

echo "== issue #109: a bad --out parent path (an ancestor component is a FILE, not a dir) is rejected, nothing written =="
BADPARENT="$TMP/blocking-file"; printf 'not a directory\n' > "$BADPARENT"
BADOUT="$BADPARENT/sub/out.age"
if cb snapshot --dir "$SRC" --out "$BADOUT" 2>/dev/null; then
  echo "FAIL: snapshot succeeded despite a bad --out parent path (an ancestor is a plain file)"; exit 1
fi
test ! -e "$BADOUT"   # nothing was ever written under the bad path
echo "[PASS] a bad --out parent path (ancestor is a file) is rejected, nothing written"

echo "== restore + compare =="
cb restore --in "$TMP/snap.age" --out-dir "$TMP/out"
tar -xzf "$TMP/out/brain-src.tar.gz" -C "$TMP/out"
diff -r "$SRC" "$TMP/out/brain-src"
echo "[PASS] restored tree is byte-identical to source"

echo "== #181/#423: restore auto-expands the component into out-dir/expanded/, keyed to its source path =="
# tar archives a --dir source as "-C $(dirname abs) -- $(basename abs)", so the expanded
# dir contains a basename(abs)-named subdirectory holding the actual tree (same shape as
# the manual `tar -xzf brain-src.tar.gz -C "$TMP/out"` two lines above, which is why THAT
# diff compares against "$TMP/out/brain-src", not "$TMP/out" itself).
# #423: the expanded/ directory NAME itself is now just "<NNN>-<basename>-<digest>"
# (short and readable, plus the FULL, un-truncated 64-hex-char SHA-256 digest of the
# FULL source path so two DIFFERENT sources sharing a basename won't collide — see
# sourceDigest() in src/lib/restore.ts), not the whole source path flattened+encoded —
# expanded/README.txt (checked below) is what actually maps the directory back to the
# full original source path.
EXPANDED_SRC_DIR="$TMP/out/expanded/001-$(basename "$SRC")-$(src_digest "$SRC")"
diff -r "$SRC" "$EXPANDED_SRC_DIR/$(basename "$SRC")" || { echo "FAIL: expanded/ tree differs from source"; ls -la "$TMP/out/expanded"; exit 1; }
test -f "$TMP/out/expanded/README.txt" || { echo "FAIL: expanded/README.txt was not written"; exit 1; }
grep -q "$SRC" "$TMP/out/expanded/README.txt" || { echo "FAIL: expanded/README.txt does not reference the source path"; cat "$TMP/out/expanded/README.txt"; exit 1; }
echo "[PASS] restore auto-expanded the single component under expanded/<001-basename-digest>/, with a README mapping it back to the full source path"

echo "== #436: default restore console output omits the raw manifest.json dump; --verbose restores it =="
# Same snap.age as above, into fresh --out-dir's so this doesn't disturb the restore
# already sitting in $TMP/out (still used by later assertions in this script).
DEFAULT_OUT="$TMP/manifest-default"
DEFAULT_LOG=$(cb restore --in "$TMP/snap.age" --out-dir "$DEFAULT_OUT")
printf '%s' "$DEFAULT_LOG" | grep -q '"schema"' \
  && { echo "FAIL: default restore (no --verbose) printed the raw manifest.json dump"; printf '%s\n' "$DEFAULT_LOG"; exit 1; }
printf '%s' "$DEFAULT_LOG" | grep -q "restored components into $DEFAULT_OUT" \
  || { echo "FAIL: default restore console output is missing the 'restored components into' summary line"; printf '%s\n' "$DEFAULT_LOG"; exit 1; }
printf '%s' "$DEFAULT_LOG" | grep -q '^expanded 1 component(s) into' \
  || { echo "FAIL: default restore console output is missing the expanded-component summary"; printf '%s\n' "$DEFAULT_LOG"; exit 1; }
test -f "$DEFAULT_OUT/manifest.json" || { echo "FAIL: manifest.json was not written to --out-dir (unrelated to console output)"; exit 1; }
echo "[PASS] default restore console output is the short summary only, with no raw manifest.json dump"

VERBOSE_OUT="$TMP/manifest-verbose"
VERBOSE_LOG=$(cb restore --in "$TMP/snap.age" --out-dir "$VERBOSE_OUT" --verbose)
printf '%s' "$VERBOSE_LOG" | grep -q '"schema"' \
  || { echo "FAIL: restore --verbose did not print the raw manifest.json dump"; printf '%s\n' "$VERBOSE_LOG"; exit 1; }
printf '%s' "$VERBOSE_LOG" | grep -q '^expanded 1 component(s) into' \
  || { echo "FAIL: restore --verbose lost the expanded-component summary"; printf '%s\n' "$VERBOSE_LOG"; exit 1; }
echo "[PASS] restore --verbose prints the raw manifest.json dump alongside the same summary"

echo "== #181 regression: colliding-basename --dir sources expand into SEPARATE, correctly-keyed directories =="
# The motivating repro from issue #181: multiple --dir sources sharing a basename (e.g.
# many claude-code project memory/ dirs) restore to opaque names (memory.tar.gz,
# memory-1.tar.gz, ...) that alone don't say which project is which. Two directories
# literally both named "memory" (different parents) reproduce this exactly.
COLLIDE_A="$TMP/collide-project-a/memory"; mkdir -p "$COLLIDE_A"
COLLIDE_B="$TMP/collide-project-b/memory"; mkdir -p "$COLLIDE_B"
printf 'alpha project memory content\n' > "$COLLIDE_A/note.txt"
printf 'beta project memory content\n' > "$COLLIDE_B/note.txt"
cb snapshot --dir "$COLLIDE_A" --dir "$COLLIDE_B" --out "$TMP/collide.age" >/dev/null
EXP_OUT="$TMP/collide-restore"
cb restore --in "$TMP/collide.age" --out-dir "$EXP_OUT" > "$TMP/collide-restore.log"
test -f "$EXP_OUT/memory.tar.gz" || { echo "FAIL: expected raw memory.tar.gz in --out-dir"; ls "$EXP_OUT"; exit 1; }
test -f "$EXP_OUT/memory-1.tar.gz" || { echo "FAIL: expected raw memory-1.tar.gz (colliding basename) in --out-dir"; ls "$EXP_OUT"; exit 1; }
test -f "$EXP_OUT/expanded/README.txt" || { echo "FAIL: expected expanded/README.txt"; exit 1; }
EXPANDED_DIR_COUNT=$(find "$EXP_OUT/expanded" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
[ "$EXPANDED_DIR_COUNT" = "2" ] || { echo "FAIL: expected 2 expanded component dirs, got $EXPANDED_DIR_COUNT"; ls "$EXP_OUT/expanded"; exit 1; }
grep -rq 'alpha project memory content' "$EXP_OUT/expanded" || { echo "FAIL: alpha content missing from expanded/"; exit 1; }
grep -rq 'beta project memory content' "$EXP_OUT/expanded" || { echo "FAIL: beta content missing from expanded/"; exit 1; }
ALPHA_DIR=$(dirname "$(grep -rl 'alpha project memory content' "$EXP_OUT/expanded" | head -1)")
BETA_DIR=$(dirname "$(grep -rl 'beta project memory content' "$EXP_OUT/expanded" | head -1)")
[ "$ALPHA_DIR" != "$BETA_DIR" ] || { echo "FAIL: alpha and beta content ended up in the SAME expanded dir"; exit 1; }
# #423: the component directory itself (one level up from the "memory" subdir tar -C'd
# into it — same shape noted above) must now be the SHORT "<NNN>-memory-<digest>" form,
# not the whole source path flattened+encoded -- and the two colliding-basename sources,
# despite sharing a label, must still land in DIFFERENT component directories. Assert
# the EXACT expected name (index + basename + src_digest of each source's own full
# path), not just the shape, so this also pins sourceDigest()'s actual role in keeping
# them apart, not just the numeric index (see shortSourceLabel's and sourceDigest's doc
# comments in src/lib/restore.ts).
ALPHA_COMPONENT_DIR=$(basename "$(dirname "$ALPHA_DIR")")
BETA_COMPONENT_DIR=$(basename "$(dirname "$BETA_DIR")")
EXPECTED_ALPHA_DIR="001-memory-$(src_digest "$COLLIDE_A")"
EXPECTED_BETA_DIR="002-memory-$(src_digest "$COLLIDE_B")"
[ "$ALPHA_COMPONENT_DIR" = "$EXPECTED_ALPHA_DIR" ] || { echo "FAIL: alpha component directory name is '$ALPHA_COMPONENT_DIR', expected '$EXPECTED_ALPHA_DIR'"; exit 1; }
[ "$BETA_COMPONENT_DIR" = "$EXPECTED_BETA_DIR" ] || { echo "FAIL: beta component directory name is '$BETA_COMPONENT_DIR', expected '$EXPECTED_BETA_DIR'"; exit 1; }
[ "$ALPHA_COMPONENT_DIR" != "$BETA_COMPONENT_DIR" ] || { echo "FAIL: alpha and beta component directories have the SAME short name despite sharing a basename"; exit 1; }
grep -q "collide-project-a" "$EXP_OUT/expanded/README.txt" || { echo "FAIL: README.txt does not reference collide-project-a's source path"; cat "$EXP_OUT/expanded/README.txt"; exit 1; }
grep -q "collide-project-b" "$EXP_OUT/expanded/README.txt" || { echo "FAIL: README.txt does not reference collide-project-b's source path"; cat "$EXP_OUT/expanded/README.txt"; exit 1; }
grep -q "expanded" "$TMP/collide-restore.log" || { echo "FAIL: restore's own stdout did not summarize the expand step"; cat "$TMP/collide-restore.log"; exit 1; }
echo "[PASS] two colliding-basename --dir sources restore into separate, short expanded/<NNN>-memory-<digest>/ dirs with the right content in each"

echo "== #181: --no-expand-components opts out, leaving only the raw *.tar.gz files =="
cb restore --in "$TMP/collide.age" --out-dir "$TMP/collide-noexpand" --no-expand-components >/dev/null
test ! -d "$TMP/collide-noexpand/expanded" || { echo "FAIL: --no-expand-components still created expanded/"; exit 1; }
test -f "$TMP/collide-noexpand/memory.tar.gz" && test -f "$TMP/collide-noexpand/memory-1.tar.gz" \
  || { echo "FAIL: --no-expand-components should still leave the raw component tarballs"; exit 1; }
echo "[PASS] --no-expand-components opts out of auto-expansion, leaving only the raw component tarballs"

echo "== #181: re-running restore into an out-dir with an existing expansion does not clobber it =="
SENTINEL_EXP="ALREADY-EXPANDED-DO-NOT-CLOBBER-$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$SENTINEL_EXP" > "$ALPHA_DIR/note.txt"
cb restore --in "$TMP/collide.age" --out-dir "$EXP_OUT" >/dev/null
[ "$(cat "$ALPHA_DIR/note.txt")" = "$SENTINEL_EXP" ] || { echo "FAIL: re-running restore into the same --out-dir clobbered a previously-expanded file"; exit 1; }
echo "[PASS] re-running restore into an out-dir with an existing expansion does not clobber it"

echo "== #527: a pre-existing UNRELATED (but valid) tar.gz at a component's on-disk name refuses the whole restore instead of silently expanding stale data =="
# Reproduces issue #527's exact repro: mkdir out-dir, drop a VALID-but-unrelated tar.gz
# at the exact on-disk name this snapshot's own component wants to use, THEN restore
# into that dir -- the freshly-decrypted bytes for that name must never be silently
# discarded (no-clobber) and then blindly expanded by the auto-expand step as if they
# were this restore's own data, with zero warning and exit 0. This is a REFUSE-the-
# whole-restore fix (findMergeCollisions() in src/lib/restore.ts), not a warn-and-
# continue one -- see restoreImpl's own comment for why.
STALE_SRC="$TMP/stale-src"; mkdir -p "$STALE_SRC"
printf 'this is the REAL snapshot content\n' > "$STALE_SRC/note.txt"
cb snapshot --dir "$STALE_SRC" --out "$TMP/stale.age" >/dev/null
STALE_COMPONENT_NAME="$(basename "$STALE_SRC").tar.gz"   # "stale-src.tar.gz"

UNRELATED_SRC="$TMP/unrelated-content"; mkdir -p "$UNRELATED_SRC"
printf 'totally different content, not from this snapshot at all\n' > "$UNRELATED_SRC/other.txt"

STALE_OUT="$TMP/stale-out"; mkdir -p "$STALE_OUT"
tar czf "$STALE_OUT/$STALE_COMPONENT_NAME" -C "$TMP" "$(basename "$UNRELATED_SRC")"
STALE_ARCHIVE_SHA_BEFORE=$(shasum -a 256 "$STALE_OUT/$STALE_COMPONENT_NAME" | cut -d' ' -f1)

set +e
STALE_ERR=$(cb restore --in "$TMP/stale.age" --out-dir "$STALE_OUT" 2>&1); STALE_RC=$?
set -e
[ "$STALE_RC" != "0" ] || { echo "FAIL: restore into an out-dir with a stale/unrelated same-named archive exited 0"; echo "$STALE_ERR"; exit 1; }
printf '%s' "$STALE_ERR" | grep -qF "$STALE_COMPONENT_NAME" || { echo "FAIL: refusal error does not name the colliding path"; echo "$STALE_ERR"; exit 1; }
test ! -d "$STALE_OUT/expanded" || { echo "FAIL: component auto-expand ran despite the refusal (would have expanded the WRONG data)"; exit 1; }
STALE_ARCHIVE_SHA_AFTER=$(shasum -a 256 "$STALE_OUT/$STALE_COMPONENT_NAME" | cut -d' ' -f1)
[ "$STALE_ARCHIVE_SHA_BEFORE" = "$STALE_ARCHIVE_SHA_AFTER" ] || { echo "FAIL: the pre-existing unrelated archive's bytes changed -- restore's no-clobber promise was violated"; exit 1; }
echo "[PASS] a pre-existing unrelated (but valid) same-named tar.gz refuses the whole restore instead of silently expanding stale data"

echo "== #527 related finding: a pre-existing GARBAGE (non-tar) file at that name also refuses the whole restore, with a non-zero exit code =="
GARBAGE_OUT="$TMP/garbage-out"; mkdir -p "$GARBAGE_OUT"
printf 'SENTINEL-NOT-A-TARBALL\n' > "$GARBAGE_OUT/$STALE_COMPONENT_NAME"
set +e
GARBAGE_ERR=$(cb restore --in "$TMP/stale.age" --out-dir "$GARBAGE_OUT" 2>&1); GARBAGE_RC=$?
set -e
[ "$GARBAGE_RC" != "0" ] || { echo "FAIL: restore into an out-dir with a garbage same-named file exited 0 (a scripted caller's \$? check could not detect the partial failure)"; echo "$GARBAGE_ERR"; exit 1; }
test ! -d "$GARBAGE_OUT/expanded" || { echo "FAIL: component auto-expand ran against garbage data despite the refusal"; exit 1; }
echo "[PASS] a pre-existing garbage (non-tar) file at a component's on-disk name also refuses the whole restore, non-zero exit"

echo "== #527: the normal happy path (empty --out-dir, no collisions) is unaffected =="
HAPPY_OUT="$TMP/stale-happy-out"
cb restore --in "$TMP/stale.age" --out-dir "$HAPPY_OUT" >/dev/null
diff -r "$STALE_SRC" "$HAPPY_OUT/expanded/001-$(basename "$STALE_SRC")-$(src_digest "$STALE_SRC")/$(basename "$STALE_SRC")" \
  || { echo "FAIL: happy-path restore into an empty --out-dir did not correctly expand"; exit 1; }
echo "[PASS] restoring into a fresh, empty --out-dir still works with no false-positive refusal"

echo "== #527: re-running restore into the SAME --out-dir twice (idempotent) must NOT start refusing =="
IDEMPOTENT_OUT="$TMP/stale-idempotent-out"
cb restore --in "$TMP/stale.age" --out-dir "$IDEMPOTENT_OUT" >/dev/null
set +e
IDEMPOTENT_ERR=$(cb restore --in "$TMP/stale.age" --out-dir "$IDEMPOTENT_OUT" 2>&1); IDEMPOTENT_RC=$?
set -e
[ "$IDEMPOTENT_RC" = "0" ] || { echo "FAIL: re-running restore into the SAME --out-dir with the SAME snapshot started refusing (should be a no-op idempotent re-run)"; echo "$IDEMPOTENT_ERR"; exit 1; }
echo "[PASS] re-running restore into the SAME --out-dir with the SAME snapshot does not trigger the new collision refusal"

echo "== #527 (multi-model review finding): --no-expand-components skips the new collision refusal too -- it means exactly the pre-#181 behavior it always has =="
# Codex review finding: the collision refusal above exists ONLY to prevent auto-expand
# from mis-attributing stale data -- with --no-expand-components, auto-expand never runs
# at all, so a stale collision here is just the plain, documented, general no-clobber
# case (same as manifest.json/db.dump) restore has always allowed. Without gating the
# check on this flag, --no-expand-components would stop meaning what its own help text
# promises (it would ALSO start refusing restores that used to succeed under it).
NOEXPAND_OUT="$TMP/stale-noexpand-out"; mkdir -p "$NOEXPAND_OUT"
tar czf "$NOEXPAND_OUT/$STALE_COMPONENT_NAME" -C "$TMP" "$(basename "$UNRELATED_SRC")"
NOEXPAND_SHA_BEFORE=$(shasum -a 256 "$NOEXPAND_OUT/$STALE_COMPONENT_NAME" | cut -d' ' -f1)
cb restore --in "$TMP/stale.age" --out-dir "$NOEXPAND_OUT" --no-expand-components >/dev/null
NOEXPAND_SHA_AFTER=$(shasum -a 256 "$NOEXPAND_OUT/$STALE_COMPONENT_NAME" | cut -d' ' -f1)
[ "$NOEXPAND_SHA_BEFORE" = "$NOEXPAND_SHA_AFTER" ] || { echo "FAIL: --no-expand-components' plain no-clobber promise was violated (the pre-existing archive's bytes changed)"; exit 1; }
test ! -d "$NOEXPAND_OUT/expanded" || { echo "FAIL: --no-expand-components still created expanded/"; exit 1; }
echo "[PASS] --no-expand-components still succeeds and keeps its plain no-clobber promise even with a stale/unrelated component-named file already present"

echo "== #527 related finding: a component archive that fails to expand for a NON-collision reason also makes the OVERALL restore exit non-zero =="
# Isolates the "Related finding" fix from the stale-collision fix above: a component
# archive that is corrupt from the moment it is decrypted (no pre-existing --out-dir, so
# findMergeCollisions() above never even runs) used to fail ONLY that component -- silently,
# with the whole restore still exiting 0, so a scripted caller checking $? alone could not
# tell. expandComponents() now reports this back to restoreImpl, which exits non-zero.
if ! command -v age >/dev/null 2>&1; then
  echo "[SKIP] non-collision partial-expand-failure test: no \`age\` binary on PATH (CI installs it; install age locally to exercise this)"
else
  CORRUPT_STAGE="$TMP/corrupt-stage"; mkdir -p "$CORRUPT_STAGE"
  printf 'SENTINEL-NOT-A-GZIP-EITHER\n' > "$CORRUPT_STAGE/corrupt.tar.gz"
  cat > "$CORRUPT_STAGE/manifest.json" <<MANIFEST
{
  "tool": "cypher-brain",
  "schema": 1,
  "host": "forged-test-fixture",
  "created_at": "2026-01-01T00:00:00.000Z",
  "content_digest": "0",
  "recipients_fingerprint": "0",
  "components": [
    { "name": "corrupt.tar.gz", "kind": "dir", "source": "/does/not/matter/corrupt", "content_digest": "0", "captured_at": "2026-01-01T00:00:00.000Z" }
  ]
}
MANIFEST
  ( cd "$CORRUPT_STAGE" && tar -cf - manifest.json corrupt.tar.gz ) | age -r "$(cat "$TMP/keys/recipient.txt")" -o "$TMP/corrupt.age"
  CORRUPT_OUT="$TMP/corrupt-out"   # fresh, empty --out-dir -- no collision possible
  set +e
  CORRUPT_ERR=$(cb restore --in "$TMP/corrupt.age" --out-dir "$CORRUPT_OUT" 2>&1); CORRUPT_RC=$?
  set -e
  [ "$CORRUPT_RC" != "0" ] || { echo "FAIL: restore with a corrupt (non-collision) component archive exited 0"; echo "$CORRUPT_ERR"; exit 1; }
  printf '%s' "$CORRUPT_ERR" | grep -qi "could not expand" || { echo "FAIL: no 'could not expand' warning for the corrupt component"; echo "$CORRUPT_ERR"; exit 1; }
  test -f "$CORRUPT_OUT/corrupt.tar.gz" || { echo "FAIL: the raw (corrupt) component archive should still be left in --out-dir as a fallback"; exit 1; }
  echo "[PASS] a component archive that fails to expand for a non-collision reason also makes the overall restore exit non-zero"
fi

echo "== #527 (multi-model review finding): a STALE pre-existing manifest.json must not drive auto-expand -- restore reads the manifest it JUST decrypted, not whatever's already in --out-dir =="
# Codex review finding on the first cut of this fix: expandComponents() used to re-read
# manifest.json back OFF DISK from --out-dir, AFTER the outer merge -- but a stale,
# unrelated manifest.json is exactly what the general no-clobber promise deliberately
# leaves untouched (same as the "#112 regression" test above). Restoring a SECOND,
# DIFFERENT snapshot into an out-dir that already holds a first snapshot's own manifest.json
# must still correctly auto-expand the second snapshot's own component -- keyed off the
# manifest THIS restore itself just decrypted, never a stale bystander already on disk.
MANIFEST_A_SRC="$TMP/manifest-a-src"; mkdir -p "$MANIFEST_A_SRC"
printf 'component A content\n' > "$MANIFEST_A_SRC/note.txt"
cb snapshot --dir "$MANIFEST_A_SRC" --out "$TMP/manifest-a.age" >/dev/null

MANIFEST_B_SRC="$TMP/manifest-b-src"; mkdir -p "$MANIFEST_B_SRC"
printf 'component B content\n' > "$MANIFEST_B_SRC/note.txt"
cb snapshot --dir "$MANIFEST_B_SRC" --out "$TMP/manifest-b.age" >/dev/null

STALE_MANIFEST_OUT="$TMP/stale-manifest-out"
cb restore --in "$TMP/manifest-a.age" --out-dir "$STALE_MANIFEST_OUT" >/dev/null
# out-dir now holds snapshot A's own manifest.json (+ its own component + expansion).
# Restoring snapshot B's own DIFFERENTLY-NAMED component (manifest-b-src.tar.gz) does NOT
# collide with anything findStaleComponentArchives() would refuse -- manifest.json itself
# DOES collide (A's vs B's content) and is correctly left untouched by the general
# no-clobber promise. The bug this test guards against: expandComponents() using THAT
# stale (A's) manifest to decide what to auto-expand, silently missing B's own freshly-
# restored component entirely despite it being written to disk correctly.
cb restore --in "$TMP/manifest-b.age" --out-dir "$STALE_MANIFEST_OUT" >/dev/null
test -f "$STALE_MANIFEST_OUT/manifest-b-src.tar.gz" || { echo "FAIL: snapshot B's own component archive was not written"; exit 1; }
diff -r "$MANIFEST_B_SRC" "$STALE_MANIFEST_OUT/expanded/001-$(basename "$MANIFEST_B_SRC")-$(src_digest "$MANIFEST_B_SRC")/$(basename "$MANIFEST_B_SRC")" \
  || { echo "FAIL: snapshot B's component was not auto-expanded -- expandComponents() likely used the STALE manifest.json from snapshot A instead of the freshly-decrypted one"; find "$STALE_MANIFEST_OUT/expanded" 2>&1; exit 1; }
echo "[PASS] restoring a second, different snapshot into an out-dir with a stale manifest.json still correctly auto-expands using the manifest THIS restore just decrypted"

echo "== #527 (multi-model review finding): a manifest that NAMES a component with no backing archive must not make a pre-existing same-named file look safe to expand =="
# Codex review finding: findStaleComponentArchives() originally skipped comparing a
# candidate component when scratchDir had no backing archive for it (only possible via a
# forged/mismatched manifest -- a legitimate manifest and its own archive are always
# written together by snapshot()). That let a pre-existing, VALID tar.gz already sitting in
# --out-dir survive the merge untouched and then be blindly expanded by expandComponents()
# under the forged manifest's own (attacker-chosen) source path -- the exact silent-wrong-
# data outcome #527 is about, reached via a different vector than the direct collision case.
if ! command -v age >/dev/null 2>&1; then
  echo "[SKIP] phantom-component hardening test: no \`age\` binary on PATH (CI installs it; install age locally to exercise this)"
else
  PHANTOM_LEFTOVER_SRC="$TMP/phantom-leftover-src"; mkdir -p "$PHANTOM_LEFTOVER_SRC"
  printf 'leftover unrelated content, a VALID tar.gz, already sitting in --out-dir\n' > "$PHANTOM_LEFTOVER_SRC/other.txt"
  PHANTOM_OUT="$TMP/phantom-out"; mkdir -p "$PHANTOM_OUT"
  tar czf "$PHANTOM_OUT/phantom.tar.gz" -C "$TMP" "$(basename "$PHANTOM_LEFTOVER_SRC")"
  PHANTOM_SHA_BEFORE=$(shasum -a 256 "$PHANTOM_OUT/phantom.tar.gz" | cut -d' ' -f1)

  PHANTOM_STAGE="$TMP/phantom-stage"; mkdir -p "$PHANTOM_STAGE"
  cat > "$PHANTOM_STAGE/manifest.json" <<MANIFEST
{
  "tool": "cypher-brain",
  "schema": 1,
  "host": "forged-test-fixture",
  "created_at": "2026-01-01T00:00:00.000Z",
  "content_digest": "0",
  "recipients_fingerprint": "0",
  "components": [
    { "name": "phantom.tar.gz", "kind": "dir", "source": "/attacker/chosen/path", "content_digest": "0", "captured_at": "2026-01-01T00:00:00.000Z" }
  ]
}
MANIFEST
  # NOTE: this bundle deliberately does NOT include a "phantom.tar.gz" file -- only
  # manifest.json itself -- simulating a manifest that names a component whose own archive
  # never actually landed in scratchDir.
  ( cd "$PHANTOM_STAGE" && tar -cf - manifest.json ) | age -r "$(cat "$TMP/keys/recipient.txt")" -o "$TMP/phantom.age"
  set +e
  PHANTOM_ERR=$(cb restore --in "$TMP/phantom.age" --out-dir "$PHANTOM_OUT" 2>&1); PHANTOM_RC=$?
  set -e
  [ "$PHANTOM_RC" != "0" ] || { echo "FAIL: restore into an out-dir with a pre-existing file at a PHANTOM component's name exited 0"; echo "$PHANTOM_ERR"; exit 1; }
  printf '%s' "$PHANTOM_ERR" | grep -qF "phantom.tar.gz" || { echo "FAIL: refusal error does not name the phantom-component collision"; echo "$PHANTOM_ERR"; exit 1; }
  test ! -d "$PHANTOM_OUT/expanded" || { echo "FAIL: component auto-expand ran despite the phantom-component refusal (would have expanded unrelated data under an attacker-chosen source label)"; exit 1; }
  PHANTOM_SHA_AFTER=$(shasum -a 256 "$PHANTOM_OUT/phantom.tar.gz" | cut -d' ' -f1)
  [ "$PHANTOM_SHA_BEFORE" = "$PHANTOM_SHA_AFTER" ] || { echo "FAIL: the pre-existing file at the phantom component's name was modified"; exit 1; }
  echo "[PASS] a manifest naming a component with no backing archive refuses to treat a pre-existing same-named file as safe to expand"
fi

echo "== #181 hardening: a forged manifest component 'name' containing a path separator is refused, not followed (path-traversal guard) =="
# age is public-key encryption -- anyone holding a recipient's PUBLIC key can construct
# ciphertext encrypted to it, so a crafted manifest.json inside otherwise-valid
# ciphertext is something restore must defend against. Simulate that by hand-building a
# forged plaintext bundle (manifest.json with a malicious component name, alongside one
# LEGITIMATE component) and encrypting it with the real `age` binary to this test's own
# recipient -- restore must refuse only the malicious component, warn about it clearly,
# still expand the legitimate sibling, and exit 0 (best-effort, not a hard failure).
if ! command -v age >/dev/null 2>&1; then
  echo "[SKIP] path-traversal hardening test: no \`age\` binary on PATH (CI installs it; install age locally to exercise this)"
else
  FORGE_STAGE="$TMP/forge-stage"; mkdir -p "$FORGE_STAGE"
  FORGE_LEGIT_SRC="$TMP/forge-legit-src"; mkdir -p "$FORGE_LEGIT_SRC"
  printf 'legit sibling component content\n' > "$FORGE_LEGIT_SRC/ok.txt"
  tar -czf "$FORGE_STAGE/legit.tar.gz" -C "$TMP" "forge-legit-src"
  cat > "$FORGE_STAGE/manifest.json" <<MANIFEST
{
  "tool": "cypher-brain",
  "schema": 1,
  "host": "forged-test-fixture",
  "created_at": "2026-01-01T00:00:00.000Z",
  "content_digest": "0",
  "recipients_fingerprint": "0",
  "components": [
    { "name": "legit.tar.gz", "kind": "dir", "source": "$FORGE_LEGIT_SRC", "content_digest": "0", "captured_at": "2026-01-01T00:00:00.000Z" },
    { "name": "../forge-traversal-marker.tar.gz", "kind": "dir", "source": "/does/not/matter", "content_digest": "0", "captured_at": "2026-01-01T00:00:00.000Z" }
  ]
}
MANIFEST
  ( cd "$FORGE_STAGE" && tar -cf - manifest.json legit.tar.gz ) | age -r "$(cat "$TMP/keys/recipient.txt")" -o "$TMP/forge.age"
  FORGE_OUT="$TMP/forge-restored"
  set +e
  FORGE_ERR=$(cb restore --in "$TMP/forge.age" --out-dir "$FORGE_OUT" 2>&1); FORGE_RC=$?
  set -e
  [ "$FORGE_RC" = "0" ] || { echo "FAIL: restore of the forged-but-otherwise-valid manifest exited non-zero (expected best-effort: skip only the malicious component)"; echo "$FORGE_ERR"; exit 1; }
  printf '%s' "$FORGE_ERR" | grep -qi "unsafe manifest name" || { echo "FAIL: no warning about the unsafe manifest component name"; echo "$FORGE_ERR"; exit 1; }
  test ! -e "$TMP/forge-traversal-marker.tar.gz" || { echo "FAIL: the forged component name resolved outside --out-dir and something was created there"; exit 1; }
  grep -rq 'legit sibling component content' "$FORGE_OUT/expanded" || { echo "FAIL: the legitimate sibling component in the same forged manifest did not still expand"; find "$FORGE_OUT"; exit 1; }
  echo "[PASS] a forged component name containing a path separator is refused (warned + skipped) without crashing restore, and a legitimate sibling component in the SAME manifest still expands"
fi

echo "== #225 hardening: a manifest.json declaring a NEWER schema than this build understands is refused, not silently misread =="
# Arweave's storage is meant to outlive any one build of this tool -- if manifest.json's
# shape ever changes in a way older restore code would misread, that older build must
# refuse outright (upgrade first) rather than guess. Simulate a "from-the-future"
# manifest by hand (same forged-plaintext-bundle technique as the #181 test above) and
# prove restore fails loudly, mentioning both the declared schema and "upgrade".
if ! command -v age >/dev/null 2>&1; then
  echo "[SKIP] manifest schema forward-compat test: no \`age\` binary on PATH (CI installs it; install age locally to exercise this)"
else
  FUTURE_STAGE="$TMP/future-schema-stage"; mkdir -p "$FUTURE_STAGE"
  cat > "$FUTURE_STAGE/manifest.json" <<MANIFEST
{
  "tool": "cypher-brain",
  "schema": 999,
  "host": "future-schema-test-fixture",
  "created_at": "2026-01-01T00:00:00.000Z",
  "content_digest": "0",
  "recipients_fingerprint": "0",
  "components": []
}
MANIFEST
  ( cd "$FUTURE_STAGE" && tar -cf - manifest.json ) | age -r "$(cat "$TMP/keys/recipient.txt")" -o "$TMP/future-schema.age"
  FUTURE_OUT="$TMP/future-schema-restored"
  set +e
  FUTURE_ERR=$(cb restore --in "$TMP/future-schema.age" --out-dir "$FUTURE_OUT" 2>&1); FUTURE_RC=$?
  set -e
  [ "$FUTURE_RC" != "0" ] || { echo "FAIL: restore of a manifest declaring schema 999 exited 0 (should refuse a schema newer than this build supports)"; echo "$FUTURE_ERR"; exit 1; }
  printf '%s' "$FUTURE_ERR" | grep -q "declares schema 999" || { echo "FAIL: error does not mention the declared future schema version"; echo "$FUTURE_ERR"; exit 1; }
  printf '%s' "$FUTURE_ERR" | grep -qi "upgrade cypher-brain" || { echo "FAIL: error does not tell the operator to upgrade"; echo "$FUTURE_ERR"; exit 1; }
  test ! -d "$FUTURE_OUT/expanded" || { echo "FAIL: component expansion ran despite the unsupported future schema"; exit 1; }
  echo "[PASS] a manifest declaring a schema newer than this build supports is refused with a clear upgrade message, before any component expansion runs"

  # A future format could change the FIELD'S TYPE, not just bump the number -- a guard
  # that only special-cases numbers-too-high would fail OPEN here (silently falling
  # through as if unversioned) instead of refusing. Prove a non-numeric schema is
  # refused too, not treated as legacy/absent.
  NONNUM_STAGE="$TMP/nonnum-schema-stage"; mkdir -p "$NONNUM_STAGE"
  cat > "$NONNUM_STAGE/manifest.json" <<MANIFEST
{
  "tool": "cypher-brain",
  "schema": "2",
  "host": "nonnumeric-schema-test-fixture",
  "created_at": "2026-01-01T00:00:00.000Z",
  "content_digest": "0",
  "recipients_fingerprint": "0",
  "components": []
}
MANIFEST
  ( cd "$NONNUM_STAGE" && tar -cf - manifest.json ) | age -r "$(cat "$TMP/keys/recipient.txt")" -o "$TMP/nonnum-schema.age"
  NONNUM_OUT="$TMP/nonnum-schema-restored"
  set +e
  NONNUM_ERR=$(cb restore --in "$TMP/nonnum-schema.age" --out-dir "$NONNUM_OUT" 2>&1); NONNUM_RC=$?
  set -e
  [ "$NONNUM_RC" != "0" ] || { echo "FAIL: restore of a manifest with a non-numeric schema (\"2\") exited 0 (should refuse, not treat it as legacy/absent)"; echo "$NONNUM_ERR"; exit 1; }
  printf '%s' "$NONNUM_ERR" | grep -qi "upgrade cypher-brain" || { echo "FAIL: error does not tell the operator to upgrade"; echo "$NONNUM_ERR"; exit 1; }
  test ! -d "$NONNUM_OUT/expanded" || { echo "FAIL: component expansion ran despite the non-numeric schema"; exit 1; }
  echo "[PASS] a manifest with a non-numeric schema value is refused (fails closed), not silently treated as an unversioned legacy manifest"
fi

echo "== #181 hardening: a pre-existing SYMLINK at the expanded component directory path is refused, never followed =="
# mkdirSync({recursive:true}) FOLLOWS an existing symlink rather than refusing it -- if
# an attacker (or a prior run) planted one at the predictable
# expanded/<NNN>-<basename>-<digest> path (#423: the directory name is now
# "<NNN>-<basename>-<digest>", see shortSourceLabel()/sourceDigest() in
# src/lib/restore.ts) before expandComponents() ever runs, extracting into it would
# land OUTSIDE --out-dir entirely. Pre-plant that symlink by hand and prove restore
# refuses to follow it: warns, leaves the symlink untouched, and writes nothing
# through it.
SYM_SRC="$TMP/symlink-guard-src"; mkdir -p "$SYM_SRC"
printf 'symlink guard test content\n' > "$SYM_SRC/note.txt"
cb snapshot --dir "$SYM_SRC" --out "$TMP/symguard.age" >/dev/null
SYM_OUT="$TMP/symguard-out"; mkdir -p "$SYM_OUT/expanded"
SYM_ESCAPE_TARGET="$TMP/symlink-escape-target"; mkdir -p "$SYM_ESCAPE_TARGET"
SYM_DIRNAME="001-$(basename "$SYM_SRC")-$(src_digest "$SYM_SRC")"
ln -s "$SYM_ESCAPE_TARGET" "$SYM_OUT/expanded/$SYM_DIRNAME"
set +e
SYM_ERR=$(cb restore --in "$TMP/symguard.age" --out-dir "$SYM_OUT" 2>&1); SYM_RC=$?
set -e
[ "$SYM_RC" = "0" ] || { echo "FAIL: restore into an out-dir with a pre-planted expanded-dir symlink exited non-zero"; echo "$SYM_ERR"; exit 1; }
printf '%s' "$SYM_ERR" | grep -qi "is a symlink" || { echo "FAIL: no symlink-refusal warning was printed"; echo "$SYM_ERR"; exit 1; }
printf '%s' "$SYM_ERR" | grep -qi "expanded component directory" || { echo "FAIL: the symlink warning does not identify the expanded component directory"; echo "$SYM_ERR"; exit 1; }
[ "$(readlink "$SYM_OUT/expanded/$SYM_DIRNAME")" = "$SYM_ESCAPE_TARGET" ] || { echo "FAIL: the pre-existing symlink was replaced or removed instead of being left alone"; exit 1; }
[ "$(find "$SYM_ESCAPE_TARGET" -mindepth 1 | wc -l | tr -d ' ')" = "0" ] || { echo "FAIL: something was written through the symlink into $SYM_ESCAPE_TARGET"; find "$SYM_ESCAPE_TARGET"; exit 1; }
echo "[PASS] a pre-existing symlink at the expanded component directory path is refused (warned + skipped), left untouched, with nothing written through it"

echo "== #181 hardening: a pre-existing SYMLINK at expanded/README.txt is refused; component expansion still happens =="
README_OUT="$TMP/symguard-readme-out"; mkdir -p "$README_OUT/expanded"
README_ESCAPE_TARGET="$TMP/symlink-escape-readme-target.txt"
printf 'DO-NOT-OVERWRITE\n' > "$README_ESCAPE_TARGET"
ln -s "$README_ESCAPE_TARGET" "$README_OUT/expanded/README.txt"
set +e
README_ERR=$(cb restore --in "$TMP/symguard.age" --out-dir "$README_OUT" 2>&1); README_RC=$?
set -e
[ "$README_RC" = "0" ] || { echo "FAIL: restore into an out-dir with a pre-planted README.txt symlink exited non-zero"; echo "$README_ERR"; exit 1; }
printf '%s' "$README_ERR" | grep -qi "is a symlink" || { echo "FAIL: no symlink-refusal warning was printed for README.txt"; echo "$README_ERR"; exit 1; }
printf '%s' "$README_ERR" | grep -qi "README.txt" || { echo "FAIL: the symlink warning does not mention README.txt"; echo "$README_ERR"; exit 1; }
[ "$(cat "$README_ESCAPE_TARGET")" = "DO-NOT-OVERWRITE" ] || { echo "FAIL: the external file the README.txt symlink pointed to was overwritten"; exit 1; }
grep -rq 'symlink guard test content' "$README_OUT/expanded" || { echo "FAIL: the component itself did not still expand despite the README.txt write being refused"; find "$README_OUT"; exit 1; }
echo "[PASS] a pre-existing symlink at expanded/README.txt is refused (write skipped, external target untouched), while the component itself still expands"

echo "== wrong key really cannot restore (defense in depth) =="
export CYPHER_BRAIN_HOME="$TMP/keys2"
cb keygen >/dev/null
set +e
WRONGKEY_ERR=$(cb restore --in "$TMP/snap.age" --out-dir "$TMP/out-wrong" 2>&1); WRONGKEY_RC=$?
set -e
if [ "$WRONGKEY_RC" = "0" ]; then echo "FAIL: restored with a different identity"; exit 1; fi
echo "[PASS] a different identity cannot restore"
echo "== issue #212: a wrong-identity restore carries the CB-E002 error code =="
printf '%s' "$WRONGKEY_ERR" | grep -q '\[CB-E002\]' || { echo "FAIL: wrong-identity restore error lacks the CB-E002 code"; echo "$WRONGKEY_ERR"; exit 1; }
echo "[PASS] wrong-identity restore error carries [CB-E002]"

echo "== P1 regression: a failed snapshot must not leave staged plaintext =="
# a recipient file with garbage makes the encrypter setup fail (typage rejects the
# line up front, before any plaintext is staged). The run must (a) fail cleanly and
# (b) leave no staged plaintext and no partial output behind.
export TMPDIR="$TMP/stagedir"; mkdir -p "$TMPDIR"
printf 'not-a-valid-age-recipient\n' > "$TMP/bad-recipient.txt"
if cb snapshot --dir "$SRC" --recipient "$TMP/bad-recipient.txt" --out "$TMP/bad.age" 2>/dev/null; then
  echo "FAIL: snapshot with a bad recipient unexpectedly succeeded"; exit 1
fi
LEFTOVERS=$(find "$TMPDIR" -maxdepth 1 -name 'cypher-brain-*' -type d 2>/dev/null | wc -l | tr -d ' ')
if [ "$LEFTOVERS" != "0" ]; then
  echo "FAIL: $LEFTOVERS staged plaintext dir(s) left behind after a failed snapshot"; exit 1
fi
# atomic output: a failed snapshot must leave NEITHER a truncated *.age NOR its (now
# per-run-randomized "<out>.<pid>.<hex>.part") partial — glob, not the old fixed name.
npart() { find "$1" -maxdepth 1 -name "$(basename "$2").*.part" 2>/dev/null | wc -l | tr -d ' '; }
test ! -f "$TMP/bad.age" || { echo "FAIL: failed snapshot left a (truncated) bad.age"; exit 1; }
[ "$(npart "$TMP" "$TMP/bad.age")" = "0" ] || { echo "FAIL: failed snapshot left a bad.age .part"; exit 1; }
echo "[PASS] failed snapshot exited cleanly and left no staged plaintext / no partial *.age"
# a SUCCESSFUL snapshot promotes the .part and leaves none behind
test -f "$TMP/snap.age" && [ "$(npart "$TMP" "$TMP/snap.age")" = "0" ] \
  && echo "[PASS] successful snapshot left no .part (atomic promote)" || { echo "FAIL: snap.age .part lingered"; exit 1; }

echo "== P1 regression: a recipients file with only comments/blank lines must refuse to snapshot =="
# Such a file flattens to ZERO recipients. typage would happily encrypt to an EMPTY
# stanza list — valid-looking ciphertext NO identity can ever decrypt (the old external
# `age -R` errored here). snapshot must fail fast with a clear stderr error and leave
# no output / .part behind.
printf '# rotated out, keys to follow\n\n# (none yet)\n' > "$TMP/comments-only-recipient.txt"
set +e
ERR=$(cb snapshot --dir "$SRC" --recipient "$TMP/comments-only-recipient.txt" --out "$TMP/norecip.age" 2>&1 >/dev/null); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] snapshot with a zero-recipient file exited 0"; exit 1; }
printf '%s' "$ERR" | grep -q "NO identity can ever decrypt" \
  || { echo "[FAIL] empty-recipient refusal lacks a clear stderr error"; echo "$ERR"; exit 1; }
test ! -f "$TMP/norecip.age" || { echo "[FAIL] refused snapshot still created norecip.age"; exit 1; }
[ "$(npart "$TMP" "$TMP/norecip.age")" = "0" ] || { echo "[FAIL] refused snapshot left a norecip.age .part"; exit 1; }
echo "[PASS] snapshot refused a recipients file that resolves to zero entries (nothing written)"

echo "== restore of a corrupt artifact fails and removes the tree it created =="
# Drop the LAST bytes of a valid snapshot (snap.age holds a 1 MB blob => multiple age
# STREAM chunks): the leading chunks still decrypt and tar extracts a PARTIAL tree, then
# age fails on the broken final chunk. Use the ORIGINAL keypair ($TMP/keys) so the
# failure is the truncation, not a wrong key (CYPHER_BRAIN_HOME is $TMP/keys2 here).
SNAPSZ=$(wc -c < "$TMP/snap.age" | tr -d ' ')
head -c $((SNAPSZ - 500)) "$TMP/snap.age" > "$TMP/trunc.age"
RDIR="$TMP/restore-corrupt"   # does NOT pre-exist -> restore creates it -> must remove it on failure
set +e
CYPHER_BRAIN_HOME="$TMP/keys" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$TMP/trunc.age" --out-dir "$RDIR" >/dev/null 2>&1; RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: restore of a truncated artifact unexpectedly succeeded"; exit 1; fi
test ! -e "$RDIR" || { echo "FAIL: restore left a partial tree at $RDIR"; exit 1; }
echo "[PASS] restore of a corrupt artifact failed and removed the partial tree"

echo "== tar dying mid-stream must fail the snapshot (no valid-looking truncated .age) =="
# With in-process encryption (typage), a tar that dies after emitting some bytes just
# EOFs its stdout — which the encrypter would happily finalize into VALID ciphertext
# of a TRUNCATED archive. encryptToFile gates success on tar's exit code; prove it.
# The stub tar intercepts ONLY the snapshot pipeline invocation (`tar -cf - …`) and
# dispatches on TAR_STUB_MODE; every other tar call passes through to the real tar.
REALTAR="$(command -v tar)"
STUBBIN="$TMP/stubbin"; mkdir -p "$STUBBIN"
cat > "$STUBBIN/tar" <<EOF
#!/usr/bin/env bash
# block-* modes announce that a named snapshot phase has been REACHED and then park there,
# so the SIGINT test far below can pin its signal to that exact phase instead of racing a
# poll loop (see the P1 regression block). Every other invocation falls through to the real
# tar, so these modes are invisible to the cases above. `exec sleep` rather than a bare
# `sleep`: the guard SIGKILLs the process it spawned, which is THIS shell — a bare sleep
# would be a grandchild and survive it, leaving a stray process per phase (measured).
case "\${TAR_STUB_MODE:-}" in
  block-staging-tar)                                 # per-component "tar -czf <stage>/x.tar.gz"
    if [ "\$1" = "-czf" ]; then printf 'reached\n' > "\$CB_PHASE_SENTINEL"; exec sleep 30; fi ;;
  block-pipeline-tar)                                # the streaming "tar -cf - -C <stage> ."
    if [ "\$1" = "-cf" ] && [ "\$2" = "-" ]; then printf 'reached\n' > "\$CB_PHASE_SENTINEL"; exec sleep 30; fi ;;
esac
if [ "\$1" = "-cf" ] && [ "\$2" = "-" ]; then
  case "\${TAR_STUB_MODE:-}" in
    slow)  sleep "\${TAR_STUB_SLEEP:-3}" ;;          # hold the pipeline open, then behave
    fail)  printf 'partial-tar-bytes'; exit 1 ;;      # die mid-stream after emitting bytes
    wedge) exec node "$TMP/tar-ignore-term.mjs" ;;    # ignore SIGTERM and hang (timeout test)
  esac
fi
exec "$REALTAR" "\$@"
EOF
chmod +x "$STUBBIN/tar"
set +e
OUT=$(PATH="$STUBBIN:$PATH" TAR_STUB_MODE=fail node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/midfail.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "FAIL: snapshot with a mid-stream tar death exited 0"; exit 1; }
test ! -f "$TMP/midfail.age" || { echo "FAIL: mid-stream tar death left a truncated midfail.age"; exit 1; }
[ "$(npart "$TMP" "$TMP/midfail.age")" = "0" ] || { echo "FAIL: mid-stream tar death left a .part"; exit 1; }
LEFTOVERS=$(find "$TMPDIR" -maxdepth 1 -name 'cypher-brain-*' -type d 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFTOVERS" = "0" ] || { echo "FAIL: mid-stream tar death left staged plaintext"; exit 1; }
echo "[PASS] a tar that dies mid-stream fails the snapshot and leaves nothing behind"

echo "== P1 regression: SIGINT mid-snapshot must not leave staged plaintext =="
# A signal tears the process down WITHOUT running the finally-blocks, so this is the gap
# the failure cases above do NOT cover. Every temp directory a snapshot creates has to be
# registered with the signal guard BEFORE it can exist unobserved on disk, and deregistered
# only AFTER it is gone; a gap at either end leaks a directory the finally would have taken.
#
# The signal is pinned to a NAMED phase, which is what makes this deterministic. The earlier
# version polled for the stage dir and fired the instant it appeared, so the phase the signal
# landed in was chosen by machine speed rather than by the test — it was written to hold the
# run open in the streaming tar, but the poll returns long before the run gets there. Sampling
# a different phase per machine is how the gitleaks scan's own report dir — cypher-brain-*,
# so the leftover glob below counts it — stayed unexamined until the day the signal landed in
# a window where it was not yet tracked and one CI cell went red. Each stub announces that its
# phase has been reached and then parks, so the signal lands inside that phase every run.
#
# What this canNOT reach, so nobody reads a pass here as proof of it: the two registration
# gaps that caused that red cell both sit between a completed filesystem syscall and the JS
# continuation that records it. A stub cannot announce from inside them — it only runs once
# registration has already happened — so reverting the secrets-scan.ts ordering leaves this
# block green. Only an async signal observes those windows, and pinning one there needs a
# lifecycle hook in production code, which is not worth shipping to be able to test it. The
# guarantee there is structural (create+register in one tick, rm before clear), not asserted.
export TMPDIR="$TMP/stagedir-sig"; mkdir -p "$TMPDIR"

# gitleaks stand-in for the scan phase: announce, then park. Pinning the scan needs a
# scanner that will not finish on its own, and pointing CYPHER_BRAIN_GITLEAKS_BIN at this
# also makes the case run identically on a machine with no real gitleaks installed.
# Announce ONLY for the real scan invocation ("gitleaks dir <path>"), never for a probe:
# today's availability check is a `command -v` that does not execute this at all, but a
# probe that DID run it would otherwise fire the sentinel before the report dir exists and
# the test would signal the wrong phase while still reporting a pass.
cat > "$STUBBIN/gitleaks-block" <<'EOF'
#!/usr/bin/env bash
if [ "$1" != "dir" ]; then exit 0; fi
printf 'reached\n' > "$CB_PHASE_SENTINEL"
exec sleep 30
EOF
chmod +x "$STUBBIN/gitleaks-block"

# Park a snapshot in $1, SIGINT it there, and assert the guard erased everything it owned.
sigint_at_phase() {
  local phase="$1"
  local phase_tmp="$TMPDIR/$phase"; mkdir -p "$phase_tmp"
  local sentinel="$TMP/sig-$phase.sentinel"; rm -f "$sentinel"
  local out="$TMP/sig-$phase.age"
  # Invoke `node` DIRECTLY (not the cb() function): backgrounding a shell function makes $!
  # the subshell's pid, so `kill -INT $!` would hit the subshell and leave node orphaned to
  # run to completion — the signal would never reach the handler under test.
  case "$phase" in
    staging-tar)   PATH="$STUBBIN:$PATH" TMPDIR="$phase_tmp" CB_PHASE_SENTINEL="$sentinel" TAR_STUB_MODE=block-staging-tar \
                     node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$out" >/dev/null 2>&1 & ;;
    scan)          PATH="$STUBBIN:$PATH" TMPDIR="$phase_tmp" CB_PHASE_SENTINEL="$sentinel" CYPHER_BRAIN_GITLEAKS_BIN="$STUBBIN/gitleaks-block" \
                     node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$out" >/dev/null 2>&1 & ;;
    pipeline-tar)  PATH="$STUBBIN:$PATH" TMPDIR="$phase_tmp" CB_PHASE_SENTINEL="$sentinel" TAR_STUB_MODE=block-pipeline-tar \
                     node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$out" >/dev/null 2>&1 & ;;
    *) echo "FAIL: unknown phase '$phase' (test bug)"; exit 1 ;;
  esac
  local pid=$!
  # Wait for the phase to be REACHED, never for a fixed duration. A timeout here is BLOCKED,
  # not a pass: the assertions below would be vacuous if the signal never landed in-phase.
  local waited=0
  while [ ! -s "$sentinel" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "FAIL: snapshot exited before reaching phase '$phase' — the assertions below never ran"; exit 1
    fi
    sleep 0.1; waited=$((waited + 1))
    if [ "$waited" -ge 300 ]; then
      echo "FAIL: phase '$phase' not reached within 30s — BLOCKED, refusing to report a pass"
      kill "$pid" 2>/dev/null || true; exit 1
    fi
  done
  # Not `|| true`: a kill that cannot land means the run under test is already gone, so the
  # assertions below would be checking a process that never got signalled. Say that out loud
  # rather than dying bare under `set -e`.
  kill -INT "$pid" || { echo "FAIL: could not SIGINT the snapshot parked in '$phase' — it exited early"; exit 1; }
  # Require death BY SIGINT (128+2), never just "exited non-zero". Without this the whole
  # block degrades into a false PASS: if the signal were ignored, the parked stub would
  # eventually exit on its own, the snapshot would fail through its ORDINARY error path,
  # its finally-blocks would tidy everything up, and all three assertions below would pass
  # while having tested none of the signal handling they exist for.
  set +e; wait "$pid"; local rc=$?; set -e
  [ "$rc" = "130" ] || { echo "FAIL: snapshot in '$phase' exited $rc, expected 130 (SIGINT) — the handler under test never ran"; exit 1; }
  # Name what survived: the prefix says WHICH tracked resource leaked (the plaintext stage,
  # the gitleaks report dir, a verify scratch dir), which a bare count cannot.
  local leftovers
  leftovers=$(find "$phase_tmp" -maxdepth 1 -name 'cypher-brain-*' -type d 2>/dev/null)
  if [ -n "$leftovers" ]; then
    echo "FAIL: SIGINT during '$phase' left staged temp dir(s) behind:"
    printf '%s\n' "$leftovers" | sed 's/^/  /'
    exit 1
  fi
  # the signal handler also kills the pipeline children, so no partial ciphertext lingers
  [ "$(npart "$TMP" "$out")" = "0" ] || { echo "FAIL: SIGINT during '$phase' left a $(basename "$out") .part (child not killed)"; exit 1; }
  test ! -f "$out" || { echo "FAIL: SIGINT during '$phase' left a partial $(basename "$out")"; exit 1; }
  echo "[PASS] SIGINT during '$phase' left no staged plaintext / no partial ciphertext"
}

# The three phases that hold a tracked temp dir open, earliest to latest: the stage dir
# alone; the stage dir plus the fully-extracted plaintext AND the scan's report dir; the
# stage dir plus the .part being streamed into.
sigint_at_phase staging-tar
sigint_at_phase scan
sigint_at_phase pipeline-tar

echo "== race: an --out that appears mid-snapshot is NOT clobbered (link promote is exclusive) =="
# Start a slow snapshot (passes the early exists() check while --out is absent), then
# create --out externally before it promotes. link()+EEXIST must refuse, preserving the
# external file — a plain rename would have clobbered it.
RACE="$TMP/race-out.age"
PATH="$STUBBIN:$PATH" TAR_STUB_MODE=slow TAR_STUB_SLEEP=3 node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$RACE" >/dev/null 2>&1 &
RACE_PID=$!
# APPEARED flag (same pattern as selftest-ton.sh's READY / selftest-verify-levels.sh's
# APPEARED / selftest-gbrain-pglite.sh's post-loop grep, #573): without this, a silently
# exhausted loop (slow CI, or a staging-dir naming regression) would let the script
# proceed anyway, and the RC/content checks below could still report PASS via the CLI's
# earlier upfront exists() refusal rather than the late link()+EEXIST exclusive-promote
# path this test is actually meant to exercise.
APPEARED=0
for _ in $(seq 1 50); do find "$TMPDIR" -maxdepth 1 -name 'cypher-brain-*' -type d 2>/dev/null | grep -q . && { APPEARED=1; break; }; sleep 0.1; done
if [ "$APPEARED" != "1" ]; then
  echo "FAIL: staging dir never appeared — the race window was never set up, so the link()+EEXIST path was not exercised"
  kill "$RACE_PID" 2>/dev/null || true
  wait "$RACE_PID" 2>/dev/null || true
  exit 1
fi
printf 'PRE-EXISTING-WINNER\n' > "$RACE"   # a "concurrent run" finished first
set +e
wait "$RACE_PID"; RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: snapshot clobbered an --out that appeared mid-run"; exit 1; fi
[ "$(cat "$RACE")" = "PRE-EXISTING-WINNER" ] || { echo "FAIL: the pre-existing --out was overwritten"; exit 1; }
LEFTPART=$(find "$(dirname "$RACE")" -maxdepth 1 -name "$(basename "$RACE").*.part" 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFTPART" = "0" ] || { echo "FAIL: a .part lingered after the refused promote"; exit 1; }
echo "[PASS] a mid-run --out is not clobbered and no .part lingers"

echo "== verify on a public-key-only box is PARTIAL (exit 2), never a false-green PASS =="
# A box with only recipient.txt (no identity) cannot prove decryptability. verify
# must say PARTIAL and exit 2 so cron/logs don't read it as a full PASS.
PUBONLY="$TMP/pubonly"; mkdir -p "$PUBONLY"
cp "$TMP/keys/recipient.txt" "$PUBONLY/recipient.txt"   # public key only — deliberately NO identity.age
set +e
OUT=$(CYPHER_BRAIN_HOME="$PUBONLY" node "${BIN_DEV_ARGS[@]}" "$BIN" verify --in "$TMP/snap.age" 2>&1); RC=$?
set -e
if [ "$RC" != "2" ]; then echo "FAIL: public-key-only verify exited $RC, expected 2"; echo "$OUT"; exit 1; fi
if ! printf '%s' "$OUT" | grep -q "VERDICT: PARTIAL"; then echo "FAIL: expected VERDICT: PARTIAL"; echo "$OUT"; exit 1; fi
if printf '%s' "$OUT" | grep -q "VERDICT: PASS"; then echo "FAIL: public-key-only verify falsely printed PASS"; exit 1; fi
echo "[PASS] public-key-only verify is PARTIAL/exit 2"

set +e
JOUT_PARTIAL=$(CYPHER_BRAIN_HOME="$PUBONLY" node "${BIN_DEV_ARGS[@]}" "$BIN" verify --in "$TMP/snap.age" --json); RC=$?
set -e
[ "$RC" = "2" ] || { echo "FAIL: public-key-only verify --json exited $RC, expected 2"; echo "$JOUT_PARTIAL"; exit 1; }
node -e "
const j = JSON.parse(process.argv[1]);
if (j.verdict !== 'PARTIAL') throw new Error('expected verdict PARTIAL, got ' + j.verdict);
if (j.exit_code !== 2) throw new Error('expected exit_code 2, got ' + j.exit_code);
if (j.checks.positive_control !== 'skip') throw new Error('expected checks.positive_control skip, got ' + j.checks.positive_control);
" "$JOUT_PARTIAL"
echo "[PASS] public-key-only verify --json: verdict PARTIAL / exit_code 2 / positive_control skip (never a false-green PASS)"

echo "== recipient pin: snapshot refuses an out-of-allowlist recipient =="
PINHOME="$TMP/keys"   # the original keypair from the top of this test
MYPUB=$(cat "$PINHOME/recipient.txt")
# (a) matching allowlist -> snapshot succeeds
CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_PIN_RECIPIENTS="$MYPUB" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/pin-ok.age" >/dev/null
echo "[PASS] snapshot allowed when the recipient is on the allowlist"
# (b) a DIFFERENT key's pin -> snapshot must refuse (the injected-recipient case)
OTHER="$TMP/other-key"; mkdir -p "$OTHER"
CYPHER_BRAIN_HOME="$OTHER" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
OTHERPUB=$(cat "$OTHER/recipient.txt")
set +e
PINBAD_ERR=$(CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_PIN_RECIPIENTS="$OTHERPUB" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/pin-bad.age" 2>&1 >/dev/null); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: snapshot encrypted to a non-allowlisted recipient"; exit 1; fi
test ! -f "$TMP/pin-bad.age"
echo "[PASS] snapshot refused a recipient not on the allowlist"
echo "== issue #212: a recipient-pin refusal carries the CB-E005 error code =="
printf '%s' "$PINBAD_ERR" | grep -q '\[CB-E005\]' || { echo "FAIL: recipient-pin refusal lacks the CB-E005 code"; echo "$PINBAD_ERR"; exit 1; }
echo "[PASS] recipient-pin refusal error carries [CB-E005]"
# (c) a recipients FILE that keeps the allowed age key but ALSO adds an ssh recipient
# (age -R accepts ssh-ed25519) must be refused — an age1-only scan would miss it.
SSHMIX="$TMP/recipient-ssh-mix.txt"
printf '%s\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIINJECTEDATTACKERKEYxxxxxxxxxxxxxxxxxxxxxx attacker\n' "$MYPUB" > "$SSHMIX"
set +e
CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_PIN_RECIPIENTS="$MYPUB" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --recipient "$SSHMIX" --out "$TMP/pin-ssh.age" >/dev/null 2>&1; RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: pin let through a file with an injected ssh recipient"; exit 1; fi
test ! -f "$TMP/pin-ssh.age"
echo "[PASS] snapshot refused a recipient file with an injected ssh recipient"
# (d) a FILE allowlist whose path contains "age1" must be read as a file, not parsed
# as an inline key (regression for the includes('age1') path-detection bug).
PINFILE="$TMP/age1-pins.txt"; printf '%s\n' "$MYPUB" > "$PINFILE"
CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_PIN_RECIPIENTS="$PINFILE" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/pin-file.age" >/dev/null
test -f "$TMP/pin-file.age"
echo "[PASS] snapshot honored a file-based allowlist whose path contains 'age1'"
# (e) a key present only in a COMMENT line of the allowlist file is NOT allowed
# (e.g. a rotated/revoked key left commented out must not silently pass the pin).
PINCOMMENT="$TMP/pins-with-comment.txt"
printf '%s\n# rotated-out: %s\n' "$MYPUB" "$OTHERPUB" > "$PINCOMMENT"
set +e
CYPHER_BRAIN_HOME="$OTHER" CYPHER_BRAIN_PIN_RECIPIENTS="$PINCOMMENT" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --recipient "$OTHER/recipient.txt" --out "$TMP/pin-comment.age" >/dev/null 2>&1; RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: pin allowed a key that was only in a comment line"; exit 1; fi
test ! -f "$TMP/pin-comment.age"
echo "[PASS] snapshot refused a recipient whose key was only commented-out in the allowlist"
# (f) #101: an explicitly EMPTY CYPHER_BRAIN_PIN_RECIPIENTS="" (e.g. a broken
# cron/systemd template expansion) must fail CLOSED, not be silently treated the
# same as an unset var (which would disable the allowlist entirely — fail-open).
set +e
CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_PIN_RECIPIENTS="" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/pin-empty.age" >"$TMP/pin-empty.log" 2>&1; RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: snapshot succeeded with CYPHER_BRAIN_PIN_RECIPIENTS=\"\" (fail-open regression)"; cat "$TMP/pin-empty.log"; exit 1; fi
test ! -f "$TMP/pin-empty.age"
grep -q "CYPHER_BRAIN_PIN_RECIPIENTS is set but empty" "$TMP/pin-empty.log" || { echo "FAIL: expected the fail-closed empty-pin error message"; cat "$TMP/pin-empty.log"; exit 1; }
echo "[PASS] snapshot fails closed when CYPHER_BRAIN_PIN_RECIPIENTS is explicitly empty"

echo "== push arweave/turbo --yes guard: requires explicit opt-in before a paid permanent store =="
# #160: push now computes + prints the cost estimate BEFORE the --yes/CYPHER_BRAIN_YES
# gate (previously the gate fired first, and the estimate only ran INSIDE backend.put(),
# i.e. only after consent was already given). That estimate is a real, unauthenticated
# price query (arweave: GET <gateway>/price/<bytes>; turbo: the SDK's pricing call) —
# no longer "no external deps" for the arweave case, so point it at a closed local port
# (connection refused, near-instant) rather than the real network. arweave's redirect
# below (AR_OFFLINE) makes ITS query fully offline/deterministic; turbo has no such
# override (the SDK's pricing endpoint isn't configurable) — its query only fires at all
# when `@ardrive/turbo-sdk` happens to be installed (an optional peerDependency, absent
# in this repo's own devDependencies), same conditional-network precedent cli-smoke.sh's
# `estimate --backend turbo` test already relies on (its "(sdk installed)" vs
# "(dependency not installed)" branches). Either way, the wallet/SDK signing path is
# still never reached without --yes (put() is never called), so the gate itself remains
# a no-signing, no-spend check.
AR_OFFLINE=(CYPHER_BRAIN_AR_HOST=127.0.0.1 CYPHER_BRAIN_AR_PORT=1 CYPHER_BRAIN_AR_PROTOCOL=http)
set +e
OUT_AR=$(env "${AR_OFFLINE[@]}" node "${BIN_DEV_ARGS[@]}" "$BIN" push --in "$TMP/snap.age" --backend arweave 2>&1); RC_AR=$?
OUT_TU=$(env "${AR_OFFLINE[@]}" node "${BIN_DEV_ARGS[@]}" "$BIN" push --in "$TMP/snap.age" --backend turbo  2>&1); RC_TU=$?
set -e
[ "$RC_AR" != "0" ] || { echo "[FAIL] push arweave without --yes exited 0"; exit 1; }
[ "$RC_TU" != "0" ] || { echo "[FAIL] push turbo without --yes exited 0"; exit 1; }
printf '%s' "$OUT_AR" | grep -qi "CYPHER_BRAIN_YES\|--yes" \
  || { echo "[FAIL] push arweave error lacks --yes guidance"; echo "$OUT_AR"; exit 1; }
printf '%s' "$OUT_TU" | grep -qi "CYPHER_BRAIN_YES\|--yes" \
  || { echo "[FAIL] push turbo error lacks --yes guidance"; echo "$OUT_TU"; exit 1; }
echo "[PASS] push arweave/turbo without --yes fails with clear guidance"
echo "== issue #212: the --yes consent-gate refusal carries the CB-E007 error code =="
printf '%s' "$OUT_AR" | grep -q '\[CB-E007\]' || { echo "[FAIL] push arweave --yes-gate error lacks the CB-E007 code"; echo "$OUT_AR"; exit 1; }
printf '%s' "$OUT_TU" | grep -q '\[CB-E007\]' || { echo "[FAIL] push turbo --yes-gate error lacks the CB-E007 code"; echo "$OUT_TU"; exit 1; }
echo "[PASS] push arweave/turbo --yes-gate error carries [CB-E007]"
# #160 regression: the cost estimate must appear BEFORE the --yes consent-gate error in
# the SAME output — not just present somewhere, but ahead of it (line-order check).
EST_LINE_AR=$(printf '%s\n' "$OUT_AR" | grep -n -i "cost estimate" | head -1 | cut -d: -f1)
YES_LINE_AR=$(printf '%s\n' "$OUT_AR" | grep -n -i "re-run push with --yes" | head -1 | cut -d: -f1)
[ -n "$EST_LINE_AR" ] || { echo "[FAIL] push arweave (no --yes) printed no cost estimate"; echo "$OUT_AR"; exit 1; }
[ -n "$YES_LINE_AR" ] || { echo "[FAIL] push arweave (no --yes) printed no --yes consent error"; echo "$OUT_AR"; exit 1; }
[ "$EST_LINE_AR" -lt "$YES_LINE_AR" ] \
  || { echo "[FAIL] push arweave printed the --yes consent gate before the cost estimate (#160 regression)"; echo "$OUT_AR"; exit 1; }
EST_LINE_TU=$(printf '%s\n' "$OUT_TU" | grep -n -i "cost estimate" | head -1 | cut -d: -f1)
YES_LINE_TU=$(printf '%s\n' "$OUT_TU" | grep -n -i "re-run push with --yes" | head -1 | cut -d: -f1)
[ -n "$EST_LINE_TU" ] || { echo "[FAIL] push turbo (no --yes) printed no cost estimate"; echo "$OUT_TU"; exit 1; }
[ -n "$YES_LINE_TU" ] || { echo "[FAIL] push turbo (no --yes) printed no --yes consent error"; echo "$OUT_TU"; exit 1; }
[ "$EST_LINE_TU" -lt "$YES_LINE_TU" ] \
  || { echo "[FAIL] push turbo printed the --yes consent gate before the cost estimate (#160 regression)"; echo "$OUT_TU"; exit 1; }
echo "[PASS] push arweave/turbo prints the cost estimate BEFORE asking for --yes consent (#160)"
# With CYPHER_BRAIN_YES=1 the --yes guard passes; the error moves further in
# (wallet / SDK missing), which proves the guard no longer blocks.
set +e
OUT2=$(env "${AR_OFFLINE[@]}" CYPHER_BRAIN_YES=1 node "${BIN_DEV_ARGS[@]}" "$BIN" push --in "$TMP/snap.age" --backend arweave 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] arweave push should fail (no wallet in test env)"; exit 1; }
printf '%s' "$OUT2" | grep -qi "CYPHER_BRAIN_YES\|--yes" \
  && { echo "[FAIL] CYPHER_BRAIN_YES=1 still hitting the --yes gate"; echo "$OUT2"; exit 1; } || true
echo "[PASS] push arweave with CYPHER_BRAIN_YES=1 passes the --yes guard (fails further in: wallet/SDK)"

echo "== issue #211: estimate --json prints the SAME CostEstimate object as one JSON line, human output unchanged =="
# Capture the full output first (command substitution reads to EOF) rather than
# piping the live process into `grep -q`, which can close its end of the pipe the
# instant it matches an early line — EPIPE-killing the still-writing producer (none
# of estimate's lines is guarded the way printMascot's stderr writes are, see ui.ts).
EOUT=$(cb estimate --in "$TMP/snap.age" --backend file)
printf '%s\n' "$EOUT" | grep -q "^backend: file$" \
  || { echo "[FAIL] estimate --backend file human output regressed"; echo "$EOUT"; exit 1; }
EXPECT_SIZE=$(stat -f%z "$TMP/snap.age" 2>/dev/null || stat -c%s "$TMP/snap.age")
EJOUT=$(cb estimate --in "$TMP/snap.age" --backend file --json)
LINES=$(printf '%s\n' "$EJOUT" | wc -l | tr -d ' ')
[ "$LINES" = "1" ] || { echo "FAIL: estimate --json printed $LINES stdout line(s), expected exactly 1"; echo "$EJOUT"; exit 1; }
node -e "
const j = JSON.parse(process.argv[1]);
if (j.backend !== 'file') throw new Error('expected backend file, got ' + j.backend);
if (j.cost !== '0') throw new Error('expected cost 0 for file backend, got ' + j.cost);
if (j.size_bytes !== Number(process.argv[2])) throw new Error('expected size_bytes ' + process.argv[2] + ', got ' + j.size_bytes);
if (typeof j.note !== 'string' || j.note.length === 0) throw new Error('expected a non-empty note');
" "$EJOUT" "$EXPECT_SIZE"
echo "[PASS] estimate --json (file backend): one JSON line, field-for-field matching the human report's underlying CostEstimate"

echo "== issue #655: --remote is warned as ignored when passed with --backend file (rclone-only flag) =="
# --remote is read ONLY by the rclone backend (backends/rclone.ts) — every other
# backend's put() ignores it entirely. Previously push --backend file --remote <val>
# succeeded silently with no signal the value did anything (repro: an operator
# copy-pasting a push invocation between backends, e.g. switching from rclone to file
# for a quick local test).
FILE_REMOTE_ERR=$(cb push --in "$TMP/snap.age" --backend file --remote "someremote:/some/path" 2>&1 >/dev/null)
printf '%s' "$FILE_REMOTE_ERR" | grep -q -- '--remote is only used by --backend rclone' \
  || { echo "[FAIL] push --backend file --remote did not warn that --remote is ignored"; echo "$FILE_REMOTE_ERR"; exit 1; }
printf '%s' "$FILE_REMOTE_ERR" | grep -qF 'someremote:/some/path' \
  || { echo "[FAIL] the --remote warning did not name the ignored value"; echo "$FILE_REMOTE_ERR"; exit 1; }
echo "[PASS] push --backend file --remote <val> warns that --remote will be ignored"

echo "== issue #655 control: push --backend file WITHOUT --remote prints no such warning =="
FILE_NO_REMOTE_ERR=$(cb push --in "$TMP/snap.age" --backend file 2>&1 >/dev/null)
if printf '%s' "$FILE_NO_REMOTE_ERR" | grep -q -- '--remote is only used by'; then
  echo "[FAIL] the --remote warning fired despite --remote not being given"; echo "$FILE_NO_REMOTE_ERR"; exit 1
fi
echo "[PASS] push --backend file without --remote stays silent about --remote"

echo "== pipeline timeout: a wedged, SIGTERM-IGNORING tar can't hang the CLI (#38) =="
# TAR_STUB_MODE=wedge swaps the pipeline tar for a node stub that IGNORES SIGTERM and
# stays alive 30s (exec'd — no grandchild, so SIGKILL on it leaks nothing). This
# exercises the hard path: the pipeline must (a) time out, (b) escalate SIGTERM→SIGKILL
# so the child actually dies, and (c) only THEN reject — so cleanup runs after the child
# is dead, leaving no output / .part / staged plaintext. If escalation failed, the run
# would block on the stub's full 30s.
printf 'process.on("SIGTERM",()=>{});\nsetTimeout(()=>process.exit(0),30000);\nprocess.stdout.write("wedged");\n' > "$TMP/tar-ignore-term.mjs"
TOUT="$TMP/timeout-snap.age"
START=$(date +%s)
set +e
TERR=$(PATH="$STUBBIN:$PATH" TAR_STUB_MODE=wedge CYPHER_BRAIN_PIPE_TIMEOUT=600 node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TOUT" 2>&1); TRC=$?
set -e
ELAPSED=$(( $(date +%s) - START ))
[ "$TRC" != "0" ] || { echo "[FAIL] wedged-tar snapshot exited 0"; exit 1; }
printf '%s' "$TERR" | grep -qi "timed out" || { echo "[FAIL] no timeout error surfaced"; echo "$TERR"; exit 1; }
# < 15s proves the SIGKILL escalation fired (timeout 0.6s + 2s SIGKILL + overhead),
# NOT that we waited out the stub's 30s sleep.
[ "$ELAPSED" -lt 15 ] || { echo "[FAIL] pipeline took ${ELAPSED}s — SIGKILL escalation did not bound it (< the 30s stub)"; exit 1; }
test ! -f "$TOUT"                                       # no finished output
[ -z "$(find "$TMP" -name '*.part' 2>/dev/null)" ] || { echo "[FAIL] a .part lingered after timeout"; exit 1; }
# the staged plaintext dir must be erased by snapshot's finally on the timeout path
[ -z "$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'cypher-brain-*' -newermt "@$START" 2>/dev/null)" ] \
  || { echo "[FAIL] a staged-plaintext cypher-brain-* dir lingered after timeout"; exit 1; }
echo "[PASS] SIGTERM-ignoring tar killed via SIGKILL escalation in ${ELAPSED}s; no output / .part / staged plaintext"

echo "== single-key warning counts DISTINCT keys, not --recipient args (#43) =="
# one --recipient file holding TWO keys must NOT warn (recovery exists); a duplicate
# (two args, same key) MUST warn.
keygen2() { CYPHER_BRAIN_HOME="$1" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null 2>&1; }
keygen2 "$TMP/k-a"; keygen2 "$TMP/k-b"
MULTIREC="$TMP/multi-recipient.txt"
cat "$TMP/k-a/recipient.txt" "$TMP/k-b/recipient.txt" > "$MULTIREC"
W1=$(cb snapshot --dir "$SRC" --recipient "$MULTIREC" --out "$TMP/mk.age" 2>&1 | grep -ic "SINGLE recipient" || true)
[ "$W1" = "0" ] || { echo "[FAIL] warned on a 2-key recipient FILE"; exit 1; }
W2=$(cb snapshot --dir "$SRC" --recipient "$TMP/k-a/recipient.txt" --recipient "$TMP/k-a/recipient.txt" --out "$TMP/dup.age" 2>&1 | grep -ic "SINGLE recipient" || true)
[ "$W2" != "0" ] || { echo "[FAIL] did NOT warn on two args naming the SAME key"; exit 1; }
echo "[PASS] single-key warning is by distinct key, not arg count (2-key file silent; dup-arg warns)"

echo "== #119 regression: keygenAt() fails closed when chmod(home, 0700) cannot succeed =="
# chflags uchg (macOS "user immutable") makes even the OWNER's own chmod() fail EPERM,
# without needing root — the only portable, non-root way found to force a chmod
# failure deterministically. No Linux equivalent exists (chattr +i needs
# CAP_LINUX_IMMUTABLE, i.e. root, on ext4/most filesystems), so this is macOS-only;
# on Linux CI it SKIPs rather than fabricate a pass (rules/shell-ops.md: BLOCKED != PASS).
if [ "$(uname -s)" = "Darwin" ]; then
  CHMOD_FAIL_HOME="$TMP/chmod-fail-home"; mkdir -p "$CHMOD_FAIL_HOME"
  chmod 755 "$CHMOD_FAIL_HOME"    # pre-existing, LOOSER than the 0700 keygenAt() must enforce
  set +e
  chflags uchg "$CHMOD_FAIL_HOME" # immutable: keygenAt()'s own chmod(home, 0700) will now EPERM
  CHFLAGS_RC=$?
  set -e
  if [ "$CHFLAGS_RC" != "0" ]; then
    echo "[SKIP] #119 chmod-fail-closed repro: chflags uchg is unsupported on this filesystem (e.g. a virtualized TMPDIR)"
  else
    set +e
    OUT=$(CYPHER_BRAIN_HOME="$CHMOD_FAIL_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen 2>&1); RC=$?
    set -e
    chflags nouchg "$CHMOD_FAIL_HOME" # clear FIRST — every check below may exit 1, and the
                                       # trap's rm -rf "$TMP" cannot remove an immutable dir
    if [ "$RC" = "0" ]; then echo "FAIL: keygen succeeded despite chmod(home, 0700) failing — the #119 regression (a swallowed chmod error)"; echo "$OUT"; exit 1; fi
    printf '%s' "$OUT" | grep -qi "operation not permitted\|EPERM" || { echo "FAIL: keygen's failure was not the expected chmod EPERM"; echo "$OUT"; exit 1; }
    test ! -f "$CHMOD_FAIL_HOME/identity.age" || { echo "FAIL: an identity.age was written into a directory whose permissions could not be verified/corrected"; exit 1; }
    [ "$(stat -f '%Lp' "$CHMOD_FAIL_HOME")" = "755" ] || { echo "FAIL: the directory's mode changed despite the chmod call failing"; exit 1; }
    echo "[PASS] keygen fails closed (writes nothing) when chmod(home, 0700) cannot succeed, instead of silently proceeding"
  fi
else
  echo "[SKIP] #119 chmod-fail-closed repro needs chflags (macOS-only — see comment above)"
fi

echo "== #120 regression: --recipient FILE whose path contains 'age1' is read as a file, not mistaken for an inline literal =="
REC_AGE1_HOME="$TMP/rec-age1-home"
CYPHER_BRAIN_HOME="$REC_AGE1_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
REC_AGE1_FILE="$TMP/age1-manual-recipients.txt"   # the filename itself starts with "age1"
printf '%s\n' "$(cat "$REC_AGE1_HOME/recipient.txt")" > "$REC_AGE1_FILE"
cb snapshot --dir "$SRC" --recipient "$REC_AGE1_FILE" --out "$TMP/age1-file-recipient.age" >/dev/null
test -f "$TMP/age1-file-recipient.age" || { echo "FAIL: snapshot did not honor a recipients FILE whose path starts with 'age1'"; exit 1; }
CYPHER_BRAIN_HOME="$REC_AGE1_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" verify --in "$TMP/age1-file-recipient.age" 2>&1 | grep -q 'VERDICT: PASS' \
  || { echo "FAIL: the age1-named-file recipient did not actually decrypt (recipientEntries misread the filename as the literal key)"; exit 1; }
echo "[PASS] --recipient honored a file-based recipient whose path contains 'age1' (recipientEntries checks existence before the age1 prefix, #120)"

echo "== #121 regression: keygen refuses to silently re-key a stray recipient.txt that has no matching identity.age =="
STRAY_HOME="$TMP/stray-recipient-home"
CYPHER_BRAIN_HOME="$STRAY_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
STRAY_RECIPIENT_ORIG="$(cat "$STRAY_HOME/recipient.txt")"
rm -f "$STRAY_HOME/identity.age"   # simulate: identity moved offline (cold storage), recipient.txt left behind
set +e
OUT=$(CYPHER_BRAIN_HOME="$STRAY_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen 2>&1); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: keygen silently re-keyed a stray recipient.txt with no matching identity — the #121 regression"; echo "$OUT"; exit 1; fi
printf '%s' "$OUT" | grep -qi "recipient already exists" || { echo "FAIL: wrong error for a stray pre-existing recipient.txt"; echo "$OUT"; exit 1; }
[ "$(cat "$STRAY_HOME/recipient.txt")" = "$STRAY_RECIPIENT_ORIG" ] || { echo "FAIL: the stray recipient.txt was modified despite the refusal"; exit 1; }
test ! -f "$STRAY_HOME/identity.age" || { echo "FAIL: an identity.age was written despite the recipientPath refusal"; exit 1; }
echo "[PASS] keygen refuses to re-key a stray pre-existing recipient.txt without --force, leaving it byte-identical"

echo "== #122 regression: a failed 'keygen --force' (new payload never finishes) must not lose the OLD identity =="
FORCE_HOME="$TMP/force-atomic-home"
CYPHER_BRAIN_HOME="$FORCE_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
ORIG_IDENTITY_SHA="$(shasum -a 256 "$FORCE_HOME/identity.age" | cut -d' ' -f1)"
ORIG_RECIPIENT="$(cat "$FORCE_HOME/recipient.txt")"
# --passphrase with no CYPHER_BRAIN_PASSPHRASE and no TTY (< /dev/null): askNewPassphrase()
# throws deterministically ("stdin is not a TTY") AFTER the new keypair is generated but
# BEFORE keygenAt() ever touches identityPath/recipientPath on disk (see keys.ts) — the
# same "prepare fully, THEN replace" ordering the #122 fix requires.
set +e
OUT=$(CYPHER_BRAIN_HOME="$FORCE_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --force --passphrase < /dev/null 2>&1); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: keygen --force --passphrase succeeded despite no TTY / no CYPHER_BRAIN_PASSPHRASE"; echo "$OUT"; exit 1; fi
printf '%s' "$OUT" | grep -qi "not a TTY" || { echo "FAIL: expected the passphrase-requires-a-TTY error"; echo "$OUT"; exit 1; }
[ "$(shasum -a 256 "$FORCE_HOME/identity.age" | cut -d' ' -f1)" = "$ORIG_IDENTITY_SHA" ] || { echo "FAIL: the ORIGINAL identity was lost/modified by a failed --force keygen — the #122 regression (delete-before-ready)"; exit 1; }
[ "$(cat "$FORCE_HOME/recipient.txt")" = "$ORIG_RECIPIENT" ] || { echo "FAIL: the ORIGINAL recipient was lost/modified by a failed --force keygen"; exit 1; }
TMP_LEFTOVER="$(find "$FORCE_HOME" -maxdepth 1 -name '*.tmp' 2>/dev/null | head -n1)"
[ -z "$TMP_LEFTOVER" ] || { echo "FAIL: a .tmp sibling survived a failed --force keygen: $TMP_LEFTOVER"; exit 1; }
echo "[PASS] a failed --force keygen (passphrase step throwing) leaves the ORIGINAL identity/recipient completely intact — nothing is deleted before the replacement is ready"

echo "== #122: a SUCCESSFUL 'keygen --force' actually replaces identity+recipient, atomically, with no leftover temp file =="
CYPHER_BRAIN_HOME="$FORCE_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --force >/dev/null
[ "$(shasum -a 256 "$FORCE_HOME/identity.age" | cut -d' ' -f1)" != "$ORIG_IDENTITY_SHA" ] || { echo "FAIL: --force did not actually replace the identity"; exit 1; }
[ "$(cat "$FORCE_HOME/recipient.txt")" != "$ORIG_RECIPIENT" ] || { echo "FAIL: --force did not actually replace the recipient"; exit 1; }
[ "$(stat -c '%a' "$FORCE_HOME/identity.age" 2>/dev/null || stat -f '%Lp' "$FORCE_HOME/identity.age")" = "600" ] || { echo "FAIL: the replaced identity is not mode 600"; exit 1; }
TMP_LEFTOVER2="$(find "$FORCE_HOME" -maxdepth 1 -name '*.tmp' 2>/dev/null | head -n1)"
[ -z "$TMP_LEFTOVER2" ] || { echo "FAIL: a .tmp sibling survived a successful --force keygen: $TMP_LEFTOVER2"; exit 1; }
echo "[PASS] keygen --force replaces both identity and recipient with a fresh keypair (mode 600 preserved), no .tmp sibling left behind"

echo "== #110: 'keygen --wrap-in-place' passphrase-protects an EXISTING identity WITHOUT replacing it =="
WRAP_HOME="$TMP/wrap-home"
CYPHER_BRAIN_HOME="$WRAP_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
WRAP_RECIPIENT_ORIG="$(cat "$WRAP_HOME/recipient.txt")"
# Prove non-destructiveness end-to-end, not just "the recipient string didn't change":
# encrypt a snapshot to this identity BEFORE wrapping it, then decrypt that SAME
# snapshot AFTER wrapping — if --wrap-in-place secretly generated a brand-new keypair
# (the exact #110 bug `keygen --passphrase --force` has), this pre-wrap snapshot would
# no longer decrypt with the now-wrapped identity.
CYPHER_BRAIN_HOME="$WRAP_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --out "$TMP/wrap-presnap.age" >/dev/null

CYPHER_BRAIN_HOME="$WRAP_HOME" CYPHER_BRAIN_PASSPHRASE="wrap-in-place-test-pass" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --wrap-in-place >/dev/null

grep -qa '^-> scrypt ' "$WRAP_HOME/identity.age" || { echo "FAIL: keygen --wrap-in-place did not actually scrypt-wrap the identity"; exit 1; }
[ "$(cat "$WRAP_HOME/recipient.txt")" = "$WRAP_RECIPIENT_ORIG" ] || { echo "FAIL: keygen --wrap-in-place changed the recipient — it generated a NEW keypair instead of wrapping the existing one (the #110 bug)"; exit 1; }

CYPHER_BRAIN_HOME="$WRAP_HOME" CYPHER_BRAIN_PASSPHRASE="wrap-in-place-test-pass" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" verify --in "$TMP/wrap-presnap.age" 2>&1 | grep -q 'VERDICT: PASS' \
  || { echo "FAIL: a snapshot encrypted BEFORE the wrap no longer decrypts with the wrapped identity — wrap-in-place did not preserve the original keypair"; exit 1; }
echo "[PASS] keygen --wrap-in-place scrypt-wraps the identity in place, keeps the SAME recipient, and a snapshot made BEFORE the wrap still decrypts with it afterward"

echo "== keygen --wrap-in-place refuses a no-op re-wrap and a missing identity =="
set +e
OUT=$(CYPHER_BRAIN_HOME="$WRAP_HOME" CYPHER_BRAIN_PASSPHRASE="wrap-in-place-test-pass" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --wrap-in-place 2>&1); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: re-wrapping an already-wrapped identity should refuse, not succeed"; echo "$OUT"; exit 1; fi
printf '%s' "$OUT" | grep -qi "already passphrase-wrapped" || { echo "FAIL: wrong error for re-wrapping an already-wrapped identity"; echo "$OUT"; exit 1; }

NOKEY_HOME="$TMP/wrap-no-identity-home"; mkdir -p "$NOKEY_HOME"
set +e
OUT=$(CYPHER_BRAIN_HOME="$NOKEY_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --wrap-in-place 2>&1); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: --wrap-in-place should refuse when no identity exists yet"; echo "$OUT"; exit 1; fi
printf '%s' "$OUT" | grep -qi "no identity found" || { echo "FAIL: wrong error for a missing identity"; echo "$OUT"; exit 1; }
echo "[PASS] keygen --wrap-in-place refuses to re-wrap an already-wrapped identity, and refuses cleanly when no identity exists yet"

echo "== keygen --wrap-in-place also refuses an ASCII-ARMORED already-wrapped identity, without corrupting it (#87-style edge case) =="
# loadIdentities() (crypt.ts) treats a wrapped identity as EITHER raw age ciphertext OR
# that same ciphertext ASCII-armored (`age -p -a`, or one re-typed from a printed
# recovery note — #87's own motivating case) — wrap-in-place's "already wrapped" check
# must recognize both shapes too, or it would silently double-wrap/corrupt an armored
# one instead of refusing.
ARMOR_HOME="$TMP/wrap-armor-home"
CYPHER_BRAIN_HOME="$ARMOR_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
CYPHER_BRAIN_HOME="$ARMOR_HOME" CYPHER_BRAIN_PASSPHRASE="wrap-in-place-test-pass" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --wrap-in-place >/dev/null
node -e "
const fs = require('fs');
const { armor } = require('age-encryption');
const raw = fs.readFileSync(process.argv[1]);
fs.writeFileSync(process.argv[1], armor.encode(new Uint8Array(raw)));
" "$ARMOR_HOME/identity.age"
grep -q -- '-----BEGIN AGE ENCRYPTED FILE-----' "$ARMOR_HOME/identity.age" || { echo "FAIL: test setup: identity.age was not actually armored"; exit 1; }
ARMORED_SHA="$(shasum -a 256 "$ARMOR_HOME/identity.age" | cut -d' ' -f1)"
set +e
OUT=$(CYPHER_BRAIN_HOME="$ARMOR_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --wrap-in-place 2>&1); RC=$?
set -e
if [ "$RC" = "0" ]; then echo "FAIL: re-wrapping an ASCII-armored already-wrapped identity should refuse, not succeed"; echo "$OUT"; exit 1; fi
printf '%s' "$OUT" | grep -qi "already passphrase-wrapped" || { echo "FAIL: wrong error for re-wrapping an armored already-wrapped identity"; echo "$OUT"; exit 1; }
[ "$(shasum -a 256 "$ARMOR_HOME/identity.age" | cut -d' ' -f1)" = "$ARMORED_SHA" ] || { echo "FAIL: the armored identity was modified despite the refusal — double-wrap corruption"; exit 1; }
echo "[PASS] keygen --wrap-in-place recognizes an ASCII-armored identity as already-wrapped too, refuses, and leaves it byte-identical (no double-wrap corruption)"

echo "== #111 regression: restore --pg requires --yes/CYPHER_BRAIN_YES before pg_restore --clean --if-exists =="
# pg_restore --clean --if-exists DROPs/replaces objects in the target DB — an
# irreversible operation, so it needs the same explicit-opt-in gate as push's
# paid-backend guard above. The gate fires before any decrypt/extract work, so
# this needs no real Postgres and no valid identity for the negative case.
set +e
OUT=$(node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$TMP/snap.age" --out-dir "$TMP/pg-noyes-out" --pg "postgres://x/y" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] restore --pg without --yes exited 0"; exit 1; }
printf '%s' "$OUT" | grep -qi "CYPHER_BRAIN_YES\|--yes" \
  || { echo "[FAIL] restore --pg without --yes error lacks --yes guidance"; echo "$OUT"; exit 1; }
test ! -e "$TMP/pg-noyes-out" || { echo "[FAIL] the consent gate ran AFTER out-dir was created"; exit 1; }
echo "[PASS] restore --pg without --yes fails with clear guidance, before touching --out-dir"
# --yes (or CYPHER_BRAIN_YES=1) passes the gate — the error moves further in (this
# snapshot has no db.dump, so it now fails on THAT check instead), proving the gate
# no longer blocks. Needs the correct identity ($TMP/keys, snap.age's recipient).
set +e
OUT2=$(CYPHER_BRAIN_HOME="$TMP/keys" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$TMP/snap.age" --out-dir "$TMP/pg-yes-out" --pg "postgres://x/y" --yes 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] restore --pg --yes against a snapshot with no db.dump exited 0"; exit 1; }
printf '%s' "$OUT2" | grep -qi "no db.dump in snapshot" \
  || { echo "[FAIL] --yes did not pass the consent gate (expected to fail further in, on the missing db.dump)"; echo "$OUT2"; exit 1; }
set +e
OUT3=$(CYPHER_BRAIN_HOME="$TMP/keys" CYPHER_BRAIN_YES=1 node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$TMP/snap.age" --out-dir "$TMP/pg-envyes-out" --pg "postgres://x/y" 2>&1); RC3=$?
set -e
[ "$RC3" != "0" ] || { echo "[FAIL] restore --pg with CYPHER_BRAIN_YES=1 against a snapshot with no db.dump exited 0"; exit 1; }
printf '%s' "$OUT3" | grep -qi "no db.dump in snapshot" \
  || { echo "[FAIL] CYPHER_BRAIN_YES=1 did not pass the consent gate"; echo "$OUT3"; exit 1; }
echo "[PASS] --yes and CYPHER_BRAIN_YES=1 both pass the consent gate (fail further in: missing db.dump)"

echo "== #112 regression: restore --keep-old-files does not clobber a pre-existing file in --out-dir =="
KOF_OUT="$TMP/keep-old-out"
mkdir -p "$KOF_OUT"
SENTINEL="PRE-EXISTING-DO-NOT-OVERWRITE-$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$SENTINEL" > "$KOF_OUT/manifest.json"   # same top-level name a real restore would extract
CYPHER_BRAIN_HOME="$TMP/keys" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$TMP/snap.age" --out-dir "$KOF_OUT" >/dev/null
[ "$(cat "$KOF_OUT/manifest.json")" = "$SENTINEL" ] || { echo "[FAIL] restore overwrote a pre-existing file in --out-dir (missing --keep-old-files)"; exit 1; }
test -f "$KOF_OUT/brain-src.tar.gz" || { echo "[FAIL] restore did not extract the non-colliding component alongside the kept file"; exit 1; }
echo "[PASS] restore --keep-old-files preserves a pre-existing file in --out-dir while extracting the rest of the archive around it"

echo "== #106 regression: pg_restore is bounded by a timeout (a wedged pg_restore can't hang the CLI) =="
# A fake pg_dump/pg_restore pair: pg_dump behaves normally (so the snapshot really
# gets a db.dump component); pg_restore just sleeps, simulating a wedged/hung
# process. run()'s timeout SIGKILLs on expiry (proc.ts) — no SIGTERM-ignoring
# trick needed, unlike the pipeline-tar wedge test above.
FAKE_PGBIN_R="$TMP/fake-pgbin-restore-timeout"; mkdir -p "$FAKE_PGBIN_R"
cat > "$FAKE_PGBIN_R/pg_dump" <<'SHIM'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ]; then out="$a"; fi
  prev="$a"
done
printf 'fake-pg-dump-content\n' > "$out"
exit 0
SHIM
chmod +x "$FAKE_PGBIN_R/pg_dump"
cat > "$FAKE_PGBIN_R/pg_restore" <<'SHIM'
#!/usr/bin/env bash
exec sleep 30
SHIM
chmod +x "$FAKE_PGBIN_R/pg_restore"
PGTO_SNAP="$TMP/pg-timeout-snap.age"
CYPHER_BRAIN_HOME="$TMP/keys" CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN_R" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --pg "postgres://fake/conn" --out "$PGTO_SNAP" >/dev/null
PGTO_OUT="$TMP/pg-timeout-out"
START=$(date +%s)
set +e
TERR=$(CYPHER_BRAIN_HOME="$TMP/keys" CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN_R" CYPHER_BRAIN_PIPE_TIMEOUT=600 \
  node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$PGTO_SNAP" --out-dir "$PGTO_OUT" --pg "postgres://fake/scratch" --yes 2>&1); TRC=$?
set -e
ELAPSED=$(( $(date +%s) - START ))
[ "$TRC" != "0" ] || { echo "[FAIL] restore with a wedged pg_restore exited 0"; exit 1; }
printf '%s' "$TERR" | grep -qi "timed out" || { echo "[FAIL] no timeout error surfaced for a wedged pg_restore"; echo "$TERR"; exit 1; }
[ "$ELAPSED" -lt 15 ] || { echo "[FAIL] pg_restore took ${ELAPSED}s — timeoutMs did not bound it (< the 30s stub sleep)"; exit 1; }
echo "[PASS] a wedged pg_restore is killed by the timeout in ${ELAPSED}s instead of hanging the CLI"

echo "== #235: --pg-filter / --pg-exclude-table-data are a literal pass-through to pg_dump's OWN flags =="
# A fake pg_dump that ALSO records its exact argv (via an env-provided log path, NOT a
# stage-relative one — the real stage dir is rm'd in snapshot()'s finally block before we'd
# get a chance to read anything left inside it) so we can assert precisely what cypher-brain
# invoked pg_dump with, without needing a real Postgres instance (same shim pattern as the
# #106 test above — cypher-brain does no SQL parsing/filtering of its own, so proving the
# flags reach pg_dump's argv unchanged is the whole test).
FAKE_PGBIN_F="$TMP/fake-pgbin-filter"; mkdir -p "$FAKE_PGBIN_F"
cat > "$FAKE_PGBIN_F/pg_dump" <<'SHIM'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ]; then out="$a"; fi
  prev="$a"
done
printf 'fake-pg-dump-content\n' > "$out"
: "${PG_DUMP_ARGV_LOG:?PG_DUMP_ARGV_LOG not set}"
printf '%s\n' "$@" > "$PG_DUMP_ARGV_LOG"
SHIM
chmod +x "$FAKE_PGBIN_F/pg_dump"

FILTER_FILE="$TMP/pg-filter.txt"
cat > "$FILTER_FILE" <<'EOF'
include table conversation_summaries
exclude table conversation_logs
exclude table embedding_cache
EOF

# (a) flags given -> --filter/--exclude-table-data reach pg_dump's argv verbatim.
FILTER_ARGV="$TMP/pg-dump-argv-filter.txt"
FILTER_SNAP="$TMP/pg-filter-snap.age"
CYPHER_BRAIN_HOME="$TMP/keys" CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN_F" PG_DUMP_ARGV_LOG="$FILTER_ARGV" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --pg "postgres://fake/conn" \
    --pg-filter "$FILTER_FILE" \
    --pg-exclude-table-data tool_logs --pg-exclude-table-data embedding_cache \
    --out "$FILTER_SNAP" >/dev/null
test -f "$FILTER_ARGV" || { echo "[FAIL] fake pg_dump never ran (no argv log)"; exit 1; }
GOT_FILTER=$(awk '/^--filter$/{getline v; print v}' "$FILTER_ARGV")
[ "$GOT_FILTER" = "$FILTER_FILE" ] \
  || { echo "[FAIL] pg_dump argv --filter value = '$GOT_FILTER', expected '$FILTER_FILE'"; cat "$FILTER_ARGV"; exit 1; }
GOT_EXCLUDE=$(awk '/^--exclude-table-data$/{getline v; print v}' "$FILTER_ARGV")
EXPECT_EXCLUDE="$(printf 'tool_logs\nembedding_cache')"
[ "$GOT_EXCLUDE" = "$EXPECT_EXCLUDE" ] \
  || { echo "[FAIL] pg_dump argv --exclude-table-data values = '$GOT_EXCLUDE', expected '$EXPECT_EXCLUDE'"; cat "$FILTER_ARGV"; exit 1; }
echo "[PASS] --pg-filter <file> and --pg-exclude-table-data <t> (repeated) reach pg_dump's argv unchanged"

# (b) the manifest records what was passed (transparency, same spirit as --pg-table's `tables`).
FILTER_OUT="$TMP/pg-filter-restore-out"
CYPHER_BRAIN_HOME="$TMP/keys" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$FILTER_SNAP" --out-dir "$FILTER_OUT" \
  --no-expand-components >/dev/null
grep -qF "\"filter\": \"$FILTER_FILE\"" "$FILTER_OUT/manifest.json" \
  || { echo "[FAIL] manifest.json does not record the --pg-filter file path"; cat "$FILTER_OUT/manifest.json"; exit 1; }
grep -q '"exclude_table_data"' "$FILTER_OUT/manifest.json" || { echo "[FAIL] manifest.json missing exclude_table_data"; exit 1; }
grep -q 'tool_logs' "$FILTER_OUT/manifest.json" || { echo "[FAIL] manifest.json missing excluded table tool_logs"; exit 1; }
grep -q 'embedding_cache' "$FILTER_OUT/manifest.json" || { echo "[FAIL] manifest.json missing excluded table embedding_cache"; exit 1; }
echo "[PASS] manifest.json records the --pg-filter path and --pg-exclude-table-data tables"

# (c) unspecified (the default) -> pg_dump's argv carries NEITHER flag (identical to pre-#235
# behavior: a full, unfiltered dump).
PLAIN_ARGV="$TMP/pg-dump-argv-plain.txt"
CYPHER_BRAIN_HOME="$TMP/keys" CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN_F" PG_DUMP_ARGV_LOG="$PLAIN_ARGV" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --pg "postgres://fake/conn" --out "$TMP/pg-plain-snap.age" >/dev/null
if grep -q -- '--filter\|--exclude-table-data' "$PLAIN_ARGV"; then
  echo "[FAIL] pg_dump argv carries --filter/--exclude-table-data even though neither flag was passed"
  cat "$PLAIN_ARGV"; exit 1
fi
echo "[PASS] omitting --pg-filter/--pg-exclude-table-data leaves pg_dump's argv exactly as before (no filtering)"

echo "== #215: --scan-secrets warn|deny (gitleaks) =="
# This whole section is deliberately explicit about CYPHER_BRAIN_HOME="$TMP/keys" on
# EVERY invocation (snapshot AND restore) rather than relying on the ambient exported
# default — the export was repointed to "$TMP/keys2" earlier in this script (line ~216),
# so a bare `cb` call and an explicit "$TMP/keys" override would silently use TWO
# DIFFERENT identities/recipients (a snapshot's ciphertext would then not decrypt with
# the identity a paired restore call explicitly names).
echo "== #215: --scan-secrets is validated up front (bad value refused before any work) =="
set +e
BADMODE_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out "$TMP/badmode.age" --scan-secrets bogus 2>&1); BADMODE_RC=$?
set -e
[ "$BADMODE_RC" != "0" ] || { echo "[FAIL] --scan-secrets bogus was accepted"; exit 1; }
printf '%s' "$BADMODE_ERR" | grep -q 'must be "warn", "deny", "off"' || { echo "[FAIL] wrong error for --scan-secrets bogus"; echo "$BADMODE_ERR"; exit 1; }
test ! -e "$TMP/badmode.age" || { echo "[FAIL] --scan-secrets bogus still produced an output file"; exit 1; }
echo "[PASS] --scan-secrets rejects anything other than warn/deny/off, before any --out is created"

echo "== #307: --scan-secrets with NO --dir/--profile source is refused (it would scan zero components while the manifest claimed the mode was in effect) =="
# Needs no gitleaks: the refusal is checked BEFORE assertGitleaksAvailable() precisely so
# the answer does not depend on whether the host happens to have the binary.
set +e
NOSRC_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --pg "postgres://x/y" --out "$TMP/nosrc.age" --scan-secrets deny 2>&1); NOSRC_RC=$?
set -e
[ "$NOSRC_RC" != "0" ] || { echo "[FAIL] --scan-secrets deny with only --pg was accepted — it would scan nothing while reporting deny"; exit 1; }
printf '%s' "$NOSRC_ERR" | grep -q 'nothing to scan' || { echo "[FAIL] the refusal does not say the scan would have no component to look at"; echo "$NOSRC_ERR"; exit 1; }
test ! -e "$TMP/nosrc.age" || { echo "[FAIL] --scan-secrets with no scannable source still produced an output file"; exit 1; }
# The same --pg-only snapshot WITHOUT the flag must not hit this refusal at all (it gets
# as far as pg_dump and fails there for its own unrelated reason — an unreachable test
# DSN — which is exactly the point: the new check fires only when the flag is present).
set +e
PGONLY_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --pg "postgres://x/y" --out "$TMP/nosrc-noflag.age" 2>&1)
set -e
if printf '%s' "$PGONLY_ERR" | grep -q 'nothing to scan'; then echo "[FAIL] a --pg-only snapshot WITHOUT --scan-secrets was refused by the new check"; echo "$PGONLY_ERR"; exit 1; fi
echo "[PASS] --scan-secrets is refused when no --dir/--profile source would be scanned, without needing gitleaks, and only when the flag is present"

echo "== #307: --scan-secrets + --dry-run is refused (a dry run stages nothing, so the preview would exit 0 having scanned nothing) =="
set +e
DRYSCAN_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --dry-run --scan-secrets deny 2>&1); DRYSCAN_RC=$?
# The pre-#307 shape of the same hole: --dry-run returned before the mode was even
# validated, so a value the real run rejects also exited 0.
DRYBAD_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --dry-run --scan-secrets bogus 2>&1); DRYBAD_RC=$?
set -e
[ "$DRYSCAN_RC" != "0" ] || { echo "[FAIL] --dry-run --scan-secrets deny exited 0 — readable as a clean scan preflight when nothing was scanned"; echo "$DRYSCAN_ERR"; exit 1; }
printf '%s' "$DRYSCAN_ERR" | grep -q -- 'cannot be combined with --dry-run' || { echo "[FAIL] the --dry-run refusal does not explain the combination"; echo "$DRYSCAN_ERR"; exit 1; }
[ "$DRYBAD_RC" != "0" ] || { echo "[FAIL] --dry-run --scan-secrets bogus exited 0"; echo "$DRYBAD_ERR"; exit 1; }
# --dry-run on its own is untouched by this refusal.
CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --dry-run > /dev/null 2>&1 || { echo "[FAIL] a plain --dry-run was broken by the new refusal"; exit 1; }
echo "[PASS] --scan-secrets with --dry-run is refused (both a valid and an invalid mode), while a plain --dry-run still previews"

echo "== #307: a value-taking flag given with NO value is refused, naming the flag (it used to read as \"flag omitted\" and silently disable the gate) =="
set +e
NOVAL_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out "$TMP/noval.age" --scan-secrets 2>&1); NOVAL_RC=$?
set -e
[ "$NOVAL_RC" != "0" ] || { echo "[FAIL] a trailing --scan-secrets (no mode) was accepted — the gate is silently off"; exit 1; }
printf '%s' "$NOVAL_ERR" | grep -q -- '--scan-secrets requires a value' || { echo "[FAIL] the refusal does not name the flag that is missing its value"; echo "$NOVAL_ERR"; exit 1; }
test ! -e "$TMP/noval.age" || { echo "[FAIL] a trailing --scan-secrets still produced an output file"; exit 1; }
# Not special-cased to one flag: the parser refuses ANY value-taking flag left dangling.
set +e
NOVAL_OUT_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out 2>&1); NOVAL_OUT_RC=$?
NOVAL_REC_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out "$TMP/noval2.age" --recipient 2>&1); NOVAL_REC_RC=$?
set -e
[ "$NOVAL_OUT_RC" != "0" ] || { echo "[FAIL] a trailing --out was accepted"; exit 1; }
printf '%s' "$NOVAL_OUT_ERR" | grep -q -- '--out requires a value' || { echo "[FAIL] a trailing --out does not name itself"; echo "$NOVAL_OUT_ERR"; exit 1; }
[ "$NOVAL_REC_RC" != "0" ] || { echo "[FAIL] a trailing --recipient was accepted"; exit 1; }
printf '%s' "$NOVAL_REC_ERR" | grep -q -- '--recipient requires a value' || { echo "[FAIL] a trailing --recipient (a repeatable array flag) does not name itself"; echo "$NOVAL_REC_ERR"; exit 1; }
# The nastier shape (multi-model review round 2): the value is not missing off the END of
# argv, it is EATEN by the preceding flag. `--out --scan-secrets deny` used to parse as
# out="--scan-secrets", scan_secrets=undefined, _="deny" — an UNSCANNED snapshot written to
# a file literally named "--scan-secrets", from a command line that asked for deny.
set +e
EATEN_ERR=$(cd "$TMP" && CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out --scan-secrets deny 2>&1); EATEN_RC=$?
set -e
[ "$EATEN_RC" != "0" ] || { echo "[FAIL] '--out --scan-secrets deny' was accepted — the snapshot ran with the gate silently off"; echo "$EATEN_ERR"; exit 1; }
printf '%s' "$EATEN_ERR" | grep -q -- '--out requires a value, but the next argument looks like another flag' || { echo "[FAIL] the swallowed-value refusal does not explain which flag ate which"; echo "$EATEN_ERR"; exit 1; }
test ! -e "$TMP/--scan-secrets" || { echo "[FAIL] a swallowed --scan-secrets still produced a snapshot file named after the flag"; exit 1; }
# A MISTYPED flag is the nastier version of the same shape: it is not a name this CLI
# knows, so an "only reject recognized flags" rule would swallow it as --out's value and
# never reach the unknown-flag refusal (#253) that exists to catch the typo. Any
# "--"-leading token is refused as a value for exactly this reason.
set +e
TYPO_ERR=$(cd "$TMP" && CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out --scan-secret deny 2>&1); TYPO_RC=$?
set -e
[ "$TYPO_RC" != "0" ] || { echo "[FAIL] '--out --scan-secret deny' (typo) was accepted — an unscanned snapshot named after the typo"; echo "$TYPO_ERR"; exit 1; }
test ! -e "$TMP/--scan-secret" || { echo "[FAIL] a mistyped flag swallowed as a value still produced a snapshot file"; exit 1; }
# The escape for a value that genuinely starts with dashes, which the error suggests.
CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SRC" --out "$TMP/./--really-a-path.age" > /dev/null 2>&1 \
  || { echo "[FAIL] a legitimate dash-leading value written as a ./ path was refused"; exit 1; }
test -f "$TMP/--really-a-path.age" || { echo "[FAIL] the ./-escaped --out value did not produce its file"; exit 1; }
echo "[PASS] a value flag is refused when its value is missing OR looks like a flag (recognized or mistyped), while a ./-escaped dash-leading path still works"

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "[SKIP] --scan-secrets warn/deny tests: no \`gitleaks\` binary on PATH (install it — https://github.com/gitleaks/gitleaks — to exercise this; CI installs it via the .github/workflows/ci.yml step, see #215)"
else
  # A DUMMY, obviously-fake AWS-access-key-SHAPED string (sequential alphabet, never a
  # real credential) — just enough to match gitleaks' default aws-access-token rule so
  # this proves the wiring, not gitleaks' own detection accuracy.
  SECRETS_SRC="$TMP/secrets-src"; mkdir -p "$SECRETS_SRC"
  printf 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP\n' > "$SECRETS_SRC/config.env"
  CLEAN_SRC="$TMP/clean-secrets-src"; mkdir -p "$CLEAN_SRC"
  printf 'nothing secret here\n' > "$CLEAN_SRC/note.txt"

  echo "== #301: the DEFAULT scans — omitting --scan-secrets now warns rather than sealing a secret in silence =="
  # This assertion is the whole point of #301 and replaces the pre-#301 one, which asserted
  # the opposite ("succeeds silently"). Reached only inside the gitleaks-present branch,
  # which is exactly the condition the default keys off.
  DEF_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SECRETS_SRC" --out "$TMP/nosca.age" 2>&1)
  test -f "$TMP/nosca.age" || { echo "[FAIL] the default-scanning snapshot did not produce an output file — warn must not refuse"; echo "$DEF_ERR"; exit 1; }
  printf '%s' "$DEF_ERR" | grep -qi "gitleaks found" || { echo "[FAIL] no --scan-secrets flag and a planted secret: nothing was reported, so the default did not scan"; echo "$DEF_ERR"; exit 1; }
  printf '%s' "$DEF_ERR" | grep -q "AKIAABCDEFGHIJKLMNOP" && { echo "[FAIL] the dummy secret value leaked into the default scan's output"; echo "$DEF_ERR"; exit 1; }
  echo "[PASS] omitting --scan-secrets scans and warns (default = warn when a source and gitleaks are both present)"

  echo "== #301: --scan-secrets off is the way to turn that default off, and it is silent =="
  OFF_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SECRETS_SRC" --out "$TMP/off.age" --scan-secrets off 2>&1)
  test -f "$TMP/off.age" || { echo "[FAIL] --scan-secrets off did not produce an output file"; echo "$OFF_ERR"; exit 1; }
  printf '%s' "$OFF_ERR" | grep -qi "gitleaks found" && { echo "[FAIL] --scan-secrets off still scanned — it is supposed to be the opt-out"; echo "$OFF_ERR"; exit 1; }
  # `off` asks for NO scan, so the "nothing to scan" refusal that guards warn/deny must not
  # fire for it: refusing to not-scan a --pg-only snapshot would be nonsense.
  set +e
  OFFPG_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --pg "postgres://x/y" --out "$TMP/offpg.age" --scan-secrets off 2>&1)
  set -e
  printf '%s' "$OFFPG_ERR" | grep -q 'nothing to scan' && { echo "[FAIL] --scan-secrets off with no scannable source hit the warn/deny 'nothing to scan' refusal"; echo "$OFFPG_ERR"; exit 1; }
  echo "[PASS] --scan-secrets off skips the scan, and is not subject to the refusals that only make sense for warn/deny"

  echo "== #301: the IMPLICIT default may skip quietly when no scanner resolves, but an EXPLICIT request still refuses =="
  # The asymmetry is load-bearing (#307/#314): nobody asked for a gate on the first call, so
  # nothing claims one ran; the second call asked, so it must not come back successful.
  QUIET_ERR=$(CYPHER_BRAIN_GITLEAKS_BIN=/nonexistent/gitleaks CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SECRETS_SRC" --out "$TMP/quiet.age" 2>&1)
  test -f "$TMP/quiet.age" || { echo "[FAIL] the default turned an absent gitleaks into a failure — it must be a no-op"; echo "$QUIET_ERR"; exit 1; }
  printf '%s' "$QUIET_ERR" | grep -qi "gitleaks found" && { echo "[FAIL] a scan reported findings with no resolvable scanner"; echo "$QUIET_ERR"; exit 1; }
  set +e
  ASKED_ERR=$(CYPHER_BRAIN_GITLEAKS_BIN=/nonexistent/gitleaks CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SECRETS_SRC" --out "$TMP/asked.age" --scan-secrets warn 2>&1); ASKED_RC=$?
  set -e
  [ "$ASKED_RC" != "0" ] || { echo "[FAIL] an EXPLICIT --scan-secrets warn with no resolvable gitleaks exited 0 — the caller asked for a gate and got none"; echo "$ASKED_ERR"; exit 1; }
  test ! -e "$TMP/asked.age" || { echo "[FAIL] the refused explicit request still wrote a snapshot"; exit 1; }
  echo "[PASS] no scanner: the implicit default no-ops silently, an explicit --scan-secrets refuses (the asymmetry #307 established)"

  echo "== #215: --scan-secrets warn proceeds despite a finding, and records rule ID + count (never the secret) in the manifest =="
  WARN_SNAP="$TMP/warn.age"
  WARN_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SECRETS_SRC" --out "$WARN_SNAP" --scan-secrets warn 2>&1)
  test -f "$WARN_SNAP" || { echo "[FAIL] --scan-secrets warn refused to produce a snapshot despite being warn-mode"; echo "$WARN_ERR"; exit 1; }
  printf '%s' "$WARN_ERR" | grep -qi "gitleaks found" || { echo "[FAIL] --scan-secrets warn did not report the finding"; echo "$WARN_ERR"; exit 1; }
  printf '%s' "$WARN_ERR" | grep -q "AKIAABCDEFGHIJKLMNOP" && { echo "[FAIL] the actual dummy secret value leaked into --scan-secrets warn output"; echo "$WARN_ERR"; exit 1; }
  WARN_OUT="$TMP/warn-restored"
  CYPHER_BRAIN_HOME="$TMP/keys" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$WARN_SNAP" --out-dir "$WARN_OUT" >/dev/null
  WARN_MANIFEST="$WARN_OUT/manifest.json"
  test -f "$WARN_MANIFEST" || { echo "[FAIL] restore did not extract manifest.json"; exit 1; }
  node -e "
    const m = JSON.parse(require('node:fs').readFileSync('$WARN_MANIFEST', 'utf8'));
    if (m.scan_secrets_mode !== 'warn') { console.error('manifest scan_secrets_mode = ' + JSON.stringify(m.scan_secrets_mode) + ', expected \"warn\"'); process.exit(1); }
    const c = m.components.find((x) => /^secrets-src/.test(x.name));
    if (!c) { console.error('no secrets-src component in manifest'); process.exit(1); }
    if (!Array.isArray(c.secrets_scan) || c.secrets_scan.length === 0) { console.error('component.secrets_scan missing/empty: ' + JSON.stringify(c.secrets_scan)); process.exit(1); }
    const f = c.secrets_scan.find((x) => x.rule_id === 'aws-access-token');
    if (!f || f.count < 1) { console.error('expected an aws-access-token finding with count >= 1, got: ' + JSON.stringify(c.secrets_scan)); process.exit(1); }
    const raw = JSON.stringify(m);
    if (raw.includes('AKIAABCDEFGHIJKLMNOP')) { console.error('the dummy secret VALUE leaked into manifest.json'); process.exit(1); }
  " || { echo "[FAIL] manifest.json did not record rule ID + count for the --scan-secrets warn finding (or leaked the secret value)"; cat "$WARN_MANIFEST"; exit 1; }
  echo "[PASS] --scan-secrets warn proceeds, logs the finding, and records only rule ID + count in the manifest — never the secret value"

  echo "== #215: --scan-secrets deny refuses the whole snapshot when a finding exists (no --out produced) =="
  DENY_SNAP="$TMP/deny.age"
  set +e
  DENY_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$SECRETS_SRC" --out "$DENY_SNAP" --scan-secrets deny 2>&1); DENY_RC=$?
  set -e
  [ "$DENY_RC" != "0" ] || { echo "[FAIL] --scan-secrets deny exited 0 despite a finding"; exit 1; }
  printf '%s' "$DENY_ERR" | grep -qi "refusing to snapshot" || { echo "[FAIL] --scan-secrets deny did not explain the refusal"; echo "$DENY_ERR"; exit 1; }
  printf '%s' "$DENY_ERR" | grep -q "AKIAABCDEFGHIJKLMNOP" && { echo "[FAIL] the actual dummy secret value leaked into --scan-secrets deny output"; echo "$DENY_ERR"; exit 1; }
  test ! -e "$DENY_SNAP" || { echo "[FAIL] --scan-secrets deny still produced an output file"; exit 1; }
  test ! -e "$DENY_SNAP.part" || { echo "[FAIL] --scan-secrets deny left a .part file behind"; exit 1; }
  echo "[PASS] --scan-secrets deny aborts the snapshot before any ciphertext is written, without leaking the secret value"

  echo "== #215: --scan-secrets deny still succeeds on a source with no findings =="
  CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --dir "$CLEAN_SRC" --out "$TMP/deny-clean.age" --scan-secrets deny >/dev/null
  test -f "$TMP/deny-clean.age" || { echo "[FAIL] --scan-secrets deny refused a clean source"; exit 1; }
  echo "[PASS] --scan-secrets deny only refuses when gitleaks actually finds something"

  echo "== #206: --profile o2b's bank-export bundle is PLAIN JSON — gitleaks reads its actual content, unlike chatgpt-export's opaque zip =="
  # profiles.ts's o2bPaths() doc comment, README.md and MANAGEMENT.md all make this exact
  # claim (a Sakana Fugu review finding on PR #334, corrected mid-implementation): unlike
  # chatgpt-export's zip — which gitleaks can only see as opaque bytes (the "== #215:
  # --scan-secrets deny still succeeds ==" pattern above would falsely pass on a zip
  # carrying a real secret) — o2b's bundle is scanned like any other text file. Prove it
  # with a synthetic bank-export bundle carrying the same dummy AWS-key-shaped string as
  # the rest of this section, embedded in a preference value (a plausible place for a
  # leaked credential to end up in a real export).
  O2B_SECRETS_BUNDLE="$TMP/o2b-secrets-bank-export.json"
  node -e "
    const fs = require('node:fs');
    const bundle = {
      schema: '1',
      graph: { nodes: [] },
      pages: [],
      preferences: [{ key: 'note', value: 'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP' }],
    };
    fs.writeFileSync('$O2B_SECRETS_BUNDLE', JSON.stringify(bundle));
  "
  set +e
  O2BDENY_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" cb snapshot --profile o2b --export "$O2B_SECRETS_BUNDLE" --out "$TMP/o2b-deny.age" --scan-secrets deny 2>&1); O2BDENY_RC=$?
  set -e
  [ "$O2BDENY_RC" != "0" ] || { echo "[FAIL] --scan-secrets deny accepted an o2b bundle carrying a planted secret"; exit 1; }
  printf '%s' "$O2BDENY_ERR" | grep -qi "refusing to snapshot" || { echo "[FAIL] o2b --scan-secrets deny did not explain the refusal"; echo "$O2BDENY_ERR"; exit 1; }
  printf '%s' "$O2BDENY_ERR" | grep -q "AKIAABCDEFGHIJKLMNOP" && { echo "[FAIL] the dummy secret value leaked into o2b --scan-secrets deny output"; echo "$O2BDENY_ERR"; exit 1; }
  test ! -e "$TMP/o2b-deny.age" || { echo "[FAIL] --scan-secrets deny still produced an output file for the leaky o2b bundle"; exit 1; }
  echo "[PASS] gitleaks reads INSIDE the o2b bank-export bundle's plain-JSON text (not opaque bytes like chatgpt-export's zip) — --scan-secrets deny catches a planted secret in it"

  echo "== #215: --scan-secrets refuses clearly (naming gitleaks) when the binary can't be resolved, regardless of the real host's PATH =="
  # Same isolated-PATH technique selftest-schedule.sh uses for pg_dump: build a PATH
  # containing ONLY the one binary this check itself shells out to (a POSIX shell, to run
  # `command -v gitleaks` — see gitleaksAvailable() in src/lib/secrets-scan.ts), so
  # gitleaks is guaranteed unresolvable no matter what the real host has installed. node
  # is invoked via its absolute path so it needs no PATH entry of its own.
  NODE_BIN_215="$(command -v node)"
  ISOLATED_PATH_215="$TMP/isolated-path-215"; mkdir -p "$ISOLATED_PATH_215"
  ln -s "$(command -v sh)" "$ISOLATED_PATH_215/sh"
  set +e
  MISS_ERR=$(CYPHER_BRAIN_HOME="$TMP/keys" PATH="$ISOLATED_PATH_215" "$NODE_BIN_215" "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$CLEAN_SRC" --out "$TMP/miss.age" --scan-secrets warn 2>&1); MISS_RC=$?
  set -e
  [ "$MISS_RC" != "0" ] || { echo "[FAIL] --scan-secrets warn (isolated PATH, no gitleaks) was accepted"; exit 1; }
  printf '%s' "$MISS_ERR" | grep -qi "gitleaks" || { echo "[FAIL] the missing-gitleaks error does not name gitleaks"; echo "$MISS_ERR"; exit 1; }
  printf '%s' "$MISS_ERR" | grep -qi "brew install gitleaks" || { echo "[FAIL] the missing-gitleaks error does not suggest an install command"; echo "$MISS_ERR"; exit 1; }
  test ! -e "$TMP/miss.age" || { echo "[FAIL] a snapshot was produced despite gitleaks being unresolvable"; exit 1; }
  echo "[PASS] --scan-secrets fails fast (before any pg_dump/tar work) with an actionable error when gitleaks cannot be resolved"
fi

echo "== #495: a gitleaks report that parses as JSON but is not the array-of-findings shape fails closed with a clear error, never an unhandled crash =="
# Uses a STUB gitleaks (not the real binary) that writes an arbitrary body to the
# --report-path and exits 0, exactly like the real tool does after --exit-code 0 —
# so this runs unconditionally, without needing gitleaks on PATH. Regression test for
# #495: scanForSecrets() used to cast the parsed report straight to
# GitleaksRawFinding[] with no shape check, so a report shaped like
# {Results:[...]} (a plausible future gitleaks wrapper) or a truncated-but-valid
# `null` write made `for (const f of raw)` throw an unhandled "raw is not iterable"
# TypeError instead of this function's own documented fail-closed error.
BADREPORT_SRC="$TMP/badreport-src"; mkdir -p "$BADREPORT_SRC"; printf 'nothing secret here\n' > "$BADREPORT_SRC/note.txt"
cat > "$STUBBIN/gitleaks-badreport" <<'EOF'
#!/usr/bin/env bash
if [ "$1" != "dir" ]; then exit 0; fi
report=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--report-path" ]; then report="$arg"; fi
  prev="$arg"
done
printf '%s' "$GITLEAKS_BADREPORT_BODY" > "$report"
exit 0
EOF
chmod +x "$STUBBIN/gitleaks-badreport"

set +e
BADSHAPE_ERR=$(GITLEAKS_BADREPORT_BODY='{"Results":[]}' CYPHER_BRAIN_GITLEAKS_BIN="$STUBBIN/gitleaks-badreport" CYPHER_BRAIN_HOME="$TMP/keys" \
  cb snapshot --dir "$BADREPORT_SRC" --out "$TMP/badshape.age" --scan-secrets warn 2>&1); BADSHAPE_RC=$?
set -e
[ "$BADSHAPE_RC" != "0" ] || { echo "[FAIL] --scan-secrets warn with a non-array ({Results:[]}) gitleaks report exited 0 — must not be treated as \"no findings\""; exit 1; }
printf '%s' "$BADSHAPE_ERR" | grep -qi "TypeError" && { echo "[FAIL] a malformed gitleaks report crashed with a raw TypeError instead of a clean error"; echo "$BADSHAPE_ERR"; exit 1; }
printf '%s' "$BADSHAPE_ERR" | grep -q "not the array-of-findings shape" || { echo "[FAIL] the error does not explain the report shape mismatch"; echo "$BADSHAPE_ERR"; exit 1; }
test ! -e "$TMP/badshape.age" || { echo "[FAIL] a snapshot was produced despite the malformed ({Results:[]}) gitleaks report"; exit 1; }

set +e
BADNULL_ERR=$(GITLEAKS_BADREPORT_BODY='null' CYPHER_BRAIN_GITLEAKS_BIN="$STUBBIN/gitleaks-badreport" CYPHER_BRAIN_HOME="$TMP/keys" \
  cb snapshot --dir "$BADREPORT_SRC" --out "$TMP/badnull.age" --scan-secrets warn 2>&1); BADNULL_RC=$?
set -e
[ "$BADNULL_RC" != "0" ] || { echo "[FAIL] --scan-secrets warn with a \"null\" gitleaks report exited 0"; exit 1; }
printf '%s' "$BADNULL_ERR" | grep -q "not the array-of-findings shape" || { echo "[FAIL] a null report body was not caught by the shape check"; echo "$BADNULL_ERR"; exit 1; }
test ! -e "$TMP/badnull.age" || { echo "[FAIL] a snapshot was produced despite a null gitleaks report"; exit 1; }
echo "[PASS] a gitleaks report that parses as JSON but isn't an array of findings (a wrapped object, or null) fails closed with a clear shape-mismatch error, never an unhandled crash"

echo "== #267: a missing path is reported the same way by every command, and never as a decrypt failure =="
# One mistyped path, five commands. Before #267 this produced three different answers:
# push/estimate said "no such file", verify and snapshot --dir leaked the raw Node
# errno text, and restore reported "age decrypt failed: … [CB-E002]" — a code
# MANAGEMENT.md documents as "wrong identity, or a corrupt/truncated artifact", i.e.
# it sent a typo straight into a key audit.
MISSING_IN="$TMP/definitely-not-here.age"
MISSING_DIR="$TMP/definitely-not-a-dir"
test ! -e "$MISSING_IN" || { echo "[FAIL] the fixture path exists — the test would prove nothing"; exit 1; }
check_missing_path() { # <label> <expected substring> <cb args...>
  local label="$1" expect="$2"; shift 2
  set +e
  local out; out=$(cb "$@" 2>&1 >/dev/null); local rc=$?
  set -e
  [ "$rc" != "0" ] || { echo "[FAIL] $label exited 0 for a path that does not exist"; echo "$out"; exit 1; }
  # -F: $expect embeds a mktemp path, which can carry regex metacharacters
  printf '%s' "$out" | grep -Fq -- "$expect" \
    || { echo "[FAIL] $label did not report '$expect'"; echo "$out"; exit 1; }
  # The raw Node errno text and the misleading decrypt code must both be gone.
  # `if` (not `grep -q … && { … }`): a NON-match is the passing case here, and a
  # non-matching `a && b` list returns non-zero, which under `set -e` would abort
  # this function mid-check instead of passing it — see rules/shell-ops.
  if printf '%s' "$out" | grep -q 'ENOENT'; then
    echo "[FAIL] $label still leaks the raw Node ENOENT string"; echo "$out"; exit 1
  fi
  if printf '%s' "$out" | grep -q 'CB-E002'; then
    echo "[FAIL] $label blames a missing path on age decryption (CB-E002)"; echo "$out"; exit 1
  fi
  return 0
}
check_missing_path "verify --in"   "no such file: $MISSING_IN"            verify --in "$MISSING_IN"
check_missing_path "estimate --in" "no such file: $MISSING_IN"            estimate --in "$MISSING_IN" --backend file
check_missing_path "push --in"     "no such file: $MISSING_IN"            push --in "$MISSING_IN" --backend file
check_missing_path "restore --in"  "no such file: $MISSING_IN"            restore --in "$MISSING_IN" --out-dir "$TMP/missing-restore-out"
check_missing_path "snapshot --dir" "no such snapshot source: $MISSING_DIR" snapshot --out "$TMP/missing.age" --dir "$MISSING_DIR"
# --dry-run resolves sources on its own path; it must fail the same way
check_missing_path "snapshot --dry-run --dir" "no such snapshot source: $MISSING_DIR" snapshot --dry-run --dir "$MISSING_DIR"
test ! -e "$TMP/missing.age" || { echo "[FAIL] snapshot wrote --out despite a missing source"; exit 1; }
test ! -e "$TMP/missing-restore-out" || { echo "[FAIL] restore created --out-dir despite a missing --in"; exit 1; }
echo "[PASS] verify/estimate/push/restore/snapshot all name the missing path, with no raw ENOENT and no CB-E002 misdiagnosis"

# The check must NOT follow symlinks: a DANGLING top-level symlink is a source
# snapshot deliberately archives (as a symlink entry), so an access()-based check
# here would break it. Guards the requirePath-vs-requireFile distinction.
ln -s "$TMP/target-that-does-not-exist" "$TMP/dangling-source"
cb snapshot --out "$TMP/dangling.age" --dir "$TMP/dangling-source" >/dev/null 2>&1 \
  || { echo "[FAIL] a dangling top-level symlink source was rejected — #267's check must not follow symlinks"; exit 1; }
test -s "$TMP/dangling.age" || { echo "[FAIL] the dangling-symlink snapshot produced no artifact"; exit 1; }
echo "[PASS] a dangling top-level symlink source still snapshots (the missing-path check does not follow symlinks)"
# #301: and it must still snapshot with the DEFAULT scan on. `gitleaks dir` stats that
# dangling link and exits 1, so a default that failed closed would turn a supported source
# into a hard error. The default degrades to a loud "UNSCANNED" warning; an EXPLICIT
# request on the same source still refuses. This pair is the tripwire for that asymmetry.
if command -v gitleaks >/dev/null 2>&1; then
  DANGDEF_ERR=$(cb snapshot --out "$TMP/dangling-default.age" --dir "$TMP/dangling-source" 2>&1) \
    || { echo "[FAIL] the default scan turned a dangling-symlink source into a snapshot failure"; echo "$DANGDEF_ERR"; exit 1; }
  test -s "$TMP/dangling-default.age" || { echo "[FAIL] the dangling-symlink snapshot produced no artifact under the default scan"; exit 1; }
  printf '%s' "$DANGDEF_ERR" | grep -q 'UNSCANNED' \
    || { echo "[FAIL] the default scan skipped silently instead of saying the component went UNSCANNED"; echo "$DANGDEF_ERR"; exit 1; }
  # The console said UNSCANNED; the DURABLE artifact must not disagree. An empty
  # secrets_scan array would read as "scanned, found nothing" forever after.
  DANGDEF_OUT="$TMP/dangling-default-restored"
  cb restore --in "$TMP/dangling-default.age" --out-dir "$DANGDEF_OUT" >/dev/null 2>&1 \
    || { echo "[FAIL] could not restore the default-scan dangling snapshot to inspect its manifest"; exit 1; }
  node -e "
    const m = JSON.parse(require('node:fs').readFileSync('$DANGDEF_OUT/manifest.json', 'utf8'));
    const c = m.components.find((x) => /dangling/.test(x.name));
    if (!c) { console.error('no dangling component in manifest'); process.exit(1); }
    if (Array.isArray(c.secrets_scan)) { console.error('manifest records secrets_scan ' + JSON.stringify(c.secrets_scan) + ' for a component whose scan could not run — that reads as a clean scan'); process.exit(1); }
    if (typeof c.secrets_scan_error !== 'string' || c.secrets_scan_error.length === 0) { console.error('manifest does not record WHY the component went unscanned: ' + JSON.stringify(c)); process.exit(1); }
  " || { echo "[FAIL] the manifest of a default-scanned-but-unscannable component is not honest about it"; exit 1; }
  set +e
  DANGEXP_ERR=$(cb snapshot --out "$TMP/dangling-explicit.age" --dir "$TMP/dangling-source" --scan-secrets warn 2>&1); DANGEXP_RC=$?
  set -e
  [ "$DANGEXP_RC" != "0" ] || { echo "[FAIL] an EXPLICIT --scan-secrets warn on an unscannable source exited 0"; echo "$DANGEXP_ERR"; exit 1; }
  test ! -e "$TMP/dangling-explicit.age" || { echo "[FAIL] the refused explicit scan still wrote a snapshot"; exit 1; }
  echo "[PASS] a scanner error degrades the DEFAULT to a loud unscanned warning, while an EXPLICIT --scan-secrets still fails closed"
else
  echo "[SKIP] #301 default-scan degradation on a dangling symlink: no gitleaks on PATH"
fi

# An UNREADABLE path is not a missing one: relabelling EACCES as "no such file" would
# be the same misdiagnosis this issue is about, one level down, so requireFile only
# converts ENOENT/ENOTDIR. Skipped when the sandbox cannot actually deny access (root).
NOACC="$TMP/noaccess"; mkdir -p "$NOACC"; echo x >"$NOACC/f.age"; chmod 000 "$NOACC"
if cat "$NOACC/f.age" >/dev/null 2>&1; then
  chmod 755 "$NOACC"
  echo "[SKIP] EACCES check: this user can read a 0000 directory (running as root?) — cannot deny access to test it"
else
  set +e
  NOACC_ERR=$(cb verify --in "$NOACC/f.age" 2>&1 >/dev/null); NOACC_RC=$?
  set -e
  chmod 755 "$NOACC"
  [ "$NOACC_RC" != "0" ] || { echo "[FAIL] verify exited 0 on an unreadable path"; exit 1; }
  if printf '%s' "$NOACC_ERR" | grep -Fq 'no such file'; then
    echo "[FAIL] an unreadable (EACCES) path was reported as missing"; echo "$NOACC_ERR"; exit 1
  fi
  printf '%s' "$NOACC_ERR" | grep -Fq 'EACCES' \
    || { echo "[FAIL] the unreadable-path error does not mention EACCES"; echo "$NOACC_ERR"; exit 1; }
  echo "[PASS] an unreadable (EACCES) path reports permission denied, not 'no such file'"
fi

echo
echo "SELFTEST PASS"
