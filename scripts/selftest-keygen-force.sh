#!/usr/bin/env bash
# Selftest for issue #786: `keygen --force` (and `keygen --sign --force`) replace the
# private identity and its paired public key/recipient with TWO SEPARATE
# writeKeyFile() calls. Each individual call is already atomic on its own
# (write-new-then-rename, #122) — but the two calls together were NOT atomic as a
# pair: the OLD order wrote the PRIVATE identity FIRST, so a failure in the SECOND
# (public) write left the brand-new private key already in place with no way back to
# the old one — the old identity gone, every snapshot it could decrypt permanently
# unrecoverable, while the OLD recipient.txt (now mismatched) survived untouched.
#
# The fix (src/lib/keys.ts keygenAt(), src/lib/minisign.ts keygenSignAt()) is two
# parts, both exercised below:
#   (1) write order reversed — PUBLIC file first, PRIVATE identity LAST — so a
#       failure in either write leaves the OLD private identity untouched.
#   (2) an unconditional backup of the OLD identity (backupIdentityFile(), keys.ts)
#       written right before either file is touched, whenever --force is about to
#       replace an EXISTING identity — the safety net for the case BOTH writes
#       succeed (an ordinary, successful --force run still discards the old
#       identity the instant it completes).
#
# Covers, in order:
#   (a) fault injection (recipient.txt replaced by a directory, blocking its own
#       write): keygen --force fails, but the OLD identity.age is byte-identical to
#       before, AND still restores a snapshot taken before the failed --force —
#       this is the exact scenario #786 reports (simulated failure instead of a
#       real EACCES/ENOSPC/signal, same effect: the second write never completes).
#   (b) a normal, SUCCESSFUL keygen --force creates a backup of the OLD identity —
#       byte-identical, mode 0600, exclusive path — and ONLY that backup (not the
#       new default identity.age) can still restore the pre-force snapshot.
#   (c)/(d) the SAME two cases, mirrored for `keygen --sign --force`
#       (src/lib/minisign.ts keygenSignAt() — sibling code, sibling fix, #786).
#   (e) a FRESH `keygen` (no pre-existing identity) never creates a backup file —
#       the unconditional-whenever-force-replaces-an-EXISTING-identity gate must
#       not fire when there is nothing to protect yet.
#   (g) `doctor`'s identity-backup-accumulation check (#811 follow-up): SKIP with
#       none, WARN once one exists (naming the count, the oldest date, and the
#       exact "safe to delete" condition), and the count keeps up as more pile up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb(), sha(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"
trap 'chmod -R u+rwX "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

for _leaked in $(env | sed -n 's/^\(CYPHER_BRAIN_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$_leaked"; done
unset _leaked

SRC="$TMP/src"; mkdir -p "$SRC"; echo "brain data" >"$SRC/note.txt"

echo "== (a) recipient.txt replaced by a directory blocks its OWN write — the OLD identity must survive byte-identical AND still restore a pre-force snapshot =="
export CYPHER_BRAIN_HOME="$TMP/home-a"
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap-a.age" >/dev/null
ORIG_SHA="$(sha "$CYPHER_BRAIN_HOME/identity.age")"
rm -f "$CYPHER_BRAIN_HOME/recipient.txt"
mkdir -p "$CYPHER_BRAIN_HOME/recipient.txt" # a directory sitting where the file goes
RC=0
cb keygen --force >"$TMP/a.log" 2>&1 || RC=$?
[ "$RC" != "0" ] || { echo "[FAIL] keygen --force succeeded despite recipient.txt being a directory"; cat "$TMP/a.log"; exit 1; }
[ "$(sha "$CYPHER_BRAIN_HOME/identity.age")" = "$ORIG_SHA" ] \
  || { echo "[FAIL] the OLD identity was lost/modified by a --force run whose SECOND write (recipient) failed — the #786 regression"; exit 1; }
rmdir "$CYPHER_BRAIN_HOME/recipient.txt" 2>/dev/null || { echo "[FAIL] test setup: recipient.txt directory was not empty (unexpected)"; exit 1; }
cb restore --in "$TMP/snap-a.age" --out-dir "$TMP/restored-a" >/dev/null
RESTORED_NOTE_A="$(find "$TMP/restored-a/expanded" -name note.txt 2>/dev/null | head -n1)"
[ -n "$RESTORED_NOTE_A" ] && [ "$(cat "$RESTORED_NOTE_A")" = "brain data" ] \
  || { echo "[FAIL] the pre-force snapshot no longer restores with the (untouched) OLD identity"; exit 1; }
echo "[PASS] a failed --force (recipient write blocked) leaves the OLD identity byte-identical and still able to restore a pre-force snapshot"

echo "== (b) a SUCCESSFUL keygen --force backs up the OLD identity (byte-identical, mode 0600) — only the backup, not the new default identity, restores the pre-force snapshot =="
export CYPHER_BRAIN_HOME="$TMP/home-b"
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap-b.age" >/dev/null
ORIG_SHA_B="$(sha "$CYPHER_BRAIN_HOME/identity.age")"
OUT_B="$(cb keygen --force)"
BACKUP_PATH="$(printf '%s\n' "$OUT_B" | sed -n 's/^old identity backed up to: //p')"
[ -n "$BACKUP_PATH" ] || { echo "[FAIL] expected an 'old identity backed up to: ...' line in keygen --force output"; echo "$OUT_B"; exit 1; }
test -f "$BACKUP_PATH" || { echo "[FAIL] the announced backup path does not exist: $BACKUP_PATH"; exit 1; }
[ "$(sha "$BACKUP_PATH")" = "$ORIG_SHA_B" ] || { echo "[FAIL] the backup is not byte-identical to the OLD identity"; exit 1; }
BACKUP_MODE="$(stat -c '%a' "$BACKUP_PATH" 2>/dev/null || stat -f '%Lp' "$BACKUP_PATH")"
[ "$BACKUP_MODE" = "600" ] || { echo "[FAIL] the backup is mode $BACKUP_MODE, expected 600"; exit 1; }
# Explicit existence check first (same reasoning as selftest-pq.sh's own guard,
# scripts/selftest-lib.sh#sha): sha() returns "" for a missing file, and "" is always
# != a real hash — so without this, a --force that deleted identity.age WITHOUT writing
# a replacement would wrongly satisfy this "!=" check and read as a successful replace.
test -f "$CYPHER_BRAIN_HOME/identity.age" || { echo "[FAIL] --force left no identity.age at all (deleted without replacing)"; exit 1; }
[ "$(sha "$CYPHER_BRAIN_HOME/identity.age")" != "$ORIG_SHA_B" ] || { echo "[FAIL] --force did not actually replace the identity"; exit 1; }
RC=0
cb restore --in "$TMP/snap-b.age" --out-dir "$TMP/restored-b-new" >"$TMP/b-new.log" 2>&1 || RC=$?
[ "$RC" != "0" ] || { echo "[FAIL] the NEW (post-force) default identity restored a snapshot only the OLD identity should be able to decrypt"; exit 1; }
cb restore --in "$TMP/snap-b.age" --out-dir "$TMP/restored-b-backup" --identity "$BACKUP_PATH" >/dev/null
RESTORED_NOTE_B="$(find "$TMP/restored-b-backup/expanded" -name note.txt 2>/dev/null | head -n1)"
[ -n "$RESTORED_NOTE_B" ] && [ "$(cat "$RESTORED_NOTE_B")" = "brain data" ] \
  || { echo "[FAIL] the backed-up OLD identity did not restore the pre-force snapshot"; exit 1; }
echo "[PASS] a successful --force writes a byte-identical, mode-0600 backup of the OLD identity, which alone restores the pre-force snapshot"

echo "== (c) keygen --sign --force: sign-recipient.pub replaced by a directory blocks its OWN write — the OLD sign-identity.key must survive byte-identical =="
export CYPHER_BRAIN_HOME="$TMP/home-c"
cb keygen --sign >/dev/null
ORIG_SIGN_SHA="$(sha "$CYPHER_BRAIN_HOME/sign-identity.key")"
rm -f "$CYPHER_BRAIN_HOME/sign-recipient.pub"
mkdir -p "$CYPHER_BRAIN_HOME/sign-recipient.pub"
RC=0
cb keygen --sign --force >"$TMP/c.log" 2>&1 || RC=$?
[ "$RC" != "0" ] || { echo "[FAIL] keygen --sign --force succeeded despite sign-recipient.pub being a directory"; cat "$TMP/c.log"; exit 1; }
[ "$(sha "$CYPHER_BRAIN_HOME/sign-identity.key")" = "$ORIG_SIGN_SHA" ] \
  || { echo "[FAIL] the OLD signing identity was lost/modified by a --force run whose SECOND write (sign-recipient) failed — the #786 regression, sibling of (a)"; exit 1; }
rmdir "$CYPHER_BRAIN_HOME/sign-recipient.pub" 2>/dev/null || { echo "[FAIL] test setup: sign-recipient.pub directory was not empty (unexpected)"; exit 1; }
echo "[PASS] a failed --sign --force (sign-recipient write blocked) leaves the OLD signing identity byte-identical"

echo "== (d) a SUCCESSFUL keygen --sign --force backs up the OLD signing identity (byte-identical, mode 0600) =="
export CYPHER_BRAIN_HOME="$TMP/home-d"
cb keygen --sign >/dev/null
ORIG_SIGN_SHA_D="$(sha "$CYPHER_BRAIN_HOME/sign-identity.key")"
OUT_D="$(cb keygen --sign --force)"
SIGN_BACKUP_PATH="$(printf '%s\n' "$OUT_D" | sed -n 's/^old signing identity backed up to: //p')"
[ -n "$SIGN_BACKUP_PATH" ] || { echo "[FAIL] expected an 'old signing identity backed up to: ...' line"; echo "$OUT_D"; exit 1; }
test -f "$SIGN_BACKUP_PATH" || { echo "[FAIL] the announced signing backup path does not exist: $SIGN_BACKUP_PATH"; exit 1; }
[ "$(sha "$SIGN_BACKUP_PATH")" = "$ORIG_SIGN_SHA_D" ] || { echo "[FAIL] the signing backup is not byte-identical to the OLD signing identity"; exit 1; }
SIGN_BACKUP_MODE="$(stat -c '%a' "$SIGN_BACKUP_PATH" 2>/dev/null || stat -f '%Lp' "$SIGN_BACKUP_PATH")"
[ "$SIGN_BACKUP_MODE" = "600" ] || { echo "[FAIL] the signing backup is mode $SIGN_BACKUP_MODE, expected 600"; exit 1; }
# Same "!=" guard as the identity check above: sha() on a missing file returns "",
# which is always != a real hash — check the file still exists before trusting "!=".
test -f "$CYPHER_BRAIN_HOME/sign-identity.key" || { echo "[FAIL] --sign --force left no sign-identity.key at all (deleted without replacing)"; exit 1; }
[ "$(sha "$CYPHER_BRAIN_HOME/sign-identity.key")" != "$ORIG_SIGN_SHA_D" ] || { echo "[FAIL] --sign --force did not actually replace the signing identity"; exit 1; }
echo "[PASS] a successful --sign --force writes a byte-identical, mode-0600 backup of the OLD signing identity"

echo "== (f) the recipient write (now FIRST) succeeds, then the identity write (now LAST) itself fails — old identity byte-identical, backup already made, pre-force snapshot still restores =="
# (a) above proves the FIRST write failing touches nothing. This proves the OTHER
# half of the reordering's guarantee: even once the recipient write has ALREADY
# succeeded, a failure in the SECOND (identity) write — the one that actually
# replaces the private key — still leaves the OLD identity byte-identical, because
# writeKeyFile()'s own write-new-then-rename atomicity (#122) never partially
# applies. Simulated via a filesystem-level immutable flag on identity.age itself
# (chflags uchg on macOS / chattr +i on Linux) rather than a directory permission,
# specifically because a directory-write block would ALSO block backupIdentityFile()
# and the recipient write, which sit in the SAME directory — an immutable flag on
# the file leaves both of those free to succeed while only the final rename() onto
# that exact path fails (verified: `stat`/`readFile` are unaffected by uchg/+i, only
# removing/replacing the entry is). Falls back to SKIP where neither is available
# without elevated privileges (this technique needs no root on macOS; Linux's
# chattr +i typically does) — the underlying atomicity is still covered generically
# by writeKeyFile()'s own #122 regression tests in scripts/selftest.sh, which apply
# to this exact code path regardless of which of the two files it targets.
export CYPHER_BRAIN_HOME="$TMP/home-f"
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap-f.age" >/dev/null
ORIG_SHA_F="$(sha "$CYPHER_BRAIN_HOME/identity.age")"
ORIG_RECIPIENT_F="$(cat "$CYPHER_BRAIN_HOME/recipient.txt")"
IMMUTABLE_UNDO=""
if chflags uchg "$CYPHER_BRAIN_HOME/identity.age" 2>/dev/null; then
  IMMUTABLE_UNDO="chflags nouchg"
elif chattr +i "$CYPHER_BRAIN_HOME/identity.age" 2>/dev/null; then
  IMMUTABLE_UNDO="chattr -i"
fi
if [ -z "$IMMUTABLE_UNDO" ]; then
  echo "[SKIP] (f) no portable, unprivileged way to make identity.age immutable on this OS/filesystem — writeKeyFile()'s atomicity for THIS exact write is still covered generically by scripts/selftest.sh's #122 regression tests"
else
  RC=0
  OUT_F=$(cb keygen --force 2>&1) || RC=$?
  $IMMUTABLE_UNDO "$CYPHER_BRAIN_HOME/identity.age" 2>/dev/null || true
  [ "$RC" != "0" ] || { echo "[FAIL] keygen --force succeeded despite an immutable identity.age"; echo "$OUT_F"; exit 1; }
  printf '%s\n' "$OUT_F" | grep -qi 'operation not permitted\|EPERM\|permission denied' \
    || { echo "[FAIL] expected an immutable-file (EPERM/operation not permitted) failure, got a different error"; echo "$OUT_F"; exit 1; }
  [ "$(sha "$CYPHER_BRAIN_HOME/identity.age")" = "$ORIG_SHA_F" ] \
    || { echo "[FAIL] the OLD identity was lost/modified when the SECOND write (identity, now last) failed — the exact #786 regression, this time on the write that was moved to be last"; exit 1; }
  [ "$(cat "$CYPHER_BRAIN_HOME/recipient.txt")" != "$ORIG_RECIPIENT_F" ] \
    || { echo "[FAIL] the recipient (FIRST write) never actually succeeded before the identity write failed — test setup did not exercise 'first succeeds, second fails'"; exit 1; }
  BACKUP_PATH_F="$(printf '%s\n' "$OUT_F" | sed -n 's/^old identity backed up to: //p')"
  [ -n "$BACKUP_PATH_F" ] || { echo "[FAIL] expected a backup to have been written before the (later) identity write failed"; echo "$OUT_F"; exit 1; }
  test -f "$BACKUP_PATH_F" || { echo "[FAIL] the announced backup path does not exist: $BACKUP_PATH_F"; exit 1; }
  [ "$(sha "$BACKUP_PATH_F")" = "$ORIG_SHA_F" ] || { echo "[FAIL] the backup made before the failed second write is not byte-identical to the OLD identity"; exit 1; }
  cb restore --in "$TMP/snap-f.age" --out-dir "$TMP/restored-f" >/dev/null
  RESTORED_NOTE_F="$(find "$TMP/restored-f/expanded" -name note.txt 2>/dev/null | head -n1)"
  [ -n "$RESTORED_NOTE_F" ] && [ "$(cat "$RESTORED_NOTE_F")" = "brain data" ] \
    || { echo "[FAIL] the pre-force snapshot no longer restores after the failed second (identity) write"; exit 1; }
  echo "[PASS] recipient write succeeded, THEN the identity write itself failed — old identity byte-identical, backup made before the failure, pre-force snapshot still restores"
fi

echo "== (e) a FRESH keygen (no pre-existing identity) never creates a backup file =="
export CYPHER_BRAIN_HOME="$TMP/home-e"
OUT_E="$(cb keygen)"
printf '%s\n' "$OUT_E" | grep -q 'backed up to' && { echo "[FAIL] a fresh keygen (nothing pre-existing) printed a backup line"; echo "$OUT_E"; exit 1; }
BAK_COUNT="$(find "$CYPHER_BRAIN_HOME" -maxdepth 1 -name '*.bak-*' 2>/dev/null | wc -l | tr -d ' ')"
[ "$BAK_COUNT" = "0" ] || { echo "[FAIL] a fresh keygen left $BAK_COUNT unexpected .bak-* file(s)"; exit 1; }
echo "[PASS] a fresh keygen (nothing pre-existing) creates no backup file"

echo "== (g) doctor's identity-backup-accumulation check (#811 follow-up): SKIP with none, WARN naming the count/oldest-date/safe-deletion-condition once backups pile up =="
export CYPHER_BRAIN_HOME="$TMP/home-g"
cb keygen >/dev/null
NONE_JSON="$(cb doctor --json || true)"
node -e "
const j = JSON.parse(process.argv[1]);
const c = j.checks.find((x) => x.id === 'identity-backup-accumulation');
if (!c || c.status !== 'skip') throw new Error('expected identity-backup-accumulation skip with no backups yet, got ' + JSON.stringify(c));
" "$NONE_JSON"
echo "[PASS] no backups yet: identity-backup-accumulation SKIPs"

cb keygen --force >/dev/null
ONE_JSON="$(cb doctor --json || true)"
node -e "
const j = JSON.parse(process.argv[1]);
const c = j.checks.find((x) => x.id === 'identity-backup-accumulation');
if (!c || c.status !== 'warn') throw new Error('expected identity-backup-accumulation warn after one --force, got ' + JSON.stringify(c));
if (!/^1 identity backup file\(s\)/.test(c.message)) throw new Error('expected the message to lead with the count 1: ' + c.message);
if (!c.message.includes('safe to delete once every snapshot encrypted to the OLD recipient')) {
  throw new Error('expected the exact safe-deletion condition in the message: ' + c.message);
}
if (!/oldest: \d{4}-\d{2}-\d{2}/.test(c.message)) throw new Error('expected an oldest: YYYY-MM-DD date in the message: ' + c.message);
" "$ONE_JSON"
echo "[PASS] one backup: identity-backup-accumulation WARNs naming the count (1), the oldest date, and the exact safe-deletion condition"

cb keygen --force >/dev/null
TWO_JSON="$(cb doctor --json || true)"
node -e "
const j = JSON.parse(process.argv[1]);
const c = j.checks.find((x) => x.id === 'identity-backup-accumulation');
if (!c || c.status !== 'warn') throw new Error('expected identity-backup-accumulation warn after two --force runs, got ' + JSON.stringify(c));
if (!/^2 identity backup file\(s\)/.test(c.message)) throw new Error('expected the message to lead with the count 2: ' + c.message);
" "$TWO_JSON"
BAK_COUNT_G="$(find "$CYPHER_BRAIN_HOME" -maxdepth 1 -name '*.bak-*' 2>/dev/null | wc -l | tr -d ' ')"
[ "$BAK_COUNT_G" = "2" ] || { echo "[FAIL] test setup: expected exactly 2 .bak-* files on disk, found $BAK_COUNT_G"; exit 1; }
echo "[PASS] a second --force: identity-backup-accumulation's count tracks it (2), matching the 2 .bak-* files actually on disk"

echo
echo "KEYGEN --FORCE ORDERING/BACKUP SELFTEST PASS"
