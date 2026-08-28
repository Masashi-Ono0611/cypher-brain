#!/usr/bin/env bash
# selftest: $CYPHER_BRAIN_HOME/config.env (#286).
#
# Every assertion here was written to FAIL before the feature existed. The ones that
# matter most are not "a value from the file is used" but the three that decide whether
# the design holds:
#
#   (c) an explicit environment variable still WINS over the file — the precedence comes
#       from Node's own loader, and a regression there would silently override what an
#       operator typed on the command line;
#   (f) an unknown CYPHER_BRAIN_* key is REFUSED through the normal error path, on BOTH
#       entry points — a module-body throw would escape cli.ts's main().catch and print a
#       raw stack trace, and an unchecked mcp.ts would serve as if nothing were wrong;
#   (g) `schedule install` still bakes file-derived values into the runner — the property
#       that lets the file exist without changing what an unattended run does.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/dist/cli.mjs"
MCP="$ROOT/dist/mcp.mjs"
[ -f "$CLI" ] || { echo "[FAIL] $CLI missing — run npm run build first"; exit 1; }

TMP="$(mktemp -d)"
trap 'chmod -R u+rwX "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

SRC="$TMP/src"; mkdir -p "$SRC"; printf 'hello\n' > "$SRC/a.md"

# with_timeout: the MCP drive below must FAIL LOUDLY within a bounded time rather than
# hang the suite if the startup guard ever regresses. GNU `timeout` is NOT available on
# macOS (this test passed locally and failed on macos-latest CI for exactly that reason),
# so use the same helper scripts/selftest-init.sh and scripts/selftest-storage.sh already
# carry — each selftest here is standalone, so it is copied rather than shared.
with_timeout() {
  local s=$1; shift
  ( set -m; "$@" ) & local c=$!
  ( sleep "$s"; kill -9 -- "-$c" 2>/dev/null || kill -9 "$c" 2>/dev/null ) >/dev/null 2>&1 & local w=$!
  wait "$c" 2>/dev/null; local rc=$?
  kill -9 "$w" 2>/dev/null; wait "$w" 2>/dev/null
  return $rc
}

# Each case gets its own CYPHER_BRAIN_HOME so a bad config in one cannot leak into another.
new_home() { local h="$TMP/$1"; mkdir -p "$h"; printf '%s' "$h"; }
write_cfg() { printf '%s\n' "${@:2}" > "$1/config.env"; chmod 600 "$1/config.env"; }

echo "== (a) no config file at all is the normal case, not an error =="
H="$(new_home none)"
CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1 \
  || { echo "[FAIL] a missing config file broke the CLI"; exit 1; }
echo "[PASS] a missing config.env is not an error"

echo "== (b) a value in the file is applied =="
H="$(new_home applied)"; STORE="$TMP/store-from-file"
write_cfg "$H" "CYPHER_BRAIN_FILE_DIR=$STORE"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
node "$CLI" snapshot --dir "$SRC" --out "$TMP/s.age" >/dev/null 2>&1
LOC="$(node "$CLI" push --in "$TMP/s.age" --backend file 2>/dev/null | grep '\.age$')"
case "$LOC" in
  "$STORE"/*) echo "[PASS] the file's CYPHER_BRAIN_FILE_DIR was used ($LOC)" ;;
  *) echo "[FAIL] the file's CYPHER_BRAIN_FILE_DIR was ignored — locator=$LOC, expected under $STORE"; exit 1 ;;
esac

echo "== (c) an explicit environment variable WINS over the file =="
ENVSTORE="$TMP/store-from-env"
LOC="$(CYPHER_BRAIN_FILE_DIR="$ENVSTORE" node "$CLI" push --in "$TMP/s.age" --backend file --force 2>/dev/null | grep '\.age$')"
case "$LOC" in
  "$ENVSTORE"/*) echo "[PASS] env beat the file ($LOC)" ;;
  *) echo "[FAIL] the file overrode an explicit env var — locator=$LOC, expected under $ENVSTORE"; exit 1 ;;
esac

echo "== (d) CYPHER_BRAIN_HOME in the file is ignored, and says so =="
H="$(new_home selfhome)"
write_cfg "$H" "CYPHER_BRAIN_HOME=/somewhere/else"
OUT="$(CYPHER_BRAIN_HOME="$H" node "$CLI" --version 2>&1 >/dev/null)"
printf '%s' "$OUT" | grep -q 'sets CYPHER_BRAIN_HOME, which is ignored' \
  || { echo "[FAIL] no warning for CYPHER_BRAIN_HOME in the file: $OUT"; exit 1; }
CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1 \
  || { echo "[FAIL] CYPHER_BRAIN_HOME in the file was fatal; it should warn and continue"; exit 1; }
echo "[PASS] CYPHER_BRAIN_HOME in the file warns and is ignored"

echo "== (e) a group-readable config file warns but still works =="
H="$(new_home loose)"
write_cfg "$H" "CYPHER_BRAIN_AR_HOST=example.invalid"
chmod 644 "$H/config.env"
OUT="$(CYPHER_BRAIN_HOME="$H" node "$CLI" --version 2>&1 >/dev/null)"
printf '%s' "$OUT" | grep -q 'group/other-accessible' \
  || { echo "[FAIL] no loose-permission warning for the config file: $OUT"; exit 1; }
CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1 \
  || { echo "[FAIL] a group-readable config file was fatal; it should warn and continue"; exit 1; }
echo "[PASS] a group-readable config file warns without refusing"

echo "== (f) an unknown CYPHER_BRAIN_* key is refused, through the NORMAL error path =="
H="$(new_home unknown)"
write_cfg "$H" "CYPHER_BRAIN_MAXSPEND=1"
if CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1; then
  echo "[FAIL] an unknown CYPHER_BRAIN_* key was accepted"; exit 1
fi
OUT="$(CYPHER_BRAIN_HOME="$H" node "$CLI" --version 2>&1 >/dev/null || true)"
printf '%s' "$OUT" | grep -q '^error: config file .*unknown setting' \
  || { echo "[FAIL] the refusal did not use the CLI's 'error: …' form (a module-body throw would print a stack trace): $OUT"; exit 1; }
printf '%s' "$OUT" | grep -q 'CYPHER_BRAIN_MAXSPEND' \
  || { echo "[FAIL] the refusal did not name the offending key: $OUT"; exit 1; }
printf '%s' "$OUT" | grep -qi 'at loadConfigFile\|^\s*at ' \
  && { echo "[FAIL] the refusal printed a stack trace instead of a clean error: $OUT"; exit 1; }
# ...and --json still yields a parseable error object (#270), not a crash
JSON="$(CYPHER_BRAIN_HOME="$H" node "$CLI" estimate --in "$TMP/s.age" --backend file --json 2>/dev/null || true)"
printf '%s' "$JSON" | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const o=JSON.parse(s); if(typeof o.error!=="string"||o.exit_code!==1) throw new Error("bad error object: "+s);
  });' || { echo "[FAIL] --json did not produce a well-formed error object for a bad config file"; exit 1; }
# ...and the MCP server refuses to serve rather than starting up as if unconfigured
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' > "$TMP/mcp-init.jsonl"
CYPHER_BRAIN_HOME="$H" with_timeout 20 node "$MCP" < "$TMP/mcp-init.jsonl" > /dev/null 2> "$TMP/mcp.err" || true
MOUT="$(cat "$TMP/mcp.err")"
printf '%s' "$MOUT" | grep -q 'unknown setting' \
  || { echo "[FAIL] the MCP server started despite a config file it could not accept: $MOUT"; exit 1; }
echo "[PASS] an unknown key is refused on the CLI (error: + --json) and by the MCP server"

echo "== (f2) a key outside the CYPHER_BRAIN_ namespace is left alone =="
H="$(new_home foreign)"
write_cfg "$H" "EDITOR=vim" "CYPHER_BRAIN_AR_HOST=example.invalid"
CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1 \
  || { echo "[FAIL] a non-CYPHER_BRAIN_ key in the file was rejected; the file is not ours to police"; exit 1; }
echo "[PASS] a foreign key is neither rejected nor our business"

echo "== (g) schedule install BAKES a file-derived value into the runner =="
H="$(new_home baked)"; BAKESTORE="$TMP/store-baked"
write_cfg "$H" "CYPHER_BRAIN_FILE_DIR=$BAKESTORE" "CYPHER_BRAIN_SCHEDULE_DIR=$H/sched" "CYPHER_BRAIN_LAUNCHD_DIR=$H/agents"
mkdir -p "$H/agents"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
node "$CLI" schedule install --dir "$SRC" --backend file --no-load >/dev/null 2>&1 \
  || { echo "[FAIL] schedule install failed with a config file present"; exit 1; }
grep -q "export CYPHER_BRAIN_FILE_DIR='$BAKESTORE'" "$H/sched/nightly.sh" \
  || { echo "[FAIL] the runner did not bake the file-derived CYPHER_BRAIN_FILE_DIR"; sed -n '1,40p' "$H/sched/nightly.sh"; exit 1; }
echo "[PASS] a value that came from the config file is baked into the runner like any other"

echo "== (g2) a FOREIGN key in the file is not applied to the environment at all =="
# The docs say keys outside the CYPHER_BRAIN_ namespace are ignored. They were not:
# an earlier version handed the whole file to process.loadEnvFile(), so a stray TMPDIR
# or proxy variable reached every child process we spawn (multi-model review finding).
# TMPDIR is the observable — `schedule install` bakes it into the runner when set, so if
# the file's value had been applied it would appear there.
H="$(new_home foreignenv)"
write_cfg "$H" "TMPDIR=$TMP/foreign-tmp" "CYPHER_BRAIN_FILE_DIR=$TMP/store-fk" "CYPHER_BRAIN_SCHEDULE_DIR=$H/sched" "CYPHER_BRAIN_LAUNCHD_DIR=$H/agents"
mkdir -p "$H/agents"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
node "$CLI" schedule install --dir "$SRC" --backend file --no-load >/dev/null 2>&1 \
  || { echo "[FAIL] schedule install failed with a foreign key in the config file"; exit 1; }
if grep -q "export TMPDIR='$TMP/foreign-tmp'" "$H/sched/nightly.sh"; then
  echo "[FAIL] a foreign key (TMPDIR) from the config file was applied to the environment"; exit 1
fi
echo "[PASS] a foreign key is parsed, reported as not ours, and never applied"

echo "== (g3) an installed schedule does NOT re-read the config file =="
# The runner bakes install-time values, so it must also pin itself against the file:
# otherwise editing config.env would retune an installed schedule, and an unknown key
# in it would STOP the schedule — both contradicting what --help and MANAGEMENT.md say.
grep -q '^export CYPHER_BRAIN_NO_CONFIG_FILE=1$' "$H/sched/nightly.sh" \
  || { echo "[FAIL] the runner does not pin itself against \$CYPHER_BRAIN_HOME/config.env"; exit 1; }
write_cfg "$H" "CYPHER_BRAIN_TOTALLY_BOGUS=1"   # would refuse every normal invocation
CYPHER_BRAIN_NO_CONFIG_FILE=1 node "$CLI" --version >/dev/null 2>&1 \
  || { echo "[FAIL] a runner-style invocation was broken by an unrelated edit to config.env"; exit 1; }
node "$CLI" --version >/dev/null 2>&1 \
  && { echo "[FAIL] the same bogus file was accepted for a NORMAL invocation"; exit 1; }
echo "[PASS] the runner is immune to later edits of config.env; normal invocations are not"

echo "== (h) schedule status names the file it loaded =="
H="$(new_home statusrep)"
write_cfg "$H" "CYPHER_BRAIN_FILE_DIR=$TMP/store-status" "CYPHER_BRAIN_SCHEDULE_DIR=$H/sched" "CYPHER_BRAIN_LAUNCHD_DIR=$H/agents"
mkdir -p "$H/agents"; export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
node "$CLI" schedule install --dir "$SRC" --backend file --no-load >/dev/null 2>&1
node "$CLI" schedule status 2>/dev/null | grep -q "config file: $H/config.env" \
  || { echo "[FAIL] schedule status did not report the loaded config file"; exit 1; }
node "$CLI" schedule status --json 2>/dev/null | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const o=JSON.parse(s);
    if(!o.config_file || !o.config_file.path) throw new Error("no config_file in --json: "+s);
    if(!Array.isArray(o.config_file.variables) || !o.config_file.variables.includes("CYPHER_BRAIN_FILE_DIR"))
      throw new Error("config_file.variables did not list the settings: "+s);
  });' || { echo "[FAIL] schedule status --json did not report the config file"; exit 1; }
echo "[PASS] schedule status reports the config file, human-readable and in --json"

echo "== (i) legacy CIPHER_BRAIN_* names (pre-rename) keep working =="
# The project was renamed cipher-brain -> cypher-brain. Every setting is still read under
# its old spelling; the new one wins when both are set. Each case below FAILS if the
# fallback is removed, so this is the positive control for that compatibility layer.

echo "-- (i1) CIPHER_BRAIN_HOME alone selects the home --"
LH="$(new_home legacyhome)"
env -u CYPHER_BRAIN_HOME CIPHER_BRAIN_HOME="$LH" node "$CLI" keygen >/dev/null 2>&1 \
  || { echo "[FAIL] keygen failed under CIPHER_BRAIN_HOME"; exit 1; }
[ -f "$LH/identity.age" ] || { echo "[FAIL] CIPHER_BRAIN_HOME was not honoured — no identity under $LH"; ls -la "$LH"; exit 1; }
echo "[PASS] CIPHER_BRAIN_HOME (legacy) selects the home"

echo "-- (i2) CYPHER_BRAIN_HOME wins when both spellings are set --"
NH="$(new_home newhome)"; OH="$(new_home oldhome)"
env CYPHER_BRAIN_HOME="$NH" CIPHER_BRAIN_HOME="$OH" node "$CLI" keygen >/dev/null 2>&1
[ -f "$NH/identity.age" ] || { echo "[FAIL] CYPHER_BRAIN_HOME did not win over CIPHER_BRAIN_HOME"; exit 1; }
[ -f "$OH/identity.age" ] && { echo "[FAIL] the legacy home was written although the canonical one was set"; exit 1; }
echo "[PASS] canonical spelling beats legacy when both are set"

echo "-- (i3) a legacy-spelled key in config.env is applied --"
H="$(new_home legacyfile)"; LSTORE="$TMP/store-legacy-file"
write_cfg "$H" "CIPHER_BRAIN_FILE_DIR=$LSTORE"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
node "$CLI" snapshot --dir "$SRC" --out "$TMP/l.age" >/dev/null 2>&1
LOC="$(node "$CLI" push --in "$TMP/l.age" --backend file 2>/dev/null | grep '\.age$')"
case "$LOC" in
  "$LSTORE"/*) echo "[PASS] CIPHER_BRAIN_FILE_DIR from the file was applied ($LOC)" ;;
  *) echo "[FAIL] a legacy-spelled key in config.env was ignored — locator=$LOC, expected under $LSTORE"; exit 1 ;;
esac

echo "-- (i4) a legacy-spelled env var still WINS over a canonical key in the file --"
H="$(new_home legacyenvwins)"; FSTORE="$TMP/store-file-c"; ESTORE="$TMP/store-env-l"
write_cfg "$H" "CYPHER_BRAIN_FILE_DIR=$FSTORE"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
LOC="$(CIPHER_BRAIN_FILE_DIR="$ESTORE" node "$CLI" push --in "$TMP/l.age" --backend file 2>/dev/null | grep '\.age$')"
case "$LOC" in
  "$ESTORE"/*) echo "[PASS] legacy env beat the file's canonical key ($LOC)" ;;
  *) echo "[FAIL] the file's CYPHER_BRAIN_FILE_DIR overrode an explicit CIPHER_BRAIN_FILE_DIR — locator=$LOC, expected under $ESTORE"; exit 1 ;;
esac

echo "-- (i5) the same setting spelled BOTH ways in one file is refused --"
H="$(new_home bothspellings)"
write_cfg "$H" "CYPHER_BRAIN_AR_HOST=a.invalid" "CIPHER_BRAIN_AR_HOST=b.invalid"
if CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1; then
  echo "[FAIL] a file naming the same setting under both spellings was accepted"; exit 1
fi
OUT="$(CYPHER_BRAIN_HOME="$H" node "$CLI" --version 2>&1 >/dev/null || true)"
printf '%s' "$OUT" | grep -q 'spelled two ways' \
  || { echo "[FAIL] the refusal did not explain the two-spellings conflict: $OUT"; exit 1; }
echo "[PASS] a two-spellings conflict is refused with a clear message"

echo "-- (i6) an unknown key is still refused under the legacy prefix --"
H="$(new_home legacyunknown)"
write_cfg "$H" "CIPHER_BRAIN_MAXSPEND=1"
if CYPHER_BRAIN_HOME="$H" node "$CLI" --version >/dev/null 2>&1; then
  echo "[FAIL] an unknown CIPHER_BRAIN_* key was accepted"; exit 1
fi
echo "[PASS] a typo under the legacy prefix is refused too"

echo "-- (i7) schedule install captures a legacy-spelled env var and bakes it under the canonical name --"
H="$(new_home legacycapture)"; CSTORE="$TMP/store-captured"
write_cfg "$H" "CYPHER_BRAIN_SCHEDULE_DIR=$H/sched" "CYPHER_BRAIN_LAUNCHD_DIR=$H/agents"
mkdir -p "$H/agents"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
CIPHER_BRAIN_FILE_DIR="$CSTORE" node "$CLI" schedule install --dir "$SRC" --backend file --no-load >/dev/null 2>&1 \
  || { echo "[FAIL] schedule install failed with a legacy-spelled env var"; exit 1; }
grep -q "export CYPHER_BRAIN_FILE_DIR='$CSTORE'" "$H/sched/nightly.sh" \
  || { echo "[FAIL] the runner did not capture CIPHER_BRAIN_FILE_DIR (legacy) as CYPHER_BRAIN_FILE_DIR"; sed -n '1,40p' "$H/sched/nightly.sh"; exit 1; }
echo "[PASS] a legacy-spelled env var is captured and baked under the canonical name"

echo "-- (i8) default home: an existing ~/.cipher-brain is used until ~/.cypher-brain exists --"
FH="$TMP/fakehome"; mkdir -p "$FH/.cipher-brain"; chmod 700 "$FH/.cipher-brain"
env -u CYPHER_BRAIN_HOME -u CIPHER_BRAIN_HOME HOME="$FH" node "$CLI" keygen >/dev/null 2>&1 \
  || { echo "[FAIL] keygen failed with only a legacy default home present"; exit 1; }
[ -f "$FH/.cipher-brain/identity.age" ] || { echo "[FAIL] the legacy default home ~/.cipher-brain was not used"; ls -la "$FH"; exit 1; }
[ -e "$FH/.cypher-brain" ] && { echo "[FAIL] ~/.cypher-brain was created although ~/.cipher-brain existed"; exit 1; }
mkdir -p "$FH/.cypher-brain"; chmod 700 "$FH/.cypher-brain"
env -u CYPHER_BRAIN_HOME -u CIPHER_BRAIN_HOME HOME="$FH" node "$CLI" keygen >/dev/null 2>&1 \
  || { echo "[FAIL] keygen failed once ~/.cypher-brain existed"; exit 1; }
[ -f "$FH/.cypher-brain/identity.age" ] || { echo "[FAIL] ~/.cypher-brain was not preferred once it existed"; ls -la "$FH/.cypher-brain"; exit 1; }
echo "[PASS] default home falls back to ~/.cipher-brain only while ~/.cypher-brain is absent"

echo "-- (i9) a generic setting: canonical env beats legacy env, and legacy env beats a canonical file key --"
H="$(new_home genericprec)"; CST="$TMP/store-canon-env"; LST="$TMP/store-legacy-env"
write_cfg "$H" "CYPHER_BRAIN_FILE_DIR=$TMP/store-file-generic"
export CYPHER_BRAIN_HOME="$H"
node "$CLI" keygen >/dev/null 2>&1
LOC="$(CYPHER_BRAIN_FILE_DIR="$CST" CIPHER_BRAIN_FILE_DIR="$LST" node "$CLI" push --in "$TMP/l.age" --backend file 2>/dev/null | grep '\.age$')"
case "$LOC" in
  "$CST"/*) echo "[PASS] CYPHER_BRAIN_FILE_DIR beat CIPHER_BRAIN_FILE_DIR ($LOC)" ;;
  *) echo "[FAIL] with both spellings in the env the canonical one did not win — locator=$LOC, expected under $CST"; exit 1 ;;
esac

echo "-- (i10) config.env is found and applied when the home comes from legacy CIPHER_BRAIN_HOME --"
LH2="$(new_home legacyhome2)"; LST2="$TMP/store-via-legacy-home"
write_cfg "$LH2" "CYPHER_BRAIN_FILE_DIR=$LST2"
env -u CYPHER_BRAIN_HOME CIPHER_BRAIN_HOME="$LH2" node "$CLI" keygen >/dev/null 2>&1
LOC="$(env -u CYPHER_BRAIN_HOME CIPHER_BRAIN_HOME="$LH2" node "$CLI" push --in "$TMP/l.age" --backend file 2>/dev/null | grep '\.age$')"
case "$LOC" in
  "$LST2"/*) echo "[PASS] config.env under a CIPHER_BRAIN_HOME-selected home is loaded ($LOC)" ;;
  *) echo "[FAIL] config.env was not loaded from a home selected via CIPHER_BRAIN_HOME — locator=$LOC, expected under $LST2"; exit 1 ;;
esac

echo "CONFIG FILE SELFTEST: PASS"
