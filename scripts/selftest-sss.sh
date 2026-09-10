#!/usr/bin/env bash
# Shamir's Secret Sharing round-trip + integrity proof (#207): `keygen --sss <m>-of-<n>`
# ADDITIONALLY splits the identity into N share files (identity.age/recipient.txt are
# written exactly as they always were); `sss-combine` reconstructs from >= M of them.
# Asserts: (1) the reconstructed identity is byte-identical to the original and
# actually decrypts a real snapshot end-to-end; (2) a corrupt share is refused, never
# silently reconstructed into a wrong-but-plausible identity; (3) shares from two
# different splits are refused before ever reaching the crypto layer; (4) fewer than
# the declared threshold is refused; (5) a --sss-out-dir count mismatch is refused;
# (6) --sss is refused outright with --sign/--wrap-in-place (no age identity to split);
# (7) --pq hybrid identities round-trip through SSS identically to plain X25519 (an
# identity is split as opaque UTF-8 bytes — see sss.ts's own header comment).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh" # BIN_DEV_ARGS
source "$ROOT/scripts/selftest-lib.sh" # sha()
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Positional-home cb(), like selftest-pq.sh: this test runs several concurrent
# identities (a primary split, a second identity for the mixed-split negative case),
# so each call names which CYPHER_BRAIN_HOME it targets rather than relying on one
# exported default.
cb() { CYPHER_BRAIN_HOME="$1" node "${BIN_DEV_ARGS[@]}" "$BIN" "${@:2}"; }

HOME_A="$TMP/home-a"
SHARES_A="$TMP/shares-a"
mkdir -p "$SHARES_A"

echo "== keygen --sss 2-of-3: identity.age/recipient.txt written normally, PLUS 3 shares =="
cb "$HOME_A" keygen --sss 2-of-3 \
  --sss-out-dir "$SHARES_A/1.txt" --sss-out-dir "$SHARES_A/2.txt" --sss-out-dir "$SHARES_A/3.txt" >/dev/null
test -f "$HOME_A/identity.age" || { echo "[FAIL] identity.age not written"; exit 1; }
test -f "$HOME_A/recipient.txt" || { echo "[FAIL] recipient.txt not written"; exit 1; }
for i in 1 2 3; do
  test -f "$SHARES_A/$i.txt" || { echo "[FAIL] share $i not written"; exit 1; }
  grep -q '^# cypher-brain SSS share$' "$SHARES_A/$i.txt" || { echo "[FAIL] share $i missing magic header"; exit 1; }
done
echo "[PASS] identity.age + recipient.txt + 3 share files all present"

RECIPIENT_A="$(cat "$HOME_A/recipient.txt")"

echo "== sss-combine with exactly threshold (2 of 3) shares reconstructs byte-identically =="
cb "$HOME_A" sss-combine --share "$SHARES_A/1.txt" --share "$SHARES_A/3.txt" --out "$TMP/recovered-a.age" >/dev/null
# The only expected difference is identityFileText()'s own "# created: <now>" comment
# line — strip it before comparing, rather than asserting whole-file equality.
tail -n +2 "$HOME_A/identity.age" >"$TMP/orig-tail.txt"
tail -n +2 "$TMP/recovered-a.age" >"$TMP/recovered-tail.txt"
diff -q "$TMP/orig-tail.txt" "$TMP/recovered-tail.txt" >/dev/null \
  && echo "[PASS] reconstructed identity matches the original byte-for-byte" \
  || { echo "[FAIL] reconstructed identity differs from the original"; diff "$TMP/orig-tail.txt" "$TMP/recovered-tail.txt" || true; exit 1; }

echo "== reconstructed identity actually decrypts a real snapshot end-to-end =="
mkdir -p "$TMP/src"
echo "cypher-brain SSS selftest payload" >"$TMP/src/note.txt"
cb "$HOME_A" snapshot --dir "$TMP/src" --out "$TMP/snap.age" >/dev/null
cb "$HOME_A" restore --in "$TMP/snap.age" --identity "$TMP/recovered-a.age" --out-dir "$TMP/restored" --yes >/dev/null
FOUND_NOTE="$(find "$TMP/restored" -name note.txt -print -quit)"
[ -n "$FOUND_NOTE" ] && grep -q "cypher-brain SSS selftest payload" "$FOUND_NOTE" \
  && echo "[PASS] restore using ONLY the SSS-reconstructed identity recovers the real plaintext" \
  || { echo "[FAIL] restore via reconstructed identity did not recover the plaintext"; exit 1; }

echo "== a corrupted share is refused, never silently reconstructed =="
cp "$SHARES_A/1.txt" "$TMP/corrupt.txt"
node -e '
  const fs = require("node:fs");
  const p = process.argv[1];
  const lines = fs.readFileSync(p, "utf8").split("\n");
  const i = lines.findIndex((l) => l.length > 0 && !l.startsWith("#"));
  const body = lines[i];
  lines[i] = (body[0] === "A" ? "B" : "A") + body.slice(1);
  fs.writeFileSync(p, lines.join("\n"));
' "$TMP/corrupt.txt"
if cb "$HOME_A" sss-combine --share "$TMP/corrupt.txt" --share "$SHARES_A/3.txt" --out "$TMP/bad-corrupt.age" >"$TMP/corrupt.out" 2>&1; then
  echo "[FAIL] sss-combine accepted a corrupted share"; cat "$TMP/corrupt.out"; exit 1
fi
test -f "$TMP/bad-corrupt.age" && { echo "[FAIL] a wrong identity file was written despite the refusal"; exit 1; }
echo "[PASS] corrupted share refused, no file written ($(head -c 120 "$TMP/corrupt.out"))"

echo "== shares from two different splits are refused before combine() =="
HOME_B="$TMP/home-b"
SHARES_B="$TMP/shares-b"
mkdir -p "$SHARES_B"
cb "$HOME_B" keygen --sss 2-of-2 --sss-out-dir "$SHARES_B/a.txt" --sss-out-dir "$SHARES_B/b.txt" >/dev/null
if cb "$HOME_A" sss-combine --share "$SHARES_A/1.txt" --share "$SHARES_B/a.txt" --out "$TMP/bad-mixed.age" >"$TMP/mixed.out" 2>&1; then
  echo "[FAIL] sss-combine accepted shares from two different splits"; cat "$TMP/mixed.out"; exit 1
fi
grep -q "different split" "$TMP/mixed.out" \
  && echo "[PASS] mixed-split shares refused with an actionable error" \
  || { echo "[FAIL] refused, but not with the expected 'different split' message"; cat "$TMP/mixed.out"; exit 1; }
test -f "$TMP/bad-mixed.age" && { echo "[FAIL] a wrong identity file was written despite the refusal"; exit 1; }

echo "== fewer than the declared threshold is refused =="
if cb "$HOME_A" sss-combine --share "$SHARES_A/1.txt" --out "$TMP/bad-single.age" >"$TMP/single.out" 2>&1; then
  echo "[FAIL] sss-combine accepted a single share (needs 2)"; cat "$TMP/single.out"; exit 1
fi
echo "[PASS] a single share is refused up front"

echo "== --sss-out-dir count mismatch is refused before touching disk =="
HOME_C="$TMP/home-c"
if cb "$HOME_C" keygen --sss 2-of-3 --sss-out-dir "$TMP/only-one.txt" >"$TMP/mismatch.out" 2>&1; then
  echo "[FAIL] keygen --sss accepted a wrong --sss-out-dir count"; cat "$TMP/mismatch.out"; exit 1
fi
test -f "$HOME_C/identity.age" && { echo "[FAIL] identity.age was written despite the refused --sss-out-dir count"; exit 1; }
echo "[PASS] wrong --sss-out-dir count refused, nothing written"

echo "== --sss is refused outright with --sign / --wrap-in-place =="
HOME_D="$TMP/home-d"
cb "$HOME_D" keygen >/dev/null # a plain identity, so --wrap-in-place has one to refuse against
if cb "$HOME_D" keygen --sign --sss 2-of-3 >"$TMP/sign.out" 2>&1; then
  echo "[FAIL] keygen --sign --sss was accepted"; cat "$TMP/sign.out"; exit 1
fi
if cb "$HOME_D" keygen --wrap-in-place --sss 2-of-3 >"$TMP/wip.out" 2>&1; then
  echo "[FAIL] keygen --wrap-in-place --sss was accepted"; cat "$TMP/wip.out"; exit 1
fi
echo "[PASS] --sign/--wrap-in-place both refuse --sss"

echo "== --pq hybrid identity round-trips through SSS identically to plain X25519 =="
HOME_PQ="$TMP/home-pq"
SHARES_PQ="$TMP/shares-pq"
mkdir -p "$SHARES_PQ"
cb "$HOME_PQ" keygen --pq --sss 2-of-3 \
  --sss-out-dir "$SHARES_PQ/1.txt" --sss-out-dir "$SHARES_PQ/2.txt" --sss-out-dir "$SHARES_PQ/3.txt" >/dev/null
grep -q '^AGE-SECRET-KEY-PQ-1' "$HOME_PQ/identity.age" || { echo "[FAIL] --pq identity is not hybrid-prefixed"; exit 1; }
cb "$HOME_PQ" sss-combine --share "$SHARES_PQ/2.txt" --share "$SHARES_PQ/3.txt" --out "$TMP/recovered-pq.age" >/dev/null
tail -n +2 "$HOME_PQ/identity.age" >"$TMP/pq-orig-tail.txt"
tail -n +2 "$TMP/recovered-pq.age" >"$TMP/pq-recovered-tail.txt"
diff -q "$TMP/pq-orig-tail.txt" "$TMP/pq-recovered-tail.txt" >/dev/null \
  && echo "[PASS] PQ hybrid identity reconstructs byte-identically via SSS" \
  || { echo "[FAIL] PQ hybrid reconstruction differs from the original"; exit 1; }

echo "== sss-split (#890): adds shares to an ALREADY-EXISTING identity without touching it =="
HOME_E="$TMP/home-e"
SHARES_E="$TMP/shares-e"
mkdir -p "$SHARES_E"
cb "$HOME_E" keygen >/dev/null # plain keygen, no --sss at all
IDENTITY_SHA_BEFORE="$(sha "$HOME_E/identity.age")"
RECIPIENT_BEFORE="$(cat "$HOME_E/recipient.txt")"
mkdir -p "$TMP/src-e"
echo "cypher-brain sss-split selftest payload" >"$TMP/src-e/note.txt"
cb "$HOME_E" snapshot --dir "$TMP/src-e" --out "$TMP/snap-e.age" >/dev/null
cb "$HOME_E" sss-split --sss 2-of-3 \
  --sss-out-dir "$SHARES_E/1.txt" --sss-out-dir "$SHARES_E/2.txt" --sss-out-dir "$SHARES_E/3.txt" >/dev/null
[ "$(sha "$HOME_E/identity.age")" = "$IDENTITY_SHA_BEFORE" ] \
  && echo "[PASS] sss-split left identity.age byte-for-byte unchanged" \
  || { echo "[FAIL] identity.age was modified by sss-split"; exit 1; }
[ "$(cat "$HOME_E/recipient.txt")" = "$RECIPIENT_BEFORE" ] \
  && echo "[PASS] sss-split left recipient.txt unchanged" \
  || { echo "[FAIL] recipient.txt was modified by sss-split"; exit 1; }
cb "$HOME_E" sss-combine --share "$SHARES_E/1.txt" --share "$SHARES_E/3.txt" --out "$TMP/recovered-e.age" >/dev/null
tail -n +2 "$HOME_E/identity.age" >"$TMP/e-orig-tail.txt"
tail -n +2 "$TMP/recovered-e.age" >"$TMP/e-recovered-tail.txt"
diff -q "$TMP/e-orig-tail.txt" "$TMP/e-recovered-tail.txt" >/dev/null \
  && echo "[PASS] sss-split shares reconstruct the pre-existing identity byte-for-byte" \
  || { echo "[FAIL] sss-split reconstruction differs from the pre-existing identity"; exit 1; }
cb "$HOME_E" restore --in "$TMP/snap-e.age" --identity "$TMP/recovered-e.age" --out-dir "$TMP/restored-e" --yes >/dev/null
FOUND_NOTE_E="$(find "$TMP/restored-e" -name note.txt -print -quit)"
[ -n "$FOUND_NOTE_E" ] && grep -q "cypher-brain sss-split selftest payload" "$FOUND_NOTE_E" \
  && echo "[PASS] restore using sss-split's reconstructed identity recovers a snapshot made BEFORE sss-split ran" \
  || { echo "[FAIL] restore via sss-split-reconstructed identity did not recover the pre-existing snapshot"; exit 1; }

echo "== sss-split on a PASSPHRASE-protected identity: prompts via env var, shares reconstruct the PLAIN identity =="
HOME_F="$TMP/home-f"
SHARES_F="$TMP/shares-f"
mkdir -p "$SHARES_F"
CYPHER_BRAIN_PASSPHRASE=selftest-pass-f cb "$HOME_F" keygen --passphrase >/dev/null
CYPHER_BRAIN_PASSPHRASE=selftest-pass-f cb "$HOME_F" sss-split --sss 2-of-2 \
  --sss-out-dir "$SHARES_F/a.txt" --sss-out-dir "$SHARES_F/b.txt" >/dev/null
cb "$HOME_F" sss-combine --share "$SHARES_F/a.txt" --share "$SHARES_F/b.txt" --out "$TMP/recovered-f.age" >/dev/null
# No CYPHER_BRAIN_PASSPHRASE set for this restore -- succeeds only if the recovered
# identity is genuinely unwrapped plaintext, not still passphrase-protected.
mkdir -p "$TMP/src-f"
echo "sss-split passphrase selftest payload" >"$TMP/src-f/note.txt"
cb "$HOME_F" snapshot --dir "$TMP/src-f" --out "$TMP/snap-f.age" >/dev/null
env -u CYPHER_BRAIN_PASSPHRASE node "${BIN_DEV_ARGS[@]}" "$BIN" restore \
  --in "$TMP/snap-f.age" --identity "$TMP/recovered-f.age" --out-dir "$TMP/restored-f" --yes >/dev/null
FOUND_NOTE_F="$(find "$TMP/restored-f" -name note.txt -print -quit)"
[ -n "$FOUND_NOTE_F" ] && grep -q "sss-split passphrase selftest payload" "$FOUND_NOTE_F" \
  && echo "[PASS] sss-split on a passphrase-protected identity reconstructs a usable PLAIN identity (no passphrase needed to restore)" \
  || { echo "[FAIL] restore via the passphrase-originated sss-split reconstruction failed"; exit 1; }

echo "== sss-split refuses share paths colliding with identity/recipient, and pre-existing share paths =="
if cb "$HOME_E" sss-split --sss 2-of-2 \
  --sss-out-dir "$HOME_E/identity.age" --sss-out-dir "$SHARES_E/new.txt" >"$TMP/split-collide.out" 2>&1; then
  echo "[FAIL] sss-split accepted a share path colliding with identity.age"; cat "$TMP/split-collide.out"; exit 1
fi
if cb "$HOME_E" sss-split --sss 2-of-3 \
  --sss-out-dir "$SHARES_E/1.txt" --sss-out-dir "$SHARES_E/2.txt" --sss-out-dir "$SHARES_E/3.txt" \
  >"$TMP/split-exists.out" 2>&1; then
  echo "[FAIL] sss-split accepted already-existing share paths"; cat "$TMP/split-exists.out"; exit 1
fi
echo "[PASS] sss-split refuses identity-path collisions and pre-existing share paths"

echo "== sss-split refuses a missing identity with an actionable error, not a raw ENOENT =="
if cb "$TMP/home-missing" sss-split --sss 2-of-2 --identity "$TMP/no-such-identity.age" \
  --sss-out-dir "$TMP/no-such-1.txt" --sss-out-dir "$TMP/no-such-2.txt" >"$TMP/split-missing.out" 2>&1; then
  echo "[FAIL] sss-split accepted a nonexistent --identity path"; cat "$TMP/split-missing.out"; exit 1
fi
grep -q "no identity at" "$TMP/split-missing.out" \
  && echo "[PASS] missing --identity path refused with an actionable message" \
  || { echo "[FAIL] missing --identity path did not get the actionable message"; cat "$TMP/split-missing.out"; exit 1; }

echo "SSS SELFTEST: PASS"
