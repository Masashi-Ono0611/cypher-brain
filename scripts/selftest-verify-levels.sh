#!/usr/bin/env bash
# verify --level quick|remote|drill (issue #209): restic/kopia-style staged verification.
# quick was already the whole of `verify` before #209 and stays covered by
# scripts/selftest.sh / selftest-storage.sh / selftest-minisign.sh — this script covers
# the two NEW levels against the FILE backend (daemon-free, same reason
# selftest-storage.sh uses it): remote actually re-fetches by locator and re-runs the
# quick checks against the fetched bytes; drill additionally decrypts + extracts into a
# scratch directory and cleans it up.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb()/sha(), see scripts/selftest-lib.sh (#572)
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export CYPHER_BRAIN_HOME="$TMP/keys"
export CYPHER_BRAIN_FILE_DIR="$TMP/store"

MARKER="verify-levels-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
SRC="$TMP/brain-src"; mkdir -p "$SRC"
printf '%s\n' "$MARKER" > "$SRC/note.txt"

echo "== setup: keygen, snapshot, push (file backend) =="
cb keygen >/dev/null
cb snapshot --dir "$SRC" --out "$TMP/snap.age"
ORIG=$(sha "$TMP/snap.age")
LOC=$(cb push --in "$TMP/snap.age" --backend file --save-locator "$TMP/loc.tsv")
echo "[PASS] setup: pushed to file backend, locator=$LOC"

echo "== --level quick (default, unchanged): still works with no --level flag =="
cb verify --in "$TMP/snap.age" | grep -q 'VERDICT: PASS' \
  && echo "[PASS] verify (no --level) still defaults to quick" \
  || { echo "[FAIL] plain verify regressed"; exit 1; }
cb verify --level quick --in "$TMP/snap.age" | grep -q 'VERDICT: PASS' \
  && echo "[PASS] verify --level quick explicit PASS" \
  || { echo "[FAIL] --level quick explicit did not PASS"; exit 1; }

echo "== --level quick refuses --locator/--backend/--from-locator-file (those FETCH; quick never does) =="
set +e
Q_ERR=$(cb verify --level quick --in "$TMP/snap.age" --locator "$LOC" --backend file 2>&1); Q_RC=$?
set -e
[ "$Q_RC" != "0" ] || { echo "[FAIL] --level quick accepted --locator"; exit 1; }
printf '%s' "$Q_ERR" | grep -q 'quick' || { echo "[FAIL] refusal message unclear: $Q_ERR"; exit 1; }
echo "[PASS] --level quick refuses --locator/--backend"

echo "== --level remote/drill refuse --in (they fetch instead) =="
set +e
R_ERR=$(cb verify --level remote --in "$TMP/snap.age" --locator "$LOC" --backend file 2>&1); R_RC=$?
set -e
[ "$R_RC" != "0" ] || { echo "[FAIL] --level remote accepted --in"; exit 1; }
echo "[PASS] --level remote refuses --in"

echo "== --level remote/drill require --locator+--backend or --from-locator-file =="
set +e
NL_ERR=$(cb verify --level remote 2>&1); NL_RC=$?
set -e
[ "$NL_RC" != "0" ] || { echo "[FAIL] --level remote with no locator/backend accepted"; exit 1; }
echo "[PASS] --level remote refuses with no --locator/--backend/--from-locator-file"

echo "== --level remote: actually re-fetches from the store (delete local copy first) =="
rm -f "$TMP/snap.age"
cb verify --level remote --locator "$LOC" --backend file --sha256 "$ORIG" > "$TMP/remote.out" 2>&1
grep -q 'VERDICT: PASS' "$TMP/remote.out" \
  && echo "[PASS] --level remote VERDICT PASS after re-fetch from store" \
  || { echo "[FAIL] --level remote did not PASS"; cat "$TMP/remote.out"; exit 1; }
grep -q 'remote retrievability confirmed' "$TMP/remote.out" \
  && echo "[PASS] --level remote reports the fetch step" \
  || { echo "[FAIL] --level remote missing fetch-confirmation line"; cat "$TMP/remote.out"; exit 1; }

echo "== --level remote --from-locator-file: same recovery-path input pull/restore already use =="
cb verify --level remote --from-locator-file "$TMP/loc.tsv" | grep -q 'VERDICT: PASS' \
  && echo "[PASS] --level remote --from-locator-file PASS" \
  || { echo "[FAIL] --level remote --from-locator-file did not PASS"; exit 1; }

echo "== --level remote --json: exactly one JSON line, includes pulled{} =="
RJ=$(cb verify --level remote --locator "$LOC" --backend file --json); RRC=$?
[ "$RRC" = "0" ] || { echo "[FAIL] --level remote --json exited $RRC"; echo "$RJ"; exit 1; }
RLINES=$(printf '%s\n' "$RJ" | wc -l | tr -d ' ')
[ "$RLINES" = "1" ] || { echo "[FAIL] --level remote --json printed $RLINES stdout line(s), expected 1"; echo "$RJ"; exit 1; }
printf '%s' "$RJ" | grep -q '"pulled":{"backend":"file"' \
  && echo "[PASS] --level remote --json: one line, includes pulled{backend:file,...}" \
  || { echo "[FAIL] --level remote --json missing pulled{} block"; echo "$RJ"; exit 1; }
printf '%s' "$RJ" | grep -q '"verdict":"PASS"' \
  || { echo "[FAIL] --level remote --json verdict is not PASS"; echo "$RJ"; exit 1; }

echo "== --level remote: a locator that does not exist in the store FAILs (not a crash) =="
set +e
BAD_ERR=$(cb verify --level remote --locator "0000000000000000000000000000000000000000000000000000000000000000.age" --backend file 2>&1); BAD_RC=$?
set -e
[ "$BAD_RC" = "1" ] || { echo "[FAIL] --level remote on a missing locator exited $BAD_RC, expected 1"; echo "$BAD_ERR"; exit 1; }
printf '%s' "$BAD_ERR" | grep -q 'VERDICT: FAIL' \
  && echo "[PASS] --level remote on a missing store object reports VERDICT: FAIL, exit 1 (not a raw crash)" \
  || { echo "[FAIL] missing-object remote check did not report VERDICT: FAIL"; echo "$BAD_ERR"; exit 1; }

echo "== --level drill: pull -> decrypt -> extract into a scratch dir, byte-identical to source =="
cb verify --level drill --locator "$LOC" --backend file --sha256 "$ORIG" > "$TMP/drill.out" 2>&1
grep -q 'VERDICT: PASS' "$TMP/drill.out" \
  && echo "[PASS] --level drill VERDICT PASS" \
  || { echo "[FAIL] --level drill did not PASS"; cat "$TMP/drill.out"; exit 1; }
grep -q 'full restore' "$TMP/drill.out" \
  && echo "[PASS] --level drill reports the full-restore step" \
  || { echo "[FAIL] --level drill missing full-restore line"; cat "$TMP/drill.out"; exit 1; }

echo "== --level drill: the scratch pull/restore directory is not left behind =="
BEFORE=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'cypher-brain-verify-*' 2>/dev/null | wc -l | tr -d ' ')
cb verify --level drill --locator "$LOC" --backend file --sha256 "$ORIG" >/dev/null 2>&1
AFTER=$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'cypher-brain-verify-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$BEFORE" = "$AFTER" ] \
  && echo "[PASS] --level drill leaves no cypher-brain-verify-* scratch dir behind" \
  || { echo "[FAIL] --level drill leaked a scratch dir (before=$BEFORE after=$AFTER)"; exit 1; }

echo "== --level drill --json: exactly one JSON line, includes full_restore:true =="
DJ=$(cb verify --level drill --locator "$LOC" --backend file --json); DRC=$?
[ "$DRC" = "0" ] || { echo "[FAIL] --level drill --json exited $DRC"; echo "$DJ"; exit 1; }
DLINES=$(printf '%s\n' "$DJ" | wc -l | tr -d ' ')
[ "$DLINES" = "1" ] || { echo "[FAIL] --level drill --json printed $DLINES stdout line(s), expected 1"; echo "$DJ"; exit 1; }
printf '%s' "$DJ" | grep -q '"full_restore":true' \
  && echo "[PASS] --level drill --json: one line, includes full_restore:true" \
  || { echo "[FAIL] --level drill --json missing full_restore:true"; echo "$DJ"; exit 1; }

echo "== #436: --level drill's default console output omits the raw manifest.json dump; --verbose restores it =="
cb verify --level drill --locator "$LOC" --backend file --sha256 "$ORIG" > "$TMP/drill-default.out" 2>&1
grep -q '"schema"' "$TMP/drill-default.out" \
  && { echo "[FAIL] --level drill (no --verbose) printed the raw manifest.json dump"; cat "$TMP/drill-default.out"; exit 1; }
grep -q 'VERDICT: PASS' "$TMP/drill-default.out" \
  || { echo "[FAIL] --level drill (no --verbose) lost its VERDICT line"; cat "$TMP/drill-default.out"; exit 1; }
echo "[PASS] --level drill's default console output has no raw manifest.json dump, VERDICT still shown"

cb verify --level drill --locator "$LOC" --backend file --sha256 "$ORIG" --verbose > "$TMP/drill-verbose.out" 2>&1
grep -q '"schema"' "$TMP/drill-verbose.out" \
  || { echo "[FAIL] --level drill --verbose did not print the raw manifest.json dump"; cat "$TMP/drill-verbose.out"; exit 1; }
grep -q 'VERDICT: PASS' "$TMP/drill-verbose.out" \
  || { echo "[FAIL] --level drill --verbose lost its VERDICT line"; cat "$TMP/drill-verbose.out"; exit 1; }
echo "[PASS] --level drill --verbose prints the raw manifest.json dump alongside VERDICT"

echo "== --level drill --json --verbose: --verbose has no effect on --json's single-line contract =="
DJV=$(cb verify --level drill --locator "$LOC" --backend file --json --verbose); DJVRC=$?
[ "$DJVRC" = "0" ] || { echo "[FAIL] --level drill --json --verbose exited $DJVRC"; echo "$DJV"; exit 1; }
DJVLINES=$(printf '%s\n' "$DJV" | wc -l | tr -d ' ')
[ "$DJVLINES" = "1" ] \
  && echo "[PASS] --level drill --json --verbose still prints exactly one JSON line" \
  || { echo "[FAIL] --level drill --json --verbose printed $DJVLINES stdout line(s), expected 1"; echo "$DJV"; exit 1; }

echo "== --level drill refuses --pg (a drill must never touch a live database) =="
set +e
PG_ERR=$(cb verify --level drill --locator "$LOC" --backend file --pg "postgres://x/y" 2>&1); PG_RC=$?
set -e
[ "$PG_RC" != "0" ] || { echo "[FAIL] --level drill accepted --pg"; exit 1; }
printf '%s' "$PG_ERR" | grep -qi 'pg_restore' \
  && echo "[PASS] --level drill refuses --pg before doing any work" \
  || { echo "[FAIL] --level drill --pg refusal message unclear: $PG_ERR"; exit 1; }

echo "== --level drill: a sha256 mismatch FAILs closed (no plaintext extracted) =="
set +e
MISMATCH_ERR=$(cb verify --level drill --locator "$LOC" --backend file --sha256 "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" 2>&1); MISMATCH_RC=$?
set -e
[ "$MISMATCH_RC" = "1" ] || { echo "[FAIL] --level drill sha256 mismatch exited $MISMATCH_RC, expected 1"; echo "$MISMATCH_ERR"; exit 1; }
printf '%s' "$MISMATCH_ERR" | grep -q 'VERDICT: FAIL' \
  && echo "[PASS] --level drill with a wrong --sha256 pin reports VERDICT: FAIL" \
  || { echo "[FAIL] mismatched-pin drill did not report VERDICT: FAIL"; echo "$MISMATCH_ERR"; exit 1; }

echo "== --level bogus is refused =="
set +e
LVL_ERR=$(cb verify --level bogus --in "$TMP/snap.age" 2>&1); LVL_RC=$?
set -e
[ "$LVL_RC" != "0" ] || { echo "[FAIL] --level bogus accepted"; exit 1; }
printf '%s' "$LVL_ERR" | grep -q 'quick, remote or drill' \
  && echo "[PASS] --level bogus refused with a clear message" \
  || { echo "[FAIL] --level bogus refusal message unclear: $LVL_ERR"; exit 1; }

echo "== --level drill on a public-key-only box is PARTIAL (skips the restore step, no identity to decrypt with) =="
PUBONLY="$TMP/pubonly"; mkdir -p "$PUBONLY"
cp "$TMP/keys/recipient.txt" "$PUBONLY/recipient.txt"
set +e
PART_OUT=$(CYPHER_BRAIN_HOME="$PUBONLY" node "${BIN_DEV_ARGS[@]}" "$BIN" verify --level drill --locator "$LOC" --backend file --sha256 "$ORIG" 2>&1); PART_RC=$?
set -e
[ "$PART_RC" = "2" ] || { echo "[FAIL] public-key-only --level drill exited $PART_RC, expected 2"; echo "$PART_OUT"; exit 1; }
printf '%s' "$PART_OUT" | grep -q 'no private identity on this box' \
  && echo "[PASS] public-key-only --level drill SKIPs the restore step and reports PARTIAL (exit 2)" \
  || { echo "[FAIL] public-key-only --level drill did not explain the skip"; echo "$PART_OUT"; exit 1; }
# The exit code above proves the VERDICT internally, but drill's SKIP branch used to
# suppress the human-readable "VERDICT: …" line entirely (runFileChecks was told not to
# print one, since drill's overall verdict still depended on a restore step it never
# reaches here, and finishVerify never printed one either) — this specific assertion is
# what would have caught that regression; the exit-code check above alone would not
# have (#332 review).
printf '%s' "$PART_OUT" | grep -q 'VERDICT: PARTIAL' \
  && echo "[PASS] public-key-only --level drill still prints the promised VERDICT: PARTIAL line" \
  || { echo "[FAIL] public-key-only --level drill did not print VERDICT: PARTIAL"; echo "$PART_OUT"; exit 1; }

echo "== --level drill: a fetched-but-corrupt artifact (not a fetch failure) also prints VERDICT: FAIL in human mode =="
# Distinct from the --sha256 mismatch case above: THAT fails during the FETCH itself
# (pull()'s own pin check), which already printed its VERDICT: FAIL from the early-
# return branch untouched by this bug. This one fetches fine — the corruption is only
# caught by runFileChecks AFTERWARD (the positive control fails to decrypt a truncated
# STREAM) — exercising the SAME "checks already failed, skip the restore" branch the
# public-key-only case above exercises for PARTIAL, but for FAIL instead.
cb snapshot --dir "$SRC" --out "$TMP/trunc-src.age" >/dev/null
TRUNCSZ=$(wc -c < "$TMP/trunc-src.age" | tr -d ' ')
head -c $((TRUNCSZ - 500)) "$TMP/trunc-src.age" > "$TMP/trunc.age"
TRUNC_LOC=$(cb push --in "$TMP/trunc.age" --backend file)
set +e
FAIL_OUT=$(cb verify --level drill --locator "$TRUNC_LOC" --backend file 2>&1); FAIL_RC=$?
set -e
[ "$FAIL_RC" = "1" ] || { echo "[FAIL] drill on a fetched-but-corrupt artifact exited $FAIL_RC, expected 1"; echo "$FAIL_OUT"; exit 1; }
printf '%s' "$FAIL_OUT" | grep -q 'full restore drill — the checks above already failed' \
  || { echo "[FAIL] drill did not report why the restore step was skipped"; echo "$FAIL_OUT"; exit 1; }
printf '%s' "$FAIL_OUT" | grep -q 'VERDICT: FAIL' \
  && echo "[PASS] --level drill on a fetched-but-corrupt artifact prints VERDICT: FAIL (not silently suppressed)" \
  || { echo "[FAIL] --level drill on a fetched-but-corrupt artifact did not print VERDICT: FAIL"; echo "$FAIL_OUT"; exit 1; }

echo "== --level remote: file backend refuses an object substituted under the same locator (#332 review) =="
# The file backend's locator IS its object's own sha256 (its whole "content-addressed"
# claim) — but nothing enforced that BEFORE this fix: get() only checked the FILENAME
# shape, never the actual bytes. Push a SECOND, different snapshot, then overwrite the
# FIRST object's on-disk bytes with the second's, keeping the first object's FILENAME
# (its locator) unchanged — exactly what a substituted/rolled-back object looks like.
# Without --sha256 (the scenario NON_CONTENT_ADDRESSED_BACKENDS' warning does NOT cover
# for `file`, since `file` is presumed self-verifying), this used to reach VERDICT: PASS.
SRC2="$TMP/brain-src-2"; mkdir -p "$SRC2"
printf 'different-content-%s\n' "$MARKER" > "$SRC2/note2.txt"
cb snapshot --dir "$SRC2" --out "$TMP/snap2.age" >/dev/null
LOC2=$(cb push --in "$TMP/snap2.age" --backend file)
cp "$LOC2" "$LOC"
set +e
SUBST_ERR=$(cb verify --level remote --locator "$LOC" --backend file 2>&1); SUBST_RC=$?
set -e
[ "$SUBST_RC" != "0" ] || { echo "[FAIL] verify --level remote PASSed over a substituted file-backend object"; echo "$SUBST_ERR"; exit 1; }
printf '%s' "$SUBST_ERR" | grep -qi 'does not match its own locator hash' \
  && echo "[PASS] file backend refuses a substituted object (content no longer matches its own locator hash)" \
  || { echo "[FAIL] substituted-object refusal message unclear: $SUBST_ERR"; exit 1; }

echo "== --level remote --json: a recorded-but-unfetchable signature sidecar is reported structurally, not just a stderr warning (#332 review) =="
# src/mcp.ts's verify_restore/restore_now already have this (signatureGap(), #312); the
# CLI's --json had no equivalent field at all before this fix — only the human-readable
# stderr warning pull() itself already prints.
SIGHOME="$TMP/sig-keys"; mkdir -p "$SIGHOME"
CYPHER_BRAIN_HOME="$SIGHOME" cb keygen >/dev/null
CYPHER_BRAIN_HOME="$SIGHOME" cb keygen --sign >/dev/null
SIGSRC="$TMP/sig-src"; mkdir -p "$SIGSRC"
printf 'sig-test-%s\n' "$MARKER" > "$SIGSRC/note.txt"
CYPHER_BRAIN_HOME="$SIGHOME" cb snapshot --dir "$SIGSRC" --out "$TMP/sig.age" >/dev/null
CYPHER_BRAIN_HOME="$SIGHOME" cb push --in "$TMP/sig.age" --backend file --save-locator "$TMP/sig-loc.tsv" >/dev/null
SIG_LOCATOR_PATH=$(cut -f6 "$TMP/sig-loc.tsv")
[ -n "$SIG_LOCATOR_PATH" ] || { echo "[FAIL] save-locator file has no 6th (sig_locator) field"; cat "$TMP/sig-loc.tsv"; exit 1; }
rm -f "$SIG_LOCATOR_PATH"   # the signature object itself vanishes from storage — recorded, but no longer fetchable
SIGJ=$(CYPHER_BRAIN_HOME="$SIGHOME" cb verify --level remote --from-locator-file "$TMP/sig-loc.tsv" --json)
printf '%s' "$SIGJ" | grep -q '"signature":{"fetched":false' \
  && echo "[PASS] --level remote --json reports the downgrade structurally (signature.fetched:false)" \
  || { echo "[FAIL] --level remote --json did not report the signature gap"; echo "$SIGJ"; exit 1; }
printf '%s' "$SIGJ" | grep -q 'could not fetch the authenticity signature' \
  && echo "[PASS] --level remote --json signature.reason carries pull's own reason" \
  || { echo "[FAIL] --level remote --json signature block missing pull's reason"; echo "$SIGJ"; exit 1; }

echo "== --level remote --json: a failed fetch still carries sha256_pin (consistent pulled{} shape across outcomes) =="
set +e
FAILJ=$(cb verify --level remote --locator "0000000000000000000000000000000000000000000000000000000000000000.age" --backend file --sha256 "$ORIG" --json)
set -e
printf '%s' "$FAILJ" | grep -q '"sha256_pin":"'"$ORIG"'"' \
  && echo "[PASS] a failed-fetch --json still includes pulled.sha256_pin (same field, every outcome)" \
  || { echo "[FAIL] failed-fetch --json is missing pulled.sha256_pin"; echo "$FAILJ"; exit 1; }

echo "== --level drill: SIGTERM during component auto-expand leaves no scratch dir or plaintext behind (#332 review) =="
# The P1 gap this covers: restoreImpl()'s own out-dir signal tracking (ACTIVE_RESTORE_OUT_DIR)
# is cleared the instant its OWN tar extract settles — which is BEFORE component auto-expand
# runs (still more plaintext written under the SAME scratch dir). A signal landing in
# EXACTLY that window used to go untracked entirely. Slow down ONLY the auto-expand step's
# own `tar -xzf` (never the outer restoreImpl() extract, which uses `tar -xf -`, no `z`) via
# a stub tar, poll for the outer extract's manifest.json to land (proving
# ACTIVE_RESTORE_OUT_DIR has ALREADY been cleared), then SIGTERM — landing in the gap.
REALTAR="$(command -v tar)"
STUBBIN="$TMP/stubbin"; mkdir -p "$STUBBIN"
cat > "$STUBBIN/tar" <<STUBEOF
#!/usr/bin/env bash
if [ "\$1" = "-xzf" ] && [ "\${TAR_STUB_MODE:-}" = "slow_expand" ]; then
  sleep "\${TAR_STUB_SLEEP:-5}"
fi
exec "$REALTAR" "\$@"
STUBEOF
chmod +x "$STUBBIN/tar"
export TMPDIR="$TMP/verify-sig-tmpdir"; mkdir -p "$TMPDIR"
PATH="$STUBBIN:$PATH" TAR_STUB_MODE=slow_expand TAR_STUB_SLEEP=5 \
  node "${BIN_DEV_ARGS[@]}" "$BIN" verify --level drill --locator "$LOC2" --backend file --sha256 "$(sha "$TMP/snap2.age")" >/dev/null 2>&1 &
DRILL_PID=$!
APPEARED=0
for _ in $(seq 1 50); do
  if find "$TMPDIR" -maxdepth 1 -name 'cypher-brain-verify-*' -type d 2>/dev/null | grep -q .; then
    MANIFEST=$(find "$TMPDIR" -maxdepth 3 -path '*/restored/manifest.json' 2>/dev/null | head -1)
    if [ -n "$MANIFEST" ] && [ -f "$MANIFEST" ]; then APPEARED=1; break; fi
  fi
  sleep 0.1
done
if [ "$APPEARED" != "1" ]; then
  echo "[FAIL] drill never reached component auto-expand (test setup)"; kill "$DRILL_PID" 2>/dev/null || true; exit 1
fi
kill -TERM "$DRILL_PID"
wait "$DRILL_PID" 2>/dev/null || true   # signal exit is non-zero — expected
LEFTOVERS=$(find "$TMPDIR" -maxdepth 1 -name 'cypher-brain-verify-*' 2>/dev/null | wc -l | tr -d ' ')
[ "$LEFTOVERS" = "0" ] \
  && echo "[PASS] SIGTERM mid-component-expand leaves no cypher-brain-verify-* scratch dir (no plaintext left behind)" \
  || { echo "[FAIL] SIGTERM mid-component-expand leaked $LEFTOVERS scratch dir(s)"; exit 1; }
unset TMPDIR

echo "== #536: --level quick --json includes \"level\":\"quick\" (parity with remote/drill) =="
QJ=$(cb verify --in "$TMP/snap2.age" --json); QJRC=$?
[ "$QJRC" = "0" ] || { echo "[FAIL] quick --json exited $QJRC"; echo "$QJ"; exit 1; }
printf '%s' "$QJ" | grep -q '"level":"quick"' \
  && echo "[PASS] --level quick --json includes \"level\":\"quick\"" \
  || { echo "[FAIL] --level quick --json missing the level field"; echo "$QJ"; exit 1; }

echo "== #536: --level quick's plain-text first line is 'level: quick' (parity with remote/drill's own first line) =="
QPLAIN=$(cb verify --in "$TMP/snap2.age")
QFIRST=$(printf '%s\n' "$QPLAIN" | head -1)
[ "$QFIRST" = "level: quick" ] \
  && echo "[PASS] --level quick's plain-text output starts with 'level: quick'" \
  || { echo "[FAIL] --level quick's first output line was '$QFIRST', expected 'level: quick'"; exit 1; }

echo "== #745: 'level: quick' must not print to stdout before --in is validated =="
# Sibling commands (restore, and #528/#536 above's own remote/drill checks) print
# nothing to stdout on a basic usage/argument error — only the error line goes to
# stderr. quick used to violate that: the "level: quick" console.log two lines above
# this test's setup fired unconditionally, BEFORE runFileChecks()'s own --in
# presence/existence check ever ran — so a caller with no --in, or a typo'd path, still
# saw a stdout line ahead of the stderr error.
set +e
NOIN_OUT=$(cb verify 2>"$TMP/745-noin.err"); NOIN_RC=$?
set -e
[ "$NOIN_RC" != "0" ] || { echo "[FAIL] verify with no --in exited 0"; exit 1; }
[ -z "$NOIN_OUT" ] \
  && echo "[PASS] verify with no --in prints nothing to stdout" \
  || { echo "[FAIL] verify with no --in printed to stdout: $NOIN_OUT"; exit 1; }
grep -q 'required' "$TMP/745-noin.err" \
  && echo "[PASS] verify with no --in reports the error on stderr" \
  || { echo "[FAIL] verify with no --in stderr missing the expected error"; cat "$TMP/745-noin.err"; exit 1; }

set +e
BADIN_OUT=$(cb verify --in "$TMP/745-does-not-exist.age" 2>"$TMP/745-badin.err"); BADIN_RC=$?
set -e
[ "$BADIN_RC" != "0" ] || { echo "[FAIL] verify --in <nonexistent> exited 0"; exit 1; }
[ -z "$BADIN_OUT" ] \
  && echo "[PASS] verify --in <nonexistent> prints nothing to stdout" \
  || { echo "[FAIL] verify --in <nonexistent> printed to stdout: $BADIN_OUT"; exit 1; }
grep -q 'no such file' "$TMP/745-badin.err" \
  && echo "[PASS] verify --in <nonexistent> reports the error on stderr" \
  || { echo "[FAIL] verify --in <nonexistent> stderr missing the expected error"; cat "$TMP/745-badin.err"; exit 1; }

echo "== #528 setup: a genuinely signed artifact, pushed with --save-locator (records the sig_locator as the 6th field) =="
SIGHOME528="$TMP/sig-keys-528"; mkdir -p "$SIGHOME528"
CYPHER_BRAIN_HOME="$SIGHOME528" cb keygen >/dev/null
CYPHER_BRAIN_HOME="$SIGHOME528" cb keygen --sign >/dev/null
SIGSRC528="$TMP/sig-src-528"; mkdir -p "$SIGSRC528"
printf 'sig528-test-%s\n' "$MARKER" > "$SIGSRC528/note.txt"
CYPHER_BRAIN_HOME="$SIGHOME528" cb snapshot --dir "$SIGSRC528" --out "$TMP/sig528.age" >/dev/null
CYPHER_BRAIN_HOME="$SIGHOME528" cb push --in "$TMP/sig528.age" --backend file --save-locator "$TMP/sig528-loc.tsv" >/dev/null
SIG528_LOC=$(cut -f1 "$TMP/sig528-loc.tsv")
SIG528_LOCATOR=$(cut -f6 "$TMP/sig528-loc.tsv")
[ -n "$SIG528_LOCATOR" ] || { echo "[FAIL] #528 setup: save-locator file has no 6th (sig_locator) field"; cat "$TMP/sig528-loc.tsv"; exit 1; }

echo "== #528 POSITIVE CONTROL: bare --locator/--backend/--sig-locator/--require-signature now PASSes on a genuinely valid signature =="
# Before the fix, verifyImpl()'s internal pull() call (src/lib/restore.ts ~line 1277)
# built its CliOptions object literal WITHOUT sig_locator, so the .minisig sidecar was
# never fetched — --require-signature then hard-failed on a signature that was actually
# valid and fetchable. Confirmed as an actual regression during development (not just
# theorized): temporarily removing the `sig_locator: o.sig_locator,` line from that
# object literal and re-running this EXACT command reproduced `"signature":"fail"` /
# `"verdict":"FAIL"` / exit 1 — restoring the line fixed it back to PASS, which is what
# this assertion locks in.
set +e
S528=$(CYPHER_BRAIN_HOME="$SIGHOME528" cb verify --level remote --locator "$SIG528_LOC" --backend file --sig-locator "$SIG528_LOCATOR" --require-signature --json); S528RC=$?
set -e
[ "$S528RC" = "0" ] || { echo "[FAIL] #528: bare --locator/--backend/--sig-locator/--require-signature exited $S528RC, expected 0"; echo "$S528"; exit 1; }
printf '%s' "$S528" | grep -q '"signature":"pass"' \
  && echo "[PASS] #528: bare --locator/--backend/--sig-locator/--require-signature fetches and verifies a genuinely valid signature" \
  || { echo "[FAIL] #528: signature check did not report pass"; echo "$S528"; exit 1; }
printf '%s' "$S528" | grep -q '"verdict":"PASS"' \
  && echo "[PASS] #528: overall verdict is PASS (not a false-negative FAIL)" \
  || { echo "[FAIL] #528: overall verdict was not PASS"; echo "$S528"; exit 1; }

echo "== #528: --level quick refuses --sig-locator (it never fetches, same as --locator/--backend/--from-locator-file) =="
set +e
SQ_ERR=$(cb verify --level quick --in "$TMP/snap2.age" --sig-locator "$SIG528_LOCATOR" 2>&1); SQ_RC=$?
set -e
[ "$SQ_RC" != "0" ] || { echo "[FAIL] --level quick accepted --sig-locator"; exit 1; }
printf '%s' "$SQ_ERR" | grep -q -- '--sig-locator' \
  && echo "[PASS] --level quick refuses --sig-locator" \
  || { echo "[FAIL] --level quick --sig-locator refusal message unclear: $SQ_ERR"; exit 1; }

echo "== #530: --level drill prints the signature-check result exactly once (not duplicated by the internal restore step) =="
D530=$(CYPHER_BRAIN_HOME="$SIGHOME528" cb verify --level drill --locator "$SIG528_LOC" --backend file --sig-locator "$SIG528_LOCATOR" --require-signature 2>&1)
printf '%s\n' "$D530" | grep -q 'VERDICT: PASS' \
  || { echo "[FAIL] #530 setup: --level drill on a signed artifact did not PASS"; echo "$D530"; exit 1; }
SIGLINES=$(printf '%s\n' "$D530" | grep -c 'minisign authenticity signature verified' || true)
[ "$SIGLINES" = "1" ] \
  && echo "[PASS] #530: --level drill prints the signature-check PASS line exactly once (not twice)" \
  || { echo "[FAIL] #530: --level drill printed the signature-check line $SIGLINES time(s), expected exactly 1"; echo "$D530"; exit 1; }

echo "== #531: an EXPLICITLY-given --identity path that does not exist is a hard error (typo), not a silent PARTIAL =="
set +e
ID_ERR=$(cb verify --in "$TMP/snap2.age" --level quick --identity "$TMP/no-such-identity.age" 2>&1); ID_RC=$?
set -e
[ "$ID_RC" = "1" ] || { echo "[FAIL] explicit nonexistent --identity exited $ID_RC, expected 1 (hard error, not exit 2/PARTIAL)"; echo "$ID_ERR"; exit 1; }
printf '%s' "$ID_ERR" | grep -q 'cannot decrypt without the private key' \
  && echo "[PASS] explicit nonexistent --identity is refused with the same hard-error wording restore uses" \
  || { echo "[FAIL] explicit nonexistent --identity refusal message unclear: $ID_ERR"; exit 1; }
printf '%s' "$ID_ERR" | grep -q 'CB-E015' \
  && echo "[PASS] explicit nonexistent --identity carries the CB-E015 error code" \
  || { echo "[FAIL] explicit nonexistent --identity is missing the CB-E015 error code: $ID_ERR"; exit 1; }
if printf '%s' "$ID_ERR" | grep -q 'PARTIAL'; then
  echo "[FAIL] explicit nonexistent --identity error text mentions PARTIAL — it must read as a hard error, not a verdict"
  exit 1
fi
echo "[PASS] explicit nonexistent --identity does not read as a PARTIAL verdict"

echo "== #531 control: --identity OMITTED entirely (no default identity present either) is still the legitimate PARTIAL — must not regress =="
set +e
NOID_OUT=$(CYPHER_BRAIN_HOME="$PUBONLY" node "${BIN_DEV_ARGS[@]}" "$BIN" verify --in "$TMP/snap2.age" --level quick 2>&1); NOID_RC=$?
set -e
[ "$NOID_RC" = "2" ] || { echo "[FAIL] control: --identity omitted on a public-key-only box exited $NOID_RC, expected 2 (PARTIAL)"; echo "$NOID_OUT"; exit 1; }
printf '%s' "$NOID_OUT" | grep -q 'no private identity on this machine' \
  && echo "[PASS] control: --identity omitted with no default identity present is still an unchanged, expected PARTIAL" \
  || { echo "[FAIL] control: omitted-identity PARTIAL message missing/changed"; echo "$NOID_OUT"; exit 1; }

echo "== #531 (multi-model review fix): an EXPLICIT bad --identity still surfaces as CB-E015 even when the signature ALSO independently fails =="
# Before this fix, the explicit-identity check lived inside the 'else' of `if (sigOk ===
# false)` — so a genuinely invalid/tampered signature would route straight into "[SKIP]
# positive control — skipped (the authenticity signature above failed)" and the identity
# typo underneath it was never reported at all, silently subsumed by the signature FAIL.
cp "$TMP/sig528.age.minisig" "$TMP/sig528.age.minisig.bak"
printf 'not a real signature\n' > "$TMP/sig528.age.minisig"
set +e
BADSIG_ERR=$(CYPHER_BRAIN_HOME="$SIGHOME528" cb verify --in "$TMP/sig528.age" --level quick --identity "$TMP/no-such-identity-2.age" 2>&1); BADSIG_RC=$?
set -e
mv "$TMP/sig528.age.minisig.bak" "$TMP/sig528.age.minisig"
[ "$BADSIG_RC" = "1" ] || { echo "[FAIL] explicit bad --identity + invalid signature exited $BADSIG_RC, expected 1"; echo "$BADSIG_ERR"; exit 1; }
printf '%s' "$BADSIG_ERR" | grep -q 'CB-E015' \
  && echo "[PASS] explicit bad --identity is still refused (CB-E015) even when the signature above is ALSO invalid" \
  || { echo "[FAIL] explicit bad --identity was not refused when the signature also failed: $BADSIG_ERR"; exit 1; }

echo "[PASS] verify --level quick/remote/drill (issue #209) all behave as documented"
