#!/usr/bin/env bash
# Restore security proof (#218): a forged/malicious tar archive — not merely a forged
# manifest.json field, which PR #198 already covers — must be REJECTED before restore
# writes a single byte, and a legitimate archive (including the symlink/hardlink shapes
# snapshot() itself deliberately produces) must still restore correctly.
#
# Threat model reminder (see the comment above inspectRestoreArchive() in
# src/lib/restore.ts): age is public-key encryption, so anyone holding a recipient's
# PUBLIC key can construct ciphertext encrypted to it and hand it over claiming to be
# "your backup" — a forged/malicious TAR PAYLOAD inside such ciphertext is something
# restore must defend against, the same way #198 already made it defend against a forged
# manifest.json.
#
# Each malicious case below is built as a real tar with Python's stdlib `tarfile` module
# (scripts/restore-security-fixtures.py — precise control over path-traversal/absolute-
# path/symlink/hardlink/FIFO/device entries that the `tar` CLI itself will not construct
# on request), wrapped into age ciphertext with the REAL age binary
# (`age -r <recipient> -o out.age in.tar`, the same technique scripts/selftest-interop.sh
# already uses to prove typage<->binary interop) addressed to a keypair this script
# controls, and then handed to `cypher-brain restore`.
#
# Auto-SKIPs (exit 0) when the `age` binary is absent — same posture as
# selftest-interop.sh, which needs it for the identical reason (constructing ciphertext
# outside the CLI's own snapshot() path).
set -euo pipefail

if ! command -v age >/dev/null 2>&1; then
  echo "[SKIP] restore-security selftest: no \`age\` binary on PATH — install age (brew/apt) to exercise this"
  exit 0
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[SKIP] restore-security selftest: no \`python3\` on PATH — needed to craft malicious tar entries"
  exit 0
fi

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

cb keygen >/dev/null
RECIPIENT="$(cat "$CYPHER_BRAIN_HOME/recipient.txt")"

# Build a raw tar of shape $2 (a CB_TAR_SHAPE the python helper switches on) at $1, then
# wrap it into age ciphertext at $3.
make_age() {
  out_tar="$1"; shape="$2"; out_age="$3"
  CB_TAR_OUT="$out_tar" CB_TAR_SHAPE="$shape" python3 "$ROOT/scripts/restore-security-fixtures.py"
  age -r "$RECIPIENT" -o "$out_age" "$out_tar"
}

# Assert `cb restore` REJECTS $1 (an age file) with an error mentioning $4, and that
# nothing was left behind: no --out-dir at $2, and no scratch directory sibling to it
# either (proves the isolated-scratch + atomic-promote design in restoreImpl never let a
# rejected archive touch disk). Prints its own [PASS]/[FAIL] and exits 1 on failure —
# deliberately NOT meant to be called inside a `$(...)` capture (a caller that did would
# swallow this function's own diagnostic output instead of letting it reach the console).
assert_restore_rejected() {
  # $5 (optional): a second acceptable substring — see the hardlink-escape call
  # below for why one case needs this.
  in_age="$1"; out_dir="$2"; label="$3"; expect_substr="$4"; expect_substr2="${5:-}"
  set +e
  ERR=$(cb restore --in "$in_age" --out-dir "$out_dir" 2>&1); RC=$?
  set -e
  if [ "$RC" = "0" ]; then
    echo "[FAIL] $label: restore succeeded, expected rejection"
    exit 1
  fi
  if [ -e "$out_dir" ]; then
    echo "[FAIL] $label: --out-dir was created despite rejection ($out_dir)"
    exit 1
  fi
  # shellcheck disable=SC2086 # deliberate glob, not a single path
  if compgen -G "${out_dir}.restore-*" >/dev/null; then
    echo "[FAIL] $label: a restore scratch directory was left behind (not cleaned up on rejection)"
    exit 1
  fi
  if ! printf '%s' "$ERR" | grep -qi -- "$expect_substr" \
    && { [ -z "$expect_substr2" ] || ! printf '%s' "$ERR" | grep -qi -- "$expect_substr2"; }; then
    echo "[FAIL] $label: error message did not contain the expected text ('$expect_substr'${expect_substr2:+ or '$expect_substr2'})"
    echo "$ERR"
    exit 1
  fi
  echo "[PASS] $label: rejected, no --out-dir, no scratch dir left behind"
}

echo "== malicious archives are rejected before anything is written =="

make_age "$TMP/m-traversal.tar" traversal "$TMP/m-traversal.age"
assert_restore_rejected "$TMP/m-traversal.age" "$TMP/out-traversal" "path traversal (..)" 'path traversal'

make_age "$TMP/m-absolute.tar" absolute "$TMP/m-absolute.age"
assert_restore_rejected "$TMP/m-absolute.age" "$TMP/out-absolute" "absolute path entry" 'absolute path'

make_age "$TMP/m-fifo.tar" fifo "$TMP/m-fifo.age"
assert_restore_rejected "$TMP/m-fifo.age" "$TMP/out-fifo" "FIFO entry" 'fifo entry'

make_age "$TMP/m-device.tar" device "$TMP/m-device.age"
assert_restore_rejected "$TMP/m-device.age" "$TMP/out-device" "device entry" 'device entry'

make_age "$TMP/m-hardlink.tar" hardlink-escape "$TMP/m-hardlink.age"
# GNU tar's OWN `-tv` listing already strips a hardlink target's leading `../` (with a
# `Removing leading '../../' from hard link targets` warning) before restore.ts's own
# inspection ever sees the line — see restore.ts's big top comment. So on GNU tar
# (Linux CI, most Linux desktops) validateRestoreEntries() never gets a chance to see
# the traversal and never throws its own message; the archive instead fails during the
# real `tar` extraction step itself (GNU tar refuses the now-relative-but-nonexistent
# hardlink target: "Cannot hard link to ... No such file or directory") -- rejected
# either way, just via a different, tar-flavor-owned message. bsdtar's `-tv` (macOS)
# shows the raw unsanitized target, so it IS caught by restore.ts's own check there.
assert_restore_rejected "$TMP/m-hardlink.age" "$TMP/out-hardlink" "hardlink target escapes the tree" \
  'hardlink target escapes' 'tar exited'

# The classic tar path-traversal-through-symlink attack (OWASP's page, #218's own
# citation): a symlink entry named "link" pointing outside the tree, followed by a LATER
# entry "link/pwned.txt" nested under it. If this ever slipped through, the payload would
# land at $TMP/escape-target/pwned.txt (the symlink's target) — assert that file is never
# created, not merely that the command exits non-zero.
mkdir -p "$TMP/escape-target"
CB_SYMLINK_TARGET="$TMP/escape-target" make_age "$TMP/m-symtraverse.tar" symlink-traverse "$TMP/m-symtraverse.age"
assert_restore_rejected "$TMP/m-symtraverse.age" "$TMP/out-symtraverse" "path-traversal-through-symlink" 'path-traversal-through-symlink'
[ ! -e "$TMP/escape-target/pwned.txt" ] || { echo "[FAIL] path-traversal-through-symlink actually wrote outside --out-dir"; exit 1; }
echo "[PASS] path-traversal-through-symlink did not write through the symlink's target"

echo
echo "== legitimate archives snapshot() itself deliberately produces still restore =="

# A plain file tree restores exactly as before (no false positive from the new inspection
# phase on ordinary content).
make_age "$TMP/c-plain.tar" plain "$TMP/c-plain.age"
cb restore --in "$TMP/c-plain.age" --out-dir "$TMP/out-plain" >/dev/null
[ "$(cat "$TMP/out-plain/note.txt")" = "plain-ok" ] || { echo "[FAIL] plain archive restore content mismatch"; exit 1; }
echo "[PASS] a plain file tree restores unchanged"

# snapshot.ts deliberately archives a dangling/absolute-target symlink AS-IS when a --dir
# source is itself a symlink (see restore.ts's own comment above validateRestoreEntries) —
# this must NOT be rejected just because its target is absolute; only a LATER entry
# nested under it is the attack.
make_age "$TMP/c-symlink.tar" symlink-standalone "$TMP/c-symlink.age"
cb restore --in "$TMP/c-symlink.age" --out-dir "$TMP/out-symlink" >/dev/null
[ -L "$TMP/out-symlink/dangling-link" ] || { echo "[FAIL] legitimate standalone symlink entry was not restored"; exit 1; }
echo "[PASS] a legitimate dangling absolute-target symlink entry restores unchanged"

# An in-tree hardlink to a sibling regular file (both same archive, relative names) is
# ordinary tar content with no traversal potential — must restore, not be rejected.
make_age "$TMP/c-hardlink.tar" hardlink-safe "$TMP/c-hardlink.age"
cb restore --in "$TMP/c-hardlink.age" --out-dir "$TMP/out-hardlink-safe" >/dev/null
[ "$(cat "$TMP/out-hardlink-safe/link.txt")" = "hardlink-ok" ] || { echo "[FAIL] legitimate in-tree hardlink did not restore"; exit 1; }
echo "[PASS] a legitimate in-tree hardlink restores unchanged"

echo
echo "== (p) a SECOND restore into an out-dir a symlink already lives in cannot merge through it (mergeNoClobber) =="

# First restore: a legitimate standalone symlink named "evil-link" pointing OUTSIDE
# out-dir (a real directory this script controls, not the archive's own tree).
OUTSIDE="$TMP/outside-target"
mkdir -p "$OUTSIDE"
CB_SYMLINK_TARGET="$OUTSIDE" make_age "$TMP/m-first.tar" merge-escape-symlink "$TMP/m-first.age"
OUT_MERGE="$TMP/out-merge"
cb restore --in "$TMP/m-first.age" --out-dir "$OUT_MERGE" >/dev/null
[ -L "$OUT_MERGE/evil-link" ] || { echo "[FAIL] first restore did not create the symlink setup for this test"; exit 1; }

# Second restore, into the SAME (now pre-existing) out-dir: an archive whose only entry
# is a file nested under a directory sharing the symlink's name. Before the fix,
# mergeNoClobber() followed exists()'s symlink-following stat and recursed straight
# through "evil-link" into $OUTSIDE, writing payload.txt there.
make_age "$TMP/m-second.tar" merge-escape-payload "$TMP/m-second.age"
cb restore --in "$TMP/m-second.age" --out-dir "$OUT_MERGE" >/dev/null
[ ! -e "$OUTSIDE/payload.txt" ] || { echo "[FAIL] mergeNoClobber wrote through the pre-existing symlink into \$OUTSIDE"; exit 1; }
[ -L "$OUT_MERGE/evil-link" ] || { echo "[FAIL] the pre-existing symlink itself was disturbed"; exit 1; }
echo "[PASS] mergeNoClobber refuses to recurse through a pre-existing symlink; no write escaped out-dir"

echo
echo "== (q) #784: mergeNoClobber() moves with exclusive-create primitives, not check-then-act rename() =="

# What this section proves and what it does NOT.
#
# The defect #784 fixes is a RACE: mergeNoClobber() used to decide a destination name was
# free with lstat() and then act on that decision with rename(), which REPLACES an
# existing destination — so anything created in between was silently overwritten. There is
# no in-process hook to widen that window from a shell script, so this section does not
# (and cannot honestly claim to) demonstrate the race closing. It proves the two things
# that ARE observable from out here:
#
#   1. the primitives the fix relies on behave on THIS filesystem as the fix assumes —
#      rename() replaces an occupied destination while link()/symlink()/mkdir() refuse it.
#      Without this, the fix would be an untested assumption about the platform.
#   2. rewriting the move from one rename() into per-kind link/symlink/mkdir did not
#      change any observable merge behaviour: every entry kind still lands, with content,
#      link-ness and directory modes intact, and a colliding name is still left untouched.
#      This is a regression guard for the rewrite; it passes on the pre-fix code too.

node -e '
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "cb-prim-"));
const fail = (m) => { console.error(m); process.exit(1); };
// rename() onto an occupied destination: silently replaces (this is the defect).
fs.writeFileSync(path.join(d, "s1"), "new"); fs.writeFileSync(path.join(d, "d1"), "OLD");
fs.renameSync(path.join(d, "s1"), path.join(d, "d1"));
if (fs.readFileSync(path.join(d, "d1"), "utf8") !== "new") fail("rename() did NOT replace an occupied destination — this platform does not match what the fix assumes");
// link() onto an occupied destination: EEXIST (this is the fix).
fs.writeFileSync(path.join(d, "s2"), "new"); fs.writeFileSync(path.join(d, "d2"), "OLD");
try { fs.linkSync(path.join(d, "s2"), path.join(d, "d2")); fail("link() replaced an occupied destination instead of failing EEXIST"); }
catch (e) { if (e.code !== "EEXIST") fail("link() onto an occupied destination failed with " + e.code + ", expected EEXIST"); }
if (fs.readFileSync(path.join(d, "d2"), "utf8") !== "OLD") fail("link() disturbed the occupied destination");
// symlink() and mkdir() onto an occupied destination: EEXIST.
try { fs.symlinkSync("whatever", path.join(d, "d2")); fail("symlink() replaced an occupied destination"); }
catch (e) { if (e.code !== "EEXIST") fail("symlink() failed with " + e.code + ", expected EEXIST"); }
try { fs.mkdirSync(path.join(d, "d2")); fail("mkdir() replaced an occupied destination"); }
catch (e) { if (e.code !== "EEXIST") fail("mkdir() failed with " + e.code + ", expected EEXIST"); }
fs.rmSync(d, { recursive: true, force: true });
' || { echo "[FAIL] the exclusive-create primitives mergeNoClobber() now relies on do not behave as assumed on this filesystem"; exit 1; }
echo "[PASS] positive control: rename() replaces an occupied destination here; link()/symlink()/mkdir() refuse it with EEXIST"

# Contract regression: two restores into the same out-dir, the second one merging.
make_age "$TMP/mc-first.tar" merge-contract-first "$TMP/mc-first.age"
make_age "$TMP/mc-second.tar" merge-contract-second "$TMP/mc-second.age"
OUT_MC="$TMP/out-merge-contract"
cb restore --in "$TMP/mc-first.age" --out-dir "$OUT_MC" >/dev/null
cb restore --in "$TMP/mc-second.age" --out-dir "$OUT_MC" >/dev/null
# The archive records newdir at 0500; read the mode the merge actually produced BEFORE
# widening anything, then widen so a failure below cannot also break this script's own
# EXIT trap (removing entries under a 0500 directory needs write on it).
MC_MODE=$(node -e 'process.stdout.write((require("node:fs").lstatSync(process.argv[1]).mode & 0o777).toString(8))' "$OUT_MC/newdir")
# Same for the directory's mtime: the old whole-directory rename() carried the archive's
# timestamps along with the inode, mkdir() does not. The fixtures record epoch-0 mtimes,
# so an unrestored timestamp shows up as "now" — decades away, no tolerance needed.
MC_MTIME=$(node -e 'process.stdout.write(String(Math.round(require("node:fs").lstatSync(process.argv[1]).mtimeMs)))' "$OUT_MC/newdir")
chmod -R u+rwX "$OUT_MC"

[ "$(cat "$OUT_MC/collide.txt")" = "ORIGINAL-MUST-SURVIVE" ] \
  || { echo "[FAIL] the merge overwrote a name that already existed in out-dir"; exit 1; }
[ "$(cat "$OUT_MC/keep/fresh.txt")" = "merged-into-existing-dir" ] \
  || { echo "[FAIL] a new file was not merged into a directory that existed on both sides"; exit 1; }
[ "$(cat "$OUT_MC/keep/existing.txt")" = "first-restore-content" ] \
  || { echo "[FAIL] the first restore's file inside the merged directory was disturbed"; exit 1; }
[ "$(cat "$OUT_MC/newdir/nested/deep.txt")" = "deep-merged" ] \
  || { echo "[FAIL] a new nested directory tree did not survive the merge"; exit 1; }
[ -L "$OUT_MC/newlink" ] || { echo "[FAIL] a symlink entry was not recreated as a symlink by the merge"; exit 1; }
[ "$(readlink "$OUT_MC/newlink")" = "keep/existing.txt" ] \
  || { echo "[FAIL] the merged symlink points at $(readlink "$OUT_MC/newlink"), expected keep/existing.txt"; exit 1; }
echo "[PASS] every entry kind still merges (new file, new nested tree, symlink) and a colliding name is still left untouched"

# The archive records newdir at 0500. The old code moved a not-yet-existing directory
# with one whole-tree rename(), which preserved that mode for free; the new code creates
# it with mkdir() and has to put the mode back deliberately, AFTER its children have been
# moved in (a 0500 directory cannot be written into). This is the assertion that catches
# it if that chmod is dropped or moved ahead of the recursion.
[ "$MC_MODE" = "500" ] \
  || { echo "[FAIL] the merged directory landed at mode 0$MC_MODE, expected 0500 (the mode the archive recorded)"; exit 1; }
echo "[PASS] the merged directory's recorded mode is applied to the destination, not left at the process umask"

[ "$MC_MTIME" = "0" ] \
  || { echo "[FAIL] the merged directory's mtime is $MC_MTIME ms, expected the archive's 0 (mkdir left it at 'now' instead of restoring it)"; exit 1; }
echo "[PASS] the merged directory keeps the archive's mtime, as the old whole-directory rename() did"

echo
echo "RESTORE-SECURITY SELFTEST PASS"
