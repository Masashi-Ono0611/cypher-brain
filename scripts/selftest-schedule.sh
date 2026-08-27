#!/usr/bin/env bash
# Selftest for `cypher-brain schedule` (issue #69): the generated nightly runner +
# platform trigger, the paid-backend spend-cap refusal, two REAL back-to-back
# end-to-end runs of the generated runner against the file backend (retry-safety:
# a same-day re-run must not collide with the prior run's snapshot name), status
# reporting, idempotent uninstall, the --no-load uninstall consistency contract
# (#113) and CYPHER_BRAIN_HOME-scoped LABEL/CRON_MARKER (#114). Every `install`
# call uses --no-load (artifacts only) EXCEPT where a test specifically needs to
# prove real (un)registration behavior — those calls use a LABEL/CRON_MARKER that
# is hash-derived from a throwaway $TMP-based CYPHER_BRAIN_HOME (see home_hash()),
# which can never collide with a real, machine-wide schedule, and are always
# uninstalled again (trap-guarded) before this script exits. The one identifier
# this script deliberately never mutates for real is the LEGACY (pre-#114,
# unscoped) LABEL/CRON_MARKER — it is machine-wide, not test-scoped, and could
# name a real production schedule on whatever machine runs this script; the
# legacy-migration coverage below therefore only exercises detection (status) and
# the --no-load report path (uninstall), never the real bootout/crontab-edit call.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Start from a CLEAN CYPHER_BRAIN_* environment. This script is not merely reading
# configuration — `schedule install` BAKES whatever it can see into the generated runner
# (captureEnv), so a value exported in whoever-runs-this's own shell becomes part of the
# fixtures, and the REAL runner invocations below then execute against it. Observed with
# CYPHER_BRAIN_PIN_RECIPIENTS: an operator's own allowlist is baked in, the real run in
# (a5.4) encrypts to this script's throwaway key, the snapshot is refused, and the failure
# reads as "successful run (ping e2e) exited non-zero" — nothing points at the environment.
# Cleared as a CLASS rather than by naming the variables that happen to hurt today. Which
# ones can be baked is a property of ENV_CAPTURE_VARS (11 of the 25 declared names, right
# now) and that list grows — #276 was a variable missing from it. A test that enumerated
# the dangerous ones would be a second copy of that list, drifting from the real one, and
# the next variable to bite would arrive with the same unhelpful symptom. Sections that
# need one of these set it themselves, right where they assert on it.
# Both spellings: readEnv() falls back to the pre-rename CIPHER_BRAIN_* name, so an ambient
# legacy value would reach the CLI (and be baked into a runner) just the same.
for _leaked in $(env | sed -n 's/^\(C[IY]PHER_BRAIN_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$_leaked"; done
unset _leaked
export CYPHER_BRAIN_HOME="$TMP/home"
export CYPHER_BRAIN_SCHEDULE_DIR="$TMP/sched"
export CYPHER_BRAIN_LAUNCHD_DIR="$TMP/launchagents"
export CYPHER_BRAIN_FILE_DIR="$TMP/store"
cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }

# First 8 hex chars of sha256(CYPHER_BRAIN_HOME) — must match src/lib/schedule.ts's
# HOME_LABEL_HASH exactly (same input, same algorithm, same truncation) so this script can
# predict the LABEL/CRON_MARKER/plist filename `schedule install` will actually use.
home_hash() {
  if command -v sha256sum > /dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | cut -c1-8
  else
    printf '%s' "$1" | shasum -a 256 | cut -c1-8
  fi
}

RUNNER="$CYPHER_BRAIN_SCHEDULE_DIR/nightly.sh"
CONFIG="$CYPHER_BRAIN_SCHEDULE_DIR/schedule.json"
PLIST="$CYPHER_BRAIN_LAUNCHD_DIR/dev.cypher-brain.nightly.$(home_hash "$CYPHER_BRAIN_HOME").plist"
CRON_ENTRY="$CYPHER_BRAIN_SCHEDULE_DIR/cron.entry"
OS="$(uname -s)"
HAS_CRONTAB=1
if [ "$OS" != "Darwin" ] && ! command -v crontab > /dev/null 2>&1; then HAS_CRONTAB=0; fi

SRC="$TMP/brain-src"; mkdir -p "$SRC"
echo "a-thought" > "$SRC/note.txt"
# Guarded, and the output kept, because an unguarded `> /dev/null 2>&1` here fails in the
# worst possible way. `set -e` ends the script the moment this returns non-zero; it is the
# first command in the file that can fail, nothing has echoed yet, and its own diagnostics
# went to /dev/null — so the entire run is a bare non-zero exit with an EMPTY log and
# nothing naming keygen. (Hit while writing the environment fix above: a worktree without
# dependencies installed makes this exact line fail, and the symptom is indistinguishable
# from the script never starting.)
cb keygen > "$TMP/keygen.log" 2>&1 \
  || { echo "[FAIL] keygen (fixture setup) exited non-zero"; cat "$TMP/keygen.log"; exit 1; }

echo "== (a0) --help documents the CYPHER_BRAIN_LAUNCHD_DIR escape hatch (#182: it existed in code but was undocumented) =="
cb --help > "$TMP/help.txt" 2>&1 || { echo "[FAIL] --help exited non-zero"; cat "$TMP/help.txt"; exit 1; }
grep -q 'CYPHER_BRAIN_LAUNCHD_DIR' "$TMP/help.txt" || { echo "[FAIL] --help Env: block does not mention CYPHER_BRAIN_LAUNCHD_DIR (#182)"; exit 1; }
echo "[PASS] --help documents CYPHER_BRAIN_LAUNCHD_DIR"

echo "== (a) install --backend file --no-load: runner + trigger artifact, 03:30 default =="
cb schedule install --backend file --dir "$SRC" --no-load > "$TMP/install-a.log" 2>&1 \
  || { echo "[FAIL] install (file) exited non-zero"; cat "$TMP/install-a.log"; exit 1; }
[ -x "$RUNNER" ] || { echo "[FAIL] runner missing or not executable: $RUNNER"; exit 1; }
[ -f "$CONFIG" ] || { echo "[FAIL] schedule.json not written"; exit 1; }
grep -q '^set -euo pipefail$' "$RUNNER" || { echo "[FAIL] runner lacks set -euo pipefail"; exit 1; }
grep -q -- "snapshot --dir '$SRC' " "$RUNNER" || { echo "[FAIL] runner lacks the composed snapshot flags"; exit 1; }
grep -q -- '--out "$OUT"' "$RUNNER" || { echo "[FAIL] runner's snapshot line has no --out"; exit 1; }
# #301: an install that named no mode still bakes the EFFECTIVE one, so the nightly cannot
# start scanning — or stop — because of what lands on the scheduler's PATH months later.
grep -qE -- "--scan-secrets '(warn|deny|off)'" "$RUNNER" \
  || { echo "[FAIL] the runner carries no explicit --scan-secrets, so it would re-derive a default at run time"; grep -n 'snapshot ' "$RUNNER"; exit 1; }
grep -q -- "push --in \"\$OUT\" --backend 'file' --skip-unchanged --save-locator" "$RUNNER" || { echo "[FAIL] runner lacks the composed push flags (--backend/--skip-unchanged/--save-locator, #100)"; exit 1; }
grep -q -- 'SHA=$(cut -f3 ' "$RUNNER" || { echo "[FAIL] runner does not read the index SHA256 back from the save-locator file's 3rd field (#100 — re-hashing \$OUT would break the index on a skip)"; exit 1; }
if grep -q 'sha256_of' "$RUNNER"; then echo "[FAIL] runner still contains the retired sha256_of \$OUT helper (#100)"; exit 1; fi
grep -q 'STAMP="\$(date +%Y%m%dT%H%M%S)"' "$RUNNER" || { echo "[FAIL] runner lacks the dated+timed output stamp"; exit 1; }
grep -q 'while \[ -e "\$OUT" \]' "$RUNNER" || { echo "[FAIL] runner lacks the retry-safe disambiguation loop"; exit 1; }
grep -q -- "index.tsv" "$RUNNER" || { echo "[FAIL] runner lacks the index.tsv append"; exit 1; }
grep -q 'FAILED rc=' "$RUNNER" || { echo "[FAIL] runner lacks the trailing FAILED rc trap"; exit 1; }
if grep -q 'CYPHER_BRAIN_YES' "$RUNNER"; then echo "[FAIL] free backend runner must NOT set CYPHER_BRAIN_YES"; exit 1; fi
if grep -q 'CYPHER_BRAIN_MAX_SPEND' "$RUNNER"; then echo "[FAIL] free backend runner must NOT set CYPHER_BRAIN_MAX_SPEND"; exit 1; fi
grep -q '03:30' "$TMP/install-a.log" || { echo "[FAIL] install did not report the 03:30 default"; exit 1; }
grep -q 'settled state' "$TMP/install-a.log" || { echo "[FAIL] install did not print the write-window rationale"; exit 1; }
if [ "$OS" = "Darwin" ]; then
  [ -f "$PLIST" ] || { echo "[FAIL] launchd plist not written: $PLIST"; exit 1; }
  grep -q '<key>Hour</key><integer>3</integer>' "$PLIST" || { echo "[FAIL] plist hour != 3"; exit 1; }
  grep -q '<key>Minute</key><integer>30</integer>' "$PLIST" || { echo "[FAIL] plist minute != 30"; exit 1; }
  grep -q "$RUNNER" "$PLIST" || { echo "[FAIL] plist does not point at the runner"; exit 1; }
  grep -q -- "$PLIST is a REAL, PERSISTENT file" "$TMP/install-a.log" || { echo "[FAIL] install --no-load did not warn that the plist is a real, persistent file written outside CYPHER_BRAIN_HOME (#182)"; cat "$TMP/install-a.log"; exit 1; }
  grep -q 'CYPHER_BRAIN_LAUNCHD_DIR' "$TMP/install-a.log" || { echo "[FAIL] install --no-load warning did not mention the CYPHER_BRAIN_LAUNCHD_DIR override (#182)"; exit 1; }
else
  [ -f "$CRON_ENTRY" ] || { echo "[FAIL] cron entry artifact not written: $CRON_ENTRY"; exit 1; }
  grep -q '^30 3 \* \* \* /bin/bash ' "$CRON_ENTRY" || { echo "[FAIL] cron entry is not 03:30 daily"; exit 1; }
  grep -q '# cypher-brain-nightly' "$CRON_ENTRY" || { echo "[FAIL] cron entry lacks the uninstall marker"; exit 1; }
  grep -q -- '--no-load: cron entry written' "$TMP/install-a.log" || { echo "[FAIL] install --no-load did not report the cron entry write"; exit 1; }
fi
echo "[PASS] install (file): runner + trigger artifact with the expected pipeline, 03:30 default, no spend lines"

echo "== (a2) non-default backend env vars (not just the FILE_DIR/PG_BIN/AR_WALLET/PIN_RECIPIENTS 4) are baked into the runner =="
# launchd/cron start with a BARE env — anything read from process.env by config.mjs that
# was set at install time and silently dropped makes a scheduled run of a non-default
# backend (turbo/a custom arweave gateway) fail or fall back to the wrong default
# vs. what the operator actually tested interactively (Codex review, #69 P2).
CYPHER_BRAIN_AR_PAID_BY="1234567890abcdef1234567890ABCDEF12345678" \
CYPHER_BRAIN_AR_USD_RATE_URL="https://rates.invalid/v1/rates/usd" \
  cb schedule install --backend file --dir "$SRC" --no-load > "$TMP/install-a2.log" 2>&1 \
  || { echo "[FAIL] install (env-capture) exited non-zero"; cat "$TMP/install-a2.log"; exit 1; }
grep -q "export CYPHER_BRAIN_AR_PAID_BY='1234567890abcdef1234567890ABCDEF12345678'" "$RUNNER" || { echo "[FAIL] runner did not bake CYPHER_BRAIN_AR_PAID_BY"; cat "$RUNNER"; exit 1; }
# #276: read on the PUSH path (arweave put()/turbo call arUsdRate() for the approximate-USD
# line), so dropping it makes the unattended run egress to the default payment.ardrive.io
# that the operator configured away from. It is a bare URL, so it must be baked VERBATIM —
# a value ending up path-resolved here would mean it was wrongly added to PATH_ENV_VARS.
grep -q "export CYPHER_BRAIN_AR_USD_RATE_URL='https://rates.invalid/v1/rates/usd'" "$RUNNER" || { echo "[FAIL] runner did not bake CYPHER_BRAIN_AR_USD_RATE_URL verbatim"; cat "$RUNNER"; exit 1; }
echo "[PASS] env-capture: non-default env vars (CYPHER_BRAIN_AR_PAID_BY, CYPHER_BRAIN_AR_USD_RATE_URL) set at install time are baked into the runner"

echo "== (a3) relative --vault/--zip/--export/--recipient file paths resolve to ABSOLUTE in the runner (launchd/cron runs from a DIFFERENT cwd than install); an inline age1... --recipient is left UNCHANGED =="
# This is the exact issue #69 P2 regression: a relative path baked in verbatim resolves
# correctly at install time (whatever cwd the operator happened to be in) but not
# necessarily at scheduled-run time (launchd/cron invoke the runner from a different,
# unrelated cwd). Run install FROM a subdirectory so cwd truly differs from $TMP.
# --export (issue #206, profile o2b) is resolved the exact same way as --vault/--zip, so
# it is folded into this same regression check rather than duplicating the whole test.
# --profile o2b is required alongside it (see the (a3e) refusal test below) — --vault/
# --zip stay on this same install call purely to exercise their OWN absolute-path
# resolution; o2b never reads them, so their presence here is inert.
mkdir -p "$TMP/subdir/vaultdir"
touch "$TMP/subdir/exportdata.zip"
printf '{"schema":"1"}\n' > "$TMP/subdir/bank-export.json"
printf '# a recipients file\nage1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqcexskr\n' > "$TMP/subdir/recipients.txt"
INLINE_KEY="age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqcexskr"
# Canonical form of $TMP/subdir — matches what node:path's resolve()/process.cwd() bakes
# in (macOS mktemp dirs live under a symlinked /var/folders -> /private/var/folders, so a
# naive string comparison against the raw $TMP/subdir would false-fail here).
REALSUB="$(cd "$TMP/subdir" && pwd -P)"
(cd "$TMP/subdir" && cb schedule install --backend file --dir "$SRC" --profile o2b --vault vaultdir --zip exportdata.zip --export bank-export.json --recipient recipients.txt --recipient "$INLINE_KEY" --no-load) \
  > "$TMP/install-a3.log" 2>&1 || { echo "[FAIL] install (relative paths, invoked from a different cwd) exited non-zero"; cat "$TMP/install-a3.log"; exit 1; }
grep -qF -- "--vault '$REALSUB/vaultdir'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved --vault path"; cat "$RUNNER"; exit 1; }
grep -qF -- "--zip '$REALSUB/exportdata.zip'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved --zip path"; cat "$RUNNER"; exit 1; }
grep -qF -- "--export '$REALSUB/bank-export.json'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved --export path"; cat "$RUNNER"; exit 1; }
grep -qF -- "--recipient '$REALSUB/recipients.txt'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved --recipient FILE path"; cat "$RUNNER"; exit 1; }
grep -qF -- "--recipient '$INLINE_KEY'" "$RUNNER" || { echo "[FAIL] runner does not bake the inline age1... --recipient value UNCHANGED"; cat "$RUNNER"; exit 1; }
if grep -qF -- "--vault 'vaultdir'" "$RUNNER"; then echo "[FAIL] runner still contains the RELATIVE --vault string"; exit 1; fi
if grep -qF -- "--zip 'exportdata.zip'" "$RUNNER"; then echo "[FAIL] runner still contains the RELATIVE --zip string"; exit 1; fi
if grep -qF -- "--export 'bank-export.json'" "$RUNNER"; then echo "[FAIL] runner still contains the RELATIVE --export string"; exit 1; fi
if grep -qF -- "--recipient 'recipients.txt'" "$RUNNER"; then echo "[FAIL] runner still contains the RELATIVE --recipient FILE string"; exit 1; fi
echo "[PASS] relative --vault/--zip/--export/--recipient(file) resolved to absolute in the runner; inline age1... --recipient left unchanged"

echo "== (a3b) relative CYPHER_BRAIN_AR_WALLET / CYPHER_BRAIN_PIN_RECIPIENTS set before install (from a subdirectory) resolve to ABSOLUTE in the runner (same launchd/cron-different-cwd hazard as --vault/--zip/--recipient — Codex review round 4, #69 P2) =="
mkdir -p "$TMP/subdir2"
touch "$TMP/subdir2/wallet.json"
printf '# a pin-recipients file\nage1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqcexskr\n' > "$TMP/subdir2/pins.txt"
REALSUB2="$(cd "$TMP/subdir2" && pwd -P)"
(cd "$TMP/subdir2" && CYPHER_BRAIN_AR_WALLET="wallet.json" CYPHER_BRAIN_PIN_RECIPIENTS="pins.txt" cb schedule install --backend file --dir "$SRC" --no-load) \
  > "$TMP/install-a3b.log" 2>&1 || { echo "[FAIL] install (relative AR_WALLET/PIN_RECIPIENTS, invoked from a different cwd) exited non-zero"; cat "$TMP/install-a3b.log"; exit 1; }
grep -qF "export CYPHER_BRAIN_AR_WALLET='$REALSUB2/wallet.json'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved CYPHER_BRAIN_AR_WALLET"; cat "$RUNNER"; exit 1; }
grep -qF "export CYPHER_BRAIN_PIN_RECIPIENTS='$REALSUB2/pins.txt'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved CYPHER_BRAIN_PIN_RECIPIENTS"; cat "$RUNNER"; exit 1; }
if grep -qF "CYPHER_BRAIN_AR_WALLET='wallet.json'" "$RUNNER"; then echo "[FAIL] runner still contains the RELATIVE CYPHER_BRAIN_AR_WALLET string"; exit 1; fi
if grep -qF "CYPHER_BRAIN_PIN_RECIPIENTS='pins.txt'" "$RUNNER"; then echo "[FAIL] runner still contains the RELATIVE CYPHER_BRAIN_PIN_RECIPIENTS string"; exit 1; fi
echo "[PASS] relative CYPHER_BRAIN_AR_WALLET/CYPHER_BRAIN_PIN_RECIPIENTS resolved to absolute in the runner"

echo "== (a3c) TMPDIR set at install time (relative, from a subdirectory) is baked into the runner as an ABSOLUTE export (snapshot()'s mkdtempSync stages plaintext there; launchd/cron start with a bare env and would silently fall back to the system temp dir otherwise) =="
mkdir -p "$TMP/bigdisk"
# Canonical form of $TMP/bigdisk — matches what node:path's resolve()/process.cwd() bakes
# in (macOS mktemp dirs live under a symlinked /var/folders -> /private/var/folders, so a
# naive string comparison against the raw $TMP/bigdisk would false-fail here — see a3's
# REALSUB for the same reasoning).
REALBIGDISK="$(cd "$TMP/bigdisk" && pwd -P)"
(cd "$TMP/subdir2" && TMPDIR=../bigdisk cb schedule install --backend file --dir "$SRC" --no-load) \
  > "$TMP/install-a3c.log" 2>&1 || { echo "[FAIL] install (relative TMPDIR, invoked from a different cwd) exited non-zero"; cat "$TMP/install-a3c.log"; exit 1; }
grep -qF "export TMPDIR='$REALBIGDISK'" "$RUNNER" || { echo "[FAIL] runner does not bake the ABSOLUTE resolved TMPDIR"; cat "$RUNNER"; exit 1; }
echo "[PASS] TMPDIR baked into the runner as an absolute export"

echo "== (a3d) an explicitly EMPTY CYPHER_BRAIN_PIN_RECIPIENTS is baked into the runner VERBATIM, so the unattended run fails CLOSED exactly like the interactive one (#101) =="
# config.ts keeps '' distinct from unset and snapshot() refuses to run on it, so a broken
# cron/systemd template rendering CYPHER_BRAIN_PIN_RECIPIENTS="" cannot silently disable the
# recipient allowlist. captureEnv() used to drop every falsy value, collapsing the two cases
# into a runner carrying no pin at all — and because that runner exports
# CYPHER_BRAIN_NO_CONFIG_FILE=1 (#286), $CYPHER_BRAIN_HOME/config.env could not put it back
# either: the interactive path failed closed while the scheduled one ran unpinned.
# A throwaway home/schedule/store, because the deliberately FAILING run below must not
# disturb the shared log/index/store counts (c) and (c1b) assert on.
PINHOME="$TMP/emptypin-home"; PINSCHED="$TMP/emptypin-sched"; PINSTORE="$TMP/emptypin-store"
PINLAUNCHD="$TMP/emptypin-launchagents"
PINSRC="$TMP/emptypin-src"; mkdir -p "$PINSRC"; echo "a-pinned-thought" > "$PINSRC/note.txt"
PINRUNNER="$PINSCHED/nightly.sh"
CYPHER_BRAIN_HOME="$PINHOME" cb keygen > /dev/null 2>&1 || { echo "[FAIL] keygen for the empty-pin home exited non-zero"; exit 1; }
# Control: with the var genuinely UNSET, it is still dropped (no pin configured) — proving
# the assertion below is about '' specifically, not about baking the name unconditionally.
# `unset` in a subshell rather than relying on "we never set it": the script-wide clean
# slate at the top already guarantees nothing ambient is in scope, but this case is
# specifically ABOUT unset-versus-empty, so it states which one it means locally instead
# of depending on a distant line to be read.
(unset CYPHER_BRAIN_PIN_RECIPIENTS CIPHER_BRAIN_PIN_RECIPIENTS
 CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_SCHEDULE_DIR="$PINSCHED" CYPHER_BRAIN_FILE_DIR="$PINSTORE" CYPHER_BRAIN_LAUNCHD_DIR="$PINLAUNCHD" \
   cb schedule install --backend file --dir "$PINSRC" --no-load) > "$TMP/install-a3d-unset.log" 2>&1 \
  || { echo "[FAIL] install (pin unset) exited non-zero"; cat "$TMP/install-a3d-unset.log"; exit 1; }
if grep -q '^export CYPHER_BRAIN_PIN_RECIPIENTS=' "$PINRUNNER"; then echo "[FAIL] runner baked a CYPHER_BRAIN_PIN_RECIPIENTS export even though the var was UNSET at install time"; cat "$PINRUNNER"; exit 1; fi
CYPHER_BRAIN_HOME="$PINHOME" CYPHER_BRAIN_SCHEDULE_DIR="$PINSCHED" CYPHER_BRAIN_FILE_DIR="$PINSTORE" CYPHER_BRAIN_LAUNCHD_DIR="$PINLAUNCHD" CYPHER_BRAIN_PIN_RECIPIENTS="" \
  cb schedule install --backend file --dir "$PINSRC" --no-load > "$TMP/install-a3d.log" 2>&1 \
  || { echo "[FAIL] install (explicitly empty pin) exited non-zero"; cat "$TMP/install-a3d.log"; exit 1; }
grep -qF "export CYPHER_BRAIN_PIN_RECIPIENTS=''" "$PINRUNNER" || { echo "[FAIL] #101 fail-open regression: the runner does not bake the explicitly EMPTY CYPHER_BRAIN_PIN_RECIPIENTS verbatim (an unattended run would snapshot with NO recipient allowlist)"; cat "$PINRUNNER"; exit 1; }
# End-to-end, not just the generated text: the baked empty pin must actually stop the run.
if bash "$PINRUNNER" > "$TMP/emptypin-run.log" 2>&1; then echo "[FAIL] #101 fail-open regression: the generated runner completed a snapshot with an explicitly empty CYPHER_BRAIN_PIN_RECIPIENTS"; cat "$TMP/emptypin-run.log"; exit 1; fi
PINRUNLOG="$PINSCHED/logs/nightly-$(date +%F).log"
grep -q "CYPHER_BRAIN_PIN_RECIPIENTS is set but empty" "$PINRUNLOG" 2>/dev/null \
  || { echo "[FAIL] the failing run did not report the fail-closed empty-pin error"; cat "$PINRUNLOG" 2>/dev/null || cat "$TMP/emptypin-run.log"; exit 1; }
tail -n 1 "$PINRUNLOG" | grep -q '^FAILED rc=' || { echo "[FAIL] the empty-pin run did not end with the FAILED rc=N heartbeat line"; tail -n 3 "$PINRUNLOG"; exit 1; }
[ -z "$(find "$PINSTORE" -maxdepth 1 -name '*.age' 2>/dev/null)" ] || { echo "[FAIL] the empty-pin run pushed an object to the store despite failing closed"; exit 1; }
echo "[PASS] an explicitly empty CYPHER_BRAIN_PIN_RECIPIENTS is baked verbatim and the scheduled run fails closed (unset is still dropped)"

echo "== (a3e) schedule install: --export without --profile o2b is refused, not silently baked into the runner (multi-model review, PR #334) =="
# Before this check, install() baked cfg.export into the generated runner's snapshot line
# UNCONDITIONALLY — it never calls resolveProfilePaths() itself — so a --export given
# with no --profile (or the wrong one) installed cleanly and only turned out to be a
# no-op every night, once the runner actually ran snapshot() (which only reads --export
# via profile o2b's o2bPaths()). Refused HERE, at install time, instead.
set +e
ERR=$(cb schedule install --backend file --dir "$SRC" --export "$TMP/subdir/bank-export.json" --no-load 2>&1); RC=$?
set -e
[ "$RC" != "0" ] || { echo "[FAIL] schedule install accepted --export with no --profile at all"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--export" || { echo "[FAIL] install's no-profile --export refusal does not mention --export"; echo "$ERR"; exit 1; }
printf '%s' "$ERR" | grep -q -- "--profile o2b" || { echo "[FAIL] install's no-profile --export refusal does not mention --profile o2b"; echo "$ERR"; exit 1; }
set +e
ERR2=$(cb schedule install --backend file --dir "$SRC" --profile obsidian --vault "$TMP/subdir/vaultdir" --export "$TMP/subdir/bank-export.json" --no-load 2>&1); RC2=$?
set -e
[ "$RC2" != "0" ] || { echo "[FAIL] schedule install accepted --export with --profile obsidian"; exit 1; }
printf '%s' "$ERR2" | grep -q "obsidian" || { echo "[FAIL] install's wrong-profile --export refusal does not name the mismatched profile"; echo "$ERR2"; exit 1; }
echo "[PASS] schedule install refuses --export without --profile o2b (absent or mismatched) before writing anything"

echo "== (a4) --pg without CYPHER_BRAIN_PG_BIN resolves pg_dump on PATH at install time and bakes its DIRECTORY as CYPHER_BRAIN_PG_BIN (config.mjs's PG_BIN is a dir joined with the tool name via pgTool(), not the pg_dump binary path itself — baking the binary path verbatim would break both pg_dump AND pg_restore); install fails clearly when pg_dump cannot be resolved =="
FAKE_PGBIN="$TMP/fake-pgbin"; mkdir -p "$FAKE_PGBIN"
cat > "$FAKE_PGBIN/pg_dump" <<'SHIM'
#!/usr/bin/env bash
echo "fake pg_dump shim: $*" >&2
exit 0
SHIM
chmod +x "$FAKE_PGBIN/pg_dump"
# NOTE: unlike --vault/--zip/--recipient (resolved via node:path's resolve() against
# process.cwd(), which macOS reports already symlink-resolved), pg_dump's path here comes
# straight from `command -v` reading PATH — resolve() only normalizes it (it does NOT
# follow symlinks), so the baked value is the literal $FAKE_PGBIN, not its realpath.
REAL_FAKE_PGBIN="$FAKE_PGBIN"
PATH="$FAKE_PGBIN:$PATH" cb schedule install --backend file --pg "postgres://x/y" --no-load > "$TMP/install-pg.log" 2>&1 \
  || { echo "[FAIL] install (--pg, shimmed pg_dump prepended to PATH) exited non-zero"; cat "$TMP/install-pg.log"; exit 1; }
grep -qF "export CYPHER_BRAIN_PG_BIN='$REAL_FAKE_PGBIN'" "$RUNNER" || { echo "[FAIL] runner did not bake the resolved pg_dump DIRECTORY as CYPHER_BRAIN_PG_BIN"; cat "$RUNNER"; exit 1; }
if grep -qF "CYPHER_BRAIN_PG_BIN='$REAL_FAKE_PGBIN/pg_dump'" "$RUNNER"; then echo "[FAIL] runner baked the pg_dump BINARY path, not its directory — pgTool('pg_dump')/pgTool('pg_restore') would break"; exit 1; fi
grep -qF "resolved pg_dump -> $REAL_FAKE_PGBIN/pg_dump" "$TMP/install-pg.log" || { echo "[FAIL] install did not report the resolved pg_dump path"; cat "$TMP/install-pg.log"; exit 1; }
echo "[PASS] --pg without CYPHER_BRAIN_PG_BIN resolves pg_dump on PATH and bakes its containing directory into the runner"

NODE_BIN="$(command -v node)"
# Do NOT strip PATH down to /usr/bin:/bin and assume pg_dump is absent there — hosts
# (including plausible CI images) that ship the PostgreSQL client tools system-wide under
# /usr/bin make that assertion host-dependent and wrongly FAIL a working feature (Codex
# review round 4, #69 P2). Build an ISOLATED PATH dir containing ONLY the one binary
# schedule install's --pg auto-detect itself shells out to — a POSIX shell, to run
# `command -v pg_dump` (see resolvePgDumpDir() in src/lib/schedule.ts) — so pg_dump is
# guaranteed unresolvable no matter what the real host has installed. node is invoked
# directly via its absolute path ($NODE_BIN), so it needs no entry on PATH itself
# (BIN_DEV_ARGS is passed as literal argv, not via PATH or an env var).
ISOLATED_PATH_DIR="$TMP/isolated-path"; mkdir -p "$ISOLATED_PATH_DIR"
ln -s "$(command -v sh)" "$ISOLATED_PATH_DIR/sh"
if PATH="$ISOLATED_PATH_DIR" "$NODE_BIN" "${BIN_DEV_ARGS[@]}" "$BIN" schedule install --backend file --pg "postgres://x/y" --no-load > "$TMP/install-pg-missing.log" 2>&1; then
  echo "[FAIL] install (--pg, isolated PATH with no pg_dump) was accepted"; exit 1
fi
grep -qi 'pg_dump' "$TMP/install-pg-missing.log" || { echo "[FAIL] install failure does not name the missing pg_dump binary"; cat "$TMP/install-pg-missing.log"; exit 1; }
echo "[PASS] install refuses clearly (naming pg_dump) when it cannot be resolved, regardless of the real host's PATH contents"

EXPLICIT_PGBIN="$TMP/explicit-pgbin"; mkdir -p "$EXPLICIT_PGBIN"
CYPHER_BRAIN_PG_BIN="$EXPLICIT_PGBIN" cb schedule install --backend file --pg "postgres://x/y" --no-load > "$TMP/install-pg-explicit.log" 2>&1 \
  || { echo "[FAIL] install (--pg, explicit CYPHER_BRAIN_PG_BIN set) exited non-zero"; cat "$TMP/install-pg-explicit.log"; exit 1; }
grep -qF "export CYPHER_BRAIN_PG_BIN='$EXPLICIT_PGBIN'" "$RUNNER" || { echo "[FAIL] runner did not preserve an explicit CYPHER_BRAIN_PG_BIN unchanged"; cat "$RUNNER"; exit 1; }
echo "[PASS] an explicit CYPHER_BRAIN_PG_BIN is respected as-is, no auto-resolution overrides it"

echo "== (a5) --ping-url: dead man's switch pings baked into the runner + real end-to-end curl hits (issue #202) =="
# A local-only, OS-assigned-port HTTP request logger (scripts/ping-echo-server.mjs) plays
# the role of a healthchecks.io-style monitor — no real network request ever leaves this
# machine. Started here (before any of the sub-checks below) so (a5.4)'s real runner
# invocations have somewhere to curl.
PING_LOG="$TMP/ping-hits.log"; : > "$PING_LOG"
PING_SERVER_OUT="$TMP/ping-server.out"
node "$ROOT/scripts/ping-echo-server.mjs" "$PING_LOG" > "$PING_SERVER_OUT" 2>&1 &
PING_SERVER_PID=$!
PING_PORT=""
for _ in $(seq 1 50); do
  if [ -s "$PING_SERVER_OUT" ]; then
    PING_PORT="$(sed -n 's/^READY:\([0-9]*\)$/\1/p' "$PING_SERVER_OUT" | head -n1)"
    [ -n "$PING_PORT" ] && break
  fi
  sleep 0.1
done
[ -n "$PING_PORT" ] || { echo "[FAIL] local ping-echo-server.mjs never reported READY"; cat "$PING_SERVER_OUT"; kill "$PING_SERVER_PID" 2>/dev/null; exit 1; }
cleanup_ping_server() { kill "$PING_SERVER_PID" 2>/dev/null || true; }
trap 'cleanup_ping_server; rm -rf "$TMP"' EXIT
PING_BASE="http://127.0.0.1:$PING_PORT/hc/abc123"

echo "-- (a5.0) --ping-url-fail without --ping-url is refused --"
if cb schedule install --backend file --dir "$SRC" --ping-url-fail "$PING_BASE/custom-fail" --no-load > "$TMP/ping-fail-only.log" 2>&1; then
  echo "[FAIL] install --ping-url-fail without --ping-url was accepted"; exit 1
fi
grep -q -- '--ping-url-fail requires --ping-url' "$TMP/ping-fail-only.log" || { echo "[FAIL] refusal does not explain --ping-url-fail requires --ping-url"; cat "$TMP/ping-fail-only.log"; exit 1; }
echo "[PASS] --ping-url-fail without --ping-url refused with a clear message"

echo "-- (a5.1) --ping-url alone: runner bakes PING_URL + default \${url}/fail, the trap curl's both, install + status report it --"
cb schedule install --backend file --dir "$SRC" --ping-url "$PING_BASE" --no-load > "$TMP/ping-install.log" 2>&1 \
  || { echo "[FAIL] install (--ping-url) exited non-zero"; cat "$TMP/ping-install.log"; exit 1; }
grep -qF "PING_URL='$PING_BASE'" "$RUNNER" || { echo "[FAIL] runner does not bake PING_URL"; cat "$RUNNER"; exit 1; }
grep -qF "PING_URL_FAIL='$PING_BASE/fail'" "$RUNNER" || { echo "[FAIL] runner does not default PING_URL_FAIL to \${ping_url}/fail"; cat "$RUNNER"; exit 1; }
grep -qF 'curl -fsS -m 10 "$PING_URL" >/dev/null 2>&1 || true' "$RUNNER" || { echo "[FAIL] runner trap lacks the success ping curl"; cat "$RUNNER"; exit 1; }
grep -qF 'curl -fsS -m 10 "$PING_URL_FAIL" >/dev/null 2>&1 || true' "$RUNNER" || { echo "[FAIL] runner trap lacks the failure ping curl"; cat "$RUNNER"; exit 1; }
grep -qF "dead man's switch enabled: success -> $PING_BASE, failure -> $PING_BASE/fail" "$TMP/ping-install.log" || { echo "[FAIL] install did not report the ping config"; cat "$TMP/ping-install.log"; exit 1; }
cb schedule status > "$TMP/ping-status.log" 2>&1 || { echo "[FAIL] status exited non-zero"; cat "$TMP/ping-status.log"; exit 1; }
grep -qF "ping: $PING_BASE (fail: $PING_BASE/fail)" "$TMP/ping-status.log" || { echo "[FAIL] status does not report the configured ping url"; cat "$TMP/ping-status.log"; exit 1; }
echo "[PASS] --ping-url alone: PING_URL/PING_URL_FAIL baked in with the default /fail suffix, curl calls present in the trap, install + status report it"

echo "-- (a5.2) --ping-url-fail overrides the default \${url}/fail suffix --"
cb schedule install --backend file --dir "$SRC" --ping-url "$PING_BASE" --ping-url-fail "http://127.0.0.1:$PING_PORT/hc/custom-fail" --no-load > "$TMP/ping-override.log" 2>&1 \
  || { echo "[FAIL] install (--ping-url + --ping-url-fail override) exited non-zero"; cat "$TMP/ping-override.log"; exit 1; }
grep -qF "PING_URL_FAIL='http://127.0.0.1:$PING_PORT/hc/custom-fail'" "$RUNNER" || { echo "[FAIL] runner did not use the explicit --ping-url-fail override"; cat "$RUNNER"; exit 1; }
if grep -qF "PING_URL_FAIL='$PING_BASE/fail'" "$RUNNER"; then echo "[FAIL] runner still carries the default /fail suffix even though --ping-url-fail was given"; exit 1; fi
echo "[PASS] --ping-url-fail overrides the default /fail suffix"

echo "-- (a5.3) a schedule installed WITHOUT --ping-url never references PING_URL/curl (no regression) --"
cb schedule install --backend file --dir "$SRC" --no-load > /dev/null 2>&1 || { echo "[FAIL] install (no ping) exited non-zero"; exit 1; }
if grep -q 'PING_URL' "$RUNNER"; then echo "[FAIL] runner without --ping-url still references PING_URL"; cat "$RUNNER"; exit 1; fi
if grep -q 'curl' "$RUNNER"; then echo "[FAIL] runner without --ping-url still calls curl"; cat "$RUNNER"; exit 1; fi
echo "[PASS] omitting --ping-url leaves the runner untouched (no PING_URL/curl)"

echo "-- (a5.4) end-to-end: a REAL successful run curls the success URL exactly once; a REAL failing run curls \${url}/fail exactly once --"
# Fully isolated schedule dir + file-backend store + save-locator (distinct from the
# shared ones the rest of this script uses) so these real runs never perturb the
# skip-unchanged / index.tsv / snapshot-count assertions later sections make against
# the shared fixtures.
PING_SCHED_OK="$TMP/sched-ping-ok"
CYPHER_BRAIN_SCHEDULE_DIR="$PING_SCHED_OK" CYPHER_BRAIN_FILE_DIR="$TMP/ping-store" \
  cb schedule install --backend file --dir "$SRC" --ping-url "$PING_BASE" --save-locator "$TMP/ping-locator.tsv" --no-load > "$TMP/ping-e2e-ok-install.log" 2>&1 \
  || { echo "[FAIL] install (ping e2e, success fixture) exited non-zero"; cat "$TMP/ping-e2e-ok-install.log"; exit 1; }
TODAY_PING="$(date +%F)"
: > "$PING_LOG"
bash "$PING_SCHED_OK/nightly.sh" || { echo "[FAIL] successful run (ping e2e) exited non-zero"; cat "$PING_SCHED_OK/logs/nightly-$TODAY_PING.log" 2>/dev/null; exit 1; }
for _ in $(seq 1 30); do grep -qx "GET /hc/abc123" "$PING_LOG" 2>/dev/null && break; sleep 0.1; done
grep -qx "GET /hc/abc123" "$PING_LOG" || { echo "[FAIL] successful run did not curl the success ping URL"; cat "$PING_LOG"; exit 1; }
if grep -qx "GET /hc/abc123/fail" "$PING_LOG"; then echo "[FAIL] successful run also (wrongly) curled the failure ping URL"; exit 1; fi
[ "$(wc -l < "$PING_LOG" | tr -d ' ')" = "1" ] || { echo "[FAIL] expected exactly 1 ping hit after the successful run"; cat "$PING_LOG"; exit 1; }

PING_SCHED_FAIL="$TMP/sched-ping-fail"
CYPHER_BRAIN_SCHEDULE_DIR="$PING_SCHED_FAIL" CYPHER_BRAIN_FILE_DIR="$TMP/ping-store-2" \
  cb schedule install --backend file --dir "$TMP/does-not-exist-ping" --ping-url "$PING_BASE" --save-locator "$TMP/ping-locator-2.tsv" --no-load > "$TMP/ping-e2e-fail-install.log" 2>&1 \
  || { echo "[FAIL] install (ping e2e, failure fixture) exited non-zero"; cat "$TMP/ping-e2e-fail-install.log"; exit 1; }
: > "$PING_LOG"
if bash "$PING_SCHED_FAIL/nightly.sh"; then echo "[FAIL] runner with a missing --dir (ping e2e) unexpectedly succeeded"; exit 1; fi
for _ in $(seq 1 30); do grep -qx "GET /hc/abc123/fail" "$PING_LOG" 2>/dev/null && break; sleep 0.1; done
grep -qx "GET /hc/abc123/fail" "$PING_LOG" || { echo "[FAIL] failing run did not curl the failure ping URL"; cat "$PING_LOG"; exit 1; }
if grep -qx "GET /hc/abc123" "$PING_LOG"; then echo "[FAIL] failing run also (wrongly) curled the success ping URL"; exit 1; fi
[ "$(wc -l < "$PING_LOG" | tr -d ' ')" = "1" ] || { echo "[FAIL] expected exactly 1 ping hit after the failing run"; cat "$PING_LOG"; exit 1; }
echo "[PASS] end-to-end: a successful run curls only the success URL, a failing run curls only \${url}/fail, both exactly once — the ping never changes the run's own OK/FAILED outcome"

cleanup_ping_server
trap 'rm -rf "$TMP"' EXIT

echo "== (a6) --scan-secrets is HONOURED by the generated runner, not accepted and discarded (#307) =="
# The exact bug: `schedule install --backend file --dir X --scan-secrets deny --no-load`
# exited 0 and produced a runner whose snapshot line had no --scan-secrets at all, so the
# one run nobody watches was the one run that never scanned. These assertions need no real
# gitleaks: a shim on PATH plays the part for the install-time resolution (same technique
# as the pg_dump shim in (a4) above), which keeps the tripwire live on every machine.
FAKE_GITLEAKS_DIR="$TMP/fake-gitleaks"; mkdir -p "$FAKE_GITLEAKS_DIR"
cat > "$FAKE_GITLEAKS_DIR/gitleaks" <<'SHIM'
#!/usr/bin/env bash
# Minimal stand-in for the gitleaks CLI, emulating only what src/lib/secrets-scan.ts
# invokes: write a JSON report to --report-path and exit 0. It always reports one
# planted finding, so a run that really scans is unambiguously distinguishable from a
# run that skipped the scan.
REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report-path) REPORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$REPORT" ] || exit 3
printf '%s' '[{"RuleID":"selftest-planted-rule"}]' > "$REPORT"
exit 0
SHIM
chmod +x "$FAKE_GITLEAKS_DIR/gitleaks"

PATH="$FAKE_GITLEAKS_DIR:$PATH" cb schedule install --backend file --dir "$SRC" --scan-secrets deny --no-load > "$TMP/install-scan.log" 2>&1 \
  || { echo "[FAIL] install (--scan-secrets deny, shimmed gitleaks on PATH) exited non-zero"; cat "$TMP/install-scan.log"; exit 1; }
# THE tripwire: the generated snapshot command line must carry the flag.
grep -q -- "snapshot --dir '$SRC' --scan-secrets 'deny' --out" "$RUNNER" \
  || { echo "[FAIL] #307: the runner's snapshot line does not carry --scan-secrets deny"; grep -n 'snapshot ' "$RUNNER"; exit 1; }
# The BINARY is pinned, not merely made reachable: appending its directory to PATH would
# let a different gitleaks earlier on the scheduler's PATH win (see (a6b) below, which
# proves the pin holds against exactly that).
grep -qF "export CYPHER_BRAIN_GITLEAKS_BIN='$FAKE_GITLEAKS_DIR/gitleaks'" "$RUNNER" \
  || { echo "[FAIL] runner does not bake the resolved gitleaks BINARY as CYPHER_BRAIN_GITLEAKS_BIN (launchd/cron start with a bare PATH — the scan would fail every night)"; cat "$RUNNER"; exit 1; }
if grep -q 'export PATH=' "$RUNNER"; then echo "[FAIL] runner rewrites PATH instead of pinning the binary — an earlier gitleaks could shadow the resolved one"; exit 1; fi
grep -qF "resolved gitleaks -> $FAKE_GITLEAKS_DIR/gitleaks" "$TMP/install-scan.log" \
  || { echo "[FAIL] install did not report the resolved gitleaks path"; cat "$TMP/install-scan.log"; exit 1; }
node -e "
const cfg = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (cfg.scan_secrets !== 'deny') throw new Error('schedule.json scan_secrets = ' + JSON.stringify(cfg.scan_secrets) + ', expected deny');
if (cfg.env.CYPHER_BRAIN_GITLEAKS_BIN !== process.argv[2]) throw new Error('schedule.json env.CYPHER_BRAIN_GITLEAKS_BIN = ' + JSON.stringify(cfg.env.CYPHER_BRAIN_GITLEAKS_BIN) + ', expected ' + process.argv[2]);
" "$CONFIG" "$FAKE_GITLEAKS_DIR/gitleaks" || { echo "[FAIL] schedule.json did not record the scan mode / resolved gitleaks binary"; exit 1; }
cb schedule status > "$TMP/status-scan.log" 2>&1 || { echo "[FAIL] status (scan-enabled schedule) exited non-zero"; cat "$TMP/status-scan.log"; exit 1; }
grep -q 'secret scan: configured --scan-secrets deny' "$TMP/status-scan.log" \
  || { echo "[FAIL] status does not report that this schedule scans"; cat "$TMP/status-scan.log"; exit 1; }
# It must say "configured", not imply a health check it did not perform: status reads
# schedule.json, so it cannot know gitleaks is still resolvable tonight (multi-model review).
grep -q 'not a health check' "$TMP/status-scan.log" \
  || { echo "[FAIL] status states the scan mode as if it had verified gitleaks is still available"; cat "$TMP/status-scan.log"; exit 1; }
echo "[PASS] --scan-secrets deny is threaded into the runner's snapshot line, the resolved gitleaks BINARY is pinned into the runner, and status reports it"

echo "== (a6b) the baked runner ACTUALLY refuses a leaky source when it runs, using the PINNED gitleaks even when a different one shadows it on PATH (#307 end-to-end) =="
# Run the runner the way launchd/cron would: a bare system PATH, which reaches neither the
# shim dir nor whatever real gitleaks this host happens to have. Only the pinned binary can
# be resolved, so a run that refuses proves the whole chain — flag threaded -> scanner
# resolvable in a bare env -> deny honoured — identically on a host with gitleaks and one
# without.
SCAN_LOG="$CYPHER_BRAIN_SCHEDULE_DIR/logs/nightly-$(date +%F).log"
if PATH=/usr/bin:/bin:/usr/sbin:/sbin bash "$RUNNER" > /dev/null 2>&1; then
  echo "[FAIL] #307: the runner exited 0 on a source the scan flags — the gate is baked in but not honoured"; cat "$SCAN_LOG"; exit 1
fi
grep -q 'refusing to snapshot' "$SCAN_LOG" || { echo "[FAIL] the runner failed for some reason OTHER than the deny gate"; cat "$SCAN_LOG"; exit 1; }
grep -q 'selftest-planted-rule' "$SCAN_LOG" || { echo "[FAIL] the refusal does not name the rule the scan reported"; cat "$SCAN_LOG"; exit 1; }
tail -n 1 "$SCAN_LOG" | grep -q '^FAILED rc=' || { echo "[FAIL] the refused run did not end with the FAILED rc heartbeat line"; tail -n 3 "$SCAN_LOG"; exit 1; }
# THE shadowing tripwire (multi-model review round 4): a DIFFERENT gitleaks — one that
# reports no findings — placed FIRST on the runner's PATH must not take the pinned one's
# place. Merely appending the resolved directory to PATH failed exactly this: the stub won
# and a deny runner exited 0 and pushed.
SHADOW_DIR="$TMP/shadow-gitleaks"; mkdir -p "$SHADOW_DIR"
cat > "$SHADOW_DIR/gitleaks" <<'SHIM'
#!/usr/bin/env bash
# A "clean" scanner: always reports zero findings. If this one runs, deny lets the
# snapshot through — which is precisely what must NOT happen once the binary is pinned.
REPORT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --report-path) REPORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$REPORT" ] || exit 3
printf '%s' '[]' > "$REPORT"
exit 0
SHIM
chmod +x "$SHADOW_DIR/gitleaks"
SHADOW_LOG_FROM="$(( $(wc -l < "$SCAN_LOG" | tr -d ' ') + 1 ))" # first line the shadowed run will write
if PATH="$SHADOW_DIR:/usr/bin:/bin:/usr/sbin:/sbin" bash "$RUNNER" > /dev/null 2>&1; then
  echo "[FAIL] #307: a no-findings gitleaks earlier on PATH shadowed the pinned one — the deny runner exited 0 and pushed an unscanned snapshot"; tail -n +"$SHADOW_LOG_FROM" "$SCAN_LOG"; exit 1
fi
tail -n +"$SHADOW_LOG_FROM" "$SCAN_LOG" | grep -q 'selftest-planted-rule' \
  || { echo "[FAIL] the run under a shadowing PATH did not use the pinned scanner (no planted finding reported)"; tail -n +"$SHADOW_LOG_FROM" "$SCAN_LOG"; exit 1; }
echo "[PASS] the installed nightly really runs the scan, refuses on a finding, and uses the PINNED binary even when another gitleaks precedes it on PATH"

echo "== (a6c) install REFUSES a bad mode, and refuses when gitleaks cannot be resolved — never a schedule that silently cannot scan (#307) =="
if PATH="$FAKE_GITLEAKS_DIR:$PATH" cb schedule install --backend file --dir "$SRC" --scan-secrets bogus --no-load > "$TMP/install-scan-bad.log" 2>&1; then
  echo "[FAIL] install --scan-secrets bogus was accepted"; cat "$TMP/install-scan-bad.log"; exit 1
fi
grep -q 'warn or deny' "$TMP/install-scan-bad.log" || { echo "[FAIL] the bad-mode refusal does not say what the valid modes are"; cat "$TMP/install-scan-bad.log"; exit 1; }
# ISOLATED_PATH_DIR (built in (a4)) holds only `sh`, so gitleaks is guaranteed
# unresolvable regardless of what the real host has installed.
if PATH="$ISOLATED_PATH_DIR" "$NODE_BIN" "${BIN_DEV_ARGS[@]}" "$BIN" schedule install --backend file --dir "$SRC" --scan-secrets deny --no-load > "$TMP/install-scan-missing.log" 2>&1; then
  echo "[FAIL] install --scan-secrets deny was accepted with no gitleaks resolvable"; cat "$TMP/install-scan-missing.log"; exit 1
fi
grep -qi 'gitleaks' "$TMP/install-scan-missing.log" || { echo "[FAIL] the refusal does not name the missing gitleaks binary"; cat "$TMP/install-scan-missing.log"; exit 1; }
# An EXPLICIT CYPHER_BRAIN_GITLEAKS_BIN is resolved and validated, not trusted (multi-model
# review round 5): a bare name is a fine interactive setting and a useless baked one, and a
# stale path is worse — either would install a nightly that fails every run.
if CYPHER_BRAIN_GITLEAKS_BIN="$TMP/definitely-not-here/gitleaks" PATH="$FAKE_GITLEAKS_DIR:$PATH" \
   cb schedule install --backend file --dir "$SRC" --scan-secrets deny --no-load > "$TMP/install-scan-badbin.log" 2>&1; then
  echo "[FAIL] an explicit CYPHER_BRAIN_GITLEAKS_BIN pointing at nothing was accepted"; cat "$TMP/install-scan-badbin.log"; exit 1
fi
grep -q 'could not be resolved to an executable' "$TMP/install-scan-badbin.log" || { echo "[FAIL] the bad-override refusal does not say the configured binary could not be resolved"; cat "$TMP/install-scan-badbin.log"; exit 1; }
# A bare-name override resolves through PATH and is baked ABSOLUTE, never verbatim.
CYPHER_BRAIN_GITLEAKS_BIN=gitleaks PATH="$FAKE_GITLEAKS_DIR:$PATH" \
  cb schedule install --backend file --dir "$SRC" --scan-secrets deny --no-load > "$TMP/install-scan-barebin.log" 2>&1 \
  || { echo "[FAIL] a bare-name CYPHER_BRAIN_GITLEAKS_BIN override was refused even though PATH could resolve it"; cat "$TMP/install-scan-barebin.log"; exit 1; }
grep -qF "export CYPHER_BRAIN_GITLEAKS_BIN='$FAKE_GITLEAKS_DIR/gitleaks'" "$RUNNER" \
  || { echo "[FAIL] a bare-name override was baked verbatim instead of resolved to an absolute path — the nightly would fail under the scheduler's bare PATH"; grep -n GITLEAKS "$RUNNER"; exit 1; }
# A trailing --scan-secrets (mode omitted) used to parse as `undefined`, i.e. exactly like
# "flag not passed": install exited 0 and wrote a runner with no scan. That is the same
# silent-drop this whole issue is about, so it gets its own tripwire.
if PATH="$FAKE_GITLEAKS_DIR:$PATH" cb schedule install --backend file --dir "$SRC" --no-load --scan-secrets > "$TMP/install-scan-noval.log" 2>&1; then
  echo "[FAIL] a trailing --scan-secrets (no mode) was accepted — install would write a runner with no scan"; cat "$TMP/install-scan-noval.log"; exit 1
fi
grep -q -- '--scan-secrets requires a value' "$TMP/install-scan-noval.log" || { echo "[FAIL] the dangling-flag refusal does not name --scan-secrets"; cat "$TMP/install-scan-noval.log"; exit 1; }
# #307: --pg-only + --scan-secrets would install a nightly that scans zero components
# while `schedule status` reports the mode as in effect.
if PATH="$FAKE_GITLEAKS_DIR:$PATH" cb schedule install --backend file --pg "postgres://x/y" --scan-secrets deny --no-load > "$TMP/install-scan-nosrc.log" 2>&1; then
  echo "[FAIL] --scan-secrets with only --pg was accepted — the nightly would report a scan of no component"; cat "$TMP/install-scan-nosrc.log"; exit 1
fi
grep -q 'nothing to scan' "$TMP/install-scan-nosrc.log" || { echo "[FAIL] the no-source refusal does not say the scan would have no component to look at"; cat "$TMP/install-scan-nosrc.log"; exit 1; }
echo "[PASS] install refuses a bad --scan-secrets mode, a dangling --scan-secrets, a source-less --scan-secrets, and a gitleaks it cannot resolve"

echo "== (a6d) #301: an install WITHOUT --scan-secrets resolves the EFFECTIVE mode now and bakes it in, both ways =="
# Replaces the pre-#301 assertion that omitting the flag left the runner untouched. The
# point of baking it either way is that the nightly's behaviour is decided at install time,
# in this environment, rather than re-derived at 03:30 from whatever is on the scheduler's
# PATH by then. Both branches are FORCED here rather than left to whatever the host has, so
# this proves the rule on every machine.
PATH="$FAKE_GITLEAKS_DIR:$PATH" cb schedule install --backend file --dir "$SRC" --no-load > "$TMP/install-noscan.log" 2>&1 \
  || { echo "[FAIL] reinstall without --scan-secrets (gitleaks resolvable) exited non-zero"; cat "$TMP/install-noscan.log"; exit 1; }
grep -q -- "--scan-secrets 'warn'" "$RUNNER" \
  || { echo "[FAIL] with gitleaks resolvable, an install naming no mode did not bake the warn default"; grep -n 'snapshot ' "$RUNNER"; exit 1; }
grep -q 'CYPHER_BRAIN_GITLEAKS_BIN=' "$RUNNER" \
  || { echo "[FAIL] the defaulted scan did not pin the scanner it resolved"; exit 1; }
grep -q 'defaults to warn' "$TMP/install-noscan.log" \
  || { echo "[FAIL] install did not say that the mode it baked came from the default"; cat "$TMP/install-noscan.log"; exit 1; }
cb schedule status > "$TMP/status-defscan.log" 2>&1 || { echo "[FAIL] status (defaulted-scan schedule) exited non-zero"; exit 1; }
grep -q 'secret scan: configured --scan-secrets warn' "$TMP/status-defscan.log" \
  || { echo "[FAIL] status does not report the defaulted mode as configured"; cat "$TMP/status-defscan.log"; exit 1; }

# ISOLATED_PATH_DIR holds only `sh`, so gitleaks is guaranteed unresolvable. The default
# must then bake `off` — NOT leave the flag out, which is what would let a gitleaks that
# appears later silently change what the nightly does.
PATH="$ISOLATED_PATH_DIR" "$NODE_BIN" "${BIN_DEV_ARGS[@]}" "$BIN" schedule install --backend file --dir "$SRC" --no-load > "$TMP/install-offscan.log" 2>&1 \
  || { echo "[FAIL] reinstall without --scan-secrets (no gitleaks) exited non-zero — an absent scanner must not fail an install that did not ask for one"; cat "$TMP/install-offscan.log"; exit 1; }
grep -q -- "--scan-secrets 'off'" "$RUNNER" \
  || { echo "[FAIL] with no gitleaks, the install did not bake an explicit off"; grep -n 'snapshot ' "$RUNNER"; exit 1; }
if grep -qi 'gitleaks' "$RUNNER"; then echo "[FAIL] an off runner still pins/mentions gitleaks"; exit 1; fi
grep -q 'secret scan: OFF' "$TMP/install-offscan.log" \
  || { echo "[FAIL] install did not say the schedule will not scan"; cat "$TMP/install-offscan.log"; exit 1; }
cb schedule status > "$TMP/status-noscan.log" 2>&1 || { echo "[FAIL] status (no-scan schedule) exited non-zero"; exit 1; }
grep -q 'secret scan: off' "$TMP/status-noscan.log" || { echo "[FAIL] status does not report that this schedule does NOT scan"; cat "$TMP/status-noscan.log"; exit 1; }
echo "[PASS] omitting --scan-secrets bakes the resolved effective mode (warn + pinned scanner, or off) instead of leaving the nightly to decide later"

echo "== (b) paid backend: refused without --max-spend, spend lines written with it =="
if cb schedule install --backend turbo --dir "$SRC" --no-load > "$TMP/turbo-refuse.log" 2>&1; then
  echo "[FAIL] install --backend turbo WITHOUT --max-spend was accepted"; exit 1
fi
grep -q -- '--max-spend' "$TMP/turbo-refuse.log" || { echo "[FAIL] refusal does not name --max-spend"; cat "$TMP/turbo-refuse.log"; exit 1; }
cb schedule install --backend turbo --dir "$SRC" --max-spend 500000 --no-load > "$TMP/install-turbo.log" 2>&1 \
  || { echo "[FAIL] install (turbo, --max-spend) exited non-zero"; cat "$TMP/install-turbo.log"; exit 1; }
grep -q '^export CYPHER_BRAIN_YES=1$' "$RUNNER" || { echo "[FAIL] paid runner lacks CYPHER_BRAIN_YES=1"; exit 1; }
grep -q '^export CYPHER_BRAIN_MAX_SPEND=500000$' "$RUNNER" || { echo "[FAIL] paid runner lacks CYPHER_BRAIN_MAX_SPEND=500000"; exit 1; }
grep -q 'CYPHER_BRAIN_MAX_SPEND=500000' "$TMP/install-turbo.log" || { echo "[FAIL] install did not tell the user to review the cap"; exit 1; }
echo "[PASS] paid backend: uncapped install refused; capped install writes both env lines"

echo "== (c) the generated runner RUNS end-to-end, TWICE in immediate succession (retry-safe, file backend, temp env) =="
cb schedule install --backend file --dir "$SRC" --no-load > /dev/null 2>&1 \
  || { echo "[FAIL] reinstall (file) exited non-zero"; exit 1; }
TODAY="$(date +%F)"
TODAY_COMPACT="$(date +%Y%m%d)" # matches the STAMP="$(date +%Y%m%dT%H%M%S)" the runner names snapshots with
LOG="$CYPHER_BRAIN_SCHEDULE_DIR/logs/nightly-$TODAY.log"
LOCFILE="$CYPHER_BRAIN_HOME/latest-locator.tsv"
IDX="$CYPHER_BRAIN_SCHEDULE_DIR/index.tsv"
SNAP_DIR="$CYPHER_BRAIN_SCHEDULE_DIR/snapshots"

bash "$RUNNER" || { echo "[FAIL] first runner invocation exited non-zero"; cat "$LOG" 2>/dev/null; exit 1; }
STORE_COUNT_1="$(find "$CYPHER_BRAIN_FILE_DIR" -maxdepth 1 -name '*.age' 2>/dev/null | wc -l | tr -d ' ')"
# Same-day immediate re-run (manual test-on-install-day / retry-after-failure): must
# NOT collide with run 1's snapshot name (this is the exact issue #69 regression). $SRC
# is byte-identical to run 1 (nothing wrote to it in between), so this second run is
# ALSO the #100 regression test: the runner's push line must carry --skip-unchanged and
# actually skip the re-upload rather than silently re-paying/re-storing every night.
bash "$RUNNER" || { echo "[FAIL] second runner invocation (same day, immediate retry) exited non-zero — retry-unsafe"; cat "$LOG" 2>/dev/null; exit 1; }
STORE_COUNT_2="$(find "$CYPHER_BRAIN_FILE_DIR" -maxdepth 1 -name '*.age' 2>/dev/null | wc -l | tr -d ' ')"

[ -f "$LOG" ] || { echo "[FAIL] dated log not produced: $LOG"; exit 1; }
tail -n 1 "$LOG" | grep -q '^OK rc=0$' || { echo "[FAIL] log does not end with OK rc=0 after the second run"; tail -n 3 "$LOG"; exit 1; }
grep -q 'SKIPPED: content, recipients and signing unchanged' "$LOG" || { echo "[FAIL] #100: second same-day run (identical \$SRC content) did not SKIP the re-upload — the runner's --skip-unchanged is not wired in / not working"; tail -n 20 "$LOG"; exit 1; }
[ "$STORE_COUNT_2" = "$STORE_COUNT_1" ] || { echo "[FAIL] #100: the file backend store gained a new object on the second (unchanged-content) run — expected $STORE_COUNT_1, got $STORE_COUNT_2 (skip-unchanged did not prevent the re-upload)"; exit 1; }
SNAP_COUNT="$(find "$SNAP_DIR" -maxdepth 1 -name "brain-$TODAY_COMPACT*.age" | wc -l | tr -d ' ')"
[ "$SNAP_COUNT" = "2" ] || { echo "[FAIL] expected 2 distinct dated snapshots after 2 same-day runs, got $SNAP_COUNT"; find "$SNAP_DIR" -maxdepth 1 -name "brain-$TODAY_COMPACT*.age"; exit 1; }
[ -f "$LOCFILE" ] || { echo "[FAIL] --save-locator file not written: $LOCFILE"; exit 1; }
[ "$(awk -F'\t' '{print NF; exit}' "$LOCFILE")" = "5" ] || { echo "[FAIL] locator file is not 5 tab-separated fields (locator/backend/sha256/content_digest/recipients_fingerprint — snapshot always writes both sidecars, #70)"; exit 1; }
[ "$(awk -F'\t' '{print $2; exit}' "$LOCFILE")" = "file" ] || { echo "[FAIL] locator file backend != file"; exit 1; }
[ "$(wc -l < "$IDX" | tr -d ' ')" = "2" ] || { echo "[FAIL] index.tsv does not have exactly 2 appended lines after 2 runs"; exit 1; }
[ "$(awk -F'\t' '{print NF; exit}' "$IDX")" = "3" ] || { echo "[FAIL] index.tsv line is not timestamp/locator/sha256"; exit 1; }
# The skipped 2nd run must have re-used run 1's locator+sha (read back from the
# save-locator file's 3rd field, #100) — both index.tsv lines should therefore carry the
# SAME locator+sha, only the leading timestamp differs.
[ "$(awk -F'\t' '{print $2"\t"$3}' "$IDX" | sort -u | wc -l | tr -d ' ')" = "1" ] || { echo "[FAIL] #100: index.tsv locator/sha256 differ between the two runs even though the 2nd run skipped (expected the same locator+sha reused from the save-locator file)"; cat "$IDX"; exit 1; }
SNAP="$(find "$SNAP_DIR" -maxdepth 1 -name "brain-$TODAY_COMPACT*.age" | sort | tail -n 1)"
cb pull --from-locator-file "$LOCFILE" --out "$TMP/got.age" > /dev/null 2>&1 || { echo "[FAIL] pull via the saved locator failed"; exit 1; }
cb verify --in "$TMP/got.age" > "$TMP/verify.log" 2>&1 || { echo "[FAIL] verify on the pulled snapshot failed"; cat "$TMP/verify.log"; exit 1; }
grep -q 'VERDICT: PASS' "$TMP/verify.log" || { echo "[FAIL] verify verdict is not PASS"; exit 1; }
echo "[PASS] runner end-to-end, twice same day: 2 distinct dated snapshots, 2nd push SKIPPED (#100, no new store object, index.tsv reuses the locator+sha) + trailing OK rc=0 + pull-back verify PASS"

echo "== (c1b) genuinely CHANGED \$SRC content on a same-day 3rd run: a real re-upload happens, not a false SKIP (#100 coverage: --skip-unchanged must never suppress an actual content change) =="
LOG_LINES_BEFORE_RUN3="$(wc -l < "$LOG" | tr -d ' ')"
echo "a-different-thought" >> "$SRC/note.txt"
bash "$RUNNER" || { echo "[FAIL] third runner invocation (changed \$SRC content) exited non-zero"; cat "$LOG" 2>/dev/null; exit 1; }
STORE_COUNT_3="$(find "$CYPHER_BRAIN_FILE_DIR" -maxdepth 1 -name '*.age' 2>/dev/null | wc -l | tr -d ' ')"
[ "$STORE_COUNT_3" = "$((STORE_COUNT_2 + 1))" ] || { echo "[FAIL] #100: changed \$SRC content did not add exactly 1 new object to the file backend store (expected $((STORE_COUNT_2 + 1)), got $STORE_COUNT_3) — skip-unchanged must never suppress a real content change"; exit 1; }
RUN3_LOG="$(tail -n "+$((LOG_LINES_BEFORE_RUN3 + 1))" "$LOG")"
if echo "$RUN3_LOG" | grep -q 'SKIPPED:'; then echo "[FAIL] #100: the 3rd run (changed content) was wrongly SKIPPED"; echo "$RUN3_LOG"; exit 1; fi
echo "$RUN3_LOG" | grep -q '^pushed -> file:' || { echo "[FAIL] 3rd run log lacks the pushed confirmation line"; echo "$RUN3_LOG"; exit 1; }
tail -n 1 "$LOG" | grep -q '^OK rc=0$' || { echo "[FAIL] log does not end with OK rc=0 after the 3rd (changed-content) run"; tail -n 3 "$LOG"; exit 1; }
[ "$(wc -l < "$IDX" | tr -d ' ')" = "3" ] || { echo "[FAIL] index.tsv does not have exactly 3 appended lines after 3 runs (2 unchanged + 1 changed)"; cat "$IDX"; exit 1; }
[ "$(awk -F'\t' '{print $2"\t"$3}' "$IDX" | sort -u | wc -l | tr -d ' ')" = "2" ] || { echo "[FAIL] #100: index.tsv should now have exactly 2 DISTINCT locator+sha pairs (the 2 unchanged runs sharing one, the changed run with a new one)"; cat "$IDX"; exit 1; }
echo "[PASS] a genuinely changed \$SRC on a same-day 3rd run triggers a REAL re-upload (new store object, new locator+sha in index.tsv, no false SKIPPED) — --skip-unchanged never suppresses an actual content change"

echo "== (d) status reports time, backend, last log rc, next run =="
cb schedule status > "$TMP/status.log" 2>&1 || { echo "[FAIL] status exited non-zero"; cat "$TMP/status.log"; exit 1; }
grep -q 'daily at 03:30' "$TMP/status.log" || { echo "[FAIL] status lacks the configured time"; exit 1; }
grep -q 'backend file' "$TMP/status.log" || { echo "[FAIL] status lacks the backend"; exit 1; }
grep -q "nightly-$TODAY.log — OK rc=0" "$TMP/status.log" || { echo "[FAIL] status lacks the last log + rc line"; cat "$TMP/status.log"; exit 1; }
grep -q 'next run: ' "$TMP/status.log" || { echo "[FAIL] status lacks the next scheduled run"; exit 1; }
echo "[PASS] status: configured time + backend + last rc + next run"

echo "== issue #211: status --json prints the SAME state as one JSON line, human output unchanged =="
SJOUT=$(cb schedule status --json)
LINES=$(printf '%s\n' "$SJOUT" | wc -l | tr -d ' ')
[ "$LINES" = "1" ] || { echo "FAIL: schedule status --json printed $LINES stdout line(s), expected exactly 1"; echo "$SJOUT"; exit 1; }
node -e "
const j = JSON.parse(process.argv[1]);
if (j.configured.at !== '03:30') throw new Error('expected configured.at 03:30, got ' + j.configured.at);
if (j.configured.backend !== 'file') throw new Error('expected configured.backend file, got ' + j.configured.backend);
if (typeof j.runner !== 'string' || j.runner.length === 0) throw new Error('expected a non-empty runner path');
if (!j.last_run || !/^nightly-.*\.log$/.test(j.last_run.log)) throw new Error('expected last_run.log to name a nightly log, got ' + JSON.stringify(j.last_run));
if (j.last_run.rc_line !== 'OK rc=0') throw new Error('expected last_run.rc_line OK rc=0, got ' + j.last_run.rc_line);
if (typeof j.next_run !== 'string' || j.next_run.length === 0) throw new Error('expected a non-empty next_run');
if (!j.trigger || typeof j.trigger.loaded !== 'string') throw new Error('expected trigger.loaded to be a string');
if (j.trigger.legacy !== false) throw new Error('expected trigger.legacy false for a freshly-installed schedule');
if (j.installed !== true) throw new Error('expected installed:true for an installed schedule (#426), got ' + JSON.stringify(j.installed));
" "$SJOUT"
echo "[PASS] status --json: one JSON line; configured/runner/last_run/next_run/trigger/installed all correct"

echo "== (c2) a failing run leaves a trailing FAILED rc=N line (heartbeat contract) =="
CYPHER_BRAIN_SCHEDULE_DIR="$TMP/sched-fail" cb schedule install --backend file --dir "$TMP/does-not-exist" --no-load > /dev/null 2>&1 \
  || { echo "[FAIL] install (failure fixture) exited non-zero"; exit 1; }
if bash "$TMP/sched-fail/nightly.sh"; then echo "[FAIL] runner with a missing --dir succeeded"; exit 1; fi
tail -n 1 "$TMP/sched-fail/logs/nightly-$TODAY.log" | grep -q '^FAILED rc=[0-9][0-9]*$' \
  || { echo "[FAIL] failing run did not end the log with FAILED rc=N"; tail -n 3 "$TMP/sched-fail/logs/nightly-$TODAY.log"; exit 1; }
echo "[PASS] failing run: non-zero exit + trailing FAILED rc=N in the dated log"

echo "== (c3) a CYPHER_BRAIN_HOME containing an XML metacharacter ('&') still produces a VALID, well-formed launchd plist (macOS only) =="
if [ "$OS" = "Darwin" ]; then
  AMP_HOME="$TMP/home & co" # plausible in a real $HOME/username; must not corrupt the plist
  mkdir -p "$AMP_HOME"
  AMP_LAUNCHD_DIR="$TMP/launchagents-amp"
  AMP_PLIST="$AMP_LAUNCHD_DIR/dev.cypher-brain.nightly.$(home_hash "$AMP_HOME").plist"
  # CYPHER_BRAIN_SCHEDULE_DIR is exported globally at top of this script (pointing at
  # $TMP/sched, no '&'), so it must be overridden here too — otherwise it would win over
  # CYPHER_BRAIN_HOME and the runner path baked into the plist would never see the '&'.
  CYPHER_BRAIN_HOME="$AMP_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$AMP_HOME/sched" CYPHER_BRAIN_LAUNCHD_DIR="$AMP_LAUNCHD_DIR" \
    cb schedule install --backend file --dir "$SRC" --no-load > "$TMP/install-amp.log" 2>&1 \
    || { echo "[FAIL] install with an '&' in CYPHER_BRAIN_HOME exited non-zero"; cat "$TMP/install-amp.log"; exit 1; }
  [ -f "$AMP_PLIST" ] || { echo "[FAIL] plist not written for the '&'-containing home: $AMP_PLIST"; exit 1; }
  plutil -lint "$AMP_PLIST" > "$TMP/plutil.log" 2>&1 || { echo "[FAIL] plutil -lint rejects the generated plist (invalid XML)"; cat "$TMP/plutil.log"; cat "$AMP_PLIST"; exit 1; }
  grep -q '&amp;' "$AMP_PLIST" || { echo "[FAIL] plist does not contain the escaped '&amp;' for the runner path"; cat "$AMP_PLIST"; exit 1; }
  if grep -qF ' & co' "$AMP_PLIST"; then echo "[FAIL] plist contains a raw un-escaped '&' — invalid XML"; exit 1; fi
  # Round-trip: plutil -p decodes entities back to plain text — the '&'-containing home
  # dir must reappear verbatim, proving the escape is reversible (not just well-formed).
  plutil -p "$AMP_PLIST" | grep -qF "$AMP_HOME" || { echo "[FAIL] plutil -p does not decode the plist back to the original '&'-containing path"; plutil -p "$AMP_PLIST"; exit 1; }
  echo "[PASS] plist with an '&' in CYPHER_BRAIN_HOME is valid, well-formed XML (plutil -lint) and round-trips to the original path (plutil -p)"
else
  echo "[SKIP] plist XML-escape check (macOS only — this platform registers a crontab entry, not a plist)"
fi

echo "== (c4) --index-file under a NOT-YET-EXISTING nested directory: the runner creates it before appending (a successful, possibly-paid push must never turn into a FAILED run just because the index dir does not exist yet — a naive retry after a false FAILED could re-upload and pay again) =="
IDX_NESTED_DIR="$TMP/idx-parent/does-not-exist-yet/deeper"
[ ! -d "$IDX_NESTED_DIR" ] || { echo "[FAIL] test setup invalid: $IDX_NESTED_DIR already exists"; exit 1; }
cb schedule install --backend file --dir "$SRC" --index-file "$IDX_NESTED_DIR/index.tsv" --no-load > "$TMP/install-idxnest.log" 2>&1 \
  || { echo "[FAIL] install (--index-file under a nested nonexistent dir) exited non-zero"; cat "$TMP/install-idxnest.log"; exit 1; }
[ ! -d "$IDX_NESTED_DIR" ] || { echo "[FAIL] install must not itself create the index-file directory (only the runner does, at run time)"; exit 1; }
bash "$RUNNER" || { echo "[FAIL] runner with a not-yet-existing --index-file directory exited non-zero"; tail -n 20 "$LOG" 2>/dev/null; exit 1; }
[ -f "$IDX_NESTED_DIR/index.tsv" ] || { echo "[FAIL] index file was not created under the nested directory"; exit 1; }
[ "$(wc -l < "$IDX_NESTED_DIR/index.tsv" | tr -d ' ')" = "1" ] || { echo "[FAIL] index file does not have exactly 1 appended line"; cat "$IDX_NESTED_DIR/index.tsv"; exit 1; }
[ "$(awk -F'\t' '{print NF; exit}' "$IDX_NESTED_DIR/index.tsv")" = "3" ] || { echo "[FAIL] index line is not timestamp/locator/sha256"; exit 1; }
tail -n 1 "$LOG" | grep -q '^OK rc=0$' || { echo "[FAIL] log does not end with OK rc=0 after the nested-index-dir run"; tail -n 3 "$LOG"; exit 1; }
echo "[PASS] runner mkdir -p's the --index-file's parent directory before appending, on a not-yet-existing nested path"

echo "== (e0) uninstall --no-load is a pure status report: never orphans a live trigger by deleting only the files (#113) =="
# Symmetric with install's --no-load ("write artifacts, don't touch launchd/crontab"):
# uninstall's --no-load must not touch launchd/crontab EITHER — and, unlike install,
# that means it must also leave the runner/config/plist(or cron entry) alone, since
# deleting them while the trigger is still registered would orphan a live launchd/cron
# job pointing at a script that no longer exists (the exact #113 regression). This is a
# pure file-existence check — no launchd/crontab call happens on this path at all.
[ -f "$RUNNER" ] || { echo "[FAIL] test setup: runner missing before (e0)"; exit 1; }
[ -f "$CONFIG" ] || { echo "[FAIL] test setup: config missing before (e0)"; exit 1; }
cb schedule uninstall --no-load > "$TMP/uninstall-noload.log" 2>&1 || { echo "[FAIL] uninstall --no-load exited non-zero"; cat "$TMP/uninstall-noload.log"; exit 1; }
[ -f "$RUNNER" ] || { echo "[FAIL] #113: uninstall --no-load deleted the runner — would orphan a still-registered trigger"; exit 1; }
[ -f "$CONFIG" ] || { echo "[FAIL] #113: uninstall --no-load deleted schedule.json — would orphan a still-registered trigger"; exit 1; }
if [ "$OS" = "Darwin" ]; then
  [ -f "$PLIST" ] || { echo "[FAIL] #113: uninstall --no-load deleted the plist"; exit 1; }
else
  [ -f "$CRON_ENTRY" ] || { echo "[FAIL] #113: uninstall --no-load deleted the cron entry file"; exit 1; }
fi
grep -q -- '--no-load: nothing removed' "$TMP/uninstall-noload.log" || { echo "[FAIL] uninstall --no-load did not report that nothing was removed"; cat "$TMP/uninstall-noload.log"; exit 1; }
grep -q 'still live' "$TMP/uninstall-noload.log" || { echo "[FAIL] uninstall --no-load did not explain the trigger registration is still live"; cat "$TMP/uninstall-noload.log"; exit 1; }
echo "[PASS] uninstall --no-load: pure status report — no files removed, launchd/crontab untouched, explains why"

echo "== (e) uninstall (no --no-load) removes trigger + runner; second uninstall is a clean no-op =="
if [ "$OS" != "Darwin" ] && [ "$HAS_CRONTAB" = "0" ]; then
  echo "[SKIP] uninstall (real removal) — this host has no crontab binary (Linux, non-Darwin CI image gap, not a cypher-brain issue)"
else
  # No --no-load this time: every install above used --no-load, so nothing was ever REALLY
  # registered — the launchctl bootout / crontab edit below hit the HOME-scoped (#114)
  # LABEL/CRON_MARKER, which is unique to this test's throwaway CYPHER_BRAIN_HOME and can
  # never match a real, machine-wide schedule, so this is safe to run for real.
  cb schedule uninstall > "$TMP/uninstall1.log" 2>&1 || { echo "[FAIL] uninstall exited non-zero"; cat "$TMP/uninstall1.log"; exit 1; }
  [ ! -f "$RUNNER" ] || { echo "[FAIL] runner still present after uninstall"; exit 1; }
  [ ! -f "$CONFIG" ] || { echo "[FAIL] schedule.json still present after uninstall"; exit 1; }
  if [ "$OS" = "Darwin" ]; then
    [ ! -f "$PLIST" ] || { echo "[FAIL] plist still present after uninstall"; exit 1; }
  else
    [ ! -f "$CRON_ENTRY" ] || { echo "[FAIL] cron entry artifact still present after uninstall"; exit 1; }
  fi
  grep -q 'removed: ' "$TMP/uninstall1.log" || { echo "[FAIL] uninstall did not report what it removed"; exit 1; }
  [ -f "$LOG" ] || { echo "[FAIL] uninstall must KEEP the logs"; exit 1; }
  [ -f "$SNAP" ] || { echo "[FAIL] uninstall must KEEP the snapshots"; exit 1; }
  [ -f "$IDX" ] || { echo "[FAIL] uninstall must KEEP index.tsv"; exit 1; }
  cb schedule uninstall > "$TMP/uninstall2.log" 2>&1 || { echo "[FAIL] second uninstall exited non-zero (must be idempotent)"; exit 1; }
  grep -q 'nothing to remove' "$TMP/uninstall2.log" || { echo "[FAIL] second uninstall did not report a no-op"; exit 1; }
  # #426: "not installed" is a normal, exit-0 status result (matching doctor.ts's own
  # [SKIP]-not-fail treatment of the identical fact), not an error -- a status QUERY
  # asking "is anything configured?" is answered truthfully by reporting "no", the same
  # way `schedule uninstall`'s own "nothing to remove" already exits 0 above.
  cb schedule status > "$TMP/status-after-uninstall.log" 2>&1 \
    || { echo "[FAIL] status after uninstall exited non-zero (should be a normal exit-0 'not installed' result, #426)"; cat "$TMP/status-after-uninstall.log"; exit 1; }
  grep -qF "not installed" "$TMP/status-after-uninstall.log" \
    || { echo "[FAIL] status after uninstall did not report 'not installed'"; cat "$TMP/status-after-uninstall.log"; exit 1; }
  SJ_UNINSTALLED=$(cb schedule status --json)
  [ "$SJ_UNINSTALLED" = '{"installed":false}' ] \
    || { echo "[FAIL] status --json after uninstall was [$SJ_UNINSTALLED], expected {\"installed\":false}"; exit 1; }
  echo "[PASS] uninstall: trigger + runner removed, data kept, idempotent; status exits 0 and reports 'not installed' (plain + --json, #426)"
fi

echo "== (f) two different CYPHER_BRAIN_HOME schedules never collide: distinct LABEL/CRON_MARKER, installing/uninstalling one never touches the other's REAL registration (#114) =="
if [ "$OS" != "Darwin" ] && [ "$HAS_CRONTAB" = "0" ]; then
  echo "[SKIP] multi-home collision check — this host has no crontab binary"
else
  MHOME1="$TMP/multi-home1"; MHOME2="$TMP/multi-home2"
  MSRC1="$MHOME1/src"; MSRC2="$MHOME2/src"; mkdir -p "$MSRC1" "$MSRC2"
  echo one > "$MSRC1/f.txt"; echo two > "$MSRC2/f.txt"
  MSCHED1="$TMP/multi-sched1"; MSCHED2="$TMP/multi-sched2"
  MLAUNCHD="$TMP/multi-launchagents" # a SHARED dir, like the real ~/Library/LaunchAgents
  mkdir -p "$MLAUNCHD"
  MH1="$(home_hash "$MHOME1")"; MH2="$(home_hash "$MHOME2")"
  [ "$MH1" != "$MH2" ] || { echo "[FAIL] two different CYPHER_BRAIN_HOME produced the SAME label/marker hash"; exit 1; }

  # These two installs are NOT --no-load — real launchctl/crontab registration — but that
  # is safe: LABEL/CRON_MARKER are hash-derived from CYPHER_BRAIN_HOME (#114), so MH1/MH2
  # are guaranteed unique to this run and can never match a real, machine-wide schedule.
  # Guard with a trap so a failure partway through this block still unregisters both real
  # jobs before the script exits (a leaked real trigger pointing at a $TMP dir that is
  # about to be deleted is exactly the #113 orphan bug this whole file guards against).
  cleanup_multi_home() {
    CYPHER_BRAIN_HOME="$MHOME1" CYPHER_BRAIN_SCHEDULE_DIR="$MSCHED1" CYPHER_BRAIN_LAUNCHD_DIR="$MLAUNCHD" cb schedule uninstall > /dev/null 2>&1 || true
    CYPHER_BRAIN_HOME="$MHOME2" CYPHER_BRAIN_SCHEDULE_DIR="$MSCHED2" CYPHER_BRAIN_LAUNCHD_DIR="$MLAUNCHD" cb schedule uninstall > /dev/null 2>&1 || true
  }
  trap 'cleanup_multi_home; rm -rf "$TMP"' EXIT

  CYPHER_BRAIN_HOME="$MHOME1" CYPHER_BRAIN_SCHEDULE_DIR="$MSCHED1" CYPHER_BRAIN_LAUNCHD_DIR="$MLAUNCHD" \
    cb schedule install --backend file --dir "$MSRC1" > "$TMP/multi-install1.log" 2>&1 \
    || { echo "[FAIL] multi-home install 1 exited non-zero"; cat "$TMP/multi-install1.log"; exit 1; }
  CYPHER_BRAIN_HOME="$MHOME2" CYPHER_BRAIN_SCHEDULE_DIR="$MSCHED2" CYPHER_BRAIN_LAUNCHD_DIR="$MLAUNCHD" \
    cb schedule install --backend file --dir "$MSRC2" > "$TMP/multi-install2.log" 2>&1 \
    || { echo "[FAIL] multi-home install 2 exited non-zero"; cat "$TMP/multi-install2.log"; exit 1; }

  if [ "$OS" = "Darwin" ]; then
    MP1="$MLAUNCHD/dev.cypher-brain.nightly.$MH1.plist"; MP2="$MLAUNCHD/dev.cypher-brain.nightly.$MH2.plist"
    [ -f "$MP1" ] || { echo "[FAIL] home1 plist missing after both installs: $MP1"; exit 1; }
    [ -f "$MP2" ] || { echo "[FAIL] home2 plist missing after both installs (#114: did it overwrite home1's file instead of writing a distinct one?)"; exit 1; }
    launchctl print "gui/$(id -u)/dev.cypher-brain.nightly.$MH1" > /dev/null 2>&1 \
      || { echo "[FAIL] #114: home1's launchd job is not loaded after home2 was installed — home2 clobbered it"; exit 1; }
    launchctl print "gui/$(id -u)/dev.cypher-brain.nightly.$MH2" > /dev/null 2>&1 \
      || { echo "[FAIL] home2's launchd job is not loaded"; exit 1; }
    CYPHER_BRAIN_HOME="$MHOME2" CYPHER_BRAIN_SCHEDULE_DIR="$MSCHED2" CYPHER_BRAIN_LAUNCHD_DIR="$MLAUNCHD" \
      cb schedule uninstall > "$TMP/multi-uninstall2.log" 2>&1 || { echo "[FAIL] home2 uninstall exited non-zero"; cat "$TMP/multi-uninstall2.log"; exit 1; }
    [ -f "$MP1" ] || { echo "[FAIL] #114: uninstalling home2 removed home1's plist"; exit 1; }
    launchctl print "gui/$(id -u)/dev.cypher-brain.nightly.$MH1" > /dev/null 2>&1 \
      || { echo "[FAIL] #114: uninstalling home2 unregistered home1's launchd job"; exit 1; }
  else
    crontab -l 2>/dev/null | grep -q "# cypher-brain-nightly:$MH1" \
      || { echo "[FAIL] home1's crontab entry missing after both installs"; exit 1; }
    crontab -l 2>/dev/null | grep -q "# cypher-brain-nightly:$MH2" \
      || { echo "[FAIL] #114: home2's crontab entry missing after both installs (did it overwrite home1's line?)"; exit 1; }
    CYPHER_BRAIN_HOME="$MHOME2" CYPHER_BRAIN_SCHEDULE_DIR="$MSCHED2" CYPHER_BRAIN_LAUNCHD_DIR="$MLAUNCHD" \
      cb schedule uninstall > "$TMP/multi-uninstall2.log" 2>&1 || { echo "[FAIL] home2 uninstall exited non-zero"; cat "$TMP/multi-uninstall2.log"; exit 1; }
    crontab -l 2>/dev/null | grep -q "# cypher-brain-nightly:$MH1" \
      || { echo "[FAIL] #114: uninstalling home2 removed home1's crontab entry"; exit 1; }
  fi
  cleanup_multi_home
  trap 'rm -rf "$TMP"' EXIT
  echo "[PASS] two different CYPHER_BRAIN_HOME schedules use distinct LABEL/CRON_MARKER; installing/uninstalling one never touches the other's real registration"
fi

echo "== (g) backward compat: a legacy (pre-#114, unscoped LABEL/CRON_MARKER) schedule is recognized by status and reported by uninstall --no-load (#114) =="
# Hand-craft what a pre-#114 `install` would have left behind for THIS home: a
# schedule.json whose trigger literally names the OLD unscoped plist/crontab-marker
# (exactly the shape install() used to write before this fix), plus a plist/cron.entry
# file at that legacy (unscoped, machine-wide) name. Detection-only coverage: this test
# deliberately never invokes a REAL launchctl/crontab mutation against the legacy
# identifier (see the file header) — it only exercises status's read-only launchctl
# print / crontab -l and uninstall --no-load's pure (mutation-free) report path.
LEGACY_HOME="$TMP/legacy-home"; LEGACY_SCHED="$TMP/legacy-sched"; LEGACY_LAUNCHD="$TMP/legacy-launchagents"
LEGACY_SRC="$LEGACY_HOME/src"; mkdir -p "$LEGACY_SRC" "$LEGACY_LAUNCHD"
echo legacy > "$LEGACY_SRC/f.txt"
CYPHER_BRAIN_HOME="$LEGACY_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$LEGACY_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$LEGACY_LAUNCHD" \
  cb schedule install --backend file --dir "$LEGACY_SRC" --no-load > "$TMP/legacy-install.log" 2>&1 \
  || { echo "[FAIL] legacy-fixture install exited non-zero"; cat "$TMP/legacy-install.log"; exit 1; }
if [ "$OS" = "Darwin" ]; then
  LEGACY_PLIST_PATH="$LEGACY_LAUNCHD/dev.cipher-brain.nightly.plist"
  NEW_PLIST_PATH="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$LEGACY_SCHED/schedule.json','utf8')).trigger.path)")"
  mv "$NEW_PLIST_PATH" "$LEGACY_PLIST_PATH"
  node -e "
    const fs = require('fs');
    const p = '$LEGACY_SCHED/schedule.json';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.trigger.path = '$LEGACY_PLIST_PATH';
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  "
  CYPHER_BRAIN_HOME="$LEGACY_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$LEGACY_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$LEGACY_LAUNCHD" \
    cb schedule status > "$TMP/legacy-status.log" 2>&1 || { echo "[FAIL] status on a legacy-format schedule exited non-zero"; cat "$TMP/legacy-status.log"; exit 1; }
  grep -qi 'legacy' "$TMP/legacy-status.log" || { echo "[FAIL] status did not flag the legacy unscoped launchd label"; cat "$TMP/legacy-status.log"; exit 1; }
  CYPHER_BRAIN_HOME="$LEGACY_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$LEGACY_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$LEGACY_LAUNCHD" \
    cb schedule uninstall --no-load > "$TMP/legacy-uninstall-noload.log" 2>&1 || { echo "[FAIL] uninstall --no-load on a legacy-format schedule exited non-zero"; cat "$TMP/legacy-uninstall-noload.log"; exit 1; }
  grep -q "legacy launchd plist" "$TMP/legacy-uninstall-noload.log" || { echo "[FAIL] uninstall --no-load did not report the legacy plist as present"; cat "$TMP/legacy-uninstall-noload.log"; exit 1; }
  [ -f "$LEGACY_PLIST_PATH" ] || { echo "[FAIL] uninstall --no-load must not delete the legacy plist either"; exit 1; }
  echo "[PASS] legacy-format schedule.json: status flags it, uninstall --no-load reports (but never deletes) the legacy plist"
else
  if [ "$HAS_CRONTAB" = "0" ]; then
    echo "[SKIP] legacy backward-compat check — this host has no crontab binary"
  else
    printf '30 3 * * * /bin/bash "%s" # cipher-brain-nightly\n' "$LEGACY_SCHED/nightly.sh" > "$LEGACY_SCHED/cron.entry"
    CYPHER_BRAIN_HOME="$LEGACY_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$LEGACY_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$LEGACY_LAUNCHD" \
      cb schedule status > "$TMP/legacy-status.log" 2>&1 || { echo "[FAIL] status on a legacy-format schedule exited non-zero"; cat "$TMP/legacy-status.log"; exit 1; }
    grep -qi 'legacy' "$TMP/legacy-status.log" || { echo "[FAIL] status did not flag the legacy unscoped crontab marker"; cat "$TMP/legacy-status.log"; exit 1; }
    echo "[PASS] legacy-format cron.entry: status flags the unscoped crontab marker"
  fi
fi

echo "== (g2) backward compat: a pre-rename (cipher-brain era, HOME-scoped) registration is recognized the same way =="
# Same detection-only shape as (g), for the OTHER earlier scheme: an install made under the
# old project name wrote `dev.cipher-brain.nightly.<hash>` / `# cipher-brain-nightly:<hash>`.
# It is this home's own recorded registration, so status must flag it and uninstall
# --no-load must report it — while a DIFFERENT home's cipher-brain-era entry (other hash)
# is never matched.
RN_HOME="$TMP/rename-home"; RN_SCHED="$TMP/rename-sched"; RN_LAUNCHD="$TMP/rename-launchagents"
RN_SRC="$RN_HOME/src"; mkdir -p "$RN_SRC" "$RN_LAUNCHD"
echo rename > "$RN_SRC/f.txt"
CYPHER_BRAIN_HOME="$RN_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$RN_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$RN_LAUNCHD" \
  cb schedule install --backend file --dir "$RN_SRC" --no-load > "$TMP/rename-install.log" 2>&1 \
  || { echo "[FAIL] rename-fixture install exited non-zero"; cat "$TMP/rename-install.log"; exit 1; }
if [ "$OS" = "Darwin" ]; then
  RN_NEW_PLIST="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RN_SCHED/schedule.json','utf8')).trigger.path)")"
  # what the same install would have been called before the rename: same hash, old brand
  RN_OLD_PLIST="$(printf '%s' "$RN_NEW_PLIST" | sed 's/dev\.cypher-brain\.nightly\./dev.cipher-brain.nightly./')"
  [ "$RN_OLD_PLIST" != "$RN_NEW_PLIST" ] || { echo "[FAIL] fixture: could not derive the pre-rename plist name from $RN_NEW_PLIST"; exit 1; }
  mv "$RN_NEW_PLIST" "$RN_OLD_PLIST"
  node -e "
    const fs = require('fs');
    const p = '$RN_SCHED/schedule.json';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.trigger.path = '$RN_OLD_PLIST';
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  "
  CYPHER_BRAIN_HOME="$RN_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$RN_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$RN_LAUNCHD" \
    cb schedule status > "$TMP/rename-status.log" 2>&1 || { echo "[FAIL] status on a pre-rename schedule exited non-zero"; cat "$TMP/rename-status.log"; exit 1; }
  grep -q 'legacy launchd label (dev.cipher-brain.nightly.' "$TMP/rename-status.log" || { echo "[FAIL] status did not flag the pre-rename (cipher-brain) launchd label"; cat "$TMP/rename-status.log"; exit 1; }
  CYPHER_BRAIN_HOME="$RN_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$RN_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$RN_LAUNCHD" \
    cb schedule uninstall --no-load > "$TMP/rename-uninstall-noload.log" 2>&1 || { echo "[FAIL] uninstall --no-load on a pre-rename schedule exited non-zero"; cat "$TMP/rename-uninstall-noload.log"; exit 1; }
  grep -q "legacy launchd plist $RN_OLD_PLIST" "$TMP/rename-uninstall-noload.log" || { echo "[FAIL] uninstall --no-load did not report the pre-rename plist as present"; cat "$TMP/rename-uninstall-noload.log"; exit 1; }
  [ -f "$RN_OLD_PLIST" ] || { echo "[FAIL] uninstall --no-load must not delete the pre-rename plist either"; exit 1; }
  echo "[PASS] pre-rename schedule.json: status flags the cipher-brain label, uninstall --no-load reports (never deletes) its plist"
else
  if [ "$HAS_CRONTAB" = "0" ]; then
    echo "[SKIP] pre-rename backward-compat check — this host has no crontab binary"
  else
    RN_NEW_LINE="$(cat "$RN_SCHED/cron.entry")"
    RN_OLD_LINE="$(printf '%s' "$RN_NEW_LINE" | sed 's/# cypher-brain-nightly:/# cipher-brain-nightly:/')"
    [ "$RN_OLD_LINE" != "$RN_NEW_LINE" ] || { echo "[FAIL] fixture: could not derive the pre-rename cron marker from: $RN_NEW_LINE"; exit 1; }
    printf '%s\n' "$RN_OLD_LINE" > "$RN_SCHED/cron.entry"
    CYPHER_BRAIN_HOME="$RN_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$RN_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$RN_LAUNCHD" \
      cb schedule status > "$TMP/rename-status.log" 2>&1 || { echo "[FAIL] status on a pre-rename schedule exited non-zero"; cat "$TMP/rename-status.log"; exit 1; }
    grep -q 'legacy crontab marker (# cipher-brain-nightly:' "$TMP/rename-status.log" || { echo "[FAIL] status did not flag the pre-rename (cipher-brain) crontab marker"; cat "$TMP/rename-status.log"; exit 1; }
    echo "[PASS] pre-rename cron.entry: status flags the cipher-brain crontab marker"
  fi
fi

echo "== (g3) ownership: a schedule.json recorded by a DIFFERENT home is never treated as this home's legacy registration =="
# Same shape as (g2) — a cipher-brain-era plist path — but schedule.json says the home is
# somewhere else. Reusing/retargeting SCHEDULE_DIR must not let this home unregister that
# other home's trigger (multi-model review): status must NOT flag it and uninstall --no-load
# must NOT list its plist.
OT_HOME="$TMP/other-home"; OT_SCHED="$TMP/other-sched"; OT_LAUNCHD="$TMP/other-launchagents"
OT_SRC="$OT_HOME/src"; mkdir -p "$OT_SRC" "$OT_LAUNCHD"
echo other > "$OT_SRC/f.txt"
CYPHER_BRAIN_HOME="$OT_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$OT_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$OT_LAUNCHD" \
  cb schedule install --backend file --dir "$OT_SRC" --no-load > "$TMP/other-install.log" 2>&1 \
  || { echo "[FAIL] other-home fixture install exited non-zero"; cat "$TMP/other-install.log"; exit 1; }
if [ "$OS" = "Darwin" ]; then
  OT_NEW_PLIST="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OT_SCHED/schedule.json','utf8')).trigger.path)")"
  OT_OLD_PLIST="$(printf '%s' "$OT_NEW_PLIST" | sed 's/dev\.cypher-brain\.nightly\./dev.cipher-brain.nightly./')"
  mv "$OT_NEW_PLIST" "$OT_OLD_PLIST"
  node -e "
    const fs = require('fs');
    const p = '$OT_SCHED/schedule.json';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.trigger.path = '$OT_OLD_PLIST';
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  "
  # Now read that same SCHEDULE_DIR from a DIFFERENT home.
  ME_HOME="$TMP/me-home"; mkdir -p "$ME_HOME"
  CYPHER_BRAIN_HOME="$ME_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$OT_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$OT_LAUNCHD" \
    cb schedule status > "$TMP/other-status.log" 2>&1 || true
  grep -qi 'legacy' "$TMP/other-status.log" && { echo "[FAIL] status flagged another home's registration as this home's legacy job"; cat "$TMP/other-status.log"; exit 1; }
  CYPHER_BRAIN_HOME="$ME_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$OT_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$OT_LAUNCHD" \
    cb schedule uninstall --no-load > "$TMP/other-uninstall-noload.log" 2>&1 || true
  grep -q "legacy launchd plist" "$TMP/other-uninstall-noload.log" && { echo "[FAIL] uninstall --no-load listed another home's plist as a legacy plist to remove"; cat "$TMP/other-uninstall-noload.log"; exit 1; }
  [ -f "$OT_OLD_PLIST" ] || { echo "[FAIL] another home's plist vanished"; exit 1; }
  echo "[PASS] a registration recorded by a different home is not treated as this home's legacy job"

  echo "== (g4) same label, moved plist: only the stale file is reported, the label itself is not a legacy job =="
  # LAUNCHD_DIR changed while the home stayed: the recorded plist path differs from the
  # current PLIST but its basename IS the current LABEL. Booting that label out after
  # loading it would unload the schedule just installed (multi-model review), so install
  # must treat it as "moved file", not "legacy job". Detection-only here (--no-load).
  MV_HOME="$TMP/mv-home"; MV_SCHED="$TMP/mv-sched"; MV_L1="$TMP/mv-launchagents-1"; MV_L2="$TMP/mv-launchagents-2"
  MV_SRC="$MV_HOME/src"; mkdir -p "$MV_SRC" "$MV_L1" "$MV_L2"
  echo mv > "$MV_SRC/f.txt"
  CYPHER_BRAIN_HOME="$MV_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$MV_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$MV_L1" \
    cb schedule install --backend file --dir "$MV_SRC" --no-load > "$TMP/mv-install-1.log" 2>&1 \
    || { echo "[FAIL] moved-plist fixture install (dir 1) exited non-zero"; cat "$TMP/mv-install-1.log"; exit 1; }
  MV_P1="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$MV_SCHED/schedule.json','utf8')).trigger.path)")"
  CYPHER_BRAIN_HOME="$MV_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$MV_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$MV_L2" \
    cb schedule install --backend file --dir "$MV_SRC" --no-load > "$TMP/mv-install-2.log" 2>&1 \
    || { echo "[FAIL] moved-plist fixture install (dir 2) exited non-zero"; cat "$TMP/mv-install-2.log"; exit 1; }
  # --no-load only writes; the prior (dir 1) plist is still there and status now reads a
  # cfg whose path is dir 2 — so probe the sameLabel path via a cfg that points at dir 1
  # while LAUNCHD_DIR is dir 2 (exactly the state right after the operator changed the dir).
  node -e "
    const fs = require('fs');
    const p = '$MV_SCHED/schedule.json';
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.trigger.path = '$MV_P1';
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n');
  "
  CYPHER_BRAIN_HOME="$MV_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$MV_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$MV_L2" \
    cb schedule uninstall --no-load > "$TMP/mv-uninstall-noload.log" 2>&1 || true
  grep -q "legacy launchd plist $MV_P1" "$TMP/mv-uninstall-noload.log" || { echo "[FAIL] uninstall --no-load did not report the moved (stale) plist file"; cat "$TMP/mv-uninstall-noload.log"; exit 1; }
  CYPHER_BRAIN_HOME="$MV_HOME" CYPHER_BRAIN_SCHEDULE_DIR="$MV_SCHED" CYPHER_BRAIN_LAUNCHD_DIR="$MV_L2" \
    cb schedule status --json > "$TMP/mv-status.json" 2>/dev/null || true
  node -e "
    const o = JSON.parse(require('fs').readFileSync('$TMP/mv-status.json','utf8'));
    const note = (o.trigger && o.trigger.legacy_note) || '';
    if (!/legacy launchd label \(dev\.cypher-brain\.nightly\./.test(note)) throw new Error('status did not describe the moved plist under its (current) label: ' + JSON.stringify(o.trigger));
  " || { echo "[FAIL] status --json did not describe the moved plist"; cat "$TMP/mv-status.json"; exit 1; }
  echo "[PASS] a moved plist under the current label is reported as a stale file, and its label is the current one"
else
  echo "[SKIP] (g3)/(g4) launchd-only checks — not macOS"
fi

echo
echo "SCHEDULE SELFTEST PASS"
