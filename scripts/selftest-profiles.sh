#!/usr/bin/env bash
# Round-trip proof for --profile source presets (issue #67, #206). The four product
# entry points (claude-code / obsidian / chatgpt-export / o2b) must resolve to the
# right paths, compose with extra --dir flags, record the profile name in the
# manifest, and fail loudly (non-zero + a clear error) when their inputs are
# missing. Everything runs on synthetic fixtures under a fake $HOME — no real
# user data is read, no Postgres, no network.
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

# synthetic Claude Code home: two projects WITH memory/, one without, + CLAUDE.md
FAKEHOME="$TMP/home"
mkdir -p "$FAKEHOME/.claude/projects/proj-a/memory" \
         "$FAKEHOME/.claude/projects/proj-b/memory" \
         "$FAKEHOME/.claude/projects/no-memory-proj"
printf 'alpha memory\n' > "$FAKEHOME/.claude/projects/proj-a/memory/MEMORY.md"
printf 'beta memory\n'  > "$FAKEHOME/.claude/projects/proj-b/memory/notes.md"
printf 'global instructions\n' > "$FAKEHOME/.claude/CLAUDE.md"

echo "== profile claude-code: picks up 2 memory dirs + CLAUDE.md and round-trips =="
# homedir() honors \$HOME, so the profile reads the synthetic home, not the real one
HOME="$FAKEHOME" cb snapshot --profile claude-code --out "$TMP/cc.age" > "$TMP/cc.log" 2>&1 \
  || { echo "[FAIL] claude-code snapshot failed"; cat "$TMP/cc.log"; exit 1; }
cb restore --in "$TMP/cc.age" --out-dir "$TMP/cc-out" >/dev/null
grep -q '"profile": "claude-code"' "$TMP/cc-out/manifest.json" \
  || { echo "[FAIL] manifest lacks profile claude-code"; cat "$TMP/cc-out/manifest.json"; exit 1; }
N=$(ls "$TMP/cc-out"/*.tar.gz 2>/dev/null | wc -l | tr -d ' ')
[ "$N" = "3" ] || { echo "[FAIL] expected 3 components (memory x2 + CLAUDE.md), got $N"; exit 1; }
# Full-content diffing, not substring grep (Codex review): a substring match (the prior
# version of this check) cannot tell a truncated/corrupted restore apart from a correct
# one — it would still pass if, say, only half of proj-a's memory dir survived, as long
# as the one marker line happened to be in the surviving half. Uses restore's own
# expanded/ tree (the "<3-digit index>-<label>-<64-hex digest>" naming scheme #181/#423
# documents — see scripts/selftest-properties.mjs's own header comment) to diff each
# restored component byte-for-byte against the REAL source it was archived from — the
# same bar the obsidian/chatgpt-export/o2b profile checks below already hold themselves
# to with diff -r / sha256. Globbed by the documented NAME SHAPE, not the exact digest
# value (independently recomputing that here would just re-implement sourceDigest(),
# which is properties.mjs's own job to verify). Index order (001=proj-a, 002=proj-b,
# 003=CLAUDE.md) is not incidental to this one run — claudeCodePaths() (profiles.ts)
# sorts project dirs by name before appending CLAUDE.md last, always.
EXPANDED_A=$(ls -d "$TMP/cc-out/expanded/001-memory-"*/ 2>/dev/null | head -1)
EXPANDED_B=$(ls -d "$TMP/cc-out/expanded/002-memory-"*/ 2>/dev/null | head -1)
EXPANDED_CLAUDE=$(ls -d "$TMP/cc-out/expanded/003-CLAUDE.md-"*/ 2>/dev/null | head -1)
[ -n "$EXPANDED_A" ] || { echo "[FAIL] restore's expanded/ tree is missing the 001-memory-* dir for proj-a"; ls "$TMP/cc-out/expanded"; exit 1; }
[ -n "$EXPANDED_B" ] || { echo "[FAIL] restore's expanded/ tree is missing the 002-memory-* dir for proj-b"; ls "$TMP/cc-out/expanded"; exit 1; }
[ -n "$EXPANDED_CLAUDE" ] || { echo "[FAIL] restore's expanded/ tree is missing the 003-CLAUDE.md-* dir"; ls "$TMP/cc-out/expanded"; exit 1; }
diff -r "$FAKEHOME/.claude/projects/proj-a/memory" "${EXPANDED_A}memory" \
  || { echo "[FAIL] restored proj-a memory differs from the source"; exit 1; }
diff -r "$FAKEHOME/.claude/projects/proj-b/memory" "${EXPANDED_B}memory" \
  || { echo "[FAIL] restored proj-b memory differs from the source"; exit 1; }
diff "$FAKEHOME/.claude/CLAUDE.md" "${EXPANDED_CLAUDE}CLAUDE.md" \
  || { echo "[FAIL] restored CLAUDE.md differs from the source"; exit 1; }
echo "[PASS] claude-code profile round-trips 2 project memory dirs + CLAUDE.md byte-for-byte (3 components)"

echo "== profile claude-code composes with --dir (extra dirs appended after) =="
EXTRA="$TMP/extra"; mkdir -p "$EXTRA"; printf 'extra stuff\n' > "$EXTRA/e.txt"
HOME="$FAKEHOME" cb snapshot --profile claude-code --dir "$EXTRA" --out "$TMP/mix.age" >/dev/null 2>&1
cb restore --in "$TMP/mix.age" --out-dir "$TMP/mix-out" >/dev/null
MIXN=$(ls "$TMP/mix-out"/*.tar.gz | wc -l | tr -d ' ')
[ "$MIXN" = "4" ] || { echo "[FAIL] profile + --dir expected 4 components, got $MIXN"; exit 1; }
# --dir paths are appended AFTER the profile's paths: the LAST component is the extra dir
LASTNAME=$(grep '"name"' "$TMP/mix-out/manifest.json" | tail -1)
printf '%s' "$LASTNAME" | grep -q 'extra.tar.gz' \
  || { echo "[FAIL] extra --dir is not the last component"; cat "$TMP/mix-out/manifest.json"; exit 1; }
echo "[PASS] --profile + --dir compose (profile paths first, extra dir appended)"

echo "== profile claude-code with an empty home fails with a clear error =="
EMPTYHOME="$TMP/emptyhome"; mkdir -p "$EMPTYHOME"
set +e
ERR=$(HOME="$EMPTYHOME" cb snapshot --profile claude-code --out "$TMP/cc-empty.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] empty-home claude-code snapshot exited 0"; exit 1; }
printf '%s' "$ERR" | grep -q "found nothing to snapshot" \
  || { echo "[FAIL] empty-profile error is unclear"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q "CLAUDE.md" \
  || { echo "[FAIL] empty-profile error does not list what it looked for"; echo "$ERR"; exit 1; }
test ! -f "$TMP/cc-empty.age" || { echo "[FAIL] refused profile snapshot still wrote output"; exit 1; }
echo "[PASS] empty claude-code profile fails non-zero, listing what it looked for"

echo "== profile obsidian: vault (with .obsidian/) round-trips byte-identical =="
VAULT="$TMP/vault"
mkdir -p "$VAULT/.obsidian" "$VAULT/daily"
printf '{}\n' > "$VAULT/.obsidian/app.json"
printf 'vault note\n' > "$VAULT/daily/note.md"
cb snapshot --profile obsidian --vault "$VAULT" --out "$TMP/ob.age" >/dev/null 2>&1
cb restore --in "$TMP/ob.age" --out-dir "$TMP/ob-out" >/dev/null
grep -q '"profile": "obsidian"' "$TMP/ob-out/manifest.json" \
  || { echo "[FAIL] manifest lacks profile obsidian"; exit 1; }
tar -xzf "$TMP/ob-out/vault.tar.gz" -C "$TMP/ob-out"
diff -r "$VAULT" "$TMP/ob-out/vault" || { echo "[FAIL] restored vault differs from source"; exit 1; }
echo "[PASS] obsidian vault round-trips byte-identical (manifest records the profile)"

echo "== profile obsidian: a dir without .obsidian/ is refused unless --force-vault =="
NOTVAULT="$TMP/notavault"; mkdir -p "$NOTVAULT"; printf 'x\n' > "$NOTVAULT/note.md"
set +e
ERR=$(cb snapshot --profile obsidian --vault "$NOTVAULT" --out "$TMP/nv.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] non-vault dir was accepted without --force-vault"; exit 1; }
printf '%s' "$ERR" | grep -q "does not look like an Obsidian vault" \
  || { echo "[FAIL] non-vault refusal lacks a clear error"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--force-vault" \
  || { echo "[FAIL] non-vault refusal does not mention --force-vault"; echo "$ERR"; exit 1; }
test ! -f "$TMP/nv.age" || { echo "[FAIL] refused vault snapshot still wrote output"; exit 1; }
cb snapshot --profile obsidian --vault "$NOTVAULT" --force-vault --out "$TMP/fv.age" >/dev/null 2>&1 \
  || { echo "[FAIL] --force-vault did not override the vault check"; exit 1; }
test -f "$TMP/fv.age" || { echo "[FAIL] --force-vault snapshot produced no output"; exit 1; }
echo "[PASS] vault check refuses a non-vault dir; --force-vault overrides"

echo "== profile chatgpt-export: the zip round-trips byte-identical (never extracted) =="
ZIP="$TMP/chatgpt-export.zip"
head -c 65536 /dev/urandom > "$ZIP"   # content is opaque to the profile — taken as-is
ZSHA=$(shasum -a 256 "$ZIP" | cut -d' ' -f1)
cb snapshot --profile chatgpt-export --zip "$ZIP" --out "$TMP/gpt.age" >/dev/null 2>&1
cb restore --in "$TMP/gpt.age" --out-dir "$TMP/gpt-out" >/dev/null
grep -q '"profile": "chatgpt-export"' "$TMP/gpt-out/manifest.json" \
  || { echo "[FAIL] manifest lacks profile chatgpt-export"; exit 1; }
grep -q '"kind": "file"' "$TMP/gpt-out/manifest.json" \
  || { echo "[FAIL] zip component is not recorded as kind file"; cat "$TMP/gpt-out/manifest.json"; exit 1; }
tar -xzf "$TMP/gpt-out/chatgpt-export.zip.tar.gz" -C "$TMP/gpt-out"
GSHA=$(shasum -a 256 "$TMP/gpt-out/chatgpt-export.zip" | cut -d' ' -f1)
[ "$ZSHA" = "$GSHA" ] || { echo "[FAIL] restored zip is not byte-identical (expected $ZSHA, got $GSHA)"; exit 1; }
echo "[PASS] chatgpt-export zip round-trips byte-identical as a single file component"

echo "== profile chatgpt-export: a missing / non-.zip path is refused =="
set +e
ERR=$(cb snapshot --profile chatgpt-export --zip "$TMP/does-not-exist.zip" --out "$TMP/gz1.age" 2>&1); RC1=$?
printf 'not a zip\n' > "$TMP/export.tar"
ERR2=$(cb snapshot --profile chatgpt-export --zip "$TMP/export.tar" --out "$TMP/gz2.age" 2>&1); RC2=$?
set -e
[ "$RC1" != "0" ] || { echo "[FAIL] missing zip was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q "no export zip" || { echo "[FAIL] missing-zip error unclear"; echo "$ERR"; exit 1; }
[ "$RC2" != "0" ] || { echo "[FAIL] non-.zip path was accepted"; exit 1; }
printf '%s' "$ERR2" | grep -q "does not end in .zip" || { echo "[FAIL] non-zip error unclear"; echo "$ERR2"; exit 1; }
echo "[PASS] chatgpt-export refuses a missing or non-.zip input"

echo "== profile o2b: the bank-export bundle round-trips byte-identical (never extracted) =="
# a synthetic stand-in for "o2b brain bank-export --out <path>.json" — cypher-brain
# archives it as one opaque file, so its internal shape does not matter here, only
# that it is a real, distinct JSON document (issue #206).
BUNDLE="$TMP/bank-export.json"
printf '{"schema":"1","graph":{"nodes":[]},"pages":[],"preferences":[]}\n' > "$BUNDLE"
BSHA=$(shasum -a 256 "$BUNDLE" | cut -d' ' -f1)
cb snapshot --profile o2b --export "$BUNDLE" --out "$TMP/o2b.age" >/dev/null 2>&1
cb restore --in "$TMP/o2b.age" --out-dir "$TMP/o2b-out" >/dev/null
grep -q '"profile": "o2b"' "$TMP/o2b-out/manifest.json" \
  || { echo "[FAIL] manifest lacks profile o2b"; exit 1; }
grep -q '"kind": "file"' "$TMP/o2b-out/manifest.json" \
  || { echo "[FAIL] bundle component is not recorded as kind file"; cat "$TMP/o2b-out/manifest.json"; exit 1; }
tar -xzf "$TMP/o2b-out/bank-export.json.tar.gz" -C "$TMP/o2b-out"
OSHA=$(shasum -a 256 "$TMP/o2b-out/bank-export.json" | cut -d' ' -f1)
[ "$BSHA" = "$OSHA" ] || { echo "[FAIL] restored bundle is not byte-identical (expected $BSHA, got $OSHA)"; exit 1; }
echo "[PASS] o2b bank-export bundle round-trips byte-identical as a single file component"

echo "== profile o2b: a missing / non-.json path is refused =="
set +e
ERR=$(cb snapshot --profile o2b --export "$TMP/does-not-exist.json" --out "$TMP/o2b1.age" 2>&1); RC1=$?
printf 'not json\n' > "$TMP/bank-export.txt"
ERR2=$(cb snapshot --profile o2b --export "$TMP/bank-export.txt" --out "$TMP/o2b2.age" 2>&1); RC2=$?
set -e
[ "$RC1" != "0" ] || { echo "[FAIL] missing bundle was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q "no bank-export bundle" || { echo "[FAIL] missing-bundle error unclear"; echo "$ERR"; exit 1; }
[ "$RC2" != "0" ] || { echo "[FAIL] non-.json path was accepted"; exit 1; }
printf '%s' "$ERR2" | grep -q "does not end in .json" || { echo "[FAIL] non-json error unclear"; echo "$ERR2"; exit 1; }
echo "[PASS] o2b refuses a missing or non-.json input"

echo "== profile o2b requires --export =="
set +e
ERR=$(cb snapshot --profile o2b --out "$TMP/o2b-noexport.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] o2b without --export was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--export" || { echo "[FAIL] missing-export error does not mention --export"; echo "$ERR"; exit 1; }
echo "[PASS] o2b refuses to run without --export"

echo "== --export without --profile o2b is refused, not silently dropped (multi-model review, PR #334) =="
# Before this check, --export (a recognized VALUE_FLAG, src/cli.ts) with no --profile —
# or the wrong --profile — parsed fine and was then never read: resolveProfilePaths()
# only runs `if (o.profile)` (snapshot.ts), so the snapshot below would have exited 0
# having archived $EXTRA alone, silently omitting the bundle the caller asked for.
set +e
ERR=$(cb snapshot --dir "$EXTRA" --export "$BUNDLE" --out "$TMP/export-noprofile.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --export with no --profile at all was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--export" || { echo "[FAIL] no-profile --export refusal does not mention --export"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--profile o2b" || { echo "[FAIL] no-profile --export refusal does not mention --profile o2b"; echo "$ERR"; exit 1; }
test ! -f "$TMP/export-noprofile.age" || { echo "[FAIL] refused snapshot still wrote output"; exit 1; }
# Same silent-drop shape with a DIFFERENT profile selected: obsidian's o2bPaths() is
# never even reached, so --export just sat there unread.
set +e
ERR2=$(cb snapshot --profile obsidian --vault "$VAULT" --export "$BUNDLE" --out "$TMP/export-wrongprofile.age" 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] --export with --profile obsidian was accepted"; exit 1; }
printf '%s' "$ERR2" | grep -q "obsidian" || { echo "[FAIL] wrong-profile --export refusal does not name the mismatched profile"; echo "$ERR2"; exit 1; }
test ! -f "$TMP/export-wrongprofile.age" || { echo "[FAIL] refused snapshot (wrong profile) still wrote output"; exit 1; }
echo "[PASS] --export without --profile o2b (absent or mismatched) is refused before anything is staged"

echo "== --vault without --profile obsidian is refused, not silently dropped (issue #525) =="
# Same bug class as --export/--profile o2b above: --vault is read ONLY by obsidianPaths(),
# reached ONLY through resolveProfilePaths() `if (o.profile)` — so a --vault given with no
# --profile at all, or the WRONG --profile, used to parse fine and then be silently
# DROPPED: the snapshot below would have exited 0 having archived $EXTRA alone, never
# mentioning $VAULT anywhere in the output or manifest.
set +e
ERR=$(cb snapshot --dir "$EXTRA" --vault "$VAULT" --out "$TMP/vault-noprofile.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --vault with no --profile at all was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--vault" || { echo "[FAIL] no-profile --vault refusal does not mention --vault"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--profile obsidian" || { echo "[FAIL] no-profile --vault refusal does not mention --profile obsidian"; echo "$ERR"; exit 1; }
test ! -f "$TMP/vault-noprofile.age" || { echo "[FAIL] refused snapshot still wrote output"; exit 1; }
# Same silent-drop shape with a DIFFERENT (but valid) profile selected.
set +e
ERR2=$(cb snapshot --profile chatgpt-export --zip "$ZIP" --vault "$VAULT" --out "$TMP/vault-wrongprofile.age" 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] --vault with --profile chatgpt-export was accepted"; exit 1; }
printf '%s' "$ERR2" | grep -q "chatgpt-export" || { echo "[FAIL] wrong-profile --vault refusal does not name the mismatched profile"; echo "$ERR2"; exit 1; }
test ! -f "$TMP/vault-wrongprofile.age" || { echo "[FAIL] refused snapshot (wrong profile) still wrote output"; exit 1; }
echo "[PASS] --vault without --profile obsidian (absent or mismatched) is refused before anything is staged"

echo "== --zip without --profile chatgpt-export is refused, not silently dropped (issue #525) =="
set +e
ERR=$(cb snapshot --dir "$EXTRA" --zip "$ZIP" --out "$TMP/zip-noprofile.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --zip with no --profile at all was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--zip" || { echo "[FAIL] no-profile --zip refusal does not mention --zip"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--profile chatgpt-export" || { echo "[FAIL] no-profile --zip refusal does not mention --profile chatgpt-export"; echo "$ERR"; exit 1; }
test ! -f "$TMP/zip-noprofile.age" || { echo "[FAIL] refused snapshot still wrote output"; exit 1; }
echo "[PASS] --zip without --profile chatgpt-export is refused before anything is staged"

echo "== #535: --profile obsidian + --zip (no --vault) names the irrelevant --zip in the error =="
# obsidianPaths() itself refuses FIRST here (it has its own, more specific "requires
# --vault" check, reached before the generic assertZipRequiresChatgptExportProfile guard
# ever runs — see snapshot.ts's ordering comment) — the note about --zip is appended to
# THAT error, so a confused user learns both facts (missing --vault AND the irrelevant
# --zip) from one message instead of two round trips.
set +e
ERR=$(cb snapshot --profile obsidian --zip "$ZIP" --out "$TMP/ob-535.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --profile obsidian --zip (no --vault) was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "requires --vault" || { echo "[FAIL] #535: expected the primary requires-vault error"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--zip was also given" || { echo "[FAIL] #535: error does not note the irrelevant --zip"; echo "$ERR"; exit 1; }
echo "[PASS] #535: obsidian's missing-vault error notes the irrelevant --zip"

echo "== #535 (symmetric): --profile chatgpt-export + --vault (no --zip) names the irrelevant --vault =="
set +e
ERR=$(cb snapshot --profile chatgpt-export --vault "$VAULT" --out "$TMP/gpt-535.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --profile chatgpt-export --vault (no --zip) was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "requires --zip" || { echo "[FAIL] #535 symmetric: expected the primary requires-zip error"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--vault was also given" || { echo "[FAIL] #535 symmetric: error does not note the irrelevant --vault"; echo "$ERR"; exit 1; }
echo "[PASS] #535 (symmetric): chatgpt-export's missing-zip error notes the irrelevant --vault"

echo "== a VALID --profile obsidian --vault (no --zip) still works — no regression from the new #525 guard =="
cb snapshot --profile obsidian --vault "$VAULT" --out "$TMP/ob-regression.age" >/dev/null 2>&1 \
  || { echo "[FAIL] valid --profile obsidian --vault was rejected by the new guard"; exit 1; }
test -f "$TMP/ob-regression.age" || { echo "[FAIL] valid obsidian snapshot produced no output"; exit 1; }
echo "[PASS] valid --profile obsidian --vault still works (no regression)"

echo "== --pg-table/--pg-filter/--pg-exclude-table-data without --pg are refused, not silently dropped (issue #525) =="
# These flags are read ONLY inside snapshot.ts's \`if (o.pg)\` pg_dump block — given
# without --pg they used to parse fine and then be silently DROPPED, same bug class as
# --vault/--zip/--export above.
set +e
ERR=$(cb snapshot --dir "$EXTRA" --pg-table users --out "$TMP/pgtable-nopg.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --pg-table with no --pg was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--pg-table" || { echo "[FAIL] no-pg --pg-table refusal does not mention --pg-table"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--pg <conn>" || { echo "[FAIL] no-pg --pg-table refusal does not mention --pg <conn>"; echo "$ERR"; exit 1; }
test ! -f "$TMP/pgtable-nopg.age" || { echo "[FAIL] refused snapshot still wrote output"; exit 1; }
FILTER_FILE="$TMP/pg-filter.txt"; printf 'exclude table x\n' > "$FILTER_FILE"
set +e
ERR2=$(cb snapshot --dir "$EXTRA" --pg-filter "$FILTER_FILE" --pg-exclude-table-data cache --out "$TMP/pgfilter-nopg.age" 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] --pg-filter/--pg-exclude-table-data with no --pg was accepted"; exit 1; }
printf '%s' "$ERR2" | grep -q -- "--pg-filter" || { echo "[FAIL] no-pg --pg-filter refusal does not mention --pg-filter"; echo "$ERR2"; exit 1; }
printf '%s' "$ERR2" | grep -q -- "--pg-exclude-table-data" || { echo "[FAIL] no-pg --pg-filter refusal does not mention --pg-exclude-table-data"; echo "$ERR2"; exit 1; }
test ! -f "$TMP/pgfilter-nopg.age" || { echo "[FAIL] refused snapshot (pg-filter/exclude) still wrote output"; exit 1; }
echo "[PASS] --pg-table/--pg-filter/--pg-exclude-table-data without --pg are refused before anything is staged"

echo "== --profile obsidian/chatgpt-export with an EMPTY --vault/--zip '' still refuses with the normal requires-<flag> message (multi-model review round 2 catch) =="
# The CLI parser accepts an empty string as a value, so \`--vault ''\`/\`--zip ''\` are real
# inputs where the profile MATCHES but the value is unusable. snapshot.ts already catches
# this (obsidianPaths()/chatgptExportPaths() both use a falsy \`if (!o.vault)\` check, and
# resolveProfilePaths() runs BEFORE the new guards) — this exercises that existing path
# stays correct, and is the reference the schedule.ts version of this same case (which has
# no resolveProfilePaths() call to lean on) is compared against below.
set +e
ERR=$(cb snapshot --profile obsidian --vault "" --out "$TMP/emptyvault.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --profile obsidian --vault '' was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q "requires --vault" || { echo "[FAIL] empty --vault refusal does not say requires --vault"; echo "$ERR"; exit 1; }
test ! -f "$TMP/emptyvault.age" || { echo "[FAIL] refused snapshot (empty --vault) still wrote output"; exit 1; }
set +e
ERR2=$(cb snapshot --profile chatgpt-export --zip "" --out "$TMP/emptyzip.age" 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] --profile chatgpt-export --zip '' was accepted"; exit 1; }
printf '%s' "$ERR2" | grep -q "requires --zip" || { echo "[FAIL] empty --zip refusal does not say requires --zip"; echo "$ERR2"; exit 1; }
test ! -f "$TMP/emptyzip.age" || { echo "[FAIL] refused snapshot (empty --zip) still wrote output"; exit 1; }
echo "[PASS] an empty --vault/--zip with its OWN matching profile still refuses with the requires-<flag> message"

echo "== an EMPTY --pg '' (not just an ABSENT --pg) also refuses --pg-table (multi-model review catch) =="
# The CLI parser (src/cli.ts's valueAt()) accepts an empty string as a value — only a
# missing value or one that looks like another flag is refused — so \`--pg ''\` is a real,
# reachable input distinct from omitting --pg entirely: o.pg is then '' (!== undefined).
# assertPgFiltersRequirePg() must match the SAME truthy check the pg_dump block itself
# uses (\`if (o.pg)\`), not an \`undefined\`-only check — otherwise \`--pg '' --pg-table x\`
# would sail past the guard and hit the exact silent-drop bug this guard exists to close
# (caught by bounded codex exec review before merge, confirmed with a positive control
# against the buggy \`o.pg !== undefined\` version before fixing it here).
set +e
ERR=$(cb snapshot --dir "$EXTRA" --pg "" --pg-table users --out "$TMP/pgtable-emptypg.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --pg-table with an EMPTY --pg '' was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--pg-table" || { echo "[FAIL] empty-pg --pg-table refusal does not mention --pg-table"; echo "$ERR"; exit 1; }
test ! -f "$TMP/pgtable-emptypg.age" || { echo "[FAIL] refused snapshot (empty --pg) still wrote output"; exit 1; }
echo "[PASS] --pg-table with an empty --pg '' is refused exactly like an absent --pg"

echo "== symlinked --vault / --zip / --export are dereferenced (archive the data, not the link) =="
ln -s "$VAULT" "$TMP/linked-vault"
cb snapshot --profile obsidian --vault "$TMP/linked-vault" --out "$TMP/ob-ln.age" >/dev/null 2>&1 \
  || { echo "[FAIL] symlinked vault snapshot failed"; exit 1; }
cb restore --in "$TMP/ob-ln.age" --out-dir "$TMP/ob-ln-out" >/dev/null
tar -xzf "$TMP/ob-ln-out/vault.tar.gz" -C "$TMP/ob-ln-out" 2>/dev/null \
  || { echo "[FAIL] symlinked vault archived under the link name (expected the dereferenced vault.tar.gz)"; ls "$TMP/ob-ln-out"; exit 1; }
diff -r "$VAULT" "$TMP/ob-ln-out/vault" || { echo "[FAIL] restored vault (via symlink) differs from the real vault"; exit 1; }
[ "$(find "$TMP/ob-ln-out/vault" -type l | wc -l | tr -d ' ')" = "0" ] \
  || { echo "[FAIL] restored tree contains symlinks — archived the pointer, not the data"; exit 1; }
ln -s "$ZIP" "$TMP/linked-export.zip"
cb snapshot --profile chatgpt-export --zip "$TMP/linked-export.zip" --out "$TMP/gpt-ln.age" >/dev/null 2>&1 \
  || { echo "[FAIL] symlinked zip snapshot failed"; exit 1; }
cb restore --in "$TMP/gpt-ln.age" --out-dir "$TMP/gpt-ln-out" >/dev/null
tar -xzf "$TMP/gpt-ln-out/chatgpt-export.zip.tar.gz" -C "$TMP/gpt-ln-out"
{ test -f "$TMP/gpt-ln-out/chatgpt-export.zip" && test ! -L "$TMP/gpt-ln-out/chatgpt-export.zip"; } \
  || { echo "[FAIL] restored zip is missing or is a symlink"; exit 1; }
LSHA=$(shasum -a 256 "$TMP/gpt-ln-out/chatgpt-export.zip" | cut -d' ' -f1)
[ "$ZSHA" = "$LSHA" ] || { echo "[FAIL] zip restored via symlink is not byte-identical"; exit 1; }
ln -s "$BUNDLE" "$TMP/linked-bank-export.json"
cb snapshot --profile o2b --export "$TMP/linked-bank-export.json" --out "$TMP/o2b-ln.age" >/dev/null 2>&1 \
  || { echo "[FAIL] symlinked bundle snapshot failed"; exit 1; }
cb restore --in "$TMP/o2b-ln.age" --out-dir "$TMP/o2b-ln-out" >/dev/null
tar -xzf "$TMP/o2b-ln-out/bank-export.json.tar.gz" -C "$TMP/o2b-ln-out"
{ test -f "$TMP/o2b-ln-out/bank-export.json" && test ! -L "$TMP/o2b-ln-out/bank-export.json"; } \
  || { echo "[FAIL] restored bundle is missing or is a symlink"; exit 1; }
BLSHA=$(shasum -a 256 "$TMP/o2b-ln-out/bank-export.json" | cut -d' ' -f1)
[ "$BSHA" = "$BLSHA" ] || { echo "[FAIL] bundle restored via symlink is not byte-identical"; exit 1; }
echo "[PASS] symlinked vault, zip and export bundle are dereferenced to the real data"

echo "== unknown profile lists the valid ones =="
set +e
ERR=$(cb snapshot --profile nope --out "$TMP/nope.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] unknown profile exited 0"; exit 1; }
printf '%s' "$ERR" | grep -q "claude-code, obsidian, chatgpt-export, o2b" \
  || { echo "[FAIL] unknown-profile error does not list valid profiles"; echo "$ERR"; exit 1; }
echo "[PASS] unknown profile fails, listing the valid names"

echo "== #463: a near-miss --profile typo gets a did-you-mean suggestion, not just the bare list =="
# #425 already generalized nearestName()/didYouMean() (src/lib/suggest.ts) across
# --backend, --chain, schedule subcommands and --level; #463 was the one direct-CLI
# validator it missed — resolveProfilePaths()'s own default branch (profiles.ts).
# claude-cod -> claude-code and obsidan -> obsidian are both single-edit-distance,
# exactly what nearestName() is built to catch.
set +e
ERR=$(cb snapshot --profile claude-cod --out "$TMP/typo1.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --profile claude-cod was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q "did you mean claude-code?" \
  || { echo "[FAIL] --profile claude-cod did not suggest claude-code"; echo "$ERR"; exit 1; }

set +e
ERR=$(cb snapshot --profile obsidan --out "$TMP/typo2.age" 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] --profile obsidan was accepted"; exit 1; }
printf '%s' "$ERR" | grep -q "did you mean obsidian?" \
  || { echo "[FAIL] --profile obsidan did not suggest obsidian"; echo "$ERR"; exit 1; }
echo "[PASS] a near-miss --profile typo gets a did-you-mean suggestion (#463)"

echo
echo "PROFILES SELFTEST PASS"
