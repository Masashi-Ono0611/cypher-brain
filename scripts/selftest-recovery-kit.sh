#!/usr/bin/env bash
# `recovery-kit` selftest (#364): the standalone kit regeneration renders the
# SAME canonical kit init does (shared builder in src/lib/recoverykit.ts),
# pointed at the CURRENT push's locator. Uses REAL key material throughout —
# real `keygen --passphrase` wraps (binary scrypt ciphertext), and kits whose
# inlined identity blocks are extracted and driven through an actual restore
# (a marker-string fixture would codify exactly the sniff-level validation a
# review already rejected). Proves:
#   - the kit carries the exact save-locator line (locator + sha) of the push,
#   - --out writes 0600 and refuses an existing file without --force,
#   - --inline-identity REFUSES an unwrapped identity, and a REAL binary wrap
#     is re-armored into the kit — and the extracted block actually restores,
#   - --backup-identity inlines an unwrapped backup with a LOUD warning and a
#     correctly derived recipient — and the extracted block actually restores,
#   - a wrapped backup without --backup-recipient is refused; with it, the
#     re-armored block actually restores (with the passphrase),
#   - a snapshot pasted as an identity is refused (no scrypt stanza),
#   - a regenerated kit reports profile/Postgres as unknown, never guessed,
#   - missing flag / missing file / truncated locator line all fail closed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
HOME_DIR="$TMP/home"; BACKUP="$TMP/keys-backup"
PASS="kit-selftest-passphrase"
cb() { CYPHER_BRAIN_HOME="$HOME_DIR" CYPHER_BRAIN_FILE_DIR="$TMP/store" node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
cbh() { CYPHER_BRAIN_HOME="$1" CYPHER_BRAIN_FILE_DIR="$TMP/store" node "${BIN_DEV_ARGS[@]}" "$BIN" "${@:2}"; }

# Extract the lines between a kit's BEGIN/END markers (exclusive) into a file.
extract_block() { # $1=kit file, $2=BEGIN marker prefix, $3=out file
  awk -v b="$2" 'index($0, b) == 1 {on=1; next} on && /^END / {exit} on {print}' "$1" > "$3"
}

echo "== setup: primary + backup keypairs, snapshot to BOTH, push --backend file =="
cb keygen >/dev/null
cbh "$BACKUP" keygen >/dev/null
BACKUP_RECIPIENT="$(cat "$BACKUP/recipient.txt")"
SRC="$TMP/brain"; mkdir -p "$SRC"; printf 'kit-selftest-%s\n' "$RANDOM" > "$SRC/note.txt"
cb snapshot --dir "$SRC" --recipient "$HOME_DIR/recipient.txt" --recipient "$BACKUP/recipient.txt" \
  --out "$TMP/snap.age" >/dev/null
LOCF="$TMP/loc.tsv"
cb push --in "$TMP/snap.age" --backend file --save-locator "$LOCF" >/dev/null
LOCLINE="$(grep -v '^#' "$LOCF" | grep -m1 .)"

echo "== kit to stdout carries the exact save-locator line and unknown markers =="
KIT="$TMP/kit-stdout.txt"
cb recovery-kit --from-locator-file "$LOCF" > "$KIT"
grep -qF "$LOCLINE" "$KIT" || { echo "[FAIL] kit does not carry the save-locator line verbatim"; exit 1; }
grep -q 'CYPHER-BRAIN RECOVERY KIT' "$KIT" || { echo "[FAIL] kit header missing"; exit 1; }
grep -q 'not recorded — kit regenerated' "$KIT" || { echo "[FAIL] regenerated kit must mark profile unknown"; exit 1; }
grep -q 'Postgres dump: unknown' "$KIT" || { echo "[FAIL] regenerated kit must mark the pg column unknown"; exit 1; }
grep -q 'LOCATOR IS LOCAL-ONLY' "$KIT" || { echo "[FAIL] file-backend kit must carry the local-only warning"; exit 1; }
grep -q 'NO BACKUP IDENTITY IS IN THIS KIT' "$KIT" || { echo "[FAIL] no-backup kit must say kit-only recovery is impossible"; exit 1; }
echo "[PASS] stdout kit: verbatim locator line + honest unknown/local-only/no-backup marks"

echo "== --out writes 0600 and no-clobbers without --force =="
OUT="$TMP/kit.txt"
cb recovery-kit --from-locator-file "$LOCF" --out "$OUT" >/dev/null
# GNU first, BSD fallback — trying BSD `stat -f` FIRST does not error on Linux
# (GNU reads -f as filesystem status and exits 0 with junk), so the fallback
# never fires; same trap selftest-init.sh documents. Caught by ubuntu CI.
MODE="$(stat -c '%a' "$OUT" 2>/dev/null || stat -f '%Lp' "$OUT")"
[ "$MODE" = "600" ] || { echo "[FAIL] kit written with mode $MODE, expected 600"; exit 1; }
if cb recovery-kit --from-locator-file "$LOCF" --out "$OUT" >/dev/null 2>"$TMP/clobber.err"; then
  echo "[FAIL] second --out to the same path must refuse without --force"; exit 1
fi
grep -q 'refusing to overwrite' "$TMP/clobber.err" || { echo "[FAIL] no-clobber refusal must say why"; exit 1; }
cb recovery-kit --from-locator-file "$LOCF" --out "$OUT" --force >/dev/null
echo "[PASS] --out is 0600, no-clobber by default, --force overrides"

echo "== --inline-identity refuses an UNWRAPPED identity (the guard, #364) =="
if cb recovery-kit --from-locator-file "$LOCF" --inline-identity >/dev/null 2>"$TMP/inline.err"; then
  echo "[FAIL] inlining a bare private key must be refused"; exit 1
fi
grep -q 'NOT passphrase-wrapped' "$TMP/inline.err" || { echo "[FAIL] refusal must name the wrap requirement"; exit 1; }
echo "[PASS] unwrapped primary is refused for --inline-identity"

echo "== --inline-identity: a REAL binary wrap is re-armored, and the block restores =="
WRAPPED_HOME="$TMP/home-wrapped"
CYPHER_BRAIN_PASSPHRASE="$PASS" cbh "$WRAPPED_HOME" keygen --passphrase >/dev/null
# encrypt a snapshot to THIS identity so the extracted block can prove itself
cbh "$WRAPPED_HOME" snapshot --dir "$SRC" --out "$TMP/snap-wrapped.age" >/dev/null
WLOCF="$TMP/loc-wrapped.tsv"
cbh "$WRAPPED_HOME" push --in "$TMP/snap-wrapped.age" --backend file --save-locator "$WLOCF" >/dev/null
WKIT="$TMP/kit-wrapped.txt"
cbh "$WRAPPED_HOME" recovery-kit --from-locator-file "$WLOCF" --inline-identity > "$WKIT"
grep -q 'BEGIN PRIMARY IDENTITY FILE' "$WKIT" || { echo "[FAIL] wrapped identity was not inlined"; exit 1; }
grep -q -- '-----BEGIN AGE ENCRYPTED FILE-----' "$WKIT" || { echo "[FAIL] binary wrap must be re-armored into printable form"; exit 1; }
extract_block "$WKIT" 'BEGIN PRIMARY IDENTITY FILE' "$TMP/extracted-primary.age"
CYPHER_BRAIN_PASSPHRASE="$PASS" cbh "$WRAPPED_HOME" restore --in "$TMP/snap-wrapped.age" \
  --out-dir "$TMP/r-inline" --identity "$TMP/extracted-primary.age" >/dev/null
tar -xzf "$TMP/r-inline/brain.tar.gz" -C "$TMP/r-inline"
diff -r "$SRC" "$TMP/r-inline/brain" >/dev/null || { echo "[FAIL] kit-extracted primary did not restore the snapshot"; exit 1; }
echo "[PASS] real binary wrap inlines armored, and the EXTRACTED block restores"

echo "== --backup-identity: unwrapped inlines with a LOUD warning + derived recipient, and restores =="
BKIT="$TMP/kit-backup.txt"
cb recovery-kit --from-locator-file "$LOCF" --backup-identity "$BACKUP/identity.age" > "$BKIT" 2>"$TMP/backup.err"
grep -q 'BEGIN BACKUP IDENTITY FILE' "$BKIT" || { echo "[FAIL] backup identity was not inlined"; exit 1; }
grep -qF "$BACKUP_RECIPIENT" "$BKIT" || { echo "[FAIL] the kit must carry the backup's OWN derived recipient (not just the primary's)"; exit 1; }
grep -q 'NOT passphrase-wrapped' "$TMP/backup.err" || { echo "[FAIL] unwrapped backup must warn on stderr"; exit 1; }
extract_block "$BKIT" 'BEGIN BACKUP IDENTITY FILE' "$TMP/extracted-backup.age"
cb restore --in "$TMP/snap.age" --out-dir "$TMP/r-backup" --identity "$TMP/extracted-backup.age" >/dev/null
tar -xzf "$TMP/r-backup/brain.tar.gz" -C "$TMP/r-backup"
diff -r "$SRC" "$TMP/r-backup/brain" >/dev/null || { echo "[FAIL] kit-extracted backup did not restore the snapshot"; exit 1; }
echo "[PASS] unwrapped backup: loud warning, derived recipient, extracted block restores"

echo "== --backup-identity: a REAL wrapped backup needs --backup-recipient, then restores =="
WB_HOME="$TMP/home-wb"
CYPHER_BRAIN_PASSPHRASE="$PASS" cbh "$WB_HOME" keygen --passphrase >/dev/null
if cb recovery-kit --from-locator-file "$LOCF" --backup-identity "$WB_HOME/identity.age" >/dev/null 2>"$TMP/wb.err"; then
  echo "[FAIL] wrapped backup without --backup-recipient must be refused"; exit 1
fi
grep -q 'backup-recipient' "$TMP/wb.err" || { echo "[FAIL] refusal must name --backup-recipient"; exit 1; }
# a snapshot encrypted to the wrapped backup's recipient proves the round trip
cb snapshot --dir "$SRC" --recipient "$WB_HOME/recipient.txt" --out "$TMP/snap-wb.age" >/dev/null
WBKIT="$TMP/kit-wb.txt"
cb recovery-kit --from-locator-file "$LOCF" --backup-identity "$WB_HOME/identity.age" \
  --backup-recipient "$WB_HOME/recipient.txt" > "$WBKIT"
grep -q -- '-----BEGIN AGE ENCRYPTED FILE-----' "$WBKIT" || { echo "[FAIL] wrapped binary backup must be re-armored"; exit 1; }
extract_block "$WBKIT" 'BEGIN BACKUP IDENTITY FILE' "$TMP/extracted-wb.age"
CYPHER_BRAIN_PASSPHRASE="$PASS" cb restore --in "$TMP/snap-wb.age" \
  --out-dir "$TMP/r-wb" --identity "$TMP/extracted-wb.age" >/dev/null
tar -xzf "$TMP/r-wb/brain.tar.gz" -C "$TMP/r-wb"
diff -r "$SRC" "$TMP/r-wb/brain" >/dev/null || { echo "[FAIL] kit-extracted wrapped backup did not restore"; exit 1; }
echo "[PASS] wrapped backup: refused without recipient; with it, re-armored block restores"

echo "== an armored SNAPSHOT pasted as an identity is refused (no scrypt stanza) =="
node "${BIN_DEV_ARGS[@]}" -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  import { armor } from 'age-encryption';
  writeFileSync(process.argv[2], armor.encode(new Uint8Array(readFileSync(process.argv[1]))));
" "$TMP/snap.age" "$TMP/fake-identity.age"
if cb recovery-kit --from-locator-file "$LOCF" --backup-identity "$TMP/fake-identity.age" \
  --backup-recipient "$BACKUP/recipient.txt" >/dev/null 2>"$TMP/fake.err"; then
  echo "[FAIL] an armored snapshot must not pass as a backup identity"; exit 1
fi
grep -q 'no scrypt stanza' "$TMP/fake.err" || { echo "[FAIL] refusal must explain the scrypt-stanza check"; exit 1; }
echo "[PASS] recipient-ciphertext (a snapshot) is refused as an identity"

echo "== a forged '-> scrypt' marker AFTER the first stanza does not fool the classifier =="
# Codex round-2: an anchored first-stanza check, not a substring scan — recipient
# ciphertext with an scrypt-looking sequence later in the bytes must NOT classify
# as a passphrase wrap (it would produce a kit whose block no passphrase unwraps).
node "${BIN_DEV_ARGS[@]}" -e "
  import { readFileSync, writeFileSync } from 'node:fs';
  const snap = readFileSync(process.argv[1]);
  writeFileSync(process.argv[2], Buffer.concat([snap, Buffer.from('\n-> scrypt forged 18\n')]));
" "$TMP/snap.age" "$TMP/forged-identity.age"
if cb recovery-kit --from-locator-file "$LOCF" --backup-identity "$TMP/forged-identity.age" \
  --backup-recipient "$BACKUP/recipient.txt" >/dev/null 2>"$TMP/forged.err"; then
  echo "[FAIL] recipient ciphertext with a forged later scrypt marker must be refused"; exit 1
fi
grep -q 'no scrypt stanza' "$TMP/forged.err" || { echo "[FAIL] forged file must be classified as recipient ciphertext"; exit 1; }
echo "[PASS] forged post-header scrypt marker still classifies as recipient ciphertext"

echo "== missing flag / missing file / truncated locator all fail closed =="
if cb recovery-kit --from-locator-file "$TMP/nope.tsv" >/dev/null 2>"$TMP/nope.err"; then
  echo "[FAIL] a missing locator file must be an error"; exit 1
fi
grep -q 'has no locator line' "$TMP/nope.err" || { echo "[FAIL] the missing-file error must say the file has no locator line"; cat "$TMP/nope.err"; exit 1; }
if cb recovery-kit >/dev/null 2>"$TMP/noflag.err"; then
  echo "[FAIL] recovery-kit without --from-locator-file must be an error"; exit 1
fi
grep -q 'from-locator-file' "$TMP/noflag.err" || { echo "[FAIL] the error must name the missing flag"; exit 1; }
: > "$TMP/empty.tsv"
if cb recovery-kit --from-locator-file "$TMP/empty.tsv" >/dev/null 2>"$TMP/empty.err"; then
  echo "[FAIL] an empty locator file must be an error"; exit 1
fi
grep -q 'has no locator line' "$TMP/empty.err" || { echo "[FAIL] the empty-file error must say the file has no locator line"; cat "$TMP/empty.err"; exit 1; }
printf 'only-one-field\n' > "$TMP/truncated.tsv"
if cb recovery-kit --from-locator-file "$TMP/truncated.tsv" >/dev/null 2>"$TMP/trunc.err"; then
  echo "[FAIL] a locator line without a backend column must be an error"; exit 1
fi
grep -q 'backend' "$TMP/trunc.err" || { echo "[FAIL] the truncation error must name the missing column"; exit 1; }
if cb recovery-kit --from-locator-file "$LOCF" --backup-recipient "$BACKUP/recipient.txt" >/dev/null 2>"$TMP/orphan.err"; then
  echo "[FAIL] --backup-recipient without --backup-identity must be an error"; exit 1
fi
grep -q 'backup-identity' "$TMP/orphan.err" || { echo "[FAIL] the orphan-flag error must name --backup-identity"; exit 1; }
echo "[PASS] fails closed: missing flag, missing/empty/truncated file, orphan --backup-recipient"

echo
echo "RECOVERY-KIT SELFTEST: PASS"
