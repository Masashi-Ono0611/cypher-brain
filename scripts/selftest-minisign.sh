#!/usr/bin/env bash
# Minisign-compatible authenticity signing round trip (#214): age proves confidentiality
# + tamper detection but NOT authenticity (a recipient public key is not secret, so
# anyone holding it can forge decryptable ciphertext) — `keygen --sign` generates a
# separate Ed25519 signing keypair, `snapshot` signs each *.age it writes, and
# restore/verify check that signature BEFORE decrypting. src/lib/minisign.ts implements
# ONLY the minisign wire SERIALIZATION itself (no new crypto primitive) — the actual
# signing/verification is Node's own built-in `crypto` Ed25519.
#
# This asserts, ALWAYS (no external dependency):
#   - keygen --sign writes a signing identity + public key
#   - snapshot auto-signs whenever a signing identity is present, writing <out>.minisig
#   - verify/restore both PASS and print the signature check when the .minisig is intact
#   - a tampered .minisig makes verify FAIL and restore REFUSE — before any decryption
#   - snapshot --no-sign / no signing key at all -> unsigned, backward-compatible (SKIP,
#     never FAIL) — the whole feature is additive
#   - push (file backend) uploads the .minisig sidecar alongside the ciphertext, and
#     pull --from-locator-file fetches it back automatically (the 6th --save-locator field)
#   - push --skip-unchanged re-evaluates SIGNING state, not just content + recipients
#     (#250): enabling signing or rotating the signing key over otherwise-unchanged
#     content forces a re-push, an unsigned or same-key setup still skips, and a
#     pre-#250 6-field line counts as unknown (push) rather than unchanged (skip)
#
# PLUS, only when the reference `minisign` binary is on PATH (SKIPs otherwise, same
# posture as scripts/selftest-interop.sh's `age` binary check):
#   - a *.minisig cypher-brain writes verifies with the REAL `minisign -V` binary
#   - a *.minisig the REAL `minisign` binary writes (with its OWN keypair) verifies
#     with cypher-brain's OWN verification code (src/lib/minisign.ts)
# Proving BOTH directions is what makes "wire-compatible with minisign" a checked claim
# instead of an assertion.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_FILE_DIR="$TMP/store"
cb() { CYPHER_BRAIN_HOME="$HOME_DIR" node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }

HOME_DIR="$TMP/keys"
cb keygen >/dev/null
cb keygen --sign >/dev/null
test -f "$HOME_DIR/sign-identity.key" && echo "[PASS] keygen --sign wrote sign-identity.key" \
  || { echo "[FAIL] sign-identity.key missing"; exit 1; }
test -f "$HOME_DIR/sign-recipient.pub" && echo "[PASS] keygen --sign wrote sign-recipient.pub" \
  || { echo "[FAIL] sign-recipient.pub missing"; exit 1; }
grep -q '^untrusted comment: minisign public key ' "$HOME_DIR/sign-recipient.pub" \
  && echo "[PASS] sign-recipient.pub has the minisign wire-format comment line" \
  || { echo "[FAIL] sign-recipient.pub does not look like a minisign public key file"; exit 1; }

echo "== keygen --sign refuses to clobber an existing signing keypair without --force =="
if cb keygen --sign 2>/dev/null; then
  echo "[FAIL] a second keygen --sign (no --force) was accepted (should refuse)"; exit 1
fi
echo "[PASS] keygen --sign no-clobber refusal"

echo "== keygen --sign --wrap-in-place is refused (mutually exclusive, #214) =="
if cb keygen --sign --wrap-in-place 2>/dev/null; then
  echo "[FAIL] --sign --wrap-in-place was accepted (should refuse)"; exit 1
fi
echo "[PASS] --sign --wrap-in-place refused"

echo "== keygen --sign --pq is refused (the signing keypair is always Ed25519, #214) =="
if cb keygen --sign --pq --force 2>/dev/null; then
  echo "[FAIL] --sign --pq was accepted (should refuse)"; exit 1
fi
echo "[PASS] --sign --pq refused"

SRC="$TMP/brain-src"
mkdir -p "$SRC"
MARKER="minisign-selftest-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$MARKER" >"$SRC/note.txt"

echo "== snapshot --sign-identity naming a NONEXISTENT path fails loudly, not silently unsigned =="
# #252: this is checked fail-fast, BEFORE any staging/ciphertext work — so a bad
# --sign-identity must leave NOTHING behind at --out (no ciphertext, no .digest/
# .recipients-fingerprint sidecars, no .minisig), not just skip the .minisig. The old
# behavior wrote the ciphertext + sidecars durably and only refused at the very end,
# leaving an orphaned unsigned snapshot despite the "refusing to write" error text.
if cb snapshot --dir "$SRC" --out "$TMP/badsignid.age" --sign-identity "$TMP/no-such-sign-identity.key" >"$TMP/badsignid.out" 2>&1; then
  echo "[FAIL] snapshot with a nonexistent --sign-identity exited 0"; cat "$TMP/badsignid.out"; exit 1
fi
grep -q -- '--sign-identity .* does not exist' "$TMP/badsignid.out" \
  && echo "[PASS] snapshot refuses loudly when an explicit --sign-identity does not exist" \
  || { echo "[FAIL] snapshot's error did not name the missing --sign-identity"; cat "$TMP/badsignid.out"; exit 1; }
[ ! -f "$TMP/badsignid.age" ] && [ ! -f "$TMP/badsignid.age.digest" ] && [ ! -f "$TMP/badsignid.age.recipients-fingerprint" ] && [ ! -f "$TMP/badsignid.age.minisig" ] \
  && echo "[PASS] a nonexistent --sign-identity leaves NOTHING at --out — no orphaned unsigned ciphertext or sidecars" \
  || { echo "[FAIL] snapshot left an orphaned ciphertext/sidecar/.minisig behind despite refusing to write"; ls -la "$TMP"/badsignid.age* 2>&1; exit 1; }

echo "== snapshot auto-signs whenever a signing identity is present =="
cb snapshot --dir "$SRC" --out "$TMP/snap.age" >"$TMP/snap.out" 2>&1
test -f "$TMP/snap.age.minisig" && echo "[PASS] snapshot wrote <out>.minisig" \
  || { echo "[FAIL] no .minisig sidecar written"; cat "$TMP/snap.out"; exit 1; }
grep -q '^untrusted comment: ' "$TMP/snap.age.minisig" \
  && echo "[PASS] .minisig has the expected untrusted-comment line" \
  || { echo "[FAIL] .minisig does not look like a minisig file"; exit 1; }

echo "== verify: signature check PASSes, overall VERDICT PASS =="
cb verify --in "$TMP/snap.age" >"$TMP/verify.out" 2>&1 || true
grep -q '\[PASS\] minisign authenticity signature verified' "$TMP/verify.out" \
  && echo "[PASS] verify reports the signature check as PASS" \
  || { echo "[FAIL] verify did not report a PASS signature check"; cat "$TMP/verify.out"; exit 1; }
grep -q 'VERDICT: PASS' "$TMP/verify.out" && echo "[PASS] verify VERDICT: PASS" \
  || { echo "[FAIL] verify did not reach VERDICT: PASS"; cat "$TMP/verify.out"; exit 1; }

echo "== verify --json includes the signature check =="
cb verify --in "$TMP/snap.age" --json >"$TMP/verify.json" 2>/dev/null
grep -q '"signature":"pass"' "$TMP/verify.json" && echo "[PASS] verify --json reports signature: pass" \
  || { echo "[FAIL] verify --json missing signature: pass"; cat "$TMP/verify.json"; exit 1; }

echo "== restore: signature verified BEFORE decrypting, then restores normally =="
rm -rf "$TMP/restored"
cb restore --in "$TMP/snap.age" --out-dir "$TMP/restored" >"$TMP/restore.out" 2>&1
grep -q '\[PASS\] minisign authenticity signature verified' "$TMP/restore.out" \
  && echo "[PASS] restore reports the signature check as PASS" \
  || { echo "[FAIL] restore did not report a PASS signature check"; cat "$TMP/restore.out"; exit 1; }
tar -xzf "$TMP/restored/brain-src.tar.gz" -C "$TMP/restored"
grep -qF "$MARKER" "$TMP/restored/brain-src/note.txt" && echo "[PASS] restored content matches the source" \
  || { echo "[FAIL] restored content mismatch"; exit 1; }

echo "== tamper detection: a corrupted .minisig makes verify FAIL and restore REFUSE (before decrypt) =="
cp "$TMP/snap.age.minisig" "$TMP/snap.age.minisig.orig"
# The signature-blob line (line 2) base64-decodes to a fixed 74-byte layout: 2 bytes
# sig-alg + 8 bytes key id + 64 bytes the raw Ed25519 signature (src/lib/minisign.ts's
# SIG_BLOB_BYTES/KEY_ID_BYTES). Flip byte offset 10 specifically — the FIRST byte of the
# 64-byte signature, unambiguously past both the 2-byte sig-alg and the 8-byte key id —
# so this exercises one deterministic failure mode, not "whichever field the flipped
# base64 character happened to land in": verifyDetached() checks the global signature
# (which covers these exact signature bytes, concatenated with the trusted comment)
# BEFORE it ever hashes/checks the message itself, so a corrupted signature byte here
# always surfaces as the specific "global signature ... does not verify" reason, checked
# below — never a key-id mismatch or a content-hash mismatch.
python3 - "$TMP/snap.age.minisig" <<'PYEOF'
import base64, sys
p = sys.argv[1]
with open(p) as f:
    lines = f.readlines()
sig_line = lines[1].rstrip("\n")
blob = bytearray(base64.b64decode(sig_line))
assert len(blob) == 74, f"unexpected sigBlob length {len(blob)}, expected 74 (2 sig-alg + 8 key-id + 64 signature)"
SIG_OFFSET = 10  # first byte of the 64-byte raw Ed25519 signature (sig-alg=[0:2], key-id=[2:10], signature=[10:74])
blob[SIG_OFFSET] ^= 0xFF
lines[1] = base64.b64encode(bytes(blob)).decode() + "\n"
with open(p, "w") as f:
    f.writelines(lines)
PYEOF
if cb verify --in "$TMP/snap.age" >"$TMP/verify-tampered.out" 2>&1; then
  echo "[FAIL] verify exited 0 against a tampered .minisig"; cat "$TMP/verify-tampered.out"; exit 1
fi
grep -q '\[FAIL\] minisign authenticity signature verified' "$TMP/verify-tampered.out" \
  && echo "[PASS] verify reports the signature check as FAIL" \
  || { echo "[FAIL] verify did not report a FAIL signature check"; cat "$TMP/verify-tampered.out"; exit 1; }
grep -qF 'global signature (over the trusted comment) does not verify' "$TMP/verify-tampered.out" \
  && echo "[PASS] the failure is unambiguously a corrupted SIGNATURE (byte offset 10 of 74 — inside the 64-byte Ed25519 signature, not the 8-byte key id or the 2-byte sig-alg), not a generic/different tamper" \
  || { echo "[FAIL] verify did not report the expected signature-corruption reason (global signature check)"; cat "$TMP/verify-tampered.out"; exit 1; }
grep -q 'VERDICT: FAIL' "$TMP/verify-tampered.out" && echo "[PASS] verify VERDICT: FAIL" \
  || { echo "[FAIL] verify did not reach VERDICT: FAIL"; cat "$TMP/verify-tampered.out"; exit 1; }
cb verify --in "$TMP/snap.age" --json >"$TMP/verify-tampered.json" 2>/dev/null || true
grep -q '"wrong_key_rejected":"skip"' "$TMP/verify-tampered.json" \
  && echo "[PASS] verify --json reports wrong_key_rejected: skip (not a false 'true') once the signature already failed" \
  || { echo "[FAIL] verify --json did not report wrong_key_rejected: skip on a tampered signature"; cat "$TMP/verify-tampered.json"; exit 1; }
rm -rf "$TMP/restored-tampered"
if cb restore --in "$TMP/snap.age" --out-dir "$TMP/restored-tampered" >"$TMP/restore-tampered.out" 2>&1; then
  echo "[FAIL] restore exited 0 against a tampered .minisig"; cat "$TMP/restore-tampered.out"; exit 1
fi
grep -q 'CB-E016' "$TMP/restore-tampered.out" && echo "[PASS] restore refuses with the CB-E016 error code" \
  || { echo "[FAIL] restore did not refuse with CB-E016"; cat "$TMP/restore-tampered.out"; exit 1; }
grep -qF 'global signature (over the trusted comment) does not verify' "$TMP/restore-tampered.out" \
  && echo "[PASS] restore's refusal names the same unambiguous signature-corruption reason as verify" \
  || { echo "[FAIL] restore did not name the signature-corruption reason"; cat "$TMP/restore-tampered.out"; exit 1; }
[ ! -d "$TMP/restored-tampered" ] && echo "[PASS] restore wrote nothing to --out-dir before refusing" \
  || { echo "[FAIL] restore created --out-dir despite refusing (decrypted before checking the signature?)"; exit 1; }

echo "== tamper detection: the signature check runs BEFORE decryption even starts, not merely before extraction =="
# The check above only proves restore never wrote plaintext to --out-dir — consistent
# with "checked first" but ALSO consistent with "decryption was attempted and failed on
# its own, coincidentally leaving no output". Instrument the actual decrypt boundary by
# making the identity file UNREADABLE (chmod 000) rather than merely malformed: a
# malformed-but-readable identity (e.g. plain garbage text) is a WEAKER fixture than it
# looks — src/lib/crypt.ts's loadIdentities() happily reads and returns garbage text as
# an "identity" without validating it at all; only the LATER newDecrypter()/addIdentity()
# call rejects it (Codex review, multi-model). A regression that hoists JUST
# loadIdentities() ahead of the signature check (leaving newDecrypter() and the actual
# decrypt call in their normal, later position) would silently succeed at that hoisted
# call and produce no error at all — passing a malformed-text-based check even though the
# identity file WAS read before the signature check ran. chmod 000 closes that gap
# structurally: ANY attempt to read the file's bytes at all (loadIdentities() calls
# readFile() with no fallback) throws EACCES immediately, so there is no code path that
# can touch this file even partially without an immediate, loud failure — unlike a
# malformed-content fixture, permission enforcement does not depend on which downstream
# function happens to validate the content. Skipped when this sandbox cannot actually
# deny access (running as root) — same posture as scripts/selftest.sh's own EACCES check.
cp "$HOME_DIR/identity.age" "$HOME_DIR/identity.age.orig"
chmod 000 "$HOME_DIR/identity.age"
if cat "$HOME_DIR/identity.age" >/dev/null 2>&1; then
  chmod 600 "$HOME_DIR/identity.age"
  echo "[SKIP] decrypt-order check: this user can read a 0000 file (running as root?) — cannot deny access to test it"
else
  rm -rf "$TMP/restored-tampered-decrypt-order"
  if cb restore --in "$TMP/snap.age" --out-dir "$TMP/restored-tampered-decrypt-order" >"$TMP/restore-tampered-decrypt-order.out" 2>&1; then
    echo "[FAIL] restore exited 0 against a tampered .minisig + an unreadable identity"; cat "$TMP/restore-tampered-decrypt-order.out"
    chmod 600 "$HOME_DIR/identity.age"; cp "$HOME_DIR/identity.age.orig" "$HOME_DIR/identity.age"; exit 1
  fi
  grep -qF 'global signature (over the trusted comment) does not verify' "$TMP/restore-tampered-decrypt-order.out" \
    && echo "[PASS] restore's refusal still names the signature failure with the identity unreadable — the check ran before it ever needed (or reached) the identity/decrypt step" \
    || { echo "[FAIL] restore did not name the signature failure — cannot confirm the check ran before decryption"; cat "$TMP/restore-tampered-decrypt-order.out"; chmod 600 "$HOME_DIR/identity.age"; cp "$HOME_DIR/identity.age.orig" "$HOME_DIR/identity.age"; exit 1; }
  if grep -qiE 'eacces|permission denied|identity|decrypt' "$TMP/restore-tampered-decrypt-order.out"; then
    echo "[FAIL] restore's output also mentions a permission/identity/decrypt failure — the identity file may have been read before the signature check"
    cat "$TMP/restore-tampered-decrypt-order.out"; chmod 600 "$HOME_DIR/identity.age"; cp "$HOME_DIR/identity.age.orig" "$HOME_DIR/identity.age"; exit 1
  fi
  echo "[PASS] restore's output names no permission/identity/decrypt failure at all — the identity file was never even opened for reading"
  [ ! -d "$TMP/restored-tampered-decrypt-order" ] \
    && echo "[PASS] restore wrote nothing to --out-dir (decryption never started, let alone got far enough to produce plaintext)" \
    || { echo "[FAIL] restore created --out-dir despite refusing"; chmod 600 "$HOME_DIR/identity.age"; cp "$HOME_DIR/identity.age.orig" "$HOME_DIR/identity.age"; exit 1; }
  chmod 600 "$HOME_DIR/identity.age"
  cp "$HOME_DIR/identity.age.orig" "$HOME_DIR/identity.age"
fi

cp "$TMP/snap.age.minisig.orig" "$TMP/snap.age.minisig"

echo "== snapshot --no-sign opts out even when a signing identity exists =="
cb snapshot --dir "$SRC" --out "$TMP/nosign.age" --no-sign >/dev/null
[ ! -f "$TMP/nosign.age.minisig" ] && echo "[PASS] --no-sign wrote no .minisig sidecar" \
  || { echo "[FAIL] --no-sign wrote a .minisig anyway"; exit 1; }
cb verify --in "$TMP/nosign.age" >"$TMP/verify-nosign.out" 2>&1
grep -q '\[SKIP\] minisign authenticity signature' "$TMP/verify-nosign.out" \
  && echo "[PASS] verify SKIPs the signature check on an unsigned artifact" \
  || { echo "[FAIL] verify did not SKIP on an unsigned artifact"; cat "$TMP/verify-nosign.out"; exit 1; }
grep -q 'VERDICT: PASS' "$TMP/verify-nosign.out" && echo "[PASS] an unsigned artifact still reaches VERDICT: PASS (backward compatible)" \
  || { echo "[FAIL] an unsigned artifact did not PASS overall"; cat "$TMP/verify-nosign.out"; exit 1; }
rm -rf "$TMP/restored-nosign"
cb restore --in "$TMP/nosign.age" --out-dir "$TMP/restored-nosign" >"$TMP/restore-nosign.out" 2>&1
grep -q 'no .*\.minisig found' "$TMP/restore-nosign.out" \
  && echo "[PASS] restore warns (not fails) on an unsigned artifact" \
  || { echo "[FAIL] restore did not warn about the missing signature"; cat "$TMP/restore-nosign.out"; exit 1; }

echo "== --require-signature: an unsigned artifact is a hard FAIL/refusal instead of warn-and-proceed =="
if cb verify --in "$TMP/nosign.age" --require-signature >"$TMP/verify-require-sig.out" 2>&1; then
  echo "[FAIL] verify --require-signature exited 0 against an unsigned artifact"; cat "$TMP/verify-require-sig.out"; exit 1
fi
grep -q '\[FAIL\] minisign authenticity signature' "$TMP/verify-require-sig.out" \
  && echo "[PASS] verify --require-signature reports a FAIL (not SKIP) on an unsigned artifact" \
  || { echo "[FAIL] verify --require-signature did not report a FAIL signature check"; cat "$TMP/verify-require-sig.out"; exit 1; }
grep -q 'VERDICT: FAIL' "$TMP/verify-require-sig.out" \
  && echo "[PASS] verify --require-signature VERDICT: FAIL on an unsigned artifact" \
  || { echo "[FAIL] verify --require-signature did not reach VERDICT: FAIL"; cat "$TMP/verify-require-sig.out"; exit 1; }
rm -rf "$TMP/restored-require-sig"
if cb restore --in "$TMP/nosign.age" --out-dir "$TMP/restored-require-sig" --require-signature >"$TMP/restore-require-sig.out" 2>&1; then
  echo "[FAIL] restore --require-signature exited 0 against an unsigned artifact"; cat "$TMP/restore-require-sig.out"; exit 1
fi
[ ! -d "$TMP/restored-require-sig" ] \
  && echo "[PASS] restore --require-signature refuses an unsigned artifact, writing nothing to --out-dir" \
  || { echo "[FAIL] restore --require-signature created --out-dir despite refusing"; exit 1; }
# an actually-SIGNED artifact must still pass --require-signature (this flag tightens
# the unsigned/no-pubkey case, not the already-strict tampered-signature case).
cb verify --in "$TMP/snap.age" --require-signature | grep -q 'VERDICT: PASS' \
  && echo "[PASS] --require-signature does not affect a genuinely-signed, valid artifact" \
  || { echo "[FAIL] --require-signature rejected a genuinely-signed, valid artifact"; exit 1; }

echo "== a machine with no signing public key configured: SKIP, never FAIL =="
NOKEY_HOME="$TMP/keys-nokey"
mkdir -p "$NOKEY_HOME"
cp "$HOME_DIR/identity.age" "$NOKEY_HOME/identity.age"
cp "$HOME_DIR/recipient.txt" "$NOKEY_HOME/recipient.txt"
CYPHER_BRAIN_HOME="$NOKEY_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" verify --in "$TMP/snap.age" >"$TMP/verify-nokey.out" 2>&1
grep -q '\[SKIP\] minisign authenticity signature' "$TMP/verify-nokey.out" \
  && echo "[PASS] verify SKIPs when no signing public key is configured on this box" \
  || { echo "[FAIL] verify did not SKIP with no configured signing public key"; cat "$TMP/verify-nokey.out"; exit 1; }

echo "== push (file backend) uploads the .minisig sidecar; pull fetches it back automatically =="
rm -f "$TMP/loc.tsv"
cb push --in "$TMP/snap.age" --backend file --save-locator "$TMP/loc.tsv" >/dev/null
LOC_FIELDS=$(head -n1 "$TMP/loc.tsv" | awk -F'\t' '{print NF}')
[ "$LOC_FIELDS" -ge 7 ] && echo "[PASS] save-locator recorded the 6th (sig_locator) + 7th (sign_key_id) fields" \
  || { echo "[FAIL] save-locator has only $LOC_FIELDS field(s), expected >= 7"; cat "$TMP/loc.tsv"; exit 1; }
# the 7th field must be the key id from the .minisig itself (#250) — the same 8 bytes
# the signing identity file records as its "# key id: <hex>" comment.
LOC_KEY_ID=$(head -n1 "$TMP/loc.tsv" | awk -F'\t' '{print $7}')
IDENTITY_KEY_ID=$(grep -m1 '^# key id: ' "$HOME_DIR/sign-identity.key" | sed 's/^# key id: //')
[ -n "$LOC_KEY_ID" ] && [ "$LOC_KEY_ID" = "$IDENTITY_KEY_ID" ] \
  && echo "[PASS] the recorded sign_key_id is the signing identity's own key id ($LOC_KEY_ID)" \
  || { echo "[FAIL] sign_key_id '$LOC_KEY_ID' does not match the signing identity's '$IDENTITY_KEY_ID'"; exit 1; }
rm -f "$TMP/pulled.age" "$TMP/pulled.age.minisig"
cb pull --from-locator-file "$TMP/loc.tsv" --out "$TMP/pulled.age" >/dev/null 2>&1
test -f "$TMP/pulled.age.minisig" && echo "[PASS] pull fetched the .minisig sidecar automatically" \
  || { echo "[FAIL] pull did not fetch the .minisig sidecar"; exit 1; }
diff "$TMP/snap.age.minisig" "$TMP/pulled.age.minisig" >/dev/null \
  && echo "[PASS] pulled .minisig is byte-identical to the pushed one" \
  || { echo "[FAIL] pulled .minisig differs from the pushed one"; exit 1; }
cb verify --in "$TMP/pulled.age" | grep -q 'VERDICT: PASS' \
  && echo "[PASS] the pulled artifact verifies end-to-end (push -> pull -> verify)" \
  || { echo "[FAIL] the pulled artifact did not VERIFY: PASS"; exit 1; }

echo "== pull --force refreshes a stale .minisig alongside the ciphertext it also overwrites =="
printf 'second-generation-content\n' >"$SRC/note2.txt"
cb snapshot --dir "$SRC" --out "$TMP/snap2.age" >/dev/null
rm -f "$TMP/loc2.tsv"
cb push --in "$TMP/snap2.age" --backend file --save-locator "$TMP/loc2.tsv" >/dev/null
# "$TMP/pulled.age(.minisig)" already holds the FIRST snapshot's bytes from above —
# --force must replace BOTH with the second snapshot's, not just the ciphertext.
cb pull --from-locator-file "$TMP/loc2.tsv" --out "$TMP/pulled.age" --force >/dev/null 2>&1
diff "$TMP/snap2.age.minisig" "$TMP/pulled.age.minisig" >/dev/null \
  && echo "[PASS] pull --force refreshed the stale .minisig to match the newly-pulled ciphertext" \
  || { echo "[FAIL] pull --force left a stale .minisig that does not match the new ciphertext"; exit 1; }
cb verify --in "$TMP/pulled.age" | grep -q 'VERDICT: PASS' \
  && echo "[PASS] the force-repulled artifact verifies end-to-end" \
  || { echo "[FAIL] the force-repulled artifact did not VERIFY: PASS (stale-signature mismatch?)"; exit 1; }

echo "== pull --force with NO known signature removes a stale .minisig rather than leaving it orphaned =="
cb snapshot --dir "$SRC" --out "$TMP/snap3.age" --no-sign >/dev/null
rm -f "$TMP/loc3.tsv"
cb push --in "$TMP/snap3.age" --backend file --save-locator "$TMP/loc3.tsv" >/dev/null
# "$TMP/pulled.age.minisig" still holds the SECOND snapshot's signature from above;
# this pull has none (snap3 was --no-sign), so --force must remove it rather than
# leave it mismatched against the third snapshot's bytes.
cb pull --from-locator-file "$TMP/loc3.tsv" --out "$TMP/pulled.age" --force >/dev/null 2>&1
[ ! -f "$TMP/pulled.age.minisig" ] \
  && echo "[PASS] pull --force removed the stale .minisig when the new artifact has no signature of its own" \
  || { echo "[FAIL] a stale .minisig was left behind after a --force pull of an unsigned artifact"; exit 1; }
cb verify --in "$TMP/pulled.age" | grep -q 'VERDICT: PASS' \
  && echo "[PASS] the force-repulled unsigned artifact verifies end-to-end (SKIPs the signature check, not a false FAIL)" \
  || { echo "[FAIL] the force-repulled unsigned artifact did not VERIFY: PASS"; exit 1; }

echo "== #250: push --skip-unchanged re-evaluates SIGNING state, not just content+recipients =="
# A fresh, isolated home so this block controls the signing state from scratch: the
# scenario is specifically "unchanged plaintext, unchanged recipients, CHANGED signing".
SK_HOME="$TMP/keys-skip"
SK_SRC="$TMP/src-skip"
mkdir -p "$SK_HOME" "$SK_SRC"
printf 'skip-unchanged fixture\n' >"$SK_SRC/note.txt"
sk() { CYPHER_BRAIN_HOME="$SK_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
sk keygen >/dev/null 2>&1

# (1) unsigned baseline: push, then re-push identical content — must still SKIP. The
# pre-#214 majority has no signing key at all, and #250 must not cost them their skip.
sk snapshot --dir "$SK_SRC" --out "$TMP/sk1.age" >/dev/null
sk push --in "$TMP/sk1.age" --backend file --save-locator "$TMP/sk-loc.tsv" >/dev/null
SK_FIELDS=$(head -n1 "$TMP/sk-loc.tsv" | awk -F'\t' '{print NF}')
[ "$SK_FIELDS" = "5" ] \
  && echo "[PASS] an unsigned push still writes exactly the 5-field line (no empty trailing columns)" \
  || { echo "[FAIL] unsigned push wrote $SK_FIELDS fields, expected 5"; cat "$TMP/sk-loc.tsv"; exit 1; }
sk snapshot --dir "$SK_SRC" --out "$TMP/sk2.age" >/dev/null
sk push --in "$TMP/sk2.age" --backend file --save-locator "$TMP/sk-loc.tsv" --skip-unchanged >"$TMP/sk2.out" 2>&1
grep -q 'SKIPPED' "$TMP/sk2.out" \
  && echo "[PASS] unsigned + unchanged still skips (no regression for setups with no signing key)" \
  || { echo "[FAIL] an unsigned, unchanged re-push did not skip"; cat "$TMP/sk2.out"; exit 1; }

# (2) signing newly ENABLED over unchanged content — must NOT skip, or the remote copy
# silently stays unsigned (the first half of #250).
sk keygen --sign >/dev/null 2>&1
sk snapshot --dir "$SK_SRC" --out "$TMP/sk3.age" >/dev/null
sk push --in "$TMP/sk3.age" --backend file --save-locator "$TMP/sk-loc.tsv" --skip-unchanged >"$TMP/sk3.out" 2>&1
grep -q 'SKIPPED' "$TMP/sk3.out" \
  && { echo "[FAIL] newly-enabled signing was skipped — the remote copy stays unsigned (#250)"; cat "$TMP/sk3.out"; exit 1; }
echo "[PASS] newly-enabled signing forces a re-push even though content + recipients are unchanged"
SK_KEY_1=$(head -n1 "$TMP/sk-loc.tsv" | awk -F'\t' '{print $7}')
[ -n "$SK_KEY_1" ] || { echo "[FAIL] the re-push did not record a sign_key_id"; cat "$TMP/sk-loc.tsv"; exit 1; }

# (3) signed, SAME key, unchanged content — must skip again (the optimization still works
# once the new state is recorded; #250 must not turn every signed push into a re-push).
sk snapshot --dir "$SK_SRC" --out "$TMP/sk4.age" >/dev/null
sk push --in "$TMP/sk4.age" --backend file --save-locator "$TMP/sk-loc.tsv" --skip-unchanged >"$TMP/sk4.out" 2>&1
grep -q 'SKIPPED' "$TMP/sk4.out" \
  && echo "[PASS] signed by the SAME key + unchanged content skips as before" \
  || { echo "[FAIL] an unchanged, same-key signed re-push did not skip"; cat "$TMP/sk4.out"; exit 1; }

# (4) signing key ROTATED over unchanged content — must NOT skip, or the remote copy stays
# signed with the OLD key and a verifier trusting only the NEW one sees it as unverifiable
# (the second half of #250).
sk keygen --sign --force >/dev/null 2>&1
sk snapshot --dir "$SK_SRC" --out "$TMP/sk5.age" >/dev/null
sk push --in "$TMP/sk5.age" --backend file --save-locator "$TMP/sk-loc.tsv" --skip-unchanged >"$TMP/sk5.out" 2>&1
grep -q 'SKIPPED' "$TMP/sk5.out" \
  && { echo "[FAIL] a rotated signing key was skipped — the remote copy stays signed with the OLD key (#250)"; cat "$TMP/sk5.out"; exit 1; }
SK_KEY_2=$(head -n1 "$TMP/sk-loc.tsv" | awk -F'\t' '{print $7}')
[ -n "$SK_KEY_2" ] && [ "$SK_KEY_2" != "$SK_KEY_1" ] \
  && echo "[PASS] a rotated signing key forces a re-push and records the NEW key id" \
  || { echo "[FAIL] sign_key_id did not change after rotation ('$SK_KEY_1' -> '$SK_KEY_2')"; exit 1; }

# (5) a signed previous push recorded BEFORE #250 (a 6-field line, no sign_key_id) is
# genuinely unknown, not "unchanged" — it must push rather than skip, and the re-push
# then records the 7th field so the next run compares normally.
cut -f1-6 "$TMP/sk-loc.tsv" >"$TMP/sk-loc-legacy.tsv"
sk snapshot --dir "$SK_SRC" --out "$TMP/sk6.age" >/dev/null
sk push --in "$TMP/sk6.age" --backend file --save-locator "$TMP/sk-loc-legacy.tsv" --skip-unchanged >"$TMP/sk6.out" 2>&1
grep -q 'SKIPPED' "$TMP/sk6.out" \
  && { echo "[FAIL] a 6-field (pre-#250) signed line was treated as 'signing unchanged'"; cat "$TMP/sk6.out"; exit 1; }
[ "$(head -n1 "$TMP/sk-loc-legacy.tsv" | awk -F'\t' '{print NF}')" = "7" ] \
  && echo "[PASS] a legacy 6-field signed line pushes (unknown != unchanged) and is upgraded to 7 fields" \
  || { echo "[FAIL] the re-push did not upgrade the legacy line to 7 fields"; cat "$TMP/sk-loc-legacy.tsv"; exit 1; }

# (6) a sidecar that EXISTS but does not parse is unknown, not "unsigned" — skipping on
# it would silently accept a corrupt signature sitting next to unchanged content and
# never re-push it (multi-model review finding on #250). Reuses the unsigned baseline
# locator from (1)/(2), where a skip is otherwise guaranteed to fire.
cut -f1-5 "$TMP/sk-loc.tsv" >"$TMP/sk-loc-unsigned.tsv" # a 5-field line = previous push unsigned
sk snapshot --dir "$SK_SRC" --out "$TMP/sk7.age" --no-sign >/dev/null
printf 'not a minisig at all\n' >"$TMP/sk7.age.minisig"
sk push --in "$TMP/sk7.age" --backend file --save-locator "$TMP/sk-loc-unsigned.tsv" --skip-unchanged >"$TMP/sk7.out" 2>&1
grep -q 'SKIPPED' "$TMP/sk7.out" \
  && { echo "[FAIL] an unparseable .minisig was treated as 'unsigned' and skipped"; cat "$TMP/sk7.out"; exit 1; }
echo "[PASS] a present-but-unparseable .minisig counts as unknown signing state, never as unsigned"

if ! command -v minisign >/dev/null 2>&1; then
  echo "[SKIP] real \`minisign\` binary interop: no \`minisign\` on PATH — install it (brew/apt) to exercise CLI<->binary wire-format interop"
else
  echo "== interop: a cypher-brain-made .minisig verifies with the REAL minisign binary =="
  minisign -V -p "$HOME_DIR/sign-recipient.pub" -m "$TMP/snap.age" >"$TMP/real-verify.out" 2>&1
  grep -q 'Signature and comment signature verified' "$TMP/real-verify.out" \
    && echo "[PASS] the real minisign binary verified a cypher-brain-generated .minisig" \
    || { echo "[FAIL] the real minisign binary rejected a cypher-brain-generated .minisig"; cat "$TMP/real-verify.out"; exit 1; }

  echo "== interop: a REAL-minisign-made .minisig verifies with cypher-brain's OWN code =="
  # -W: generate the secret key WITHOUT a password, so it loads non-interactively below
  # (no TTY / pty needed — unlike `age -p`, which needs one via readpassphrase(3); see
  # selftest-interop.sh's with_pty helper for that contrast). Fine for this throwaway,
  # selftest-only keypair, which exists only to prove the wire format, not to protect
  # anything.
  minisign -G -W -p "$TMP/real.pub" -s "$TMP/real.key" </dev/null >/dev/null 2>&1
  printf '%s\n' "second" >"$TMP/real-msg.txt"
  minisign -S -s "$TMP/real.key" -m "$TMP/real-msg.txt" </dev/null >/dev/null 2>&1
  test -f "$TMP/real-msg.txt.minisig" || { echo "[FAIL] the real minisign binary did not write a .minisig"; exit 1; }
  # Feed the real binary's OWN public key + .minisig into cypher-brain's verify by
  # standing up a throwaway CYPHER_BRAIN_HOME whose sign-recipient.pub IS the real
  # binary's public key — proves cypher-brain's verifyDetached()/parsePubkeyFile()
  # (src/lib/minisign.ts) parse and verify a genuine minisign-generated artifact, not
  # just its own round trip.
  REAL_HOME="$TMP/keys-real-pubkey"
  mkdir -p "$REAL_HOME"
  cp "$HOME_DIR/identity.age" "$REAL_HOME/identity.age"
  cp "$HOME_DIR/recipient.txt" "$REAL_HOME/recipient.txt"
  cp "$TMP/real.pub" "$REAL_HOME/sign-recipient.pub"
  cb2() { CYPHER_BRAIN_HOME="$REAL_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
  cb2 snapshot --dir "$SRC" --out "$TMP/real-snap.age" --no-sign >/dev/null
  # Reuse the real binary's OWN signature bytes against a *different* file is invalid
  # (would rightly fail authenticity) — instead, sign the SAME ciphertext bytes cypher-
  # brain just produced, using the real binary + its own throwaway key, so the
  # resulting .minisig is a genuine, freshly-made signature OVER that exact artifact.
  minisign -S -s "$TMP/real.key" -m "$TMP/real-snap.age" </dev/null >/dev/null 2>&1
  cb2 verify --in "$TMP/real-snap.age" >"$TMP/verify-real.out" 2>&1 || true
  grep -q '\[PASS\] minisign authenticity signature verified' "$TMP/verify-real.out" \
    && echo "[PASS] cypher-brain's own verify accepted a REAL minisign-generated signature" \
    || { echo "[FAIL] cypher-brain's verify rejected a genuine minisign-generated signature"; cat "$TMP/verify-real.out"; exit 1; }
fi

# #532: `keygen --sign --force`'s completion message used to unconditionally claim
# existing *.minisig files "stay verifiable against the public key above regardless" —
# false, since --force overwrites sign-recipient.pub IN PLACE at its default path, so
# verify's default lookup now sees the NEW key and OLD-key signatures correctly FAIL
# against it. This isolated block (own HOME/SRC, independent of $HOME_DIR/$SK_HOME
# above) proves the corrected message text matches what actually happens: a fresh
# keygen --sign gives a plain backup reminder, a --force regen warns that the default
# path now serves the NEW key and names the --sign-recipient escape hatch, and the
# underlying crypto behavior (old sig fails by default, passes with the saved old
# pubkey named explicitly) is exactly what the message describes.
echo "== keygen --sign --force completion message accurately describes the default-path key swap (#532) =="
MSG_HOME="$TMP/keys-msg532"
MSG_SRC="$TMP/src-msg532"
mkdir -p "$MSG_HOME" "$MSG_SRC"
printf 'msg532 fixture\n' >"$MSG_SRC/note.txt"
msgcb() { CYPHER_BRAIN_HOME="$MSG_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
msgcb keygen >/dev/null

msgcb keygen --sign >"$TMP/msg532-fresh.out" 2>&1
grep -q 'Losing it means future snapshots can no longer be signed\.$' "$TMP/msg532-fresh.out" \
  && echo "[PASS] fresh keygen --sign prints the plain backup reminder" \
  || { echo "[FAIL] fresh keygen --sign message changed unexpectedly"; cat "$TMP/msg532-fresh.out"; exit 1; }
grep -q 'stay verifiable' "$TMP/msg532-fresh.out" \
  && { echo "[FAIL] fresh keygen --sign still makes the old unconditional 'stay verifiable' claim"; cat "$TMP/msg532-fresh.out"; exit 1; }
echo "[PASS] fresh keygen --sign message has no unconditional old-key claim"

# #532 review follow-up: --force with NOTHING there yet (no prior signing key) must NOT
# claim it "overwrote the previous signing public key" — the warning has to key off actual
# pre-existence, not the --force flag itself (a fresh --force is a no-op-flag-wise
# first run, same as a plain keygen --sign).
FRESH_FORCE_HOME="$TMP/keys-msg532-freshforce"
mkdir -p "$FRESH_FORCE_HOME"
CYPHER_BRAIN_HOME="$FRESH_FORCE_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
CYPHER_BRAIN_HOME="$FRESH_FORCE_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --sign --force >"$TMP/msg532-freshforce.out" 2>&1
grep -q 'Losing it means future snapshots can no longer be signed\.$' "$TMP/msg532-freshforce.out" \
  && echo "[PASS] keygen --sign --force with no prior key prints the plain backup reminder" \
  || { echo "[FAIL] a --force run with no prior key did not print the plain message"; cat "$TMP/msg532-freshforce.out"; exit 1; }
grep -q 'overwrote the previous signing public key' "$TMP/msg532-freshforce.out" \
  && { echo "[FAIL] a --force run with no prior key falsely claims it overwrote a previous key"; cat "$TMP/msg532-freshforce.out"; exit 1; }
echo "[PASS] keygen --sign --force with no prior key does not falsely claim an overwrite"

# Save the OLD public key before regenerating — mirrors the issue's repro and the
# message's own advice: retaining a copy of the OLD sign-recipient.pub is what lets an
# old .minisig still be verified (via --sign-recipient) after --force overwrites the
# default path with the NEW key.
cp "$MSG_HOME/sign-recipient.pub" "$TMP/msg532-old-sign-recipient.pub"
msgcb snapshot --dir "$MSG_SRC" --out "$TMP/msg532.age" >/dev/null
msgcb verify --in "$TMP/msg532.age" --require-signature >/dev/null 2>&1 \
  && echo "[PASS] msg532.age verifies against the key it was signed with" \
  || { echo "[FAIL] msg532.age did not verify before key rotation"; exit 1; }

msgcb keygen --sign --force >"$TMP/msg532-force.out" 2>&1
grep -q -- '--force overwrote the previous signing public key at' "$TMP/msg532-force.out" \
  && echo "[PASS] --force message states the previous key's path was overwritten in place" \
  || { echo "[FAIL] --force message missing the overwrite-in-place statement"; cat "$TMP/msg532-force.out"; exit 1; }
grep -q -- '(the default path)' "$TMP/msg532-force.out" \
  && echo "[PASS] --force message marks the overwritten path as the default (no --sign-recipient override used)" \
  || { echo "[FAIL] --force message did not identify the overwritten path as the default"; cat "$TMP/msg532-force.out"; exit 1; }
grep -q 'will FAIL verification' "$TMP/msg532-force.out" \
  && echo "[PASS] --force message warns old-key .minisig files will FAIL verification there" \
  || { echo "[FAIL] --force message does not warn about FAIL verification"; cat "$TMP/msg532-force.out"; exit 1; }
grep -q -- '--sign-recipient <path-to-saved-old-pubkey>' "$TMP/msg532-force.out" \
  && echo "[PASS] --force message names the --sign-recipient escape hatch for a saved old pubkey" \
  || { echo "[FAIL] --force message does not name the --sign-recipient escape hatch"; cat "$TMP/msg532-force.out"; exit 1; }
grep -q 'stay verifiable.*regardless' "$TMP/msg532-force.out" \
  && { echo "[FAIL] --force message still makes the old unconditional 'stay verifiable ... regardless' claim"; cat "$TMP/msg532-force.out"; exit 1; }
echo "[PASS] --force message drops the old unconditional 'stay verifiable ... regardless' claim"

# #532 review follow-up: a --force regen at a CUSTOM --sign-recipient path must NOT
# claim it overwrote "the default path" -- that path only matters to `verify` if
# `verify` is later pointed at that same custom path via --sign-recipient itself.
CUSTOM_HOME="$TMP/keys-msg532-custom"
mkdir -p "$CUSTOM_HOME"
CUSTOM_SIGN_RECIPIENT="$TMP/custom-sign-recipient.pub"
CYPHER_BRAIN_HOME="$CUSTOM_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
CYPHER_BRAIN_HOME="$CUSTOM_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --sign --sign-recipient "$CUSTOM_SIGN_RECIPIENT" >/dev/null
CYPHER_BRAIN_HOME="$CUSTOM_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --sign --sign-recipient "$CUSTOM_SIGN_RECIPIENT" --force \
  >"$TMP/msg532-custom.out" 2>&1
grep -q -- '--force overwrote the previous signing public key at' "$TMP/msg532-custom.out" \
  && echo "[PASS] custom-path --force message states the overwritten path" \
  || { echo "[FAIL] custom-path --force message missing the overwrite statement"; cat "$TMP/msg532-custom.out"; exit 1; }
grep -q -- '(the default path)' "$TMP/msg532-custom.out" \
  && { echo "[FAIL] custom-path --force message wrongly calls a --sign-recipient override 'the default path'"; cat "$TMP/msg532-custom.out"; exit 1; }
grep -q -- 'pass the same --sign-recipient to verify to use it' "$TMP/msg532-custom.out" \
  && echo "[PASS] custom-path --force message correctly scopes the warning to that explicit path" \
  || { echo "[FAIL] custom-path --force message does not scope the warning to the custom path"; cat "$TMP/msg532-custom.out"; exit 1; }

# #532 review round 3: an identity that pre-exists at its DEFAULT path, combined with a
# --sign-recipient path that has never existed before, must NOT trigger the "overwrote
# the previous signing public key" warning -- recipientPath itself is being CREATED, not
# replaced, even though --force is set and identityPath does pre-exist. The warning is
# specifically about the PUBLIC verification key at recipientPath, so it must key off
# recipientPath's own pre-existence, not identityPath's (or "either").
MIXED_HOME="$TMP/keys-msg532-mixed"
mkdir -p "$MIXED_HOME"
NEVER_EXISTED_RECIPIENT="$TMP/never-existed-sign-recipient.pub"
CYPHER_BRAIN_HOME="$MIXED_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen >/dev/null
CYPHER_BRAIN_HOME="$MIXED_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --sign >/dev/null
test -f "$MIXED_HOME/sign-identity.key" || { echo "[FAIL] mixed-case fixture setup: sign-identity.key missing"; exit 1; }
test ! -e "$NEVER_EXISTED_RECIPIENT" || { echo "[FAIL] mixed-case fixture setup: recipient path already exists"; exit 1; }
# --sign-identity re-points at the ALREADY-EXISTING default identity (so identityPath
# pre-exists) while --sign-recipient names the never-existed path above -- --force lets
# this through (keygenSignAt only individually guards each path without --force).
CYPHER_BRAIN_HOME="$MIXED_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --sign \
  --sign-identity "$MIXED_HOME/sign-identity.key" --sign-recipient "$NEVER_EXISTED_RECIPIENT" --force \
  >"$TMP/msg532-mixed.out" 2>&1
grep -q 'overwrote the previous signing public key' "$TMP/msg532-mixed.out" \
  && { echo "[FAIL] message falsely claims an overwrite when only identityPath (not recipientPath) pre-existed"; cat "$TMP/msg532-mixed.out"; exit 1; }
grep -q 'Losing it means future snapshots can no longer be signed\.$' "$TMP/msg532-mixed.out" \
  && echo "[PASS] identity-pre-exists + brand-new --sign-recipient path prints the plain backup reminder, not the overwrite warning" \
  || { echo "[FAIL] mixed-case message did not print the expected plain reminder"; cat "$TMP/msg532-mixed.out"; exit 1; }

# Prove the message matches reality (the crypto behavior itself is unchanged by #532 —
# only the text was wrong): the OLD .minisig now FAILS the default-path verify, exactly
# as the new message says, and PASSES again once told where the saved old pubkey is.
if msgcb verify --in "$TMP/msg532.age" --require-signature >/dev/null 2>&1; then
  echo "[FAIL] msg532.age still verifies against the default path after --force rotated the key"; exit 1
fi
echo "[PASS] old .minisig FAILs default-path verify after --force, matching the corrected message"
msgcb verify --in "$TMP/msg532.age" --require-signature --sign-recipient "$TMP/msg532-old-sign-recipient.pub" >/dev/null 2>&1 \
  && echo "[PASS] old .minisig verifies again via --sign-recipient pointed at the saved old pubkey" \
  || { echo "[FAIL] old .minisig did not verify even with the saved old pubkey named explicitly"; exit 1; }

echo
echo "MINISIGN AUTHENTICITY SELFTEST PASS"
