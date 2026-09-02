#!/usr/bin/env bash
# Selftest for scripts/run-selftests.mjs (#607) — the thing that runs every other selftest.
#
# A runner is a guard: it decides whether the suite passed. A guard nobody has watched fire
# is not a guard (rules/shell-ops.md — BLOCKED != PASS, and a check that has never been
# seen to fail is indistinguishable from one that cannot). So each of the runner's failure
# paths gets a positive control here: a case built to make it fire, asserted by exit code
# AND by the message, with a passing counterpart wherever "always fails" would also satisfy
# the assertion.
#
# Covered: --jobs validation (exit 2), the package.json-vs-runner coverage guard (both
# directions), pool concurrency (the same two 3s sleepers take >=6s at --jobs 1 and <4.5s
# at --jobs 3), fail-fast (stop scheduling, reap what is running, propagate the child's own
# exit code), per-test temp-hygiene attribution (a leak fails the run, names the test, and
# leaves the directory where scripts/verify.mjs will find it), and SIGTERM (children and
# grandchildren die, the runner re-raises rather than exiting 1).
#
# It drives the runner through CB_RUNNER_PLAN, which swaps the real suite for fake tests —
# see the note on that variable in scripts/run-selftests.mjs. Everything the fake tests
# write goes in $TMP/markers, NOT in the TMPDIR the inner runner hands them, so the only
# case that leaves anything behind is the one that means to.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNNER="$ROOT/scripts/run-selftests.mjs"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cb-runner-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
MARKERS="$TMP/markers"
mkdir -p "$MARKERS"

fail() { echo "[FAIL] $1"; exit 1; }
now_ms() { node -e 'process.stdout.write(String(Date.now()))'; }

# run_plan <case-name> <jobs> <plan-file> [env assignments...] -> RC, $TMP/<case>.log
run_plan() {
  local case_name="$1" jobs="$2" plan="$3"
  shift 3
  local dir="$TMP/tmpdir-$case_name"
  mkdir -p "$dir"
  RC=0
  env "$@" TMPDIR="$dir" TMP="$dir" TEMP="$dir" CB_RUNNER_PLAN="$plan" \
    node "$RUNNER" --jobs "$jobs" >"$TMP/$case_name.log" 2>&1 || RC=$?
}

# A fake test: $1 = script name, $2... = body lines.
mkfake() {
  local path="$MARKERS/$1.sh"
  shift
  printf '#!/usr/bin/env bash\n%s\n' "$*" >"$path"
  chmod +x "$path"
  printf '%s' "$path"
}

echo "== (1) --jobs validation: a bad value must exit 2, not fall back to a default =="
for bad in "--jobs 0" "--jobs x" "--jobs" "--jobs=3x" "--bogus"; do
  # shellcheck disable=SC2086 # deliberate word splitting: each case is a full argv
  RC=0
  node "$RUNNER" $bad >"$TMP/args.log" 2>&1 || RC=$?
  [ "$RC" -eq 2 ] || fail "node run-selftests.mjs $bad exited $RC, expected 2 (usage)"
done
# The counterpart: a VALID --jobs must not be rejected by the same code path.
cat >"$TMP/plan-noop.json" <<EOF
{"parallel":[{"name":"noop","cmd":"true","args":[]}]}
EOF
run_plan noop 2 "$TMP/plan-noop.json"
[ "$RC" -eq 0 ] || { cat "$TMP/noop.log"; fail "a valid --jobs 2 run exited $RC"; }
echo "[PASS] --jobs 0 / x / <missing> / 3x and an unknown flag all exit 2; a valid one runs"

echo "== (2) coverage guard: a selftest:* in package.json that the runner does not list =="
cat >"$TMP/pkg-drift.json" <<'EOF'
{"scripts":{"selftest:zzz":"bash scripts/selftest-zzz.sh","build":"true"}}
EOF
cat >"$TMP/plan-drift.json" <<EOF
{"packageJson":"$TMP/pkg-drift.json","parallel":[{"name":"noop","cmd":"true","args":[]}]}
EOF
run_plan drift 3 "$TMP/plan-drift.json"
[ "$RC" -eq 1 ] || { cat "$TMP/drift.log"; fail "the coverage guard exited $RC, expected 1"; }
grep -q 'selftest:zzz' "$TMP/drift.log" || { cat "$TMP/drift.log"; fail "the guard did not name the unlisted script"; }
grep -q 'out of sync with package.json' "$TMP/drift.log" || fail "the guard fired without saying what is wrong"
# Fired for the right reason, not because any packageJson makes it fire: same fixture, now
# listed, must pass. Without this the case above would be satisfied by an always-fail guard.
cat >"$TMP/plan-covered.json" <<EOF
{"packageJson":"$TMP/pkg-drift.json","parallel":[{"name":"selftest:zzz","cmd":"true","args":[]}]}
EOF
run_plan covered 3 "$TMP/plan-covered.json"
[ "$RC" -eq 0 ] || { cat "$TMP/covered.log"; fail "the guard failed a run whose plan DOES list the script (rc=$RC)"; }
# And the other direction: the runner listing a selftest package.json no longer declares.
cat >"$TMP/plan-stale.json" <<EOF
{"packageJson":"$TMP/pkg-drift.json","parallel":[{"name":"selftest:zzz","cmd":"true","args":[]},{"name":"selftest:gone","cmd":"true","args":[]}]}
EOF
run_plan stale 3 "$TMP/plan-stale.json"
[ "$RC" -eq 1 ] || { cat "$TMP/stale.log"; fail "the guard exited $RC for a stale entry, expected 1"; }
grep -q 'selftest:gone' "$TMP/stale.log" || fail "the guard did not name the stale entry"
echo "[PASS] the coverage guard fires in both directions and stays quiet when the lists agree"

echo "== (3) the pool really is concurrent: two 3s sleepers, --jobs 1 vs --jobs 3 =="
S1="$(mkfake sleeper1 'sleep 3')"
S2="$(mkfake sleeper2 'sleep 3')"
cat >"$TMP/plan-timing.json" <<EOF
{"parallel":[{"name":"sleeper1","cmd":"bash","args":["$S1"]},{"name":"sleeper2","cmd":"bash","args":["$S2"]}]}
EOF
T0="$(now_ms)"; run_plan serial 1 "$TMP/plan-timing.json"; T1="$(now_ms)"
[ "$RC" -eq 0 ] || { cat "$TMP/serial.log"; fail "the --jobs 1 timing run exited $RC"; }
SERIAL_MS=$((T1 - T0))
T0="$(now_ms)"; run_plan parallel 3 "$TMP/plan-timing.json"; T1="$(now_ms)"
[ "$RC" -eq 0 ] || { cat "$TMP/parallel.log"; fail "the --jobs 3 timing run exited $RC"; }
PAR_MS=$((T1 - T0))
[ "$SERIAL_MS" -ge 6000 ] || fail "--jobs 1 finished two 3s tests in ${SERIAL_MS}ms — it is not serial"
[ "$PAR_MS" -lt 4500 ] || fail "--jobs 3 took ${PAR_MS}ms for two 3s tests — the pool is not overlapping them"
echo "[PASS] --jobs 1 took ${SERIAL_MS}ms (>=6000), --jobs 3 took ${PAR_MS}ms (<4500)"

echo "== (4) fail-fast: stop scheduling, reap what is running, propagate the child's code =="
BOOM="$(mkfake boom 'echo boom-output; exit 3')"
SLOW="$(mkfake slowmate "sleep 2; echo slowmate-finished; touch '$MARKERS/slowmate.done'")"
LATE="$(mkfake late "touch '$MARKERS/late.started'; echo late-should-not-run")"
cat >"$TMP/plan-failfast.json" <<EOF
{"parallel":[
  {"name":"boom","cmd":"bash","args":["$BOOM"]},
  {"name":"slowmate","cmd":"bash","args":["$SLOW"]},
  {"name":"late-a","cmd":"bash","args":["$LATE"]},
  {"name":"late-b","cmd":"bash","args":["$LATE"]}
]}
EOF
run_plan failfast 2 "$TMP/plan-failfast.json"
[ "$RC" -eq 3 ] || { cat "$TMP/failfast.log"; fail "expected the failing child's own exit code 3, got $RC"; }
grep -q 'boom-output' "$TMP/failfast.log" || fail "the failing test's output block was not printed"
[ -f "$MARKERS/slowmate.done" ] || fail "the test already running was not awaited — it never finished"
grep -q 'slowmate-finished' "$TMP/failfast.log" || fail "the reaped test's output block was not printed"
[ ! -f "$MARKERS/late.started" ] || fail "a new test was scheduled after the failure"
grep -q 'late-a .*SKIP' "$TMP/failfast.log" || fail "the summary does not report the unrun tests as SKIP"
echo "[PASS] exit 3 propagated, the running test was reaped with its output, nothing new started"

echo "== (5) temp hygiene is attributed to the test that leaked =="
# The leak is what a real one looks like: an age private key left in the test's own TMPDIR.
LEAKY="$(mkfake leaky 'mkdir -p "$TMPDIR/keys"; echo AGE-SECRET-KEY-FAKE > "$TMPDIR/keys/identity.age"')"
CLEAN="$(mkfake cleanly 'true')"
cat >"$TMP/plan-leak.json" <<EOF
{"parallel":[{"name":"leaky","cmd":"bash","args":["$LEAKY"]},{"name":"cleanly","cmd":"bash","args":["$CLEAN"]}]}
EOF
run_plan leak 2 "$TMP/plan-leak.json"
[ "$RC" -ne 0 ] || { cat "$TMP/leak.log"; fail "a test that left an identity.age behind exited 0"; }
grep -q 'leaky' "$TMP/leak.log" || fail "the leak was not attributed to the test that caused it"
grep -q 'temp hygiene' "$TMP/leak.log" || fail "the failure does not say it is a temp-hygiene failure"
grep -q 'leaky *LEAK' "$TMP/leak.log" || fail "the summary does not mark the leaking test"
# Kept for scripts/verify.mjs to find, under the name of the test that leaked...
[ -f "$TMP/tmpdir-leak/leaky/keys/identity.age" ] || fail "the leaked directory was not preserved for inspection"
# ...while the test that cleaned up after itself had its directory removed, which is what
# keeps verify.mjs's own end-of-run "the sandbox is empty" assertion meaningful.
[ ! -d "$TMP/tmpdir-leak/cleanly" ] || fail "an empty per-test sandbox was left behind"
echo "[PASS] the leak failed the run, named 'leaky', and was left on disk; 'cleanly' was cleaned up"

echo "== (6) SIGTERM: children AND grandchildren die, and the signal is re-raised =="
UNIQ="cbmark$$"
GRAND="$(mkfake "grandchild-$UNIQ" 'sleep 120')"
CHILD="$(mkfake "child-$UNIQ" "bash '$GRAND' & sleep 120")"
cat >"$TMP/plan-signal.json" <<EOF
{"parallel":[{"name":"longrunner","cmd":"bash","args":["$CHILD"]}]}
EOF
SIGDIR="$TMP/tmpdir-signal"
mkdir -p "$SIGDIR"
# Resolve these BEFORE the assignment prefix below: bash applies a simple command's
# assignments left to right and later words in the SAME command see them, so writing
# `TMP="$SIGDIR" ... CB_RUNNER_PLAN="$TMP/plan-signal.json"` would look up the new TMP.
SIGNAL_PLAN="$TMP/plan-signal.json"
SIGNAL_LOG="$TMP/signal.log"
TMPDIR="$SIGDIR" TMP="$SIGDIR" TEMP="$SIGDIR" CB_RUNNER_PLAN="$SIGNAL_PLAN" \
  node "$RUNNER" --jobs 2 >"$SIGNAL_LOG" 2>&1 &
RUNNER_PID=$!
UP=0
for _ in $(seq 1 100); do
  if pgrep -f "grandchild-$UNIQ" >/dev/null 2>&1; then UP=1; break; fi
  sleep 0.1
done
[ "$UP" = 1 ] || { kill -9 "$RUNNER_PID" 2>/dev/null; cat "$SIGNAL_LOG"; fail "the fake test's grandchild never started — nothing to prove"; }
kill -TERM "$RUNNER_PID"
SRC=0
wait "$RUNNER_PID" || SRC=$?
# 128+15: bash reports a signal-terminated child that way, so this asserts the runner died
# OF SIGTERM rather than catching it and exiting 1 (which would hide an interrupt as a
# test failure upstream — scripts/verify.mjs relies on the distinction).
[ "$SRC" -eq 143 ] || { cat "$SIGNAL_LOG"; fail "the runner exited $SRC after SIGTERM, expected 143 (128+SIGTERM)"; }
GONE=0
for _ in $(seq 1 50); do
  if ! pgrep -f "child-$UNIQ" >/dev/null 2>&1 && ! pgrep -f "grandchild-$UNIQ" >/dev/null 2>&1; then GONE=1; break; fi
  sleep 0.1
done
if [ "$GONE" != 1 ]; then
  pkill -9 -f "$UNIQ" 2>/dev/null
  fail "a child or grandchild survived the SIGTERM (the process group was not killed)"
fi
echo "[PASS] SIGTERM killed the whole process group and the runner re-raised it (exit 143)"

echo "[PASS] scripts/run-selftests.mjs: every failure path above was observed to fire"
