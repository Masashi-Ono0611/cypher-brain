#!/usr/bin/env bash
# Post-quantum hybrid keypair round-trip proof (#205): `keygen --pq` generates an
# ML-KEM-768 + X25519 hybrid identity/recipient (via typage's generateHybridIdentity())
# instead of plain X25519 — this asserts the WHOLE pipeline (keygen -> snapshot ->
# push (file) -> pull -> verify -> restore) works with a hybrid key exactly like it
# does with a plain X25519 one, that a hybrid recipient survives
# CYPHER_BRAIN_PIN_RECIPIENTS parsing (the AGE_PUBKEY_RE fix this issue needed), and
# that a hybrid primary + X25519 backup recipient (the existing multi-recipient
# mechanism, #57/#99) mix freely — neither is special-cased for the other.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # sha(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_FILE_DIR="$TMP/store"
# cb here takes the CYPHER_BRAIN_HOME as its OWN first positional arg (this script
# exercises two concurrent keypairs, $PQ and $X25519) rather than an env-var
# override, so it keeps its own definition instead of scripts/selftest-lib.sh's.
cb() { CYPHER_BRAIN_HOME="$1" node "${BIN_DEV_ARGS[@]}" "$BIN" "${@:2}"; }

PQ="$TMP/keys-pq"
X25519="$TMP/keys-x25519"

echo "== keygen --pq generates a hybrid identity/recipient =="
cb "$PQ" keygen --pq >/dev/null
test -f "$PQ/identity.age"
test -f "$PQ/recipient.txt"
grep -q '^AGE-SECRET-KEY-PQ-1' "$PQ/identity.age" \
  && echo "[PASS] identity is AGE-SECRET-KEY-PQ-1… (hybrid)" || { echo "[FAIL] identity is not hybrid-prefixed"; cat "$PQ/identity.age"; exit 1; }
grep -q '^age1pq1' "$PQ/recipient.txt" \
  && echo "[PASS] recipient is age1pq1… (hybrid)" || { echo "[FAIL] recipient is not hybrid-prefixed"; cat "$PQ/recipient.txt"; exit 1; }
# Sanity: a hybrid recipient is MUCH bigger than a plain X25519 one (~1.9KB vs ~62
# bytes) — assert it is at least an order of magnitude bigger, not an exact byte
# count (which would pin this test to typage's current encoding).
RECLEN=$(wc -c <"$PQ/recipient.txt")
[ "$RECLEN" -gt 500 ] && echo "[PASS] hybrid recipient is much bigger than a plain X25519 one ($RECLEN bytes)" \
  || { echo "[FAIL] hybrid recipient suspiciously small ($RECLEN bytes)"; exit 1; }

echo "== keygen --wrap-in-place --pq is rejected (--pq has nothing to act on there) =="
if cb "$PQ" keygen --wrap-in-place --pq >/dev/null 2>"$TMP/wrap-pq.err"; then
  echo "[FAIL] --wrap-in-place --pq was accepted (should refuse — --pq would silently no-op)"; exit 1
fi
# Assert the SPECIFIC rejection reason, not just "some failure" — a --wrap-in-place
# --pq call could also fail for an unrelated reason (e.g. a missing identity file)
# and this check would still (wrongly) pass. The exact wording comes from
# src/lib/keys.ts's keygen() --pq/--wrap-in-place guard.
grep -q -- '--pq has no effect with --wrap-in-place' "$TMP/wrap-pq.err" \
  && echo "[PASS] --wrap-in-place --pq is refused with the specific --pq/--wrap-in-place error" \
  || { echo "[FAIL] --wrap-in-place --pq failed, but not with the expected --pq/--wrap-in-place error"; cat "$TMP/wrap-pq.err"; exit 1; }

echo "== keygen --pq --passphrase: the passphrase-wrap path is agnostic to identity type =="
cb "$X25519" keygen >/dev/null # plain X25519, used as the backup key below
PQWRAP="$TMP/keys-pq-wrapped"
CYPHER_BRAIN_HOME="$PQWRAP" CYPHER_BRAIN_PASSPHRASE="pq-selftest-pass-1234" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" keygen --pq --passphrase >/dev/null
# a passphrase-wrapped identity file is age ciphertext with a leading scrypt stanza —
# not just "doesn't start with AGE-SECRET-KEY-PQ-1" (which e.g. an empty or truncated
# file would also satisfy). Assert the POSITIVE shape instead: it must actually start
# with the age magic followed immediately by a scrypt stanza, exactly the same anchored
# check src/lib/crypt.ts's classifyIdentityFileAtRest() uses to recognize a passphrase
# wrap (vs. plain ciphertext-not-passphrase or an unrecognized file).
WRAP_HEADER="$(head -c 64 "$PQWRAP/identity.age")"
case "$WRAP_HEADER" in
  "age-encryption.org/v1"$'\n'"-> scrypt "*)
    echo "[PASS] identity.age is passphrase-wrapped (age-encryption.org/v1 + scrypt stanza)" ;;
  *)
    echo "[FAIL] identity.age does not start with the expected age-encryption.org/v1 + scrypt header"
    head -c 64 "$PQWRAP/identity.age" | cat -v
    exit 1 ;;
esac

SRC="$TMP/brain-src"; mkdir -p "$SRC"
MARKER="pq-secret-thought-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$MARKER" > "$SRC/note.txt"

# Prove the wrapped hybrid identity actually decrypts (not just "the file exists"):
# snapshot to it, then restore with CYPHER_BRAIN_PASSPHRASE supplying the passphrase
# non-interactively (same mechanism selftest.sh's own passphrase coverage uses).
cb "$PQWRAP" snapshot --dir "$SRC" --out "$TMP/wrapped-snap.age" >/dev/null
CYPHER_BRAIN_HOME="$PQWRAP" CYPHER_BRAIN_PASSPHRASE="pq-selftest-pass-1234" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$TMP/wrapped-snap.age" --out-dir "$TMP/wrapped-restored" >/dev/null
tar -xzf "$TMP/wrapped-restored/brain-src.tar.gz" -C "$TMP/wrapped-restored"
diff -r "$SRC" "$TMP/wrapped-restored/brain-src" \
  && echo "[PASS] passphrase-wrapped hybrid identity restores (--pq + --passphrase combine)" \
  || { echo "[FAIL] wrapped hybrid identity restore content mismatch"; exit 1; }

echo "== snapshot -> push (file) -> pull -> verify -> restore, encrypted to the hybrid key =="
cb "$PQ" snapshot --dir "$SRC" --out "$TMP/snap.age"
LOC=$(cb "$PQ" push --in "$TMP/snap.age" --backend file)
cb "$PQ" pull --locator "$LOC" --backend file --out "$TMP/got.age"
# Explicit existence check first: sha() on a missing file returns "", and a
# `[ "$(sha a)" = "$(sha b)" ]` comparison never sees sha()'s own exit status (see
# scripts/selftest-lib.sh's comment on sha() for why) — only its stdout. Without this, a
# `pull` that exited 0 but silently wrote nothing at $TMP/got.age would compare "" here;
# it happens to compare against a REAL hash on the other side (snap.age was already
# produced by a checked `snapshot` above), so this particular comparison would still
# correctly fail — but only by accident. Assert the precondition explicitly rather than
# relying on that.
test -f "$TMP/got.age" || { echo "[FAIL] pull exited 0 but wrote no output at $TMP/got.age"; exit 1; }
[ "$(sha "$TMP/got.age")" = "$(sha "$TMP/snap.age")" ] && echo "[PASS] pulled ciphertext == pushed ciphertext" \
  || { echo "[FAIL] pulled/pushed ciphertext mismatch"; exit 1; }
cb "$PQ" verify --in "$TMP/got.age" | grep -q "VERDICT: PASS" \
  && echo "[PASS] verify VERDICT PASS with the hybrid identity" || { echo "[FAIL] verify did not PASS"; exit 1; }
cb "$PQ" restore --in "$TMP/got.age" --out-dir "$TMP/restored" >/dev/null
tar -xzf "$TMP/restored/brain-src.tar.gz" -C "$TMP/restored"
diff -r "$SRC" "$TMP/restored/brain-src"
grep -q "$MARKER" "$TMP/restored/brain-src/note.txt" \
  && echo "[PASS] restored content matches the source (round-trip through the hybrid key)" \
  || { echo "[FAIL] restored content mismatch"; exit 1; }

echo "== an unrelated (plain X25519) identity cannot open a hybrid-only snapshot =="
if cb "$X25519" restore --in "$TMP/snap.age" --out-dir "$TMP/wrong" 2>/dev/null; then
  echo "[FAIL] a non-recipient identity restored a hybrid-encrypted snapshot"; exit 1
fi
echo "[PASS] non-recipient identity is rejected"

echo "== hybrid PRIMARY + X25519 BACKUP recipient mix freely (#57/#99 multi-recipient) =="
cb "$PQ" snapshot --dir "$SRC" \
  --recipient "$PQ/recipient.txt" --recipient "$X25519/recipient.txt" --out "$TMP/mixed.age"
cb "$PQ" restore --in "$TMP/mixed.age" --out-dir "$TMP/r-pq" >/dev/null
tar -xzf "$TMP/r-pq/brain-src.tar.gz" -C "$TMP/r-pq"
diff -r "$SRC" "$TMP/r-pq/brain-src" || { echo "[FAIL] hybrid identity did not restore the mixed-recipient snapshot"; exit 1; }
echo "[PASS] hybrid identity restores a snapshot encrypted to BOTH recipients"
cb "$X25519" restore --in "$TMP/mixed.age" --out-dir "$TMP/r-x25519" >/dev/null
tar -xzf "$TMP/r-x25519/brain-src.tar.gz" -C "$TMP/r-x25519"
diff -r "$SRC" "$TMP/r-x25519/brain-src" || { echo "[FAIL] X25519 backup identity did not restore the mixed-recipient snapshot"; exit 1; }
echo "[PASS] X25519 backup identity ALSO restores the same mixed-recipient snapshot"

echo "== CYPHER_BRAIN_PIN_RECIPIENTS accepts a hybrid recipient (AGE_PUBKEY_RE fix) =="
CYPHER_BRAIN_HOME="$PQ" CYPHER_BRAIN_PIN_RECIPIENTS="$PQ/recipient.txt" \
  node "${BIN_DEV_ARGS[@]}" "$BIN" snapshot --dir "$SRC" --recipient "$PQ/recipient.txt" --out "$TMP/pinned.age" \
  2>"$TMP/pinned.err" >/dev/null
grep -q "recipient pin OK" "$TMP/pinned.err" \
  && echo "[PASS] CYPHER_BRAIN_PIN_RECIPIENTS allowlists a hybrid recipient" \
  || { echo "[FAIL] pin check did not confirm the hybrid recipient"; cat "$TMP/pinned.err"; exit 1; }

echo
echo "POST-QUANTUM HYBRID KEY SELFTEST PASS"
