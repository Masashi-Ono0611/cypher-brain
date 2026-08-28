#!/usr/bin/env bash
# Real-data round-trip proof for the cipher layer (issue #1), operator-run on the
# machine that holds gbrain. Dumps ONE live table, encrypts -> verifies ->
# decrypts -> restores into a throwaway scratch DB, then asserts the row count and
# a content checksum match the source exactly. The scratch DB is dropped at the
# end. Reads/writes only the table and scratch DB you point it at.
#
# Config (env):
#   CB_PG_URL      source gbrain connection (required), e.g. postgres://you@localhost:5432/gbrain
#   CB_TABLE       table to round-trip (default: dream_verdicts) — pick a small, FK-free one
#   CB_SCRATCH_DB  scratch db name (default: gbrain_cipher_test)
#   CYPHER_BRAIN_PG_BIN   if the pg client tools are not on PATH (age is bundled in-process)
set -euo pipefail

: "${CB_PG_URL:?set CB_PG_URL to your gbrain connection string}"
TBL="${CB_TABLE:-dream_verdicts}"
SCRATCH_DB="${CB_SCRATCH_DB:-gbrain_cipher_test}"
PG_BIN="${CYPHER_BRAIN_PG_BIN:-}"
PSQL="${PG_BIN:+$PG_BIN/}psql"
psql() { command "$PSQL" "$@"; }   # `command` bypasses this function -> runs the real binary

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$ROOT/bin/cypher-brain.mjs"
WORK="$(mktemp -d)"
export CYPHER_BRAIN_HOME="$WORK/keys"
# Replace only the path component (the db name after the last '/' before any
# '?query' or '#fragment') so a CB_PG_URL carrying standard Postgres URL params
# (sslmode, channel_binding, etc. -- common on managed Postgres/Supabase/RDS)
# keeps them on the derived scratch URL. A naive "${CB_PG_URL%/*}" strip drops
# everything after the last '/', including the query string (#618).
SCRATCH_URL="$(python3 -c "
import sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(sys.argv[1])
print(urlunsplit((u.scheme, u.netloc, '/' + sys.argv[2], u.query, u.fragment)))
" "$CB_PG_URL" "$SCRATCH_DB")"
# always tidy up: remove the work dir AND drop the scratch db even if a step fails mid-run
trap 'rm -rf "$WORK"; psql "$CB_PG_URL" -c "drop database if exists $SCRATCH_DB;" >/dev/null 2>&1 || true' EXIT

echo "== keygen =="
node "$CLI" keygen >/dev/null

echo "== baseline (live table: $TBL) =="
SRC_COUNT=$(psql "$CB_PG_URL" -At -c "select count(*) from $TBL;")
SRC_SUM=$(psql "$CB_PG_URL" -At -c "select md5(coalesce(string_agg(t::text, '' order by t::text),'')) from $TBL t;")
echo "source: count=$SRC_COUNT checksum=$SRC_SUM"

echo "== snapshot -> verify =="
node "$CLI" snapshot --pg "$CB_PG_URL" --pg-table "$TBL" --out "$WORK/snap.age"
node "$CLI" verify --in "$WORK/snap.age"

echo "== scratch db =="
psql "$CB_PG_URL" -c "drop database if exists $SCRATCH_DB;" >/dev/null
psql "$CB_PG_URL" -c "create database $SCRATCH_DB;" >/dev/null
psql "$SCRATCH_URL" -c "create extension if not exists vector;"  >/dev/null 2>&1 || true
psql "$SCRATCH_URL" -c "create extension if not exists pg_trgm;" >/dev/null 2>&1 || true

echo "== restore -> compare =="
node "$CLI" restore --in "$WORK/snap.age" --out-dir "$WORK/out" --pg "$SCRATCH_URL" --yes >/dev/null
DST_COUNT=$(psql "$SCRATCH_URL" -At -c "select count(*) from $TBL;")
DST_SUM=$(psql "$SCRATCH_URL" -At -c "select md5(coalesce(string_agg(t::text, '' order by t::text),'')) from $TBL t;")
echo "restored: count=$DST_COUNT checksum=$DST_SUM"
psql "$CB_PG_URL" -c "drop database if exists $SCRATCH_DB;" >/dev/null

PASS=1
[ "$SRC_COUNT" = "$DST_COUNT" ] && echo "[PASS] row count ($SRC_COUNT)" || { echo "[FAIL] count $SRC_COUNT != $DST_COUNT"; PASS=0; }
[ "$SRC_SUM" = "$DST_SUM" ]     && echo "[PASS] content checksum identical" || { echo "[FAIL] checksum mismatch"; PASS=0; }
[ "$PASS" = 1 ] && { echo; echo "REAL-DATA ROUND-TRIP PASS"; } || { echo; echo "REAL-DATA ROUND-TRIP FAIL"; exit 1; }
