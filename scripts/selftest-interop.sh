#!/usr/bin/env bash
# Interop proof for #64: the CLI's bundled typage implementation and the reference
# `age` binary must read each other's output, in BOTH directions, on BOTH the
# X25519 and the scrypt-passphrase paths. This is what makes "we replaced the
# binary" safe: any age tooling can still restore a cypher-brain snapshot, and
# cypher-brain can still restore artifacts produced by the binary.
#
# Auto-SKIPs (exit 0) when the `age` binary is absent — the point of #64 is that
# consumers no longer need it; CI installs it precisely to run this assertion.
set -euo pipefail

if ! command -v age >/dev/null 2>&1; then
  echo "[SKIP] interop selftest: no \`age\` binary on PATH — install age (brew/apt) to exercise CLI<->binary interop"
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

# `age -p` / `age -d` (passphrase) read from the controlling terminal, so those legs
# need a pty; `script` provides one on both macOS and Linux (different syntax).
with_pty() {
  if [ "$(uname)" = "Darwin" ]; then script -q /dev/null "$@"; else
    local cmd; cmd=$(printf '%q ' "$@"); script -qec "$cmd" /dev/null
  fi
}

SRC="$TMP/brain-src"
mkdir -p "$SRC"
printf 'interop-marker\n' > "$SRC/note.txt"

echo "== X25519: CLI (typage) encrypts -> age binary decrypts =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/cli.age" >/dev/null 2>&1
mkdir -p "$TMP/bin-out"
age -d -i "$CYPHER_BRAIN_HOME/identity.age" "$TMP/cli.age" | tar -xf - -C "$TMP/bin-out"
tar -xzf "$TMP/bin-out/brain-src.tar.gz" -C "$TMP/bin-out"
diff "$SRC/note.txt" "$TMP/bin-out/brain-src/note.txt"
echo "[PASS] the age binary decrypted a CLI-made snapshot byte-identically"

echo "== X25519: age binary encrypts -> CLI (typage) decrypts =="
tar -cf - -C "$SRC" . | age -r "$(cat "$CYPHER_BRAIN_HOME/recipient.txt")" -o "$TMP/bin.age"
cb restore --in "$TMP/bin.age" --out-dir "$TMP/cli-out" >/dev/null
diff "$SRC/note.txt" "$TMP/cli-out/note.txt"
echo "[PASS] the CLI restored a binary-made artifact byte-identically"

# the pty legs below drive the binary's interactive prompts; if `script` itself is
# broken on this box, SKIP them (loudly) rather than fail on test scaffolding.
if ! with_pty true >/dev/null 2>&1; then
  echo "[SKIP] passphrase interop: \`script\` (pty helper) is not usable here — X25519 interop was proven above"
  exit 0
fi

PASS="interop-pass-$(od -An -N4 -tx1 /dev/urandom | tr -d ' ')"

echo "== scrypt: CLI keygen --passphrase (typage wrap) -> age binary unwraps =="
export CYPHER_BRAIN_HOME="$TMP/keys-pp"
CYPHER_BRAIN_PASSPHRASE="$PASS" cb keygen --passphrase >/dev/null
printf '%s\n' "$PASS" | with_pty age -d -o "$TMP/unwrapped.txt" "$CYPHER_BRAIN_HOME/identity.age" >/dev/null
grep -q '^AGE-SECRET-KEY-1' "$TMP/unwrapped.txt" || { echo "[FAIL] binary unwrap did not yield an identity"; exit 1; }
UNWRAPPED_PUB=$(age-keygen -y "$TMP/unwrapped.txt" 2>/dev/null || grep '^# public key: ' "$TMP/unwrapped.txt" | cut -d' ' -f4)
[ "$UNWRAPPED_PUB" = "$(cat "$CYPHER_BRAIN_HOME/recipient.txt")" ] || { echo "[FAIL] unwrapped identity does not match the recipient"; exit 1; }
echo "[PASS] the age binary unwrapped a typage-wrapped identity (matching recipient)"

echo "== scrypt: age -p wraps an identity -> CLI (typage) unwraps and restores =="
age-keygen -o "$TMP/raw.key" >/dev/null 2>&1
RAWPUB=$(age-keygen -y "$TMP/raw.key")
printf '%s\n%s\n' "$PASS" "$PASS" | with_pty age -p -o "$TMP/wrapped-by-binary.age" "$TMP/raw.key" >/dev/null
head -c 21 "$TMP/wrapped-by-binary.age" | grep -q 'age-encryption.org/v1' || { echo "[FAIL] age -p did not produce ciphertext"; exit 1; }
cb snapshot --dir "$SRC" --recipient "$RAWPUB" --out "$TMP/to-raw.age" >/dev/null 2>&1
CYPHER_BRAIN_PASSPHRASE="$PASS" cb restore --in "$TMP/to-raw.age" --out-dir "$TMP/pp-out" --identity "$TMP/wrapped-by-binary.age" >/dev/null
tar -xzf "$TMP/pp-out/brain-src.tar.gz" -C "$TMP/pp-out"
diff "$SRC/note.txt" "$TMP/pp-out/brain-src/note.txt"
echo "[PASS] the CLI unwrapped a binary-wrapped identity and restored with it"

echo "== scrypt: age -p -a wraps an identity as ASCII-armor -> CLI (typage) unwraps and restores (#87) =="
age-keygen -o "$TMP/raw-armored.key" >/dev/null 2>&1
RAWPUB_ARMORED=$(age-keygen -y "$TMP/raw-armored.key")
printf '%s\n%s\n' "$PASS" "$PASS" | with_pty age -p -a -o "$TMP/wrapped-by-binary-armored.age" "$TMP/raw-armored.key" >/dev/null
head -c 34 "$TMP/wrapped-by-binary-armored.age" | grep -q -- '-----BEGIN AGE ENCRYPTED FILE-----' || { echo "[FAIL] age -p -a did not produce armored ciphertext"; exit 1; }
cb snapshot --dir "$SRC" --recipient "$RAWPUB_ARMORED" --out "$TMP/to-raw-armored.age" >/dev/null 2>&1
CYPHER_BRAIN_PASSPHRASE="$PASS" cb restore --in "$TMP/to-raw-armored.age" --out-dir "$TMP/pp-out-armored" --identity "$TMP/wrapped-by-binary-armored.age" >/dev/null
tar -xzf "$TMP/pp-out-armored/brain-src.tar.gz" -C "$TMP/pp-out-armored"
diff "$SRC/note.txt" "$TMP/pp-out-armored/brain-src/note.txt"
echo "[PASS] the CLI unwrapped an ASCII-armored, binary-wrapped identity and restored with it"

echo "== scrypt: same armored identity, padded with leading blank lines (recovery-note paste simulation) =="
printf '\n\n' | cat - "$TMP/wrapped-by-binary-armored.age" > "$TMP/wrapped-by-binary-armored-padded.age"
CYPHER_BRAIN_PASSPHRASE="$PASS" cb restore --in "$TMP/to-raw-armored.age" --out-dir "$TMP/pp-out-armored-padded" --identity "$TMP/wrapped-by-binary-armored-padded.age" >/dev/null
tar -xzf "$TMP/pp-out-armored-padded/brain-src.tar.gz" -C "$TMP/pp-out-armored-padded"
diff "$SRC/note.txt" "$TMP/pp-out-armored-padded/brain-src/note.txt"
echo "[PASS] the CLI unwrapped an armored identity with leading blank lines, not just a byte-0 header match"

echo
echo "INTEROP SELFTEST PASS (typage <-> age binary, X25519 + scrypt, both directions)"
