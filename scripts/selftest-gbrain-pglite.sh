#!/usr/bin/env bash
# Selftest for gbrain's PGLite engine (issue #367). cypher-brain used to assume a
# Postgres-backed gbrain everywhere it touched one — but PGLite (Postgres 17 compiled
# to WASM, whose whole database is a directory on disk) is gbrain's zero-config
# DEFAULT. Two consequences, one test file:
#
#   (A) `init` printed Postgres prose and offered --pg defaulting to YES on a brain
#       that has no server to dump. Covered below by driving the wizard's gbrain
#       branch through the FULL engine-resolution matrix (explicit `engine` wins,
#       else `database_path` implies PGLite, else Postgres — gbrain's own order),
#       asserting the two branches print what they should and that --pg is never
#       proposed on a PGLite brain.
#   (B) a --dir/--profile source that is (or contains) a PGLite store is tar'd with
#       no consistency guard, and `verify` cannot see the damage — it only appears
#       at restore time. Covered below by asserting the warning fires, reaches BOTH
#       relay surfaces (the CLI run summary and the MCP `warnings` array, #347), and
#       is a WARNING: the snapshot still succeeds, exit 0, artifact on disk.
#
# The detection rule (PG_VERSION + pg_wal/ in the same directory) is exercised
# against four fixtures, so both a false negative and a false positive fail here.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
MCP_BIN="$ROOT/bin/cypher-brain-mcp.mjs"
# BIN_DEV_ARGS: literal argv flags to run the CLI against src/*.ts (no build step)
# under plain node — see scripts/dev-node-flags.sh.
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# with_timeout: identical to the helper in scripts/selftest-init.sh — a regression
# that WEDGES the wizard (e.g. a prompt appearing on the branch that must not show
# it, so the scripted driver waits forever for the next one) has to fail loudly
# inside a bounded time rather than hang the whole suite.
with_timeout() {
  local s=$1; shift
  "$@" & local c=$!
  ( sleep "$s"; kill -9 "$c" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$c" 2>/dev/null; local rc=$?
  kill -9 "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

# A synthetic PGLite data directory: the two markers a real Postgres data directory
# always carries, plus a plausible file or two. Keyed on the markers rather than the
# directory's name, because the name is whatever the operator put in `database_path`.
make_pglite_store() {
  mkdir -p "$1/pg_wal/archive_status" "$1/base" "$1/global"
  printf '17\n' > "$1/PG_VERSION"
  printf '# synthetic fixture\n' > "$1/postgresql.conf"
  printf 'fixture-wal-segment\n' > "$1/pg_wal/000000010000000000000001"
  # archive_status holds disposable bookkeeping — a cluster starts without it. Present so
  # the "partial hit inside a required directory" case has a realistic thing to exclude.
  printf '' > "$1/pg_wal/archive_status/000000010000000000000001.done"
  # pg_control is the other decisive single file (alongside PG_VERSION); losing it alone
  # stops a cluster, which is why the classifier treats it separately from the rest of global/.
  printf 'fixture-control\n' > "$1/global/pg_control"
}

# The exact sentence fragments each wizard branch is required to print. Grepped as
# literals so a rewrite that silently drops one fails here.
PGLITE_BRANCH_MARK="engine: PGLite (gbrain's default)"
POSTGRES_BRANCH_MARK="lives in Postgres, not in that directory alone"
PG_PROMPT_MARK="Include a Postgres database dump"
WARN_MARK="is a PostgreSQL data directory"
# The STRONGER warning, for a store an ignore rule has cut into pieces. Distinct from
# WARN_MARK on purpose: the two describe different hazards and must never collapse into
# one sentence (multi-model review) — a partial copy cannot be opened at all, whereas a
# live-copy may merely be inconsistent.
TRUNCATED_MARK="INSIDE it out of this snapshot"
# Within the truncated warning, THREE strengths — each says exactly what the evidence
# supports, no more (review rounds 2 and 3). Certainty needs a marker file or a whole
# required directory gone; a partial hit inside one only licenses "may"; anything else is
# reportable but hedged.
TRUNCATED_CERTAIN_MARK="cannot be opened at all"
TRUNCATED_PARTIAL_MARK="MAY prevent the restored copy from opening"
TRUNCATED_HEDGED_MARK="the copy may still open"
NOT_COVERED_MARK="NONE of the paths you gave above covers it"
COVERED_MARK="The path(s) you gave above cover it"
UNKNOWN_PATH_MARK="does not record a database_path"
RELATIVE_PATH_MARK="records the store as a RELATIVE path"
# #543: the distinct "could not be read" wording for a config read/parse FAILURE, as
# opposed to the confident POSTGRES_BRANCH_MARK a genuinely-parsed config gets.
UNREADABLE_MARK="could not be read (defaulting to Postgres)"
# resolveGbrainConfigPath()'s invalidOverride notice: an invalid GBRAIN_HOME (relative,
# or containing a '..' segment) must be distinguishable from a genuine detection at the
# $HOME fallback (multi-model review — see gbrain.ts's own doc comment).
INVALID_GBRAIN_HOME_MARK="is set but invalid"

CB_SRC="$TMP/plain-src"; mkdir -p "$CB_SRC"
printf 'gbrain-pglite-selftest\n' > "$CB_SRC/note.txt"

# ---------------------------------------------------------------------------
# (a) the wizard's engine-resolution matrix
# ---------------------------------------------------------------------------
# Each case gets its own HOME (so ~/.gbrain/config.json is a fixture) and its own
# CYPHER_BRAIN_HOME. The run is deliberately CUT SHORT at the backend prompt by
# picking `ton-provider` with no CYPHER_BRAIN_TON_PROVIDER_OWNER/MAX_SPEND set:
# everything this test asserts is printed before that point, and stopping there
# skips the snapshot/push/kit work four times over. (#396 Phase B: this used to
# answer the backend prompt with a free-text "not-a-real-backend" typo, which threw
# — select() makes that specific typo structurally unreachable now (askSelect's own
# doc comment in wizard.ts), so this needed a different, still-cheap early stop.
# ton-provider's missing-prerequisites guard is a CLEAN, non-throwing exit instead
# — see below, the wizard invocation is expected to SUCCEED here, not fail.
# scripts/selftest-init.sh's own (c2) test covers this exact guard in isolation.)
#
# config.json also carries a decoy secret in every case. gbrain's real config.json
# holds API keys, so detectGbrainEngine reads the engine fields and nothing else —
# asserting the decoy never reaches the transcript is what keeps that true.
DECOY_SECRET="sk-selftest-decoy-DO-NOT-LOG-8f2a1c"
# #540 (multi-model review, Suggestion): gbrain's config.json can carry a `database_url`
# field embedding real Postgres credentials — the wizard's --pg prefill is deliberately
# NOT read from it (see wizard.ts's own #540 comment), so a decoy credential planted here
# must never reach the transcript, confirming the privacy decision holds in practice.
DECOY_DB_URL="postgres://realuser:s3cr3t-pw-DO-NOT-LOG@db.internal.example:5432/prod"

# Extra environment for the next wizard_case call, as literal KEY=VALUE argv elements
# (never an interpolated string — see scripts/dev-node-flags.sh on why argv arrays are
# the only safe shape here). Reset by wizard_case itself, so it applies to one case.
WIZARD_EXTRA_ENV=()
# What the next wizard_case answers to "Directory path(s) to back up". The literal token
# @HOME@ expands to that case's own HOME, which is how a case can answer "~/.gbrain"
# without the caller having to re-derive the per-case home path. Reset after each call.
WIZARD_ANSWER_DIR=""

wizard_case() {
  local label="$1" config_json="$2" expect="$3" logfile="$4"
  local home="$TMP/case-$label-home"
  local cbhome="$TMP/case-$label-cb-home"
  mkdir -p "$home/.gbrain"
  # @HOME@ in the config too, so a fixture can point database_path at this case's own
  # ~/.gbrain (the ordinary layout) as easily as at somewhere else entirely.
  printf '%s\n' "${config_json//@HOME@/$home}" > "$home/.gbrain/config.json"
  local answer_dir="${WIZARD_ANSWER_DIR:-$CB_SRC}"
  answer_dir="${answer_dir//@HOME@/$home}"
  WIZARD_ANSWER_DIR=""
  local qa="$TMP/qa-$label.json"
  # The Postgres branch has one extra prompt. Scripting the WRONG list is itself an
  # assertion: the driver only sends an answer once its prompt has really appeared,
  # so a branch that prompts differently than expected stalls and with_timeout kills
  # it — a mis-branch can never quietly pass here.
  local pg_line=""
  # Both ordinary "postgres" and the #543 "postgres-unreadable" case land in the wizard's
  # Postgres branch (the ONLY difference is which prose precedes the --pg prompt), so both
  # need the same scripted answer here.
  case "$expect" in
    postgres | postgres-unreadable) pg_line="  [\"$PG_PROMPT_MARK\", \"n\"]," ;;
  esac
  cat > "$qa" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$answer_dir"],
$pg_line
  ["Choose a backend", "\u001b[A"]
]
JSON
  local extra_env=("${WIZARD_EXTRA_ENV[@]+"${WIZARD_EXTRA_ENV[@]}"}")
  WIZARD_EXTRA_ENV=()
  # Up-arrow moves the select() cursor from its initial `file` (last in
  # BACKEND_NAMES) up one slot to `ton-provider` (third) — see (c2) in
  # scripts/selftest-init.sh for the same technique. No CYPHER_BRAIN_TON_PROVIDER_
  # OWNER/MAX_SPEND is set anywhere in this file, so the wizard's own pre-flight
  # check (wizard.ts) fires and returns CLEANLY (exit 0) right after printing the
  # gbrain-detection prose this test wants — the invocation below is expected to
  # SUCCEED, not fail (the opposite polarity from the old free-text-typo version).
  CYPHER_BRAIN_HOME="$cbhome" HOME="$home" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
    with_timeout 60 env ${extra_env[@]+"${extra_env[@]}"} \
    node "$ROOT/scripts/drive-init.mjs" --qa "$qa" --out "$logfile" \
    -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
    || { echo "[FAIL] $label: init did not stop cleanly at the ton-provider prerequisites guard"; cat "$logfile"; exit 1; }
  grep -qF "CYPHER_BRAIN_TON_PROVIDER_OWNER" "$logfile" || { echo "[FAIL] $label: the run ended for some reason other than the scripted ton-provider-prerequisites stop (a stalled prompt means the wrong engine branch ran)"; cat "$logfile"; exit 1; }
  if grep -qF "$DECOY_SECRET" "$logfile"; then
    echo "[FAIL] $label: a value from ~/.gbrain/config.json reached the transcript — engine detection must read the engine fields and echo nothing"; exit 1
  fi
  if [ "$expect" = "pglite" ]; then
    grep -qF "$PGLITE_BRANCH_MARK" "$logfile" || { echo "[FAIL] $label: expected the PGLite branch"; cat "$logfile"; exit 1; }
    if grep -qF "$POSTGRES_BRANCH_MARK" "$logfile"; then echo "[FAIL] $label: PGLite brain still printed the Postgres prose"; cat "$logfile"; exit 1; fi
    if grep -qF "$PG_PROMPT_MARK" "$logfile"; then echo "[FAIL] $label: PGLite brain was offered --pg — there is no Postgres server to dump"; cat "$logfile"; exit 1; fi
  elif [ "$expect" = "postgres-unreadable" ]; then
    # #543: a read/parse FAILURE must get the "could not be read" wording, and must NOT
    # get the confident "Detected a gbrain config ... lives in Postgres" claim a genuinely
    # parsed config gets — even though both fall back to the same underlying engine.
    grep -qF "$UNREADABLE_MARK" "$logfile" || { echo "[FAIL] $label: expected the 'could not be read' wording for an unreadable/malformed config"; cat "$logfile"; exit 1; }
    if grep -qF "$POSTGRES_BRANCH_MARK" "$logfile"; then echo "[FAIL] $label: an unreadable config still got the confident 'Detected a gbrain config' Postgres prose"; cat "$logfile"; exit 1; fi
    if grep -qF "$PGLITE_BRANCH_MARK" "$logfile"; then echo "[FAIL] $label: an unreadable config took the PGLite branch"; cat "$logfile"; exit 1; fi
    grep -qF "$PG_PROMPT_MARK" "$logfile" || { echo "[FAIL] $label: an unreadable config (defaulting to Postgres) was not offered --pg"; cat "$logfile"; exit 1; }
  else
    grep -qF "$POSTGRES_BRANCH_MARK" "$logfile" || { echo "[FAIL] $label: expected the Postgres branch"; cat "$logfile"; exit 1; }
    grep -qF "$PG_PROMPT_MARK" "$logfile" || { echo "[FAIL] $label: Postgres brain was not offered --pg (pre-#367 behaviour must be byte-identical here)"; cat "$logfile"; exit 1; }
    if grep -qF "$PGLITE_BRANCH_MARK" "$logfile"; then echo "[FAIL] $label: Postgres brain took the PGLite branch"; cat "$logfile"; exit 1; fi
    if grep -qF "$UNREADABLE_MARK" "$logfile"; then echo "[FAIL] $label: a genuinely-parsed Postgres config got the 'could not be read' wording"; cat "$logfile"; exit 1; fi
  fi
}

echo "== (a) the wizard resolves the gbrain engine in gbrain's own order, and only offers --pg on Postgres =="
wizard_case neither "{\"schema_pack\":\"gbrain-base-v2\",\"api_key\":\"$DECOY_SECRET\"}" postgres "$TMP/case-neither.log"
echo "[PASS] no engine and no database_path -> Postgres (the pre-#367 assumption, unchanged: prose + --pg prompt)"
wizard_case explicit-pg "{\"engine\":\"postgres\",\"database_path\":\"/somewhere/.pglite\",\"database_url\":\"$DECOY_DB_URL\",\"api_key\":\"$DECOY_SECRET\"}" postgres "$TMP/case-explicit-pg.log"
echo "[PASS] an explicit engine=postgres WINS over a stale database_path (gbrain's own precedence)"
# #540: the decoy database_url planted above must never reach the transcript, even on the
# "n" (skip --pg) path every wizard_case call above exercises.
if grep -qF "$DECOY_DB_URL" "$TMP/case-explicit-pg.log"; then
  echo "[FAIL] explicit-pg: config.json's database_url reached the transcript — the --pg prefill must never read it"; exit 1
fi
echo "[PASS] #540: a database_url decoy credential in config.json never reaches the transcript on the --pg-declined path"

# #540, the other half: answer "y" to --pg so the prefill prompt itself actually prints
# (every wizard_case call above answers "n" there), and assert the prefill is labeled a
# generic guess — never the decoy database_url — even though this fixture HAS one.
PG_YES_HOME="$TMP/case-pg-yes-home"; mkdir -p "$PG_YES_HOME/.gbrain"
printf '{"engine":"postgres","database_url":"%s","api_key":"%s"}\n' "$DECOY_DB_URL" "$DECOY_SECRET" > "$PG_YES_HOME/.gbrain/config.json"
PG_YES_CBHOME="$TMP/case-pg-yes-cb-home"
cat > "$TMP/qa-pg-yes.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$CB_SRC"],
  ["$PG_PROMPT_MARK", "y"],
  ["Postgres connection string", ""],
  ["Choose a backend", "\u001b[A"]
]
JSON
CYPHER_BRAIN_HOME="$PG_YES_CBHOME" HOME="$PG_YES_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-pg-yes.json" --out "$TMP/case-pg-yes.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] pg-yes: init did not stop cleanly at the ton-provider prerequisites guard"; cat "$TMP/case-pg-yes.log"; exit 1; }
grep -qF "CYPHER_BRAIN_TON_PROVIDER_OWNER" "$TMP/case-pg-yes.log" || { echo "[FAIL] pg-yes: the run ended for some reason other than the scripted stop"; cat "$TMP/case-pg-yes.log"; exit 1; }
if grep -qF "$DECOY_DB_URL" "$TMP/case-pg-yes.log"; then
  echo "[FAIL] pg-yes: the decoy database_url reached the transcript (as the prefill or otherwise)"; cat "$TMP/case-pg-yes.log"; exit 1
fi
if grep -qF "$DECOY_SECRET" "$TMP/case-pg-yes.log"; then
  echo "[FAIL] pg-yes: config.json's api_key reached the transcript"; cat "$TMP/case-pg-yes.log"; exit 1
fi
grep -qF 'generic guess' "$TMP/case-pg-yes.log" \
  || { echo "[FAIL] pg-yes: expected the --pg prefill to be labeled a generic guess"; cat "$TMP/case-pg-yes.log"; exit 1; }
grep -qF 'read from your gbrain setup' "$TMP/case-pg-yes.log" \
  || { echo "[FAIL] pg-yes: expected the --pg prefill wording to say it is not read from gbrain's setup"; cat "$TMP/case-pg-yes.log"; exit 1; }
echo "[PASS] #540: with --pg accepted, the connection-string prefill is labeled a generic guess (not read from gbrain's config), and the decoy database_url/api_key never reach the transcript"
wizard_case dbpath "{\"database_path\":\"/somewhere/.pglite\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-dbpath.log"
echo "[PASS] database_path with no engine field -> PGLite: no Postgres prose, no --pg prompt"
wizard_case explicit-pglite "{\"engine\":\"pglite\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-explicit-pglite.log"
echo "[PASS] an explicit engine=pglite -> PGLite even with no database_path recorded"
echo "[PASS] no case leaked any other value out of config.json into the transcript (it holds API keys)"

# #534: a PRESENT but unrecognized engine value (a case-mismatched typo, or a hypothetical
# future gbrain engine type) must NOT fall through to the database_path-implies-pglite
# heuristic — it must fail toward the safe pre-#367 Postgres default, exactly like the
# genuinely-no-engine-field case above ("neither"), even with a database_path present that
# would otherwise imply PGLite. This is the inversion #534 reports: the pre-fix code took
# the PGLite branch here instead.
wizard_case case-mismatch "{\"engine\":\"Postgres\",\"database_path\":\"@HOME@/.gbrain/.pglite\",\"api_key\":\"$DECOY_SECRET\"}" postgres "$TMP/case-case-mismatch.log"
echo "[PASS] #534: engine=\"Postgres\" (capital P, a plausible hand-edit typo) with a database_path present -> Postgres, NOT the database_path heuristic"
wizard_case unknown-future-engine "{\"engine\":\"sqlite\",\"database_path\":\"@HOME@/.gbrain/.pglite\",\"api_key\":\"$DECOY_SECRET\"}" postgres "$TMP/case-unknown-future-engine.log"
echo "[PASS] #534: an unrecognized engine value (a hypothetical future gbrain engine type) with a database_path present -> Postgres, NOT the database_path heuristic"

# #543: a config that exists but cannot be read/parsed at all (invalid JSON here) falls
# back to the SAME 'postgres' verdict as a genuinely-parsed, engine-less config — but the
# wizard must say so distinctly ("could not be read"), not present the same confident
# "Detected a gbrain config ... lives in Postgres" claim a real detection gets.
wizard_case malformed-json "{not valid json at all, missing closing brace and quotes" postgres-unreadable "$TMP/case-malformed-json.log"
echo "[PASS] #543: invalid JSON in config.json -> the distinct 'could not be read (defaulting to Postgres)' wording, not the confident detection claim"

# gbrain's OWN runtime resolution lets a DATABASE_URL-style env var win outright and
# force Postgres. Copying that here would be a bug, not fidelity: cypher-brain is asking
# what is on disk, and an exported connection string does not make a PGLite directory
# stop existing (upstream hit this as a P1 in a gbrain doctor check — garrytan/gbrain#3879
# — where it led to advice to delete a brain that was in use). Pin BOTH variable names,
# since importing gbrain's resolution later would silently flip this case.
WIZARD_EXTRA_ENV=(DATABASE_URL=postgres://someone@localhost:5432/other GBRAIN_DATABASE_URL=postgres://someone@localhost:5432/other)
wizard_case dbpath-with-env-url "{\"database_path\":\"/somewhere/.pglite\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-dbpath-env.log"
echo "[PASS] an exported DATABASE_URL/GBRAIN_DATABASE_URL does NOT flip a file-configured PGLite brain to Postgres"

# The PGLite branch's own coverage check: those runs answered the directory prompt
# with $CB_SRC, which does NOT cover the configured store, so the wizard must say so —
# the mistake #84 exists to prevent, in its PGLite form (backing up everything EXCEPT
# the brain).
grep -qF "$NOT_COVERED_MARK" "$TMP/case-dbpath.log" \
  || { echo "[FAIL] a PGLite brain whose store is not covered by any --dir was not told so"; cat "$TMP/case-dbpath.log"; exit 1; }
grep -qF "/somewhere/.pglite" "$TMP/case-dbpath.log" \
  || { echo "[FAIL] the wizard did not print the store path it checked coverage against"; cat "$TMP/case-dbpath.log"; exit 1; }
echo "[PASS] a PGLite brain whose answered directories do not cover the configured store is told so, and the path checked is shown"

# P1 (multi-model review): the coverage answer must come from the CONFIG's database_path,
# never from an assumed ~/.gbrain. A brain kept at /srv-style path elsewhere, with the
# operator answering ~/.gbrain, is the exact case the hard-coded check got WRONG — it
# confirmed coverage for a backup with no database in it. Both directions are pinned:
# answering ~/.gbrain must be refused as coverage, and answering the real store path must
# be accepted.
ELSEWHERE_STORE="$TMP/store-elsewhere"; make_pglite_store "$ELSEWHERE_STORE"
WIZARD_ANSWER_DIR="@HOME@/.gbrain"
wizard_case dbpath-elsewhere-miss "{\"engine\":\"pglite\",\"database_path\":\"$ELSEWHERE_STORE\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-elsewhere-miss.log"
grep -qF "$NOT_COVERED_MARK" "$TMP/case-elsewhere-miss.log" \
  || { echo "[FAIL] answering ~/.gbrain for a brain configured ELSEWHERE was accepted as covering the store — the #367 failure in a new form"; cat "$TMP/case-elsewhere-miss.log"; exit 1; }
grep -qF "$ELSEWHERE_STORE" "$TMP/case-elsewhere-miss.log" \
  || { echo "[FAIL] the wizard did not name the configured store path it found to be uncovered"; cat "$TMP/case-elsewhere-miss.log"; exit 1; }
echo "[PASS] a store configured outside ~/.gbrain is NOT reported as covered just because ~/.gbrain was answered"

WIZARD_ANSWER_DIR="$ELSEWHERE_STORE"
wizard_case dbpath-elsewhere-hit "{\"engine\":\"pglite\",\"database_path\":\"$ELSEWHERE_STORE\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-elsewhere-hit.log"
grep -qF "$COVERED_MARK" "$TMP/case-elsewhere-hit.log" \
  || { echo "[FAIL] answering the real store path was not recognised as covering it"; cat "$TMP/case-elsewhere-hit.log"; exit 1; }
if grep -qF "$NOT_COVERED_MARK" "$TMP/case-elsewhere-hit.log"; then echo "[FAIL] the covered case ALSO printed the not-covered warning"; cat "$TMP/case-elsewhere-hit.log"; exit 1; fi
echo "[PASS] answering the configured store path IS recognised as covering it (the check is not simply always-negative)"

# A parent directory of the store counts as covering it, but a sibling whose name merely
# shares a prefix must not — the containment test is on path segments, not string prefix.
WIZARD_ANSWER_DIR="$TMP"
wizard_case dbpath-parent-covers "{\"engine\":\"pglite\",\"database_path\":\"$ELSEWHERE_STORE\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-parent.log"
grep -qF "$COVERED_MARK" "$TMP/case-parent.log" \
  || { echo "[FAIL] a --dir that is a PARENT of the store was not recognised as covering it"; cat "$TMP/case-parent.log"; exit 1; }
WIZARD_ANSWER_DIR="${ELSEWHERE_STORE}-sibling"
mkdir -p "${ELSEWHERE_STORE}-sibling"
wizard_case dbpath-prefix-sibling "{\"engine\":\"pglite\",\"database_path\":\"$ELSEWHERE_STORE\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-sibling.log"
grep -qF "$NOT_COVERED_MARK" "$TMP/case-sibling.log" \
  || { echo "[FAIL] a sibling directory sharing a name PREFIX with the store was accepted as covering it (string-prefix containment bug)"; cat "$TMP/case-sibling.log"; exit 1; }
echo "[PASS] coverage matches on path segments: a parent covers the store, a same-prefix sibling does not"

# The filesystem ROOT as a --dir must cover everything (review round 2). resolve('/') is
# '/', so a naive "${root}/" prefix became '//' and '--dir /' covered nothing at all — a
# false negative on a coverage claim, the same family of bug as the false positive above.
# Safe to answer here: this run stops at the backend prompt, so snapshot() never runs and
# nothing under / is ever read, let alone archived.
WIZARD_ANSWER_DIR="/"
wizard_case dbpath-root-dir "{\"engine\":\"pglite\",\"database_path\":\"$ELSEWHERE_STORE\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-root.log"
grep -qF "$COVERED_MARK" "$TMP/case-root.log" \
  || { echo "[FAIL] '--dir /' was not recognised as covering an absolute store path (the resolve('/') double-separator bug)"; cat "$TMP/case-root.log"; exit 1; }
echo "[PASS] the filesystem root as a --dir covers an absolute store path (no '//' prefix bug)"

# A RELATIVE database_path is NOT resolvable from here and must not be guessed at (review
# round 2). gbrain absolutizes it with a bare resolve(), i.e. against ITS OWN cwd, which
# this process cannot observe — so the store could be anywhere and any coverage verdict
# would be a confident guess. An earlier version anchored it to the config's directory;
# that is the residual P1 this case exists to prevent from coming back.
WIZARD_ANSWER_DIR="@HOME@/.gbrain"
wizard_case dbpath-relative "{\"engine\":\"pglite\",\"database_path\":\"brain.pglite\",\"api_key\":\"$DECOY_SECRET\"}" pglite "$TMP/case-relative.log"
grep -qF "$RELATIVE_PATH_MARK" "$TMP/case-relative.log" \
  || { echo "[FAIL] a relative database_path was not reported as relative"; cat "$TMP/case-relative.log"; exit 1; }
grep -qF "brain.pglite" "$TMP/case-relative.log" \
  || { echo "[FAIL] the wizard did not quote the configured (relative) value back to the operator"; cat "$TMP/case-relative.log"; exit 1; }
if grep -qF "$COVERED_MARK" "$TMP/case-relative.log"; then echo "[FAIL] a relative database_path produced a COVERAGE CLAIM — it cannot be resolved from here, so no verdict is honest"; cat "$TMP/case-relative.log"; exit 1; fi
if grep -qF "$NOT_COVERED_MARK" "$TMP/case-relative.log"; then echo "[FAIL] a relative database_path produced a not-covered verdict — equally a guess"; cat "$TMP/case-relative.log"; exit 1; fi
echo "[PASS] a RELATIVE database_path is quoted, explained as unresolvable, and yields NO coverage verdict in either direction"

# PGLite with no database_path recorded: the wizard must SAY it cannot tell, never claim
# coverage either way.
grep -qF "$UNKNOWN_PATH_MARK" "$TMP/case-explicit-pglite.log" \
  || { echo "[FAIL] a PGLite brain with no database_path did not say the store location is unknown"; cat "$TMP/case-explicit-pglite.log"; exit 1; }
if grep -qF "$COVERED_MARK" "$TMP/case-explicit-pglite.log"; then echo "[FAIL] a PGLite brain with no database_path still claimed the store was covered"; cat "$TMP/case-explicit-pglite.log"; exit 1; fi
echo "[PASS] a PGLite brain with no database_path is told the location is unknown, and no coverage claim is made"

# ---------------------------------------------------------------------------
# (a2) detectGbrainEngine() unit-level: edge cases not easily reachable through the
# wizard's own prompt-driving harness above (a directory in place of the config file, a
# parsed-but-non-object JSON value, and the FALSY engine values #534's fix must still
# fall through to the database_path heuristic for, matching gbrain's own `||` semantics).
# ---------------------------------------------------------------------------
echo "== (a2) detectGbrainEngine(): readError (#543) and falsy-vs-truthy engine (#534) edge cases =="
UNIT_HOME="$TMP/unit-detect"; mkdir -p "$UNIT_HOME"
node --experimental-strip-types --import ./scripts/dev-cli-loader.mjs -e "
import('./src/lib/gbrain.ts').then(async (m) => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = '$UNIT_HOME';
  const assertEq = (label, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(label + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
    }
  };

  // #543: the config PATH ITSELF is a directory, not a file — readFile() throws EISDIR.
  const dirAsConfig = path.join(dir, 'dir-as-config.json');
  await fs.mkdir(dirAsConfig);
  assertEq('directory-as-config', await m.detectGbrainEngine(dirAsConfig), { engine: 'postgres', readError: true });

  // #543: valid JSON that parses to a non-object (a bare string) — same readError
  // treatment as a hard parse failure, not folded into the ordinary engine-less read.
  const nonObject = path.join(dir, 'non-object.json');
  await fs.writeFile(nonObject, JSON.stringify('just-a-string'));
  assertEq('non-object JSON', await m.detectGbrainEngine(nonObject), { engine: 'postgres', readError: true });

  // #543: JSON null also parses to a non-object per the same 'object'-typeof/null check.
  const jsonNull = path.join(dir, 'null.json');
  await fs.writeFile(jsonNull, 'null');
  assertEq('JSON null', await m.detectGbrainEngine(jsonNull), { engine: 'postgres', readError: true });

  // #543 (multi-model review, Warning): a bare JSON ARRAY also parses to 'object' under
  // typeof (arrays are objects in JS) and is not null — without an explicit Array.isArray
  // guard it would slip past the check above and read back as an ordinary, confidently
  // engine-less config instead of a readError.
  const jsonArray = path.join(dir, 'array.json');
  await fs.writeFile(jsonArray, JSON.stringify(['not', 'a', 'config']));
  assertEq('JSON array', await m.detectGbrainEngine(jsonArray), { engine: 'postgres', readError: true });

  // #534, negative space: a config that genuinely lacks an engine field (undefined, or an
  // explicit empty string — both FALSY) must still fall through to the database_path
  // heuristic, matching gbrain's own fileConfig?.engine || (...) short-circuit exactly.
  // This is the case the #534 fix must NOT break while fixing the truthy-unrecognized one.
  const emptyEngine = path.join(dir, 'empty-engine.json');
  await fs.writeFile(emptyEngine, JSON.stringify({ engine: '', database_path: '/srv/store.pglite' }));
  assertEq('empty-string engine falls through to the heuristic', await m.detectGbrainEngine(emptyEngine), {
    engine: 'pglite',
    dataPath: '/srv/store.pglite',
  });
  const nullEngine = path.join(dir, 'null-engine.json');
  await fs.writeFile(nullEngine, JSON.stringify({ engine: null, database_path: '/srv/store.pglite' }));
  assertEq('null engine falls through to the heuristic', await m.detectGbrainEngine(nullEngine), {
    engine: 'pglite',
    dataPath: '/srv/store.pglite',
  });

  // #534, positive space (unit-level companion to the wizard-level (a) cases above): a
  // TRUTHY but unrecognized engine value never reaches the heuristic, even with a
  // database_path present — no readError either, since this config parsed just fine.
  const badEngine = path.join(dir, 'bad-engine.json');
  await fs.writeFile(badEngine, JSON.stringify({ engine: 'Postgres', database_path: '/srv/store.pglite' }));
  assertEq('truthy unrecognized engine -> postgres, no readError', await m.detectGbrainEngine(badEngine), { engine: 'postgres' });

  console.log('detectGbrainEngine unit checks OK');
});
" | grep -q 'detectGbrainEngine unit checks OK' || { echo "[FAIL] detectGbrainEngine() unit-level edge cases"; exit 1; }
echo "[PASS] detectGbrainEngine(): directory-as-config/non-object-JSON/null all set readError; falsy engine ('', null) still falls through to the database_path heuristic; a truthy unrecognized engine does not"

# ---------------------------------------------------------------------------
# (b) end-to-end: a PGLite brain goes init -> snapshot -> push -> kit with no --pg
# ---------------------------------------------------------------------------
echo "== (b) a PGLite gbrain completes init end-to-end, backing up the store directory and never a pg_dump =="
E2E_HOME="$TMP/e2e-home"; mkdir -p "$E2E_HOME/.gbrain"
E2E_CB_HOME="$TMP/e2e-cb-home"
E2E_STORE_DIR="$TMP/e2e-store"
E2E_KIT_PATH="$E2E_HOME/recovery-kit.txt"
printf '%s\n' "{\"engine\":\"pglite\",\"database_path\":\"$E2E_HOME/.gbrain/.pglite\",\"api_key\":\"$DECOY_SECRET\"}" \
  > "$E2E_HOME/.gbrain/config.json"
make_pglite_store "$E2E_HOME/.gbrain/.pglite"
E2E_MARKER="pglite-brain-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$E2E_MARKER" > "$E2E_HOME/.gbrain/.pglite/base/fixture-relation"

cat > "$TMP/qa-e2e.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$E2E_HOME/.gbrain"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$E2E_KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$E2E_CB_HOME" CYPHER_BRAIN_FILE_DIR="$E2E_STORE_DIR" HOME="$E2E_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-e2e.json" --out "$TMP/e2e.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the PGLite end-to-end wizard run did not complete"; cat "$TMP/e2e.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/e2e.log" || { echo "[FAIL] PGLite e2e run lacks the wizard's completion marker"; cat "$TMP/e2e.log"; exit 1; }
if grep -qF "$PG_PROMPT_MARK" "$TMP/e2e.log"; then echo "[FAIL] the PGLite e2e run was offered --pg"; cat "$TMP/e2e.log"; exit 1; fi
if grep -qF "$NOT_COVERED_MARK" "$TMP/e2e.log"; then echo "[FAIL] the store WAS covered by the answered directory, but the wizard still said it was not"; cat "$TMP/e2e.log"; exit 1; fi
grep -qF "$COVERED_MARK" "$TMP/e2e.log" || { echo "[FAIL] the wizard did not confirm coverage for a store the answered directory really does contain"; cat "$TMP/e2e.log"; exit 1; }
grep -qF "$WARN_MARK" "$TMP/e2e.log" || { echo "[FAIL] the wizard's own snapshot of a PGLite store did not carry the consistency warning"; cat "$TMP/e2e.log"; exit 1; }
echo "[PASS] init on a PGLite brain completes without ever proposing --pg, confirms the store IS covered, and still warns about copying it live"

E2E_SNAP="$(find "$E2E_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$E2E_SNAP" ] || { echo "[FAIL] no brain-*.age snapshot from the PGLite e2e run"; exit 1; }
E2E_RESTORE="$TMP/e2e-restored"
CYPHER_BRAIN_HOME="$E2E_CB_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" restore --in "$E2E_SNAP" --out-dir "$E2E_RESTORE" > "$TMP/e2e-restore.log" 2>&1 \
  || { echo "[FAIL] restoring the PGLite e2e snapshot failed"; cat "$TMP/e2e-restore.log"; exit 1; }
if [ -f "$E2E_RESTORE/db.dump" ]; then echo "[FAIL] a PGLite run produced a pg_dump component"; exit 1; fi
tar -xzf "$E2E_RESTORE/.gbrain.tar.gz" -C "$E2E_RESTORE"
grep -qF "$E2E_MARKER" "$E2E_RESTORE/.gbrain/.pglite/base/fixture-relation" \
  || { echo "[FAIL] the restored tree does not carry the PGLite store's own content"; exit 1; }
grep -qF 'Postgres dump: not included' "$E2E_KIT_PATH" || { echo "[FAIL] the recovery kit does not record the absent Postgres dump"; cat "$E2E_KIT_PATH"; exit 1; }
echo "[PASS] the resulting snapshot carries the PGLite store's real bytes and no db.dump; the kit says so too"

# ---------------------------------------------------------------------------
# (c) the detection rule itself, through `snapshot`
# ---------------------------------------------------------------------------
echo "== (c) snapshot warns on a PGLite store and stays silent on look-alikes (both markers required) =="
SNAP_CB_HOME="$TMP/snap-cb-home"
cb() { CYPHER_BRAIN_HOME="$SNAP_CB_HOME" node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }
cb keygen > /dev/null

# Fixture 1 — a synthetic PGLite data directory.
FIX_PGLITE="$TMP/fix-pglite"; make_pglite_store "$FIX_PGLITE"
# Fixture 2 — a Postgres-configured ~/.gbrain: config + caches, no data directory
# anywhere, because the data lives in a server this tool never looks at.
FIX_POSTGRES="$TMP/fix-postgres-gbrain"; mkdir -p "$FIX_POSTGRES/migrations" "$FIX_POSTGRES/mounts-cache"
printf '{"engine":"postgres"}\n' > "$FIX_POSTGRES/config.json"
# Fixture 3 — a ~/.gbrain carrying neither marker (nor an engine field).
FIX_BARE="$TMP/fix-bare-gbrain"; mkdir -p "$FIX_BARE"
printf '{"schema_pack":"gbrain-base-v2"}\n' > "$FIX_BARE/config.json"
# Fixture 4 — HALF the marker pair. PG_VERSION alone is not a live store (an
# extracted backup, a stray file); requiring pg_wal/ too is what keeps this from
# warning about things nobody is writing to.
FIX_HALF="$TMP/fix-half-marker"; mkdir -p "$FIX_HALF"
printf '17\n' > "$FIX_HALF/PG_VERSION"
# Fixture 5 — both NAMES present with the wrong TYPES: a directory called PG_VERSION and
# a plain file called pg_wal. Name-only matching accepted this (multi-model review); a
# cluster has PG_VERSION as a file and pg_wal as a directory, and nothing else counts.
FIX_TYPES="$TMP/fix-wrong-types"; mkdir -p "$FIX_TYPES/PG_VERSION"
printf 'not a directory\n' > "$FIX_TYPES/pg_wal"

cb snapshot --dir "$FIX_PGLITE" --out "$TMP/fix-pglite.age" > "$TMP/snap-pglite.log" 2>&1 \
  || { echo "[FAIL] snapshotting a PGLite store failed — this must be a warning, never a refusal"; cat "$TMP/snap-pglite.log"; exit 1; }
grep -qF "$WARN_MARK" "$TMP/snap-pglite.log" || { echo "[FAIL] no PGLite warning for a synthetic store"; cat "$TMP/snap-pglite.log"; exit 1; }
[ -f "$TMP/fix-pglite.age" ] || { echo "[FAIL] the warned-about snapshot produced no artifact"; exit 1; }
echo "[PASS] a synthetic PGLite data directory is detected, and the snapshot still succeeds (exit 0, artifact written)"

for fix in "$FIX_POSTGRES:a Postgres-configured ~/.gbrain" "$FIX_BARE:a ~/.gbrain with neither marker" "$FIX_HALF:a directory with PG_VERSION but no pg_wal/" "$FIX_TYPES:a directory with both marker NAMES but the wrong types"; do
  path="${fix%%:*}"; what="${fix#*:}"
  cb snapshot --dir "$path" --out "$TMP/$(basename "$path").age" > "$TMP/snap-$(basename "$path").log" 2>&1 \
    || { echo "[FAIL] snapshotting $what failed"; cat "$TMP/snap-$(basename "$path").log"; exit 1; }
  if grep -qF "$WARN_MARK" "$TMP/snap-$(basename "$path").log"; then
    echo "[FAIL] $what was wrongly reported as a data directory"; cat "$TMP/snap-$(basename "$path").log"; exit 1
  fi
done
echo "[PASS] a Postgres-configured ~/.gbrain, a ~/.gbrain with neither marker, a PG_VERSION-only directory, and a wrong-types look-alike are all left alone"

# The on-disk evidence is the authority, and it answers alone. A store whose config
# says Postgres, with a DATABASE_URL exported on top, is still a directory that tears
# when copied mid-write — so the warning must not be suppressible by either.
FIX_CONTRADICTED="$TMP/fix-contradicted"; make_pglite_store "$FIX_CONTRADICTED"
printf '{"engine":"postgres"}\n' > "$FIX_CONTRADICTED/config.json"
DATABASE_URL="postgres://someone@localhost:5432/other" GBRAIN_DATABASE_URL="postgres://someone@localhost:5432/other" \
  cb snapshot --dir "$FIX_CONTRADICTED" --out "$TMP/fix-contradicted.age" > "$TMP/snap-contradicted.log" 2>&1 \
  || { echo "[FAIL] snapshotting a store whose config claims Postgres failed"; cat "$TMP/snap-contradicted.log"; exit 1; }
grep -qF "$WARN_MARK" "$TMP/snap-contradicted.log" \
  || { echo "[FAIL] an on-disk PGLite store went unwarned because a config field / env var claimed Postgres"; cat "$TMP/snap-contradicted.log"; exit 1; }
echo "[PASS] the warning follows the bytes on disk — neither an engine=postgres config nor an exported DATABASE_URL suppresses it"

# A store nested UNDER the --dir (the ~/.gbrain layout: --dir ~/.gbrain, store at the
# configured database_path one level down) must be found too — "is OR contains".
FIX_NEST="$TMP/fix-nested-gbrain"; mkdir -p "$FIX_NEST"
printf '{"database_path":"/x/.pglite"}\n' > "$FIX_NEST/config.json"
make_pglite_store "$FIX_NEST/.pglite"
cb snapshot --dir "$FIX_NEST" --out "$TMP/fix-nested.age" > "$TMP/snap-nested.log" 2>&1 \
  || { echo "[FAIL] snapshotting a ~/.gbrain containing a PGLite store failed"; cat "$TMP/snap-nested.log"; exit 1; }
grep -qF "$WARN_MARK" "$TMP/snap-nested.log" || { echo "[FAIL] a PGLite store one level under the --dir was not detected"; cat "$TMP/snap-nested.log"; exit 1; }
echo "[PASS] a store nested under the --dir (the real ~/.gbrain layout) is detected too"

# THE DOCUMENTED BOUNDARY, pinned in the negative direction (multi-model review). With no
# .cypherbrainignore there is no walk to borrow, so the search reads the source root and
# ONE level below it and stops — a store deeper than that is not warned about. README and
# MANAGEMENT.md say exactly this rather than promising "anywhere under the source"; this
# case is what keeps the promise and the code from drifting apart. If a future change
# widens the search, this assertion is meant to fail and be replaced along with the prose.
FIX_DEEP="$TMP/fix-deep-no-ignore"; mkdir -p "$FIX_DEEP/data/brains/main"
make_pglite_store "$FIX_DEEP/data/brains/main/.pglite"
cb snapshot --dir "$FIX_DEEP" --out "$TMP/fix-deep.age" > "$TMP/snap-deep.log" 2>&1 \
  || { echo "[FAIL] snapshotting a deeply-nested store failed"; cat "$TMP/snap-deep.log"; exit 1; }
if grep -qF "$WARN_MARK" "$TMP/snap-deep.log"; then
  echo "[FAIL] a store 4 levels down was detected with no ignore file — good news, but README/MANAGEMENT.md still document the one-level bound; widen the prose in the same change"; cat "$TMP/snap-deep.log"; exit 1
fi
echo "[PASS] documented bound holds: with no .cypherbrainignore, a store deeper than one level below the source is NOT warned about (and the docs say so)"

# The .cypherbrainignore path takes a DIFFERENT route into the detector: an ignore
# file makes snapshot walk the tree itself (#216), and the detection reuses that
# walk's own path list instead of touching disk again. Nest the store deeper than
# the no-ignore-file fallback looks, so this asserts the reuse and not a repeat of
# the case above.
FIX_IGN="$TMP/fix-ignore-gbrain"; mkdir -p "$FIX_IGN/data/brains/main"
printf 'node_modules/\n' > "$FIX_IGN/.cypherbrainignore"
mkdir -p "$FIX_IGN/node_modules"; printf 'junk\n' > "$FIX_IGN/node_modules/junk.txt"
make_pglite_store "$FIX_IGN/data/brains/main/.pglite"
cb snapshot --dir "$FIX_IGN" --out "$TMP/fix-ignore.age" > "$TMP/snap-ignore.log" 2>&1 \
  || { echo "[FAIL] snapshotting an ignore-filtered tree containing a PGLite store failed"; cat "$TMP/snap-ignore.log"; exit 1; }
grep -qF "$WARN_MARK" "$TMP/snap-ignore.log" || { echo "[FAIL] a deeply-nested store was not detected from the .cypherbrainignore walk this snapshot already did"; cat "$TMP/snap-ignore.log"; exit 1; }
if grep -qF "$TRUNCATED_MARK" "$TMP/snap-ignore.log"; then echo "[FAIL] a store the ignore file does not touch was reported as partially excluded"; cat "$TMP/snap-ignore.log"; exit 1; fi
echo "[PASS] with a .cypherbrainignore present, the store is found from the walk snapshot already performed — at any depth, with no second traversal"

# THE CASE THE PRE-FIX CODE SWALLOWED (multi-model review, measured). Handing the detector
# only the ARCHIVED half of the walk meant an ignore rule matching pg_wal/ deleted one of
# the two markers it looks for, so the warning went silent — on precisely the run whose
# output cannot be opened AT ALL, which is worse than the merely-maybe-inconsistent copy
# the warning is normally about. Both halves now go in, and this case gets the stronger of
# the two warnings.
FIX_CUT="$TMP/fix-ignore-cuts-store"; mkdir -p "$FIX_CUT"
make_pglite_store "$FIX_CUT/brain.pglite"
printf 'brain.pglite/pg_wal/\n' > "$FIX_CUT/.cypherbrainignore"
cb snapshot --dir "$FIX_CUT" --out "$TMP/fix-cut.age" > "$TMP/snap-cut.log" 2>&1 \
  || { echo "[FAIL] snapshotting a partially-ignored store failed — still a warning, never a refusal"; cat "$TMP/snap-cut.log"; exit 1; }
grep -qF "$WARN_MARK" "$TMP/snap-cut.log" \
  || { echo "[FAIL] an ignore rule that hides pg_wal/ silenced the detector — the exact regression this case exists for"; cat "$TMP/snap-cut.log"; exit 1; }
grep -qF "$TRUNCATED_MARK" "$TMP/snap-cut.log" \
  || { echo "[FAIL] a store archived in PIECES got the ordinary live-copy warning instead of the stronger partial-store one"; cat "$TMP/snap-cut.log"; exit 1; }
grep -qF "$TRUNCATED_CERTAIN_MARK" "$TMP/snap-cut.log" \
  || { echo "[FAIL] excluding pg_wal/ — a component a cluster cannot start without — did not get the CERTAIN wording"; cat "$TMP/snap-cut.log"; exit 1; }
# And the archive really is missing the marker, which is what makes the warning true.
cb restore --in "$TMP/fix-cut.age" --out-dir "$TMP/cut-restored" > /dev/null 2>&1 \
  || { echo "[FAIL] restoring the partially-ignored snapshot failed"; exit 1; }
tar -tzf "$TMP/cut-restored/fix-ignore-cuts-store.tar.gz" > "$TMP/cut-listing.txt"
grep -qF 'brain.pglite/PG_VERSION' "$TMP/cut-listing.txt" || { echo "[FAIL] test setup: the archive does not even contain the store"; cat "$TMP/cut-listing.txt"; exit 1; }
if grep -qF 'brain.pglite/pg_wal' "$TMP/cut-listing.txt"; then echo "[FAIL] test setup: pg_wal was NOT actually excluded, so this proves nothing"; cat "$TMP/cut-listing.txt"; exit 1; fi
echo "[PASS] an ignore rule that removes a REQUIRED component still warns — with the certain 'cannot be opened at all' wording — and the archive really is missing pg_wal/"

# THE OTHER HALF OF THAT CERTAINTY (review round 2). Excluding postmaster.pid or a log
# does NOT make a data directory unopenable, so "cannot be opened at all" would be the
# same over-claiming reflex the hedging round already corrected once. The exclusion is
# still worth reporting — a data directory is meant to be archived whole and verify cannot
# tell you whether what went missing mattered — but the wording has to earn its certainty.
FIX_CUT_MINOR="$TMP/fix-ignore-cuts-nonessential"; mkdir -p "$FIX_CUT_MINOR"
make_pglite_store "$FIX_CUT_MINOR/brain.pglite"
printf 'running\n' > "$FIX_CUT_MINOR/brain.pglite/postmaster.pid"
mkdir -p "$FIX_CUT_MINOR/brain.pglite/log"; printf 'chatter\n' > "$FIX_CUT_MINOR/brain.pglite/log/postgresql.log"
printf 'brain.pglite/postmaster.pid\nbrain.pglite/log/\n' > "$FIX_CUT_MINOR/.cypherbrainignore"
cb snapshot --dir "$FIX_CUT_MINOR" --out "$TMP/fix-cut-minor.age" > "$TMP/snap-cut-minor.log" 2>&1 \
  || { echo "[FAIL] snapshotting a store with non-essential exclusions failed"; cat "$TMP/snap-cut-minor.log"; exit 1; }
grep -qF "$TRUNCATED_MARK" "$TMP/snap-cut-minor.log" \
  || { echo "[FAIL] a partially-excluded store was not reported at all"; cat "$TMP/snap-cut-minor.log"; exit 1; }
grep -qF "$TRUNCATED_HEDGED_MARK" "$TMP/snap-cut-minor.log" \
  || { echo "[FAIL] non-essential exclusions did not get the HEDGED wording"; cat "$TMP/snap-cut-minor.log"; exit 1; }
if grep -qF "$TRUNCATED_CERTAIN_MARK" "$TMP/snap-cut-minor.log"; then
  echo "[FAIL] excluding only postmaster.pid and a log claimed the copy 'cannot be opened at all' — certainty must be earned by hitting a required component"; cat "$TMP/snap-cut-minor.log"; exit 1
fi
if grep -qF "$TRUNCATED_PARTIAL_MARK" "$TMP/snap-cut-minor.log"; then echo "[FAIL] a non-essential exclusion was reported as reaching into a required directory"; cat "$TMP/snap-cut-minor.log"; exit 1; fi
echo "[PASS] excluding only non-essential files (postmaster.pid, log/) is reported, but HEDGED — the certain wording is reserved for required components"

# THE MIDDLE STRENGTH (review round 3). "First segment is pg_wal/base/global" was too
# coarse: pg_wal/archive_status/*.done is disposable and a cluster starts without it, so
# claiming "cannot be opened at all" there was the same over-claiming reflex a third time.
# Certainty now needs a marker FILE or a WHOLE required directory; a partial hit inside one
# gets its own wording that names the component and says "MAY". Fixed by making the
# certainty conditional on evidence rather than by enumerating disposables — that list is
# long, version-dependent, and errs in the dangerous direction when one entry is wrong.
FIX_CUT_PARTIAL="$TMP/fix-ignore-cuts-inside-required"; mkdir -p "$FIX_CUT_PARTIAL"
make_pglite_store "$FIX_CUT_PARTIAL/brain.pglite"
printf 'brain.pglite/pg_wal/archive_status/\n' > "$FIX_CUT_PARTIAL/.cypherbrainignore"
cb snapshot --dir "$FIX_CUT_PARTIAL" --out "$TMP/fix-cut-partial.age" > "$TMP/snap-cut-partial.log" 2>&1 \
  || { echo "[FAIL] snapshotting a store with a partial exclusion inside pg_wal/ failed"; cat "$TMP/snap-cut-partial.log"; exit 1; }
grep -qF "$TRUNCATED_MARK" "$TMP/snap-cut-partial.log" \
  || { echo "[FAIL] a partial exclusion inside a required directory was not reported at all"; cat "$TMP/snap-cut-partial.log"; exit 1; }
grep -qF "$TRUNCATED_PARTIAL_MARK" "$TMP/snap-cut-partial.log" \
  || { echo "[FAIL] a partial exclusion inside pg_wal/ did not get the middle-strength wording"; cat "$TMP/snap-cut-partial.log"; exit 1; }
grep -qF "pg_wal/" "$TMP/snap-cut-partial.log" \
  || { echo "[FAIL] the middle-strength warning does not name the component that was reached into"; cat "$TMP/snap-cut-partial.log"; exit 1; }
if grep -qF "$TRUNCATED_CERTAIN_MARK" "$TMP/snap-cut-partial.log"; then
  echo "[FAIL] excluding only pg_wal/archive_status/ (disposable) claimed the copy 'cannot be opened at all'"; cat "$TMP/snap-cut-partial.log"; exit 1
fi
if grep -qF "$TRUNCATED_HEDGED_MARK" "$TMP/snap-cut-partial.log"; then
  echo "[FAIL] a hit inside a required directory was downgraded to the nothing-required wording"; cat "$TMP/snap-cut-partial.log"; exit 1
fi
echo "[PASS] a partial exclusion inside pg_wal/ names the component and says MAY — neither the certain nor the nothing-required wording"

# The other half of the new rule: a decisive single FILE. Losing global/pg_control alone
# stops a cluster, so that IS a certainty even though the rest of global/ is archived.
FIX_CUT_CONTROL="$TMP/fix-ignore-cuts-pg-control"; mkdir -p "$FIX_CUT_CONTROL"
make_pglite_store "$FIX_CUT_CONTROL/brain.pglite"
printf 'brain.pglite/global/pg_control\n' > "$FIX_CUT_CONTROL/.cypherbrainignore"
cb snapshot --dir "$FIX_CUT_CONTROL" --out "$TMP/fix-cut-control.age" > "$TMP/snap-cut-control.log" 2>&1 \
  || { echo "[FAIL] snapshotting a store missing global/pg_control failed"; cat "$TMP/snap-cut-control.log"; exit 1; }
grep -qF "$TRUNCATED_CERTAIN_MARK" "$TMP/snap-cut-control.log" \
  || { echo "[FAIL] excluding global/pg_control — a decisive single file — did not get the CERTAIN wording"; cat "$TMP/snap-cut-control.log"; exit 1; }
echo "[PASS] excluding the single file global/pg_control is certain, even though the rest of global/ is archived"

# ---------------------------------------------------------------------------
# (d) both relay surfaces (#347)
# ---------------------------------------------------------------------------
echo "== (d) the warning reaches the CLI run summary AND the MCP warnings array (#347) =="
grep -qF 'run summary' "$TMP/snap-pglite.log" || { echo "[FAIL] no run summary block at all"; cat "$TMP/snap-pglite.log"; exit 1; }
# The summary block is the LAST thing printed — assert the warning is inside it, not
# merely somewhere earlier in the transcript (warn() prints live too, and only the
# recorded copy is what an agent is asked to relay).
awk '/run summary/{found=1} found' "$TMP/snap-pglite.log" | grep -qF "$WARN_MARK" \
  || { echo "[FAIL] the PGLite warning printed live but never made it into the end-of-run summary"; cat "$TMP/snap-pglite.log"; exit 1; }
echo "[PASS] the CLI's end-of-run relay-me summary carries it"

MCP_OUT="$TMP/mcp-out.jsonl"
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"selftest","version":"0"}}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  printf '%s\n' "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"snapshot_now\",\"arguments\":{\"dirs\":[\"$FIX_PGLITE\"],\"out\":\"$TMP/mcp.age\",\"recipients\":[\"$SNAP_CB_HOME/recipient.txt\"]}}}"
  # Hold stdin open until the id:2 response lands (the server exits at EOF, and a
  # fixed sleep would either race the snapshot or pad every run). Bounded: 60 * 0.5s,
  # after which the loop gives up and the assertion below reports what was missing.
  for _ in $(seq 1 60); do
    grep -q '"id":2' "$MCP_OUT" 2>/dev/null && break
    sleep 0.5
  done
} | CYPHER_BRAIN_HOME="$SNAP_CB_HOME" node "${BIN_DEV_ARGS[@]}" "$MCP_BIN" > "$MCP_OUT" 2> "$TMP/mcp-err.log" || true
grep -q '"id":2' "$MCP_OUT" || { echo "[FAIL] the MCP server never answered the snapshot_now call"; cat "$MCP_OUT"; tail -20 "$TMP/mcp-err.log"; exit 1; }
if grep -q '"isError":true' "$MCP_OUT"; then echo "[FAIL] snapshot_now on a PGLite store returned an error — this must be a warning, not a refusal"; cat "$MCP_OUT"; exit 1; fi
# Read the structured field, not the whole line: `log` echoes stderr verbatim, so a
# substring match anywhere in the response would pass even if the `warnings` array
# (the thing #347 added, and the only part an MCP client is told to relay) were empty.
node -e '
  const { readFileSync } = require("node:fs");
  const mark = process.argv[2];
  const line = readFileSync(process.argv[1], "utf8").split("\n").filter((l) => l.includes("\"id\":2")).pop();
  const warnings = JSON.parse(line).result?.structuredContent?.warnings ?? [];
  if (!warnings.some((w) => w.includes(mark))) {
    console.error("[FAIL] snapshot_now returned no PGLite warning in its structured warnings array:", JSON.stringify(warnings));
    process.exit(1);
  }
' "$MCP_OUT" "$WARN_MARK"
echo "[PASS] the MCP snapshot_now result carries it in the structured warnings array"

# ---------------------------------------------------------------------------
# (e) resolveGbrainConfigPath(): the GBRAIN_HOME override wizard.ts and doctor.ts both
# route through. Before this, each hard-coded join(homedir(), '.gbrain', 'config.json')
# independently, so a machine that had relocated its gbrain home via GBRAIN_HOME got a
# false "not set up" from both — a fully configured gbrain silently reported as absent.
# ---------------------------------------------------------------------------
echo "== (e) resolveGbrainConfigPath(): GBRAIN_HOME override, unit-level =="
RESOLVE_HOME="$TMP/resolve-home"; mkdir -p "$RESOLVE_HOME"
RESOLVE_ELSEWHERE="$TMP/resolve-elsewhere"

# HOME is set explicitly on every call below (never inherited) so the default-fallback
# assertions are pinned against a KNOWN value, not whoever happens to run this suite.
# Routed through `env` (not a bare "VAR=val cmd" prefix): once GBRAIN_HOME=... has
# passed through "$@" expansion it is plain argv text, and bash — unlike a LITERAL
# assignment-prefix written in the source — does not re-parse an expanded string as an
# env assignment; it tries to exec it as the command itself. `env` parses argv for
# NAME=value pairs explicitly, so it does not care whether they arrived literally or
# via expansion.
#
# Prints "<path>\t<0-or-1>" (tab-separated: the resolved path, then whether
# invalidOverride was set) so one call checks both fields of the return value.
resolve_path() {
  local home_env="$1"; shift
  env HOME="$home_env" "$@" node --experimental-strip-types --import ./scripts/dev-cli-loader.mjs -e "
import('./src/lib/gbrain.ts').then((m) => {
  const r = m.resolveGbrainConfigPath();
  console.log(r.path + '\t' + (r.invalidOverride ? '1' : '0'));
});
"
}

IFS=$'\t' read -r OUT INVALID <<< "$(resolve_path "$RESOLVE_HOME")"
[ "$OUT" = "$RESOLVE_HOME/.gbrain/config.json" ] \
  || { echo "[FAIL] resolveGbrainConfigPath(): GBRAIN_HOME unset did not fall back to \$HOME/.gbrain/config.json, got: $OUT"; exit 1; }
[ "$INVALID" = "0" ] || { echo "[FAIL] resolveGbrainConfigPath(): GBRAIN_HOME unset set invalidOverride, it must not"; exit 1; }
echo "[PASS] GBRAIN_HOME unset -> falls back to \$HOME/.gbrain/config.json, invalidOverride not set"

IFS=$'\t' read -r OUT INVALID <<< "$(resolve_path "$RESOLVE_HOME" GBRAIN_HOME="$RESOLVE_ELSEWHERE")"
[ "$OUT" = "$RESOLVE_ELSEWHERE/.gbrain/config.json" ] \
  || { echo "[FAIL] resolveGbrainConfigPath(): a valid absolute GBRAIN_HOME was not honored, got: $OUT"; exit 1; }
[ "$INVALID" = "0" ] || { echo "[FAIL] resolveGbrainConfigPath(): a valid absolute GBRAIN_HOME set invalidOverride, it must not"; exit 1; }
echo "[PASS] GBRAIN_HOME=<absolute path> -> \$GBRAIN_HOME/.gbrain/config.json (gbrain appends .gbrain itself — this must not double it, or fall back to \$HOME instead), invalidOverride not set"

IFS=$'\t' read -r OUT INVALID <<< "$(resolve_path "$RESOLVE_HOME" GBRAIN_HOME="")"
[ "$OUT" = "$RESOLVE_HOME/.gbrain/config.json" ] \
  || { echo "[FAIL] resolveGbrainConfigPath(): an empty-string GBRAIN_HOME was not treated as unset, got: $OUT"; exit 1; }
[ "$INVALID" = "0" ] || { echo "[FAIL] resolveGbrainConfigPath(): an empty-string GBRAIN_HOME set invalidOverride, it must not — blank is 'unset', not 'invalid'"; exit 1; }
echo "[PASS] GBRAIN_HOME=\"\" (blank) -> treated as unset, matching gbrain's own 'override && override.trim()' check; invalidOverride not set"

IFS=$'\t' read -r OUT INVALID <<< "$(resolve_path "$RESOLVE_HOME" GBRAIN_HOME="relative/path")"
[ "$OUT" = "$RESOLVE_HOME/.gbrain/config.json" ] \
  || { echo "[FAIL] resolveGbrainConfigPath(): a RELATIVE GBRAIN_HOME was not rejected back to the \$HOME default, got: $OUT"; exit 1; }
[ "$INVALID" = "1" ] || { echo "[FAIL] resolveGbrainConfigPath(): a RELATIVE GBRAIN_HOME did not set invalidOverride — a caller cannot tell the \$HOME fallback found here apart from a genuine detection"; exit 1; }
echo "[PASS] GBRAIN_HOME=<relative path> -> falls back to \$HOME/.gbrain/config.json instead of throwing (gbrain itself would refuse to start on this value — a read-only check must not crash over another tool's malformed env var), invalidOverride IS set (multi-model review — a caller must be able to tell this apart from a real detection)"

IFS=$'\t' read -r OUT INVALID <<< "$(resolve_path "$RESOLVE_HOME" GBRAIN_HOME="/srv/../etc/gbrain")"
[ "$OUT" = "$RESOLVE_HOME/.gbrain/config.json" ] \
  || { echo "[FAIL] resolveGbrainConfigPath(): a GBRAIN_HOME containing a '..' segment was not rejected back to the \$HOME default, got: $OUT"; exit 1; }
[ "$INVALID" = "1" ] || { echo "[FAIL] resolveGbrainConfigPath(): a GBRAIN_HOME containing a '..' segment did not set invalidOverride"; exit 1; }
echo "[PASS] GBRAIN_HOME containing a '..' segment -> falls back to \$HOME/.gbrain/config.json, matching gbrain's own validation rule; invalidOverride IS set"

IFS=$'\t' read -r OUT INVALID <<< "$(resolve_path "$RESOLVE_HOME" GBRAIN_HOME=" $RESOLVE_ELSEWHERE ")"
[ "$OUT" = "$RESOLVE_ELSEWHERE/.gbrain/config.json" ] \
  || { echo "[FAIL] resolveGbrainConfigPath(): a whitespace-padded absolute GBRAIN_HOME was not trimmed the same way gbrain's own configDir() trims it, got: $OUT"; exit 1; }
[ "$INVALID" = "0" ] || { echo "[FAIL] resolveGbrainConfigPath(): a whitespace-padded but otherwise valid GBRAIN_HOME set invalidOverride, it must not"; exit 1; }
echo "[PASS] GBRAIN_HOME=\" <absolute path> \" (padded) -> trimmed and honored exactly like gbrain's own configDir() (which validates and joins on the TRIMMED value, not the raw one)"

echo "== (e) GBRAIN_HOME override, through the init wizard =="
# The wizard must detect a gbrain relocated ENTIRELY away from ~/.gbrain: HOME here has
# NO .gbrain at all, so a build that still hard-codes the default path would silently
# SKIP the whole gbrain-detection block (the wizard's own `if (await exists(...))` guard)
# and fall straight through to the backend prompt with none of PGLITE_BRANCH_MARK /
# POSTGRES_BRANCH_MARK ever printed — the exact "silently-skipped prompt" failure mode.
RELOC_HOME="$TMP/case-reloc-home"; mkdir -p "$RELOC_HOME"
RELOC_CBHOME="$TMP/case-reloc-cb-home"
RELOC_GBRAIN_HOME="$TMP/case-reloc-gbrain-home"; mkdir -p "$RELOC_GBRAIN_HOME/.gbrain"
printf '{"engine":"pglite","api_key":"%s"}\n' "$DECOY_SECRET" > "$RELOC_GBRAIN_HOME/.gbrain/config.json"
cat > "$TMP/qa-reloc.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$CB_SRC"],
  ["Choose a backend", "\u001b[A"]
]
JSON
CYPHER_BRAIN_HOME="$RELOC_CBHOME" HOME="$RELOC_HOME" GBRAIN_HOME="$RELOC_GBRAIN_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-reloc.json" --out "$TMP/case-reloc.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] reloc: init did not stop cleanly at the ton-provider prerequisites guard"; cat "$TMP/case-reloc.log"; exit 1; }
grep -qF "CYPHER_BRAIN_TON_PROVIDER_OWNER" "$TMP/case-reloc.log" || { echo "[FAIL] reloc: the run ended for some reason other than the scripted stop"; cat "$TMP/case-reloc.log"; exit 1; }
grep -qF "$PGLITE_BRANCH_MARK" "$TMP/case-reloc.log" \
  || { echo "[FAIL] reloc: GBRAIN_HOME-relocated config was not detected — looks like the wizard silently skipped the gbrain-detection block against the empty default \$HOME/.gbrain"; cat "$TMP/case-reloc.log"; exit 1; }
if grep -qF "$DECOY_SECRET" "$TMP/case-reloc.log"; then
  echo "[FAIL] reloc: a value from the relocated config.json reached the transcript"; exit 1
fi
echo "[PASS] GBRAIN_HOME relocated (with an EMPTY \$HOME/.gbrain): the wizard still detects and reports the engine, instead of silently skipping the whole gbrain-detection prompt"

# An INVALID GBRAIN_HOME (relative here) with NO config at the $HOME fallback either:
# the wizard must say the override is invalid, not stay silent (there is nothing at the
# fallback to accidentally misreport as a detection in this case, but the notice must
# still fire so the operator learns GBRAIN_HOME itself needs fixing).
INVALID_HOME="$TMP/case-invalid-gbrain-home"; mkdir -p "$INVALID_HOME"
INVALID_CBHOME="$TMP/case-invalid-gbrain-cb-home"
cat > "$TMP/qa-invalid.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$CB_SRC"],
  ["Choose a backend", "\u001b[A"]
]
JSON
CYPHER_BRAIN_HOME="$INVALID_CBHOME" HOME="$INVALID_HOME" GBRAIN_HOME="not/absolute" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-invalid.json" --out "$TMP/case-invalid.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] invalid-gbrain-home: init did not stop cleanly at the ton-provider prerequisites guard"; cat "$TMP/case-invalid.log"; exit 1; }
grep -qF "CYPHER_BRAIN_TON_PROVIDER_OWNER" "$TMP/case-invalid.log" || { echo "[FAIL] invalid-gbrain-home: the run ended for some reason other than the scripted stop"; cat "$TMP/case-invalid.log"; exit 1; }
grep -qF "$INVALID_GBRAIN_HOME_MARK" "$TMP/case-invalid.log" \
  || { echo "[FAIL] invalid-gbrain-home: the wizard did not warn about the invalid GBRAIN_HOME"; cat "$TMP/case-invalid.log"; exit 1; }
grep -qF "not/absolute" "$TMP/case-invalid.log" \
  || { echo "[FAIL] invalid-gbrain-home: the wizard did not quote the actual (invalid) GBRAIN_HOME value back"; cat "$TMP/case-invalid.log"; exit 1; }
if grep -qF "$PGLITE_BRANCH_MARK" "$TMP/case-invalid.log"; then echo "[FAIL] invalid-gbrain-home: no config exists anywhere, yet the wizard claimed a PGLite detection"; cat "$TMP/case-invalid.log"; exit 1; fi
echo "[PASS] a RELATIVE GBRAIN_HOME (invalid) makes the wizard warn by name, quoting the value, instead of staying silent"

echo
echo "selftest-gbrain-pglite: all checks passed"
