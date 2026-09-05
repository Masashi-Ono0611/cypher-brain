#!/usr/bin/env bash
# Proof for #220's multi-model review (P1 finding 1): push()'s two AFTERMATH failure
# shapes in src/lib/pushpull.ts — a ciphertext upload that already succeeded before a
# LATER stage then fails. This is exactly the "partial success" scenario cypher-brain-mcp's
# idempotency_key feature (#220) exists to make retry-safe (see scripts/mcp-smoke.mjs's own
# idempotency partial-failure block for the MCP-level half of this coverage, which reuses
# the SAME error classes this proves) — but is exercised here at the CLI level because it
# needs deterministic control over exactly which upload step fails, which the file backend's
# content-addressed locator (a sha256 of the bytes) makes possible: pre-create a DIRECTORY
# at the destination path a later upload would need to copyFile into, and that specific
# copyFile call fails with EISDIR while an EARLIER one (already run) succeeded.
#
# Two scenarios, both against the free `file` backend (no network, no cost — CI can run
# this unconditionally, same posture as every other push()-touching selftest here):
#   (A) the ciphertext uploads, then the ".minisig" SIDECAR upload fails
#       (PushSignatureUploadError) — nothing about --save-locator is even reached yet.
#   (B) the ciphertext AND its signed sidecar both upload, then the LOCAL --save-locator
#       bookkeeping fails (PushLocatorWriteError, now carrying sigLocator too).
# Both assert: push exits nonzero, the error message says the upload already succeeded and
# names the (correct) locator, the ciphertext object is REALLY sitting in FILE_DIR (proof
# the "paid" step genuinely already happened), and whatever step never ran left no trace.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_FILE_DIR="$TMP/store"
export CYPHER_BRAIN_HOME="$TMP/keys"
cb keygen >/dev/null
cb keygen --sign >/dev/null

SRC="$TMP/brain"
mkdir -p "$SRC"
printf 'push-partial-failure-selftest\n' >"$SRC/note.txt"

echo "== (A) ciphertext uploads, then the .minisig SIDECAR upload fails (PushSignatureUploadError) =="
cb snapshot --dir "$SRC" --out "$TMP/sigfail.age" >/dev/null
CT_SHA_A=$(shasum -a 256 "$TMP/sigfail.age" | cut -d' ' -f1)
SIG_SHA_A=$(shasum -a 256 "$TMP/sigfail.age.minisig" | cut -d' ' -f1)
# Pre-create a DIRECTORY at the exact path the file backend's put() would copyFile the
# .minisig sidecar into — copyFile(file, <a directory>) fails (EISDIR), while the
# ciphertext's OWN put() (a different destination path, keyed on the ciphertext's own
# sha256) is untouched and succeeds normally.
mkdir -p "$TMP/store/${SIG_SHA_A}.minisig"
if cb push --in "$TMP/sigfail.age" --backend file --save-locator "$TMP/sigfail-loc.tsv" >"$TMP/sigfail-push.out" 2>&1; then
  echo "[FAIL] push exited 0 despite the .minisig sidecar upload failing"
  cat "$TMP/sigfail-push.out"
  exit 1
fi
echo "[PASS] push refuses (nonzero exit) when the .minisig sidecar upload fails"
grep -q 'ciphertext upload succeeded' "$TMP/sigfail-push.out" \
  && echo "[PASS] the error says the ciphertext upload already succeeded" \
  || { echo "[FAIL] error did not say the ciphertext upload already succeeded"; cat "$TMP/sigfail-push.out"; exit 1; }
grep -q 'signature sidecar' "$TMP/sigfail-push.out" \
  && echo "[PASS] the error names the signature sidecar as the step that failed" \
  || { echo "[FAIL] error did not name the signature sidecar"; cat "$TMP/sigfail-push.out"; exit 1; }
grep -qF "$CT_SHA_A" "$TMP/sigfail-push.out" \
  && echo "[PASS] the error names the ciphertext's own locator (its sha256)" \
  || { echo "[FAIL] error did not name the ciphertext locator ($CT_SHA_A)"; cat "$TMP/sigfail-push.out"; exit 1; }
test -f "$TMP/store/${CT_SHA_A}.age" \
  && echo "[PASS] the ciphertext object REALLY exists in FILE_DIR — the upload genuinely already happened" \
  || { echo "[FAIL] no ciphertext object in FILE_DIR — the ciphertext upload did not actually happen"; ls -la "$TMP/store"; exit 1; }
[ ! -f "$TMP/sigfail-loc.tsv" ] \
  && echo "[PASS] --save-locator was never written (push failed before that step was even reached)" \
  || { echo "[FAIL] --save-locator was written despite push failing at an EARLIER step"; exit 1; }

echo "== (B) ciphertext + signed sidecar both upload, then --save-locator's OWN write fails (PushLocatorWriteError, now carrying sigLocator) =="
cb snapshot --dir "$SRC" --out "$TMP/locfail.age" >/dev/null
CT_SHA_B=$(shasum -a 256 "$TMP/locfail.age" | cut -d' ' -f1)
SIG_SHA_B=$(shasum -a 256 "$TMP/locfail.age.minisig" | cut -d' ' -f1)
# --save-locator's own mkdir(dirname(...)) fails because its PARENT path component is a
# pre-existing regular FILE, not a directory — deterministic, no hash prediction needed
# for this one. The errno Node's fs.mkdir({recursive:true}) surfaces for "the target
# already exists as a non-directory" is platform-dependent — observed as EEXIST ("file
# already exists") on macOS, and other platforms are documented to report ENOTDIR for the
# same underlying condition — so the assertion below accepts either.
BAD_LOCATOR_PARENT="$TMP/locfail-parent-is-a-file"
printf 'not a directory\n' >"$BAD_LOCATOR_PARENT"
BAD_LOCATOR_FILE="$BAD_LOCATOR_PARENT/locator.tsv"
if cb push --in "$TMP/locfail.age" --backend file --save-locator "$BAD_LOCATOR_FILE" >"$TMP/locfail-push.out" 2>&1; then
  echo "[FAIL] push exited 0 despite --save-locator's own write failing"
  cat "$TMP/locfail-push.out"
  exit 1
fi
echo "[PASS] push refuses (nonzero exit) when --save-locator's own write fails"
grep -q 'upload succeeded' "$TMP/locfail-push.out" \
  && echo "[PASS] the error says the upload already succeeded" \
  || { echo "[FAIL] error did not say the upload already succeeded"; cat "$TMP/locfail-push.out"; exit 1; }
# Same specific-diagnostic bar as scenario A's "names the signature sidecar" check
# above — "upload succeeded" alone doesn't distinguish THIS failure (PushLocatorWriteError,
# --save-locator's own write) from scenario A's (PushSignatureUploadError, the .minisig
# sidecar). Assert the message names --save-locator as the step that failed, and surfaces
# the forced "parent is a file" cause underneath it (src/lib/push-partial-success.ts's
# PushLocatorWriteError wraps `cause.message` verbatim; see the comment above the forced
# failure setup for why this accepts either errno).
grep -q -- '--save-locator failed' "$TMP/locfail-push.out" \
  && echo "[PASS] the error names --save-locator itself as the step that failed" \
  || { echo "[FAIL] error did not name --save-locator as the failing step"; cat "$TMP/locfail-push.out"; exit 1; }
grep -qi 'ENOTDIR\|not a directory\|EEXIST\|file already exists' "$TMP/locfail-push.out" \
  && echo "[PASS] the error surfaces the underlying parent-is-a-file cause (forced failure mode)" \
  || { echo "[FAIL] error did not surface the underlying parent-is-a-file cause"; cat "$TMP/locfail-push.out"; exit 1; }
grep -qF "$CT_SHA_B" "$TMP/locfail-push.out" \
  && echo "[PASS] the error names the ciphertext's own locator" \
  || { echo "[FAIL] error did not name the ciphertext locator ($CT_SHA_B)"; cat "$TMP/locfail-push.out"; exit 1; }
test -f "$TMP/store/${CT_SHA_B}.age" \
  && echo "[PASS] the ciphertext object REALLY exists in FILE_DIR" \
  || { echo "[FAIL] no ciphertext object in FILE_DIR"; ls -la "$TMP/store"; exit 1; }
test -f "$TMP/store/${SIG_SHA_B}.minisig" \
  && echo "[PASS] the .minisig sidecar ALSO really uploaded (this scenario fails a step AFTER both uploads)" \
  || { echo "[FAIL] no .minisig sidecar object in FILE_DIR — the sidecar upload did not actually happen"; ls -la "$TMP/store"; exit 1; }
[ ! -e "$BAD_LOCATOR_FILE" ] \
  && echo "[PASS] --save-locator itself was never written (its own mkdir failed, as forced)" \
  || { echo "[FAIL] --save-locator was written despite forcing its own mkdir to fail"; exit 1; }

echo
echo "PUSH PARTIAL-FAILURE SELFTEST PASS"
