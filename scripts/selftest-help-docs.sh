#!/usr/bin/env bash
# Selftest for scripts/check-help-docs.mjs (issue #227 part 2): proves the docs-
# drift checker actually CATCHES drift in both directions — a stale README.md and
# a changed HELP text in src/cli.ts — and that `--write` repairs it back to a
# passing state. Without this, the checker itself could silently no-op (e.g. a
# broken marker regex that always "matches") and nobody would notice until the
# next real drift slipped through anyway (rules/shell-ops.md: BLOCKED != PASS —
# an untested gate is not a proven gate).
#
# Mutates README.md and src/cli.ts IN PLACE for the duration of the test; both are
# restored from a backup on ANY exit path (trap), so a failure here never leaves
# the working tree dirty.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK="$ROOT/scripts/check-help-docs.mjs"
README="$ROOT/README.md"
CLI_SRC="$ROOT/src/cli.ts"

TMP="$(mktemp -d)"
cp "$README" "$TMP/README.md.orig"
cp "$CLI_SRC" "$TMP/cli.ts.orig"
restore() {
  cp "$TMP/README.md.orig" "$README"
  cp "$TMP/cli.ts.orig" "$CLI_SRC"
  rm -rf "$TMP"
}
trap restore EXIT

fail() { echo "[FAIL] $1"; exit 1; }

# Prints everything OUTSIDE the HELP-START/HELP-END marker block: up to and including
# the HELP-START line, then from the HELP-END line to EOF. Used below to prove --write
# only touches the block it owns — a regenerator that clobbered the rest of the file
# (or duplicated/dropped content around the markers) would still leave the marker block
# itself matching `--help` and pass every other assertion in this script.
outside_marker_block() {
  sed -n '1,/HELP-START/p' "$1"
  sed -n '/HELP-END/,$p' "$1"
}

# (0) sanity: the real, un-mutated tree must pass before we start mutating it —
# otherwise every check below is meaningless (drift already present).
node "$CHECK" >/dev/null 2>&1 || fail "checker fails on a clean tree (fix the drift first, or the marker block, before trusting this selftest)"
echo "[PASS] clean tree: checker passes"

# (1) README-side drift: change a word inside the marker block only (leave
# src/cli.ts untouched) — the checker must fail non-zero.
sed -i.bak 's/Assert it is real age ciphertext/DRIFT-INJECTED-BY-SELFTEST/' "$README"
rm -f "$README.bak"
set +e
node "$CHECK" >"$TMP/readme-drift.log" 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "checker exited 0 with injected README drift"
grep -q "out of date" "$TMP/readme-drift.log" || fail "checker's failure message did not mention the drift"
echo "[PASS] README-side drift: checker fails non-zero with a clear message"

# (1b) --write must repair it back to a passing state, and only touch the marker
# block (the rest of README.md — the DRIFT-INJECTED marker itself is INSIDE the
# block and gets overwritten by the regen, which is expected here).
node "$CHECK" --write >/dev/null 2>&1 || fail "--write exited non-zero"
node "$CHECK" >/dev/null 2>&1 || fail "checker still fails after --write"
echo "[PASS] --write regenerates a passing README.md"
diff <(outside_marker_block "$TMP/README.md.orig") <(outside_marker_block "$README") >/dev/null \
  || fail "--write changed content OUTSIDE the HELP-START/HELP-END marker block"
echo "[PASS] --write left everything outside the marker block untouched"

# restore the pristine README before test (2), which mutates src/cli.ts instead
cp "$TMP/README.md.orig" "$README"

# (2) HELP-side drift: change the HELP template literal in src/cli.ts (leave
# README.md untouched) — the checker must fail non-zero the other direction too.
sed -i.bak 's/Assert it is real age ciphertext/DRIFT-INJECTED-BY-SELFTEST/' "$CLI_SRC"
rm -f "$CLI_SRC.bak"
set +e
node "$CHECK" >"$TMP/help-drift.log" 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "checker exited 0 with injected HELP text drift"
grep -q "out of date" "$TMP/help-drift.log" || fail "checker's failure message did not mention the drift"
echo "[PASS] HELP-side drift: checker fails non-zero with a clear message"

# restore src/cli.ts before the final check (trap also does this on exit, but an
# explicit restore here lets this last assertion prove the ORIGINAL pair is clean)
cp "$TMP/cli.ts.orig" "$CLI_SRC"
node "$CHECK" >/dev/null 2>&1 || fail "checker fails after restoring the original src/cli.ts"
echo "[PASS] restored tree: checker passes again"

# (3) duplicate markers: a second HELP-START/HELP-END pair appended to README.md
# (e.g. from a bad merge) must be refused, not silently matched against the FIRST
# pair while a stale duplicate second pair goes unchecked.
printf '\n%s\n```text\nstale\n```\n%s\n' "$(grep -F 'HELP-START' "$README")" "$(grep -F 'HELP-END' "$README")" >> "$README"
set +e
node "$CHECK" >"$TMP/dup-marker.log" 2>&1
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "checker exited 0 with a duplicate marker pair in README.md"
grep -q "more than one" "$TMP/dup-marker.log" || fail "checker's failure message did not mention the duplicate marker"
echo "[PASS] duplicate markers: checker refuses rather than silently matching the first pair"

# restore the pristine README before the final check
cp "$TMP/README.md.orig" "$README"
node "$CHECK" >/dev/null 2>&1 || fail "checker fails after restoring the original README.md"

echo "[PASS] scripts/check-help-docs.mjs selftest: all checks passed"
