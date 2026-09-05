#!/usr/bin/env bash
# Round-trip proof for .cypherbrainignore (issue #216): a gitignore-compatible file at
# the root of a --dir (or a --profile-resolved directory) filters what tar actually
# archives from that directory — node_modules/, caches, .git/ etc no longer need to be
# staged, encrypted, or (on a paid backend) permanently stored. Matching is delegated to
# the `ignore` npm package. No .cypherbrainignore present must behave EXACTLY as before
# (every path archived) — the whole point of an additive, backward-compatible filter.
# Also exercises `snapshot --dry-run`, which previews the same filtering without
# staging/encrypting/writing anything. Synthetic fixtures only — no real user data, no
# Postgres, no network.
set -euo pipefail

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

echo "== keygen =="
cb keygen >/dev/null

echo "== control: a --dir with NO .cypherbrainignore archives everything, exactly as before =="
PLAIN="$TMP/plain"
mkdir -p "$PLAIN/x"
printf 'hi\n' > "$PLAIN/x/f.txt"
cb snapshot --dir "$PLAIN" --out "$TMP/plain.age" >/dev/null 2>&1
cb restore --in "$TMP/plain.age" --out-dir "$TMP/plain-out" --no-expand-components >/dev/null
tar -tzf "$TMP/plain-out/plain.tar.gz" | sort > "$TMP/plain-list.txt"
grep -qx 'plain/' "$TMP/plain-list.txt" || { echo "[FAIL] control archive missing top dir entry"; cat "$TMP/plain-list.txt"; exit 1; }
grep -qx 'plain/x/f.txt' "$TMP/plain-list.txt" || { echo "[FAIL] control archive missing nested file"; cat "$TMP/plain-list.txt"; exit 1; }
if grep -q '"cypherbrainignore"' "$TMP/plain-out/manifest.json"; then rc=0; else rc=$?; fi
if [ "$rc" -eq 0 ]; then
  echo "[FAIL] manifest records cypherbrainignore when no ignore file was present"; exit 1
elif [ "$rc" -ne 1 ]; then
  echo "[FAIL] could not read $TMP/plain-out/manifest.json to confirm cypherbrainignore is absent (grep rc=$rc)"; exit 1
fi
echo "[PASS] no .cypherbrainignore -> unchanged archive contents, no manifest field"

echo "== .cypherbrainignore excludes node_modules/ and .git/, keeps everything else =="
SRC="$TMP/brain"
mkdir -p "$SRC/a/b" "$SRC/node_modules/pkg" "$SRC/.git"
printf 'keep1\n' > "$SRC/a/keep.txt"
printf 'keep2\n' > "$SRC/a/b/keep2.txt"
head -c 4096 /dev/urandom > "$SRC/node_modules/pkg/file.bin"
printf 'gitstuff\n' > "$SRC/.git/HEAD"
cat > "$SRC/.cypherbrainignore" <<'EOF'
node_modules/
.git/
EOF
cb snapshot --dir "$SRC" --out "$TMP/snap.age" >/dev/null 2>&1
cb restore --in "$TMP/snap.age" --out-dir "$TMP/out" --no-expand-components >/dev/null
tar -tzf "$TMP/out/brain.tar.gz" | sort > "$TMP/list.txt"
grep -q 'node_modules' "$TMP/list.txt" && { echo "[FAIL] node_modules leaked into the archive"; cat "$TMP/list.txt"; exit 1; }
grep -q '\.git' "$TMP/list.txt" && { echo "[FAIL] .git leaked into the archive"; cat "$TMP/list.txt"; exit 1; }
grep -qx 'brain/a/keep.txt' "$TMP/list.txt" || { echo "[FAIL] included file a/keep.txt missing"; cat "$TMP/list.txt"; exit 1; }
grep -qx 'brain/a/b/keep2.txt' "$TMP/list.txt" || { echo "[FAIL] included file a/b/keep2.txt missing"; cat "$TMP/list.txt"; exit 1; }
grep -qx 'brain/.cypherbrainignore' "$TMP/list.txt" || { echo "[FAIL] .cypherbrainignore itself missing from archive"; cat "$TMP/list.txt"; exit 1; }
echo "[PASS] node_modules/ and .git/ excluded; every other file still archived"

echo "== manifest records cypherbrainignore: true and the right excluded_count =="
grep -q '"cypherbrainignore": true' "$TMP/out/manifest.json" || { echo "[FAIL] manifest missing cypherbrainignore: true"; cat "$TMP/out/manifest.json"; exit 1; }
grep -q '"excluded_count": 2' "$TMP/out/manifest.json" || { echo "[FAIL] manifest excluded_count is not 2 (node_modules/ + .git/)"; cat "$TMP/out/manifest.json"; exit 1; }
echo "[PASS] manifest carries cypherbrainignore provenance (applied + excluded_count)"

echo "== plaintext leak check: excluded content never appears in the ciphertext =="
if LC_ALL=C grep -a -q "gitstuff" "$TMP/snap.age"; then
  echo "[FAIL] excluded .git content leaked into ciphertext"; exit 1
fi
echo "[PASS] excluded content absent from ciphertext"

echo "== negation (!pattern) re-includes a file under an otherwise-matched glob =="
NEG="$TMP/negation"
mkdir -p "$NEG/logs"
printf 'noisy\n' > "$NEG/logs/app.log"
printf 'keep-this\n' > "$NEG/logs/important.log"
cat > "$NEG/.cypherbrainignore" <<'EOF'
logs/*
!logs/important.log
EOF
cb snapshot --dir "$NEG" --out "$TMP/neg.age" >/dev/null 2>&1
cb restore --in "$TMP/neg.age" --out-dir "$TMP/neg-out" --no-expand-components >/dev/null
tar -tzf "$TMP/neg-out/negation.tar.gz" | sort > "$TMP/neg-list.txt"
grep -qx 'negation/logs/important.log' "$TMP/neg-list.txt" || { echo "[FAIL] negated file important.log was excluded"; cat "$TMP/neg-list.txt"; exit 1; }
grep -q 'negation/logs/app.log' "$TMP/neg-list.txt" && { echo "[FAIL] app.log should have been excluded by logs/*"; cat "$TMP/neg-list.txt"; exit 1; }
echo "[PASS] !negation pattern re-includes a specific file excluded by a broader glob"

echo "== --dry-run: previews include/exclude without --out, staging, or writing anything =="
set +e
OUT=$(cb snapshot --dir "$SRC" --dry-run 2>&1); RC=$?
set -e
[ "$RC" = "0" ] || { echo "[FAIL] --dry-run exited non-zero"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "DRY RUN" || { echo "[FAIL] --dry-run output missing DRY RUN banner"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "3 file(s) included" || { echo "[FAIL] --dry-run did not report 3 included files"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "2 path(s) excluded" || { echo "[FAIL] --dry-run did not report 2 excluded paths"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "node_modules/" || { echo "[FAIL] --dry-run exclude list missing node_modules/"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q '\.git/' || { echo "[FAIL] --dry-run exclude list missing .git/"; echo "$OUT"; exit 1; }
test ! -f "$TMP/dry-run-should-not-exist.age"
echo "[PASS] --dry-run reports accurate include/exclude counts, no --out required"

# #368 (WITH an ignore file present): the breakdown is added detail alongside the
# existing include/exclude report, not a replacement for it — the assertions above
# already proved the include/exclude report is unchanged; this proves the breakdown of
# what SURVIVED filtering is now there too, and its byte totals reconcile with the
# per-source total (#368 acceptance: "Byte totals in the breakdown reconcile with the
# existing per-source total"). $SRC's 3 included files are exact byte counts on purpose
# (a/keep.txt=6B, a/b/keep2.txt=6B, .cypherbrainignore=20B) so the shares below are
# clean percentages, not rounding artifacts.
echo "== --dry-run (#368): with .cypherbrainignore present, still reports the largest contributors =="
# Only 2 buckets exist here (well under CONTRIBUTORS_LIMIT), so the heading must say "2 by
# bytes" — NOT "top 10" (P3, multi-model review: the heading must never claim a truncation
# that did not happen) — and there must be no "other (N more)" remainder line.
printf '%s' "$OUT" | grep -q "largest contributors (2 by bytes, aggregated one directory level deep):" || { echo "[FAIL] with-ignore-file --dry-run heading wrong (expected '2 by bytes', not a 'top N' claim)"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -qE '\.cypherbrainignore +20 B \(62\.5% of this source\)' || { echo "[FAIL] .cypherbrainignore contributor line missing or wrong share"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -qE '^    a/ +12 B \(37\.5% of this source\)' || { echo "[FAIL] aggregated a/ contributor line missing or wrong share"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "other (" && { echo "[FAIL] unexpected remainder line with only 2 buckets"; echo "$OUT"; exit 1; }
echo "[PASS] --dry-run with an ignore file present still reports the largest contributors of what survived filtering"

# #368 acceptance: "snapshot --dry-run against a source with no .cypherbrainignore lists
# the largest contributors with their byte shares" — the branch this issue exists for. A
# --dir with no .cypherbrainignore used to print exactly ONE aggregate line and nothing
# else; this is the state nobody has audited yet, so it is the one that most needs the
# breakdown. Sizes below are exact byte counts (bigdir/a.bin=700B, bigdir/b.bin=200B,
# root.txt=100B) so the shares are clean percentages the assertions can pin exactly, and
# the reconciliation check below can sum contributor bytes back to the reported total
# without any KB/MB rounding ambiguity.
echo "== --dry-run (#368): NO .cypherbrainignore lists the largest contributors, dominant subtree first =="
CONTRIB="$TMP/contrib"
mkdir -p "$CONTRIB/bigdir"
head -c 700 /dev/urandom > "$CONTRIB/bigdir/a.bin"
head -c 200 /dev/urandom > "$CONTRIB/bigdir/b.bin"
head -c 100 /dev/urandom > "$CONTRIB/root.bin"
set +e
CONTRIB_OUT=$(cb snapshot --dir "$CONTRIB" --dry-run 2>&1); CONTRIB_RC=$?
set -e
[ "$CONTRIB_RC" = "0" ] || { echo "[FAIL] --dry-run (no ignore file, #368) exited non-zero"; echo "$CONTRIB_OUT"; exit 1; }
printf '%s' "$CONTRIB_OUT" | grep -q "no .cypherbrainignore — all 3 file(s) included (1000 B)" || { echo "[FAIL] unexpected no-ignore-file summary line"; echo "$CONTRIB_OUT"; exit 1; }
# Only 2 buckets (bigdir/, root.bin), well under CONTRIBUTORS_LIMIT — heading must say "2
# by bytes", not claim a "top 10" truncation that never happened (P3), and there must be
# no remainder line.
printf '%s' "$CONTRIB_OUT" | grep -q "largest contributors (2 by bytes, aggregated one directory level deep):" || { echo "[FAIL] no-ignore-file --dry-run heading wrong (expected '2 by bytes', not a 'top N' claim)"; echo "$CONTRIB_OUT"; exit 1; }
printf '%s' "$CONTRIB_OUT" | grep -qE '^    bigdir/ +900 B \(90\.0% of this source\)' || { echo "[FAIL] the dominant bigdir/ subtree is not reported first with the right share"; echo "$CONTRIB_OUT"; exit 1; }
printf '%s' "$CONTRIB_OUT" | grep -qE '^    root\.bin +100 B \(10\.0% of this source\)' || { echo "[FAIL] the small root.bin contributor is not reported with the right share"; echo "$CONTRIB_OUT"; exit 1; }
printf '%s' "$CONTRIB_OUT" | grep -q "other (" && { echo "[FAIL] unexpected remainder line with only 2 buckets"; echo "$CONTRIB_OUT"; exit 1; }
# reconciliation: the two contributor byte counts printed above must sum to EXACTLY the
# per-source total already reported in the (unchanged) summary line, not just look right.
BIGDIR_BYTES=$(printf '%s' "$CONTRIB_OUT" | grep -oE '^    bigdir/ +[0-9]+ B' | grep -oE '[0-9]+')
ROOT_BYTES=$(printf '%s' "$CONTRIB_OUT" | grep -oE '^    root\.bin +[0-9]+ B' | grep -oE '[0-9]+')
[ "$((BIGDIR_BYTES + ROOT_BYTES))" = "1000" ] || { echo "[FAIL] contributor bytes ($BIGDIR_BYTES + $ROOT_BYTES) do not reconcile with the reported 1000 B per-source total"; echo "$CONTRIB_OUT"; exit 1; }
echo "[PASS] no .cypherbrainignore --dry-run breaks down the largest contributors, dominant subtree first, bytes reconcile"

# #368 acceptance: "A source whose contents are one flat set of small files produces a
# sane, short report (no pathological output when there is no dominant path)" — every
# file sits directly at the root (no subdirectory to aggregate under), so each is its own
# bucket. Sizes are exact and DISTINCT (30B/20B/10B) so this asserts the actual values,
# shares, and descending order — not just a line count (multi-model review, P3: a bare
# line-count check would still [PASS] if the values or ordering were wrong).
echo "== --dry-run (#368): a flat set of small files produces a short, sane breakdown =="
FLAT="$TMP/flat368"
mkdir -p "$FLAT"
head -c 30 /dev/urandom > "$FLAT/file1.txt"
head -c 20 /dev/urandom > "$FLAT/file2.txt"
head -c 10 /dev/urandom > "$FLAT/file3.txt"
set +e
FLAT_OUT=$(cb snapshot --dir "$FLAT" --dry-run 2>&1); FLAT_RC=$?
set -e
[ "$FLAT_RC" = "0" ] || { echo "[FAIL] --dry-run (flat small files, #368) exited non-zero"; echo "$FLAT_OUT"; exit 1; }
printf '%s' "$FLAT_OUT" | grep -q "no .cypherbrainignore — all 3 file(s) included (60 B)" || { echo "[FAIL] unexpected flat-file summary line"; echo "$FLAT_OUT"; exit 1; }
printf '%s' "$FLAT_OUT" | grep -q "largest contributors (3 by bytes, aggregated one directory level deep):" || { echo "[FAIL] flat-file heading wrong (expected '3 by bytes', not a 'top N' claim)"; echo "$FLAT_OUT"; exit 1; }
# Exact values AND descending order: the three contributor lines must appear in this
# EXACT sequence (largest byte count first), each with its exact byte count and share —
# grep -A/-B against the whole block, anchored, so a wrong value OR a wrong order fails.
printf '%s' "$FLAT_OUT" | grep -A3 "largest contributors (3 by bytes" | tail -n +2 > "$TMP/flat-lines.txt"
EXPECTED_FLAT=$'    file1.txt  30 B (50.0% of this source)\n    file2.txt  20 B (33.3% of this source)\n    file3.txt  10 B (16.7% of this source)'
[ "$(cat "$TMP/flat-lines.txt")" = "$EXPECTED_FLAT" ] || { echo "[FAIL] flat-file contributor lines do not match the expected exact values/order"; echo "--- got ---"; cat "$TMP/flat-lines.txt"; echo "--- expected ---"; printf '%s\n' "$EXPECTED_FLAT"; exit 1; }
printf '%s' "$FLAT_OUT" | grep -q "other (" && { echo "[FAIL] unexpected remainder line with only 3 buckets"; echo "$FLAT_OUT"; exit 1; }
echo "[PASS] a flat set of small files produces a short breakdown with exact values, shares, and descending order"

# #368 acceptance ("Byte totals in the breakdown reconcile with the existing per-source
# total") in the branch P2 actually lives in: MORE than CONTRIBUTORS_LIMIT (10) buckets.
# Before the fix, printContributors silently dropped everything past the top 10 — the
# displayed shares could never sum to the source total, and a swarm of similar-sized
# buckets that collectively dominated would each look individually negligible. 12
# top-level files, sizes 120..10 in steps of 10 (all < 1024 B so fmtBytes never rounds
# into KB — every value below is exact): the two smallest (20B, 10B) must be folded into
# ONE "other (2 more)" remainder line, and the top-10 shown bytes PLUS the remainder bytes
# must equal the reported 780 B total exactly.
echo "== --dry-run (#368): more than CONTRIBUTORS_LIMIT buckets — remainder line reconciles exactly =="
MANY="$TMP/many368"
mkdir -p "$MANY"
for n in 120 110 100 90 80 70 60 50 40 30 20 10; do
  head -c "$n" /dev/urandom > "$MANY/s$n.bin"
done
set +e
MANY_OUT=$(cb snapshot --dir "$MANY" --dry-run 2>&1); MANY_RC=$?
set -e
[ "$MANY_RC" = "0" ] || { echo "[FAIL] --dry-run (12 buckets, #368) exited non-zero"; echo "$MANY_OUT"; exit 1; }
printf '%s' "$MANY_OUT" | grep -q "no .cypherbrainignore — all 12 file(s) included (780 B)" || { echo "[FAIL] unexpected 12-file summary line"; echo "$MANY_OUT"; exit 1; }
printf '%s' "$MANY_OUT" | grep -q "largest contributors (top 10 of 12 by bytes, aggregated one directory level deep):" || { echo "[FAIL] heading does not name the truncation (expected 'top 10 of 12')"; echo "$MANY_OUT"; exit 1; }
printf '%s' "$MANY_OUT" | grep -qE '^    other \(2 more\) +30 B \(3\.8% of this source\)' || { echo "[FAIL] remainder line missing or wrong (expected 'other (2 more)  30 B (3.8% of this source)')"; echo "$MANY_OUT"; exit 1; }
# reconciliation: sum the 10 SHOWN contributor byte counts, verify each against its known
# exact size, then add the remainder line's own byte count — the total must equal 780 B,
# the same total the (unchanged) summary line already reports. sed (not a second grep -oE
# '[0-9]+') on purpose: the filenames themselves contain digits (s120.bin, "other (2
# more)"), so a bare digit-extraction grep over the whole matched line would also catch
# the "120" in the filename or the "2" in "(2 more)" — a capturing sed anchored on the
# EXACT line shape pulls only the trailing byte count.
SHOWN_SUM=0
for n in 120 110 100 90 80 70 60 50 40 30; do
  v=$(printf '%s' "$MANY_OUT" | sed -nE "s/^    s${n}\.bin[[:space:]]+([0-9]+) B .*/\\1/p")
  [ "$v" = "$n" ] || { echo "[FAIL] contributor s$n.bin reported ${v:-<missing>} B, expected $n B"; echo "$MANY_OUT"; exit 1; }
  SHOWN_SUM=$((SHOWN_SUM + v))
done
REMAINDER_BYTES=$(printf '%s' "$MANY_OUT" | sed -nE 's/^    other \(2 more\)[[:space:]]+([0-9]+) B .*/\1/p')
[ "$((SHOWN_SUM + REMAINDER_BYTES))" = "780" ] || { echo "[FAIL] shown contributor bytes ($SHOWN_SUM) + remainder ($REMAINDER_BYTES) != 780 B per-source total"; echo "$MANY_OUT"; exit 1; }
echo "[PASS] more than CONTRIBUTORS_LIMIT buckets: top 10 shown + remainder line reconcile exactly to the per-source total"

echo "== --dry-run never stages, encrypts, or contacts pg_dump (an unreachable --pg is fine) =="
set +e
OUT=$(cb snapshot --pg "postgres://nouser:nopass@127.0.0.1:1/does-not-exist" --dir "$PLAIN" --dry-run 2>&1); RC=$?
set -e
[ "$RC" = "0" ] || { echo "[FAIL] --dry-run with an unreachable --pg still failed (pg_dump must not run in --dry-run)"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "not dumped in --dry-run" || { echo "[FAIL] --dry-run pg note missing"; echo "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q "nopass" && { echo "[FAIL] --dry-run leaked the pg password into its own output"; exit 1; }
echo "[PASS] --dry-run never touches pg_dump and redacts the connection string it prints"

echo "== --dry-run on a single-file --dir source: not filterable, no crash =="
SINGLE="$TMP/single.txt"; printf 'hello\n' > "$SINGLE"
OUT=$(cb snapshot --dir "$SINGLE" --dry-run 2>&1)
printf '%s' "$OUT" | grep -q "not filterable by .cypherbrainignore" || { echo "[FAIL] single-file --dry-run missing not-filterable note"; echo "$OUT"; exit 1; }
echo "[PASS] --dry-run handles a single-file --dir source without error"

echo "== --dry-run on a symlink --dir source: archived as-is, no crash =="
REALDIR="$TMP/realdir"; mkdir -p "$REALDIR"; printf 'x\n' > "$REALDIR/a.txt"
LINKDIR="$TMP/linkdir"; ln -s "$REALDIR" "$LINKDIR"
OUT=$(cb snapshot --dir "$LINKDIR" --dry-run 2>&1)
printf '%s' "$OUT" | grep -q "symlink source" || { echo "[FAIL] symlink --dry-run missing symlink note"; echo "$OUT"; exit 1; }
echo "[PASS] --dry-run handles a symlink --dir source without error"

echo "== security: a --dir whose OWN basename looks like a tar option (e.g. '-C') cannot hijack the tar -T list =="
# Multi-model review (Codex) finding: the tar -T list file MUST be NUL-separated
# (--null), or its FIRST line (the bare --dir basename — every OTHER line is
# prefixed "<base>/<rel>" and so can never itself start with "-") is honored by
# tar as an option rather than a literal directory name. Verified by hand: with
# a --dir literally named "-C", the newline-only (pre-fix) list made tar consume
# the well-formed 2nd/3rd list lines as a "-C <dir>" directive's argument and
# then a path relative to THAT dir, producing "Cannot stat ...: No such file or
# directory" (rc=1) instead of a correct archive — a concrete, reproducible
# corruption/DoS from this exact injection class, not just a theoretical one.
# This exercises the real code path (a --dir WITH a .cypherbrainignore, so
# scanDir's -T/--null branch runs) with a --dir directory literally named "-C".
INJ="$TMP/-C"
mkdir -p "$INJ/sub"
printf 'keep\n' > "$INJ/sub/f.txt"
printf 'irrelevant\n' > "$INJ/.cypherbrainignore"     # any ignore file triggers the -T/--null branch
set +e
INJOUT=$(cb snapshot --dir "$INJ" --out "$TMP/inj.age" 2>&1); INJRC=$?
set -e
[ "$INJRC" = "0" ] || { echo "[FAIL][SECURITY] snapshot of a --dir named '-C' failed (tar -T option-injection via the bare basename line)"; echo "$INJOUT"; exit 1; }
cb restore --in "$TMP/inj.age" --out-dir "$TMP/inj-out" --no-expand-components >/dev/null
tar -tzf "$TMP/inj-out/-C.tar.gz" | sort > "$TMP/inj-list.txt"
grep -qx -- '-C/sub/f.txt' "$TMP/inj-list.txt" || { echo "[FAIL][SECURITY] a --dir literally named '-C' did not archive correctly (tar -T list injection via the bare basename line)"; cat "$TMP/inj-list.txt"; exit 1; }
tar -xzf "$TMP/inj-out/-C.tar.gz" -C "$TMP/inj-out"
[ "$(cat "$TMP/inj-out/-C/sub/f.txt")" = "keep" ] || { echo "[FAIL] content corrupted for a --dir named '-C'"; exit 1; }
echo "[PASS] a --dir literally named '-C' archives correctly — no tar -T option-injection via the bare basename line"

echo "== legacy name: a .cipherbrainignore (pre-rename) is still honoured when no .cypherbrainignore exists =="
LEG="$TMP/legacy"
mkdir -p "$LEG/node_modules/pkg" "$LEG/a"
printf 'keep\n' > "$LEG/a/keep.txt"
printf 'junk\n' > "$LEG/node_modules/pkg/f.txt"
printf 'node_modules/\n' > "$LEG/.cipherbrainignore"
cb snapshot --dir "$LEG" --out "$TMP/leg.age" >/dev/null 2>&1
cb restore --in "$TMP/leg.age" --out-dir "$TMP/leg-out" --no-expand-components >/dev/null
tar -tzf "$TMP/leg-out/legacy.tar.gz" | sort > "$TMP/leg-list.txt"
grep -q 'node_modules' "$TMP/leg-list.txt" && { echo "[FAIL] .cipherbrainignore (legacy name) was ignored — node_modules leaked"; cat "$TMP/leg-list.txt"; exit 1; }
grep -qx 'legacy/a/keep.txt' "$TMP/leg-list.txt" || { echo "[FAIL] included file missing under legacy ignore file"; cat "$TMP/leg-list.txt"; exit 1; }
echo "[PASS] .cipherbrainignore still filters when it is the only ignore file"
OUT=$(cb snapshot --dir "$LEG" --dry-run 2>&1) || { echo "[FAIL] --dry-run exited non-zero under a legacy ignore file"; printf '%s\n' "$OUT"; exit 1; }
printf '%s' "$OUT" | grep -q '\.cipherbrainignore found' || { echo "[FAIL] --dry-run did not name the legacy .cipherbrainignore it actually applied"; printf '%s\n' "$OUT"; exit 1; }
echo "[PASS] --dry-run names the legacy file when that is what filtered the source"

echo "== legacy name: when BOTH exist, .cypherbrainignore wins and .cipherbrainignore is not merged in =="
# The current-name file ignores nothing relevant; the legacy file would exclude node_modules.
# If the legacy file were read (or merged), node_modules would be missing.
printf 'nothing-matches-this/\n' > "$LEG/.cypherbrainignore"
cb snapshot --dir "$LEG" --out "$TMP/leg2.age" >/dev/null 2>&1
cb restore --in "$TMP/leg2.age" --out-dir "$TMP/leg2-out" --no-expand-components >/dev/null
tar -tzf "$TMP/leg2-out/legacy.tar.gz" | sort > "$TMP/leg2-list.txt"
grep -qx 'legacy/node_modules/pkg/f.txt' "$TMP/leg2-list.txt" || { echo "[FAIL] with both files present the legacy .cipherbrainignore was applied — it must yield to .cypherbrainignore"; cat "$TMP/leg2-list.txt"; exit 1; }
echo "[PASS] .cypherbrainignore takes precedence over a co-existing .cipherbrainignore"

echo ""
echo "CYPHERBRAINIGNORE SELFTEST PASS"
