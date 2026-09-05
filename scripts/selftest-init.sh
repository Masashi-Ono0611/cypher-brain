#!/usr/bin/env bash
# Selftest for `cypher-brain init` (issue #68): the interactive setup wizard + its
# printable recovery kit. Covers both of the issue's acceptance criteria:
#
#   (1) "a fresh machine can go from init to first push through interaction alone" —
#       proven by driving a REAL child process's stdin with a scripted sequence of
#       answers via scripts/drive-init.mjs, which paces each answer to the prompt it
#       actually answers. A static `printf '...' | cb init` does NOT work here: this
#       wizard does real async work (keygen, disk writes) between prompts, and
#       Node's readline (non-TTY/piped mode) silently DROPS extra buffered 'line'
#       events that arrive while no question() is currently pending — dumping every
#       answer upfront wedges the wizard on a later prompt forever (confirmed while
#       building this test; see drive-init.mjs's header for the full explanation).
#
#   (2) THE DRILL: "using ONLY the recovery kit's contents, restore succeeds on a
#       different machine" — see the "THE DRILL" section below. It parses ONLY the
#       kit file's own text (never touches the wizard's live CYPHER_BRAIN_HOME) and
#       restores in a separate, fully isolated temp dir, the same "simulate a fresh
#       machine" discipline scripts/selftest-arweave-nodeps.mjs and
#       scripts/selftest-recovery.sh already use for their own recovery claims.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
# BIN_DEV_ARGS: literal argv flags to run bin/cypher-brain.mjs against src/*.ts (no
# build step) under plain node — see scripts/dev-node-flags.sh (never an exported
# NODE_OPTIONS string — whitespace-split, breaks under a checkout path with a space).
source "$ROOT/scripts/dev-node-flags.sh"
# cb/with_timeout/with_stdin_timeout: shared across scripts/selftest-*.sh, see
# scripts/selftest-lib.sh (#569, #572). with_timeout: a regression here (e.g. the
# wizard hanging on a dropped prompt) must FAIL LOUDLY within a bounded time, not
# hang the whole suite (rules/shell-ops.md — every poll/gate/interactive-drive
# call needs its OWN deadline, not just an outer one).
source "$ROOT/scripts/selftest-lib.sh"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# Point TMPDIR at a directory INSIDE $TMP (not the ambient system tmp) so that when
# with_timeout/with_stdin_timeout SIGKILLs a wedged wizard/CLI child, whatever staged
# plaintext it created (identity material, snapshot staging dirs, etc. -- none of
# which get a chance to run their own finally-block cleanup under SIGKILL) still lands
# under $TMP and is removed by the EXIT trap above, instead of leaking into the
# system-wide temp directory this script's own trap never touches.
export TMPDIR="$TMP/system-tmp"; mkdir -p "$TMPDIR"

# file_mode: portable octal permission-bits lookup. GNU coreutils `stat` (Linux,
# this repo's ubuntu-latest CI matrix cells) and BSD `stat` (macOS) both accept a
# `-f`/`-c` flag, but the SAME flag letter means something different on each: BSD
# `-f FORMAT` takes a custom format string, while GNU `-f` means "display
# filesystem status" (a totally different report) — GNU's format flag is `-c`
# instead. Trying BSD syntax (`stat -f '%Lp' path`) FIRST on Linux does not error;
# it silently prints filesystem info instead of the file's mode, corrupting
# whatever captures it. Try GNU syntax first — it is a no-op on macOS (BSD stat has
# no `-c` option, so it fails cleanly and falls through) — then fall back to BSD.
file_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"
}

echo "== (a) init refuses when an identity already exists (init is for a FRESH setup only) =="
EXISTS_HOME="$TMP/exists-home"
CYPHER_BRAIN_HOME="$EXISTS_HOME" cb keygen > /dev/null
EXISTS_RC=0
CYPHER_BRAIN_HOME="$EXISTS_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 10 node "${BIN_DEV_ARGS[@]}" "$BIN" init < /dev/null > "$TMP/exists.log" 2>&1 || EXISTS_RC=$?
[ "$EXISTS_RC" != "0" ] || { echo "[FAIL] init did not refuse with a pre-existing identity"; cat "$TMP/exists.log"; exit 1; }
# A nonzero status alone doesn't prove init refused PROMPTLY: 137 means with_timeout's own
# 10s watchdog had to SIGKILL it, which is a hang (possibly after printing the very message
# grepped for below), not the same as a clean, fast refusal.
[ "$EXISTS_RC" != "137" ] || { echo "[FAIL] init did not refuse promptly -- it hung until the 10s with_timeout watchdog SIGKILLed it"; cat "$TMP/exists.log"; exit 1; }
grep -qi "already exists" "$TMP/exists.log" || { echo "[FAIL] refusal does not name the existing identity"; cat "$TMP/exists.log"; exit 1; }
grep -qi "keygen --force" "$TMP/exists.log" || { echo "[FAIL] refusal does not point at keygen --force"; cat "$TMP/exists.log"; exit 1; }
echo "[PASS] init refuses a pre-existing identity and points at keygen --force"

echo "== (b) init refuses promptly (no hang) when stdin is not a TTY and no escape hatch is set =="
TTY_HOME="$TMP/tty-check-home"
TTY_RC=0
CYPHER_BRAIN_HOME="$TTY_HOME" with_timeout 10 node "${BIN_DEV_ARGS[@]}" "$BIN" init < /dev/null > "$TMP/tty.log" 2>&1 || TTY_RC=$?
[ "$TTY_RC" != "0" ] || { echo "[FAIL] init did not refuse a non-TTY stdin"; cat "$TMP/tty.log"; exit 1; }
# 137 (SIGKILL) means the 10s with_timeout watchdog killed it -- a hang, not a refusal --
# even if the expected message happened to be printed before the hang. Prove promptness.
[ "$TTY_RC" != "137" ] || { echo "[FAIL] init did not refuse promptly -- it hung until the 10s with_timeout watchdog SIGKILLed it"; cat "$TMP/tty.log"; exit 1; }
grep -qi "requires stdin to be a TTY" "$TMP/tty.log" || { echo "[FAIL] refusal does not mention the TTY requirement"; cat "$TMP/tty.log"; exit 1; }
[ ! -f "$TTY_HOME/identity.age" ] || { echo "[FAIL] an identity was written despite the TTY refusal"; exit 1; }
echo "[PASS] init refuses promptly (bounded by with_timeout, no hang) when stdin is not a TTY"

echo "== (c) profile=none with an empty directory answer RE-PROMPTS instead of throwing-and-rolling-back (issue #492) =="
# Before the fix, hitting Enter with nothing typed (or only whitespace/commas) at
# this free-text prompt threw immediately -- AFTER steps 1-5 had already written the
# primary identity, the offline backup keypair, and the signing keypair to disk --
# and the catch block a few hundred lines down in wizard.ts rolled ALL THREE back.
# Same bug class as #462 (the Profile prompt, fixed there via a select() menu), but
# this prompt genuinely cannot become a menu (the paths are free-form), so the fix
# loops askLine() until at least one directory is given instead of throwing on the
# first empty answer -- same fix shape the maintainer already chose for the sibling
# bug. Driving the wizard through an empty answer here must now RE-PROMPT (never
# fail), and afterwards ALL THREE artifacts (primary identity, backup identity,
# signing identity) must survive, proving the empty answer never reached the outer
# rollback catch at all.
NODIR_HOME="$TMP/nodir-home"; mkdir -p "$NODIR_HOME"
NODIR_CB_HOME="$TMP/nodir-cb-home"
NODIR_STORE="$TMP/nodir-store"
NODIR_SRC="$TMP/nodir-src"; mkdir -p "$NODIR_SRC"
printf 'nodir-marker\n' > "$NODIR_SRC/note.txt"
NODIR_KIT_PATH="$NODIR_HOME/recovery-kit.txt"
NODIR_BACKUP_HOME="${NODIR_CB_HOME}-backup" # the default sibling path the wizard suggests for the backup key

cat > "$TMP/qa-nodir.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "y"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", ""],
  ["At least one directory is required", "$NODIR_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$NODIR_KIT_PATH"]
]
JSON
# The retry's waitFor is the wizard's OWN re-prompt message ("At least one directory
# is required...", printed by the fix right before it loops back to askLine() again)
# rather than a second copy of the original prompt text -- the original prompt text
# is already present in the transcript from the first render, so keying the retry to
# it would let drive-init.mjs fire the second answer immediately, before the wizard
# has actually re-rendered the prompt and re-attached its input listener. That listener
# gap is NOT a real race on the wizard's own side, though (Codex review round 1, this
# PR): @clack/core's Prompt.prompt() is `new Promise((resolve) => { ...
# this.input.on('keypress', ...) ... })` -- the whole body, including attaching the
# keypress listener, runs SYNCHRONOUSLY inside that executor before prompt() (and so
# askLine's `await text(...)`) ever yields back to the event loop. Since the retry
# console.log() and the next askLine() call happen back-to-back with no `await`
# between them, the new listener is already attached before this driver's own
# stdout-read -> stdin-write round trip (real IPC latency) can possibly land the next
# keystroke -- confirmed by reading node_modules/@clack/core/dist/index.mjs directly,
# not just by this test happening to pass once.
#
# FORCE_COLOR is also unset here (issue #464's own doc fix, test (q) below reuses this
# exact transcript): if the CALLER's shell/CI already exports FORCE_COLOR, clack's
# color codes would be forced back on regardless of NO_COLOR (the doc comment's own
# point), which would break (q)'s "zero color codes" assertion for a reason that has
# nothing to do with this test. NO_COLOR=1 is set explicitly to match the original
# issue's own repro, rather than leaving it to ambient environment.
unset FORCE_COLOR
CYPHER_BRAIN_HOME="$NODIR_CB_HOME" CYPHER_BRAIN_FILE_DIR="$NODIR_STORE" HOME="$NODIR_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 NO_COLOR=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-nodir.json" --out "$TMP/nodir.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the empty-then-valid directory answer made init fail (it should re-prompt, then complete normally)"; cat "$TMP/nodir.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/nodir.log" || { echo "[FAIL] empty-directory-answer wizard log lacks its own completion marker"; cat "$TMP/nodir.log"; exit 1; }
grep -qi "no directory given" "$TMP/nodir.log" && { echo "[FAIL] the empty directory answer still threw the old rollback-triggering error"; cat "$TMP/nodir.log"; exit 1; }
grep -qi "At least one directory is required" "$TMP/nodir.log" || { echo "[FAIL] the empty directory answer did not re-prompt"; cat "$TMP/nodir.log"; exit 1; }
[ -f "$NODIR_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity is missing — an empty directory answer should never roll anything back"; exit 1; }
[ -f "$NODIR_BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity is missing — the #492 repro's own rollback target must survive an empty directory answer"; exit 1; }
[ -f "$NODIR_CB_HOME/sign-identity.key" ] || { echo "[FAIL] signing identity is missing — the #492 repro's own rollback target must survive an empty directory answer"; exit 1; }
echo "[PASS] an empty directory answer re-prompts instead of throwing — primary, backup AND signing identities all survive (issue #492 fixed)"

echo "== (c3) profile=none with a NONEXISTENT (typo'd) directory path RE-PROMPTS instead of throwing-and-rolling-back (issue #605) =="
# #492 (test (c) above) only fixed the EMPTY-answer case: the loop kept askLine()ing
# until at least one non-empty candidate was given, but never checked that candidate
# actually existed on disk. A non-empty but NONEXISTENT (typo'd) directory path still
# sailed straight through `.filter(Boolean)` to the final "Choose a backend" step and
# only failed deep inside snapshot()'s requirePath() check ("no such snapshot source:
# ..."), by which point the catch block a few hundred lines down had already rolled
# back the primary identity, the offline backup keypair, and the signing keypair — the
# exact same rollback-cost bug class #492 fixed for the empty case, just one input
# shape wider (confirmed live via drive-init.mjs against the PRE-fix code before this
# was closed: the wizard proceeded straight to "Choose a backend" and then failed with
# "error: no such snapshot source: ...", deleting all three artifacts). The fix checks
# each candidate against disk (util.ts's exists()) and drops — with a "does not exist"
# message — whichever ones are not real, re-looping (same "At least one directory is
# required" re-prompt test (c) already asserts) until at least one EXISTING directory
# survives.
NODIR2_HOME="$TMP/nodir2-home"; mkdir -p "$NODIR2_HOME"
NODIR2_CB_HOME="$TMP/nodir2-cb-home"
NODIR2_STORE="$TMP/nodir2-store"
NODIR2_SRC="$TMP/nodir2-src"; mkdir -p "$NODIR2_SRC"
printf 'nodir2-marker\n' > "$NODIR2_SRC/note.txt"
NODIR2_KIT_PATH="$NODIR2_HOME/recovery-kit.txt"
NODIR2_BACKUP_HOME="${NODIR2_CB_HOME}-backup"
NODIR2_BADPATH="$TMP/nodir2-this-path-does-not-exist"

cat > "$TMP/qa-nodir2.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "y"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$NODIR2_BADPATH"],
  ["At least one directory is required", "$NODIR2_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$NODIR2_KIT_PATH"]
]
JSON
CYPHER_BRAIN_HOME="$NODIR2_CB_HOME" CYPHER_BRAIN_FILE_DIR="$NODIR2_STORE" HOME="$NODIR2_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 NO_COLOR=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-nodir2.json" --out "$TMP/nodir2.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the nonexistent-then-valid directory answer made init fail (it should re-prompt, then complete normally)"; cat "$TMP/nodir2.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/nodir2.log" || { echo "[FAIL] nonexistent-directory-answer wizard log lacks its own completion marker"; cat "$TMP/nodir2.log"; exit 1; }
grep -qi "no such snapshot source" "$TMP/nodir2.log" && { echo "[FAIL] the nonexistent directory answer still threw the old rollback-triggering error"; cat "$TMP/nodir2.log"; exit 1; }
grep -qF "$NODIR2_BADPATH does not exist" "$TMP/nodir2.log" || { echo "[FAIL] the nonexistent directory answer did not print a does-not-exist message naming it"; cat "$TMP/nodir2.log"; exit 1; }
grep -qi "At least one directory is required" "$TMP/nodir2.log" || { echo "[FAIL] the nonexistent directory answer did not re-prompt"; cat "$TMP/nodir2.log"; exit 1; }
[ -f "$NODIR2_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity is missing — a nonexistent directory answer should never roll anything back"; exit 1; }
[ -f "$NODIR2_BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity is missing — the #605 repro's own rollback target must survive a nonexistent directory answer"; exit 1; }
[ -f "$NODIR2_CB_HOME/sign-identity.key" ] || { echo "[FAIL] signing identity is missing — the #605 repro's own rollback target must survive a nonexistent directory answer"; exit 1; }
echo "[PASS] a nonexistent directory answer re-prompts instead of throwing — primary, backup AND signing identities all survive (issue #605 fixed)"

# issue #732: the mid-run "does not exist — skipping it" notice used to be a plain
# console.log, invisible to warn.ts's own end-of-run "run summary" block — the exact
# curated block an agent relaying this run is told to show verbatim (see
# src/lib/warn.ts's own header comment). It now goes through warn(), so the SAME
# dropped path must appear TWICE in this transcript: once immediately (warn() still
# prints right away), and again inside the final run-summary block. Before the fix
# this count would be 1 (the summary block never mentioned it at all — the transcript
# had no run summary for this event whatsoever).
grep -q '⚠  run summary' "$TMP/nodir2.log" || { echo "[FAIL] issue #732: no end-of-run warning summary was printed even though a directory was dropped mid-run"; cat "$TMP/nodir2.log"; exit 1; }
# Two mentions anywhere in the transcript (this file's existing check below) plus a
# summary header existing SOMEWHERE do not together prove the dropped path is mentioned
# INSIDE that summary block specifically -- both could, in principle, come from the
# mid-run notice alone while the summary itself stays silent. Slice the transcript from
# the summary marker onward and check the mention lands in that slice.
NODIR2_SUMMARY_BLOCK="$(sed -n '/⚠  run summary/,$p' "$TMP/nodir2.log")"
printf '%s' "$NODIR2_SUMMARY_BLOCK" | grep -qF "$NODIR2_BADPATH does not exist" \
  || { echo "[FAIL] issue #732: the dropped directory is not mentioned INSIDE the run-summary block itself"; cat "$TMP/nodir2.log"; exit 1; }
NODIR2_BADPATH_MENTIONS="$(grep -oF "$NODIR2_BADPATH does not exist" "$TMP/nodir2.log" | wc -l | tr -d ' ')"
[ "$NODIR2_BADPATH_MENTIONS" -ge 2 ] || { echo "[FAIL] issue #732: expected the dropped directory to be mentioned at least twice (mid-run notice + run-summary recap via warn()), got $NODIR2_BADPATH_MENTIONS"; cat "$TMP/nodir2.log"; exit 1; }
echo "[PASS] the dropped (typo'd) directory survives into the end-of-run warning summary via warn() (issue #732)"

echo "== (c2) select() offers ton-provider by name, and picking it with no CYPHER_BRAIN_TON_PROVIDER_OWNER/MAX_SPEND set refuses BEFORE spending (issue #396 Phase B) =="
TONPROV_USER_HOME="$TMP/tonprov-user-home"; mkdir -p "$TONPROV_USER_HOME" # HOME override, same as test (d)'s WIZ_HOME below: without this, step 6 detects the REAL machine's ~/.gbrain/config.json (if any) and asks an extra --pg prompt this qa.json does not script for
TONPROV_HOME="$TMP/tonprov-home"
TONPROV_SRC="$TMP/tonprov-src"; mkdir -p "$TONPROV_SRC"
printf 'ton-provider select() positive control\n' > "$TONPROV_SRC/note.txt"
# Up-arrow, written in the JSON below as the six-character escape sequence
# u-0-0-1-b prefixed by a backslash (a raw ESC byte in the .json file itself
# is illegal -- JSON disallows unescaped control characters in strings, so
# drive-init.mjs's JSON.parse would reject it; the escape decodes to the real
# ESC/'['/'A' bytes once parsed) moves the select() cursor from its initial
# `file` (last in BACKEND_NAMES) up one slot to `ton-provider` (third),
# exactly like a real terminal's arrow key would; the trailing carriage
# return drive-init.mjs always appends then submits it -- no
# CYPHER_BRAIN_TON_PROVIDER_OWNER/MAX_SPEND is exported for this run, so the
# wizard's own pre-flight check (wizard.ts, mirroring #161's arweave/turbo
# wallet-presence check) should refuse BEFORE the "spends real funds"
# consent prompt, let alone push().
cat > "$TMP/qa-tonprov.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$TONPROV_SRC"],
  ["Choose a backend", "\u001b[A"]
]
JSON
# issue #731: this early-exit path used to share exit 0 with a fully-completed run
# (the same exit code as a run that actually pushed a snapshot) despite explicitly
# printing "nothing has been rolled back ... cannot be re-run" — a script/agent
# checking $? saw success either way. It now sets a non-zero exit code, so the
# invocation below is expected to FAIL (drive-init.mjs propagates the child's own
# exit code) — the `if ...; then FAIL; fi` shape (same idiom test (o3) below already
# uses for its own "still aborts" case) asserts exactly that, while the grep checks
# right after confirm this is the RIGHT reason (missing prerequisites, not a crash).
if CYPHER_BRAIN_HOME="$TONPROV_HOME" HOME="$TONPROV_USER_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  CYPHER_BRAIN_TON_PROVIDER_OWNER= CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND= \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-tonprov.json" --out "$TMP/tonprov.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #731: the ton-provider select()+refuse run exited 0 despite missing prerequisites and no push"; cat "$TMP/tonprov.log"; exit 1
fi
grep -q 'ton-provider' "$TMP/tonprov.log" || { echo "[FAIL] the select() menu never showed ton-provider"; cat "$TMP/tonprov.log"; exit 1; }
grep -q 'CYPHER_BRAIN_TON_PROVIDER_OWNER' "$TMP/tonprov.log" || { echo "[FAIL] missing-prerequisites guidance did not name CYPHER_BRAIN_TON_PROVIDER_OWNER"; cat "$TMP/tonprov.log"; exit 1; }
grep -q 'CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND' "$TMP/tonprov.log" || { echo "[FAIL] missing-prerequisites guidance did not name CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND"; cat "$TMP/tonprov.log"; exit 1; }
[ -f "$TONPROV_HOME/identity.age" ] || { echo "[FAIL] the primary identity this run set up before the backend step was rolled back / never written"; exit 1; }
[ ! -f "$TONPROV_HOME/latest-locator.tsv" ] || { echo "[FAIL] a push happened despite the missing ton-provider prerequisites"; exit 1; }
echo "[PASS] select() offers ton-provider, arrow-key navigation picks it, and the missing-prerequisites guard refuses before any push (non-zero exit, issue #731) — identity preserved, nothing rolled back"

echo "== (d) THE SCRIPTED END-TO-END RUN (issue #68 acceptance criterion 1): init -> first push, driven entirely via a scripted stdin sequence =="
SRC="$TMP/brain-src"; mkdir -p "$SRC"
MARKER="drill-thought-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$MARKER" > "$SRC/note.txt"

WIZ_HOME="$TMP/wiz-home"; mkdir -p "$WIZ_HOME"    # HOME override: os.homedir()-based defaults (kit path) stay inside TMP
WIZ_CB_HOME="$TMP/wiz-cb-home"                    # CYPHER_BRAIN_HOME: primary identity/recipient/store paths
WIZ_STORE="$TMP/wiz-store"                        # file backend store dir
KIT_PATH="$WIZ_HOME/recovery-kit.txt"
BACKUP_HOME="${WIZ_CB_HOME}-backup"               # the default sibling path the wizard suggests for the backup key

# The realistic path from the issue: file backend, no profile, backup key YES,
# signing key YES (#214 — proves the wizard's own signing step + kit inclusion),
# passphrase NO, pin-recipients SKIP. The "Choose a backend" answer is an empty
# send (just the trailing '\r' drive-init.mjs always appends) — #396 Phase B's
# select() prompt starts its cursor on `file` regardless of menu order (see
# BACKEND_NAMES's own doc comment in backends/index.ts), so a bare Enter here
# submits `file` exactly like the old askLine default did; no arrow-key
# navigation needed for THIS path (see test (c2) below for one that navigates).
cat > "$TMP/qa.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "y"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$WIZ_CB_HOME" CYPHER_BRAIN_FILE_DIR="$WIZ_STORE" HOME="$WIZ_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa.json" --out "$TMP/wizard.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the scripted end-to-end wizard run did not complete"; cat "$TMP/wizard.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard.log" || { echo "[FAIL] wizard log lacks its own completion marker"; cat "$TMP/wizard.log"; exit 1; }
echo "[PASS] scripted stdin sequence drove init end-to-end: keygen -> backup key(yes) -> signing key(yes) -> passphrase(skip) -> pin(skip) -> profile(none) -> snapshot -> push"

echo "== (d2) step 5/7 points the recipient pin at the config file, not a shell rc (issue #299) =="
# #286 introduced $CYPHER_BRAIN_HOME/config.env, which made one sentence of this step
# FALSE: it told the reader the pin "is read from the environment at snapshot time, not
# a file init controls". Grep the literal, so a reintroduction fails here instead of
# shipping a wrong instruction onto a new user's first run. The step's explanation is
# printed before its y/n prompt, so test (d)'s pin-skip transcript already contains it.
grep -qF "$WIZ_CB_HOME/config.env" "$TMP/wizard.log" || { echo "[FAIL] step 5 does not name \$CYPHER_BRAIN_HOME/config.env as the place to persist the pin"; cat "$TMP/wizard.log"; exit 1; }
if grep -qF 'not a file init controls' "$TMP/wizard.log"; then echo "[FAIL] step 5 still claims no file controls this setting — config.env (#286) does"; cat "$TMP/wizard.log"; exit 1; fi
if grep -qF 'add to your shell rc file yourself' "$TMP/wizard.log"; then echo "[FAIL] step 5 still offers a shell rc as the only place to persist the pin"; cat "$TMP/wizard.log"; exit 1; fi
grep -qF 'unattended nightly run with a bare environment' "$TMP/wizard.log" || { echo "[FAIL] step 5 does not explain why a shell rc misses the unattended run the pin exists to protect"; cat "$TMP/wizard.log"; exit 1; }
echo "[PASS] step 5 names \$CYPHER_BRAIN_HOME/config.env, explains why the unattended run needs it, and no longer claims init controls no such file"

[ -f "$WIZ_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity was not written"; exit 1; }
[ -f "$WIZ_CB_HOME/recipient.txt" ] || { echo "[FAIL] primary recipient was not written"; exit 1; }
grep -q '^AGE-SECRET-KEY-1' "$WIZ_CB_HOME/identity.age" || { echo "[FAIL] primary identity is not a plain unwrapped age identity (passphrase step should have been skipped)"; exit 1; }
[ -f "$BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity was not written at the default sibling path"; exit 1; }
[ -f "$BACKUP_HOME/recipient.txt" ] || { echo "[FAIL] backup recipient was not written"; exit 1; }
echo "[PASS] primary + backup identities/recipients written; primary is unwrapped as scripted"

[ -f "$WIZ_CB_HOME/sign-identity.key" ] || { echo "[FAIL] signing identity was not written (#214)"; exit 1; }
[ -f "$WIZ_CB_HOME/sign-recipient.pub" ] || { echo "[FAIL] signing public key was not written (#214)"; exit 1; }
echo "[PASS] signing identity + public key written (#214)"

LOCFILE="$WIZ_CB_HOME/latest-locator.tsv"
[ -f "$LOCFILE" ] || { echo "[FAIL] --save-locator file not written by the wizard's push"; exit 1; }
[ "$(awk -F'\t' '{print NF; exit}' "$LOCFILE")" = "7" ] || { echo "[FAIL] locator file is not 7 tab-separated fields (signing was enabled, so a sig_locator field (#214) and a sign_key_id field (#250) are both expected)"; cat "$LOCFILE"; exit 1; }
[ "$(awk -F'\t' '{print $2; exit}' "$LOCFILE")" = "file" ] || { echo "[FAIL] locator file backend != file"; exit 1; }
echo "[PASS] push wrote a 7-field --save-locator file (ciphertext + signature locator + signing key id) for the file backend"

SNAP="$(find "$WIZ_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$SNAP" ] || { echo "[FAIL] no brain-*.age snapshot found under CYPHER_BRAIN_HOME"; exit 1; }
CYPHER_BRAIN_HOME="$WIZ_CB_HOME" cb verify --in "$SNAP" > "$TMP/verify.log" 2>&1 || { echo "[FAIL] verify on the wizard's own snapshot failed"; cat "$TMP/verify.log"; exit 1; }
grep -q 'VERDICT: PASS' "$TMP/verify.log" || { echo "[FAIL] verify verdict on the wizard's snapshot is not PASS"; cat "$TMP/verify.log"; exit 1; }
echo "[PASS] the wizard's own snapshot verifies (real ciphertext, wrong key rejected, primary identity decrypts it)"

echo "== (e) recovery kit content structure =="
[ -f "$KIT_PATH" ] || { echo "[FAIL] recovery kit was not written at the requested path"; exit 1; }
KITMODE="$(file_mode "$KIT_PATH")"
[ "$KITMODE" = "600" ] || { echo "[FAIL] recovery kit is not mode 600 (got $KITMODE) — it contains a secret identity"; exit 1; }
grep -q 'KEEP THIS OFFLINE / PHYSICALLY SECURE' "$KIT_PATH" || { echo "[FAIL] kit missing the warning banner"; exit 1; }
grep -q -- '--- PRIMARY IDENTITY' "$KIT_PATH" || { echo "[FAIL] kit missing the PRIMARY IDENTITY section"; exit 1; }
grep -qF "$WIZ_CB_HOME/identity.age" "$KIT_PATH" || { echo "[FAIL] kit does not reference the primary identity's location"; exit 1; }
grep -q -- '--- BACKUP IDENTITY (SECRET' "$KIT_PATH" || { echo "[FAIL] kit missing the BACKUP IDENTITY section"; exit 1; }
grep -q '^AGE-SECRET-KEY-1' "$KIT_PATH" || { echo "[FAIL] kit does not inline the backup identity's secret key line"; exit 1; }
grep -qF "$(head -n1 "$LOCFILE")" "$KIT_PATH" || { echo "[FAIL] kit does not inline the exact save-locator line"; exit 1; }
grep -q 'skipped during init' "$KIT_PATH" || { echo "[FAIL] kit does not note the recipient-pin suggestion was skipped"; exit 1; }
grep -q 'cypher-brain pull --from-locator-file' "$KIT_PATH" || { echo "[FAIL] kit missing the recovery pull command"; exit 1; }
grep -q 'cypher-brain restore --in' "$KIT_PATH" || { echo "[FAIL] kit missing the recovery restore command"; exit 1; }
grep -q 'WHAT TO DO WITH THIS FILE' "$KIT_PATH" || { echo "[FAIL] kit missing the disposal-instructions section"; exit 1; }
grep -q 'LOCATOR IS LOCAL-ONLY' "$KIT_PATH" || { echo "[FAIL] kit used the file backend but does not warn that its save-locator is local-only"; exit 1; }
echo "[PASS] kit: mode 600, warning banner, primary location, backup identity inlined, exact locator line, pin-skip note, recovery commands, disposal note, file-backend local-only warning"

echo "== (e2) file backend: interactive warning + completion summary both surface the local-only risk (issue #85) =="
# Before the fix, the kit-only warning above (grepped in (e)) was the ONLY place a
# file-backend user ever saw this — invisible unless they opened the printed kit.
# Test (d)'s own run ($TMP/wizard.log) already selected the file backend (its default
# Enter-key answer), so reuse that transcript rather than scripting a whole new run.
grep -qF 'stores the pushed ciphertext ONLY on this machine' "$TMP/wizard.log" || { echo "[FAIL] wizard.log does not show the interactive file-backend warning"; cat "$TMP/wizard.log"; exit 1; }
grep -qF 'LOCAL-ONLY — not reachable from another machine' "$TMP/wizard.log" || { echo "[FAIL] completion summary does not annotate the file backend as local-only"; cat "$TMP/wizard.log"; exit 1; }
echo "[PASS] choosing the file backend prints an interactive warning, and the completion summary flags it as local-only"

echo "== (e3) profile o2b end-to-end via the init wizard (issue #206): the wizard prompts for the bundle path and actually snapshots it =="
# Test (d) above only exercises profile=none — none of the three NAMED profiles
# (obsidian/chatgpt-export/o2b) had scripted wizard coverage before this. o2b's PR
# (#334) added the "Path to the o2b bank-export bundle" prompt in wizard.ts but never
# drove it, so a typo in the prompt-branch wiring (wrong snapshotOpts field, wrong
# PROFILE_NAMES check) could ship unnoticed. Same drive-init.mjs scripted-stdin
# mechanism as test (d), with a synthetic bank-export bundle standing in for
# "o2b brain bank-export --out <path>.json" (its internal shape does not matter here,
# only that it is a real, distinct JSON document — same fixture style as
# selftest-profiles.sh's own o2b coverage).
O2B_BUNDLE="$TMP/o2b-bank-export.json"
printf '{"schema":"1","graph":{"nodes":[]},"pages":[],"preferences":[]}\n' > "$O2B_BUNDLE"
O2B_SHA=$(shasum -a 256 "$O2B_BUNDLE" | cut -d' ' -f1)

O2B_WIZ_HOME="$TMP/o2b-wiz-home"; mkdir -p "$O2B_WIZ_HOME"
O2B_WIZ_CB_HOME="$TMP/o2b-wiz-cb-home"
O2B_WIZ_STORE="$TMP/o2b-wiz-store"
O2B_KIT_PATH="$O2B_WIZ_HOME/recovery-kit.txt"

cat > "$TMP/qa-o2b.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", "\u001b[A"],
  ["Path to the o2b bank-export bundle", "$O2B_BUNDLE"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$O2B_KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$O2B_WIZ_CB_HOME" CYPHER_BRAIN_FILE_DIR="$O2B_WIZ_STORE" HOME="$O2B_WIZ_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-o2b.json" --out "$TMP/wizard-o2b.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the scripted profile-o2b wizard run did not complete"; cat "$TMP/wizard-o2b.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-o2b.log" || { echo "[FAIL] o2b wizard log lacks its own completion marker"; cat "$TMP/wizard-o2b.log"; exit 1; }
grep -q 'Path to the o2b bank-export bundle' "$TMP/wizard-o2b.log" || { echo "[FAIL] wizard did not prompt for the o2b bundle path when profile o2b was chosen"; cat "$TMP/wizard-o2b.log"; exit 1; }

# Not just a clean exit — verify the artifact: the wizard's own snapshot must record
# profile o2b and archive the bundle byte-identical (same discipline as test (d)'s
# "brain-*.age" check above).
O2B_SNAP="$(find "$O2B_WIZ_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$O2B_SNAP" ] || { echo "[FAIL] no brain-*.age snapshot found under the o2b wizard's CYPHER_BRAIN_HOME"; exit 1; }
CYPHER_BRAIN_HOME="$O2B_WIZ_CB_HOME" cb restore --in "$O2B_SNAP" --out-dir "$TMP/o2b-wiz-restore" >/dev/null 2>&1 \
  || { echo "[FAIL] restore of the wizard's o2b snapshot failed"; exit 1; }
grep -q '"profile": "o2b"' "$TMP/o2b-wiz-restore/manifest.json" \
  || { echo "[FAIL] wizard's o2b snapshot manifest lacks profile o2b"; cat "$TMP/o2b-wiz-restore/manifest.json"; exit 1; }
tar -xzf "$TMP/o2b-wiz-restore/o2b-bank-export.json.tar.gz" -C "$TMP/o2b-wiz-restore"
O2B_RESTORED_SHA=$(shasum -a 256 "$TMP/o2b-wiz-restore/o2b-bank-export.json" | cut -d' ' -f1)
[ "$O2B_SHA" = "$O2B_RESTORED_SHA" ] || { echo "[FAIL] wizard's o2b snapshot did not archive the bundle byte-identical"; exit 1; }
echo "[PASS] init wizard's profile o2b path prompts for the bundle and actually snapshots it byte-identical (manifest records profile o2b)"

echo "== (e3b) profile obsidian's --vault prompt loops past an empty AND a nonexistent answer before rolling anything back (issue #605) =="
# #462 fixed the Profile SELECTOR itself (a typo there is now structurally inert — see
# (e4) below) and #492 fixed the "none" profile's free-text directory prompt, but the
# three profile-SPECIFIC free-text path prompts (--vault/--zip/--export, right after a
# real profile is chosen) were never covered by either fix: a plain one-shot askLine()
# with no re-prompt loop and no existence check. Confirmed live via drive-init.mjs
# against the PRE-fix code before this was closed: an empty OR a nonexistent vault
# answer sailed straight through steps 6-7 to "Choose a backend", then failed deep
# inside snapshot() ("no vault at ... — profile obsidian snapshots the vault
# directory"), and the catch block a few hundred lines down rolled back the primary
# identity, the offline backup keypair, AND the signing keypair from steps 1-3 — same
# rollback-cost bug class as #462/#492, just never extended here. The fix
# (askExistingPath() in wizard.ts) loops until the answer is both non-empty and
# actually exists, exactly like the "none" profile's own directory prompt. This one
# test exercises obsidian specifically, but chatgpt-export's --zip and o2b's --export
# prompts call the exact same helper function (askExistingPath()) — not a
# copy/reimplementation per profile — so this is a shared-code-path regression check
# for all three, not just obsidian (each profile's OWN wizard flow — o2b's above,
# obsidian's own byte-identical-archive path, chatgpt-export's — is unchanged and
# already covered elsewhere; this test is specifically about the bad-answer loop).
#
# "Profile (what to back up)" navigates the select() menu down two entries from its
# default "none" (options order: none, claude-code, obsidian, chatgpt-export, o2b) —
# same down-arrow escape-sequence mechanism (e3)'s up-arrow answer above already uses.
OBS_HOME="$TMP/obsidian-home"; mkdir -p "$OBS_HOME"
OBS_CB_HOME="$TMP/obsidian-cb-home"
OBS_STORE="$TMP/obsidian-store"
OBS_VAULT="$TMP/obsidian-real-vault"; mkdir -p "$OBS_VAULT/.obsidian"
printf 'obsidian-marker\n' > "$OBS_VAULT/note.md"
OBS_KIT_PATH="$OBS_HOME/recovery-kit.txt"
OBS_BACKUP_HOME="${OBS_CB_HOME}-backup"
OBS_BADPATH="$TMP/obsidian-this-vault-does-not-exist"

cat > "$TMP/qa-obsidian.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "y"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", "\u001b[B\u001b[B"],
  ["Path to your Obsidian vault", ""],
  ["A path is required", "$OBS_BADPATH"],
  ["does not exist", "$OBS_VAULT"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$OBS_KIT_PATH"]
]
JSON
CYPHER_BRAIN_HOME="$OBS_CB_HOME" CYPHER_BRAIN_FILE_DIR="$OBS_STORE" HOME="$OBS_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 NO_COLOR=1 \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-obsidian.json" --out "$TMP/wizard-obsidian.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the empty-then-nonexistent-then-valid obsidian vault answer made init fail (it should re-prompt, then complete normally)"; cat "$TMP/wizard-obsidian.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-obsidian.log" || { echo "[FAIL] obsidian bad-vault wizard log lacks its own completion marker"; cat "$TMP/wizard-obsidian.log"; exit 1; }
grep -qi "no vault at" "$TMP/wizard-obsidian.log" && { echo "[FAIL] the bad vault answer still threw the old rollback-triggering snapshot() error"; cat "$TMP/wizard-obsidian.log"; exit 1; }
grep -qi "A path is required" "$TMP/wizard-obsidian.log" || { echo "[FAIL] the empty vault answer did not re-prompt"; cat "$TMP/wizard-obsidian.log"; exit 1; }
grep -qF "$OBS_BADPATH does not exist" "$TMP/wizard-obsidian.log" || { echo "[FAIL] the nonexistent vault answer did not print a does-not-exist message naming it"; cat "$TMP/wizard-obsidian.log"; exit 1; }
[ -f "$OBS_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity is missing — a bad obsidian vault answer should never roll anything back"; exit 1; }
[ -f "$OBS_BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity is missing — the #605 repro's own rollback target must survive a bad obsidian vault answer"; exit 1; }
[ -f "$OBS_CB_HOME/sign-identity.key" ] || { echo "[FAIL] signing identity is missing — the #605 repro's own rollback target must survive a bad obsidian vault answer"; exit 1; }
OBS_SNAP="$(find "$OBS_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$OBS_SNAP" ] || { echo "[FAIL] no brain-*.age snapshot found under the obsidian wizard's CYPHER_BRAIN_HOME"; exit 1; }
CYPHER_BRAIN_HOME="$OBS_CB_HOME" cb restore --in "$OBS_SNAP" --out-dir "$TMP/obsidian-wiz-restore" >/dev/null 2>&1 \
  || { echo "[FAIL] restore of the wizard's obsidian snapshot failed"; exit 1; }
grep -q '"profile": "obsidian"' "$TMP/obsidian-wiz-restore/manifest.json" \
  || { echo "[FAIL] wizard's obsidian snapshot manifest lacks profile obsidian"; cat "$TMP/obsidian-wiz-restore/manifest.json"; exit 1; }
echo "[PASS] obsidian's --vault prompt re-prompts past an empty AND a nonexistent answer, then completes with the real vault snapshotted — primary, backup AND signing identities all survive (issue #605 fixed; chatgpt-export/o2b share the same askExistingPath() helper)"

echo "== (e4) a former profile TYPO no longer errors or rolls back anything — select() closed the path (#462) =="
# Before the fix, this exact keystroke sequence — "obsidan" (a typo of "obsidian")
# submitted at the free-text Profile prompt, with the SAME backup=yes/signing=yes
# answers issue #462 itself used to repro it — threw "unknown profile \"obsidan\""
# AFTER steps 1-5 had already written the primary identity, the offline backup
# keypair and the signing keypair to disk, and the catch block a few hundred lines
# down in wizard.ts rolled ALL THREE back (Codex review round 1 on this PR flagged
# that the original version of this test answered backup/signing "n"/"n" and so
# never actually exercised that three-artifact rollback the issue reports — fixed
# here to "y"/"y", matching the repro exactly). The Profile prompt is now a
# select() menu (same fix shape as #396 Phase B's backend prompt, see its own doc
# comment in wizard.ts): typed characters that are not the vim-style up/down/left/
# right aliases (k/j/h/l — none of which "obsidan" contains, see @clack/core's
# default `settings.aliases`) do not move the highlighted option and are not
# otherwise collected anywhere, so they are simply inert keystrokes at a menu, not
# free text fed to a parser. Driving the wizard with literally the SAME "obsidan"
# answer at this step must now complete successfully with the highlighted default
# (none) still selected, and — the actual point of #462 — ALL THREE artifacts
# (primary identity, backup identity, signing identity) must survive, proving the
# typo path is structurally gone, not just re-worded.
TYPO_HOME="$TMP/typo-home"; mkdir -p "$TYPO_HOME"
TYPO_CB_HOME="$TMP/typo-cb-home"
TYPO_STORE="$TMP/typo-store"
TYPO_SRC="$TMP/typo-src"; mkdir -p "$TYPO_SRC"
printf 'typo-marker\n' > "$TYPO_SRC/note.txt"
TYPO_KIT_PATH="$TYPO_HOME/recovery-kit.txt"
TYPO_BACKUP_HOME="${TYPO_CB_HOME}-backup" # the default sibling path the wizard suggests for the backup key

cat > "$TMP/qa-typo.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "y"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", "obsidan"],
  ["Directory path(s) to back up", "$TYPO_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$TYPO_KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$TYPO_CB_HOME" CYPHER_BRAIN_FILE_DIR="$TYPO_STORE" HOME="$TYPO_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-typo.json" --out "$TMP/wizard-typo.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the former profile-typo keystrokes made init fail (typo path should be structurally unreachable now)"; cat "$TMP/wizard-typo.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-typo.log" || { echo "[FAIL] typo-keystrokes wizard log lacks its own completion marker"; cat "$TMP/wizard-typo.log"; exit 1; }
grep -qi "unknown profile" "$TMP/wizard-typo.log" && { echo "[FAIL] typed 'obsidan' still reached the unknown-profile error — select() did not close the typo path"; cat "$TMP/wizard-typo.log"; exit 1; }
grep -q "Directory path(s) to back up" "$TMP/wizard-typo.log" || { echo "[FAIL] 'obsidan' keystrokes did not fall through to profile=none's directory prompt as expected (menu should have stayed on its default)"; cat "$TMP/wizard-typo.log"; exit 1; }
[ -f "$TYPO_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity is missing — a no-op typo should never roll anything back"; exit 1; }
[ -f "$TYPO_BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity is missing — the #462 repro's own rollback target must survive a no-op typo"; exit 1; }
[ -f "$TYPO_CB_HOME/sign-identity.key" ] || { echo "[FAIL] signing identity is missing — the #462 repro's own rollback target must survive a no-op typo"; exit 1; }
echo "[PASS] typing a former profile typo at the select() menu is inert — primary, backup AND signing identities all survive (issue #462 fixed)"

echo "== (f) passphrase=yes path completes end-to-end (readline/promptHidden interaction fix) =="
# CYPHER_BRAIN_PASSPHRASE (crypt.ts's own automation escape hatch) makes
# askNewPassphrase() return immediately without touching stdin's raw mode, so this
# run does NOT reproduce the raw-TTY nuance itself (that was proven separately with
# a real pty harness, not part of this repo's test suite) — what it DOES prove is
# that the wizard's own readline Interface survives being closed and re-created
# around the passphrase step: every prompt AFTER "Protect the primary identity..."
# (recipient-pin, profile, directory, backend, kit path) must still be answered by
# this scripted driver, which only works if the wizard's later rl.question() calls
# are actually receiving input again.
#
# This is also the ONE run in this file that answers YES to the recipient-pin
# suggestion, so the suggested line it prints and the kit section it feeds are
# actually exercised — see (g2) below (issue #299).
F_HOME="$TMP/pass-home"; mkdir -p "$F_HOME"
F_CB_HOME="$TMP/pass-cb-home"
F_STORE="$TMP/pass-store"
F_SRC="$TMP/pass-src"; mkdir -p "$F_SRC"
printf 'pass-marker\n' > "$F_SRC/note.txt"
F_KIT_PATH="$F_HOME/recovery-kit.txt"
mkdir -p "$(dirname "$F_KIT_PATH")"
: > "$F_KIT_PATH"; chmod 644 "$F_KIT_PATH" # pre-existing, permissive-mode file — proves the chmod-after-write fix below too
# #717: a pre-existing file at the answered kit path now triggers an explicit
# "Overwrite it?" confirm() before the wizard writes over it — this run answers "y"
# (the QA script below), proving that path still lands the wizard's real content at
# mode 600 (checked further down). (u2) below covers the DECLINE branch: an existing,
# non-empty, real kit must survive untouched.
PRE_KIT_MODE="$(file_mode "$F_KIT_PATH")"
[ "$PRE_KIT_MODE" = "644" ] || { echo "[FAIL] test setup: could not pre-create the kit path at mode 644"; exit 1; }

cat > "$TMP/qa-pass.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "y"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "y"],
  ["Suggested line (edit or press Enter to accept)", ""],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$F_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$F_KIT_PATH"],
  ["Overwrite it?", "y"]
]
JSON

CYPHER_BRAIN_HOME="$F_CB_HOME" CYPHER_BRAIN_FILE_DIR="$F_STORE" HOME="$F_HOME" \
  CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 CYPHER_BRAIN_PASSPHRASE="test-selftest-passphrase" \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-pass.json" --out "$TMP/wizard-pass.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the passphrase=yes scripted run did not complete"; cat "$TMP/wizard-pass.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-pass.log" || { echo "[FAIL] passphrase=yes run: wizard log lacks its own completion marker"; cat "$TMP/wizard-pass.log"; exit 1; }
grep -qa '^-> scrypt ' "$F_CB_HOME/identity.age" || { echo "[FAIL] passphrase=yes run: identity is not scrypt-wrapped (passphrase step did not actually run)"; exit 1; }
echo "[PASS] passphrase=yes path reaches every later prompt and completes (snapshot -> push -> kit) after the readline interface is closed/re-created"

POST_KIT_MODE="$(file_mode "$F_KIT_PATH")"
[ -f "$F_KIT_PATH" ] || { echo "[FAIL] recovery kit was not written at the pre-existing path"; exit 1; }
[ "$POST_KIT_MODE" = "600" ] || { echo "[FAIL] kit path pre-existed at mode 644 but ended up mode $POST_KIT_MODE (want 600) — a secret-bearing kit must not inherit a looser pre-existing mode"; exit 1; }
echo "[PASS] a kit path that pre-existed at mode 644 ends up mode 600 after the wizard writes it"

# 6th-round P2 fix: write-then-chmod (the OLD approach) had a real exposure window —
# a pre-existing looser-mode file gets its CONTENT replaced first and only chmod'd
# to 0600 afterward, so the secret briefly sits at the pre-existing mode. The fix
# writes a distinctly-named `.tmp` sibling at mode 0600 from the instant of creation
# (`wx` — exclusive create, never reuses the loose-mode inode), then atomically
# rename()s it over kitPath — which makes the insecure window impossible BY
# CONSTRUCTION rather than by a race that is merely unlikely to lose. This can't be
# proven by racing a background poll (a construction-level guarantee has no window
# to catch even in principle); what CAN be proven here: (1) the tmp sibling never
# survives a successful run (it was renamed away, not left behind or leaked), and
# (2) the final file actually contains the real secret content (a scrypt-wrapped
# passphrase run's kit — not the empty placeholder it started as), at 0600 (already
# checked above).
TMP_KIT_LEFTOVER="$(find "$(dirname "$F_KIT_PATH")" -maxdepth 1 -name "$(basename "$F_KIT_PATH").*.tmp" 2>/dev/null | head -n1)"
[ -z "$TMP_KIT_LEFTOVER" ] || { echo "[FAIL] a .tmp sibling of the recovery kit survived a successful write: $TMP_KIT_LEFTOVER"; exit 1; }
[ -s "$F_KIT_PATH" ] || { echo "[FAIL] recovery kit is empty — still the pre-existing placeholder, not the wizard's real content"; exit 1; }
grep -q 'KEEP THIS OFFLINE / PHYSICALLY SECURE' "$F_KIT_PATH" || { echo "[FAIL] recovery kit does not contain the wizard's real content — write-then-rename did not actually replace the placeholder"; exit 1; }
echo "[PASS] the pre-existing-644 kit path ends up with NO leftover .tmp sibling and real secret content at mode 600 (write-at-0600-then-rename fix — no write-then-chmod exposure window)"

echo "== (g) recovery kit honesty when the backup key was skipped (test f's own run: backup=NO) =="
# Test (f) above already drove backup=NO through to a completed kit (F_KIT_PATH) —
# reuse it rather than scripting a whole new duplicate wizard run just for this.
# Without a backup identity, the ONLY thing that can decrypt is the PRIMARY
# identity, which deliberately never leaves the machine via the kit (MANAGEMENT.md
# "Key recovery #1") — so the kit must NOT tell the reader to copy/use a BACKUP
# IDENTITY block that was never generated, and MUST explain the honest alternative.
grep -q -- '--- BACKUP IDENTITY ---' "$F_KIT_PATH" || { echo "[FAIL] no-backup kit missing the plain (no-key) BACKUP IDENTITY section"; exit 1; }
if grep -q 'BEGIN BACKUP IDENTITY FILE' "$F_KIT_PATH"; then echo "[FAIL] no-backup kit unexpectedly inlines a BACKUP IDENTITY FILE block"; exit 1; fi
if grep -q 'Copy the BACKUP IDENTITY block above' "$F_KIT_PATH"; then echo "[FAIL] no-backup kit still tells the reader to copy a BACKUP IDENTITY block that was never generated"; exit 1; fi
grep -q 'NO BACKUP IDENTITY IS IN THIS KIT' "$F_KIT_PATH" || { echo "[FAIL] no-backup kit does not warn that kit-only recovery on a fresh machine is not possible"; exit 1; }
grep -qF "$F_CB_HOME/identity.age" "$F_KIT_PATH" || { echo "[FAIL] no-backup kit does not point at the primary identity as the only thing that can restore"; exit 1; }
grep -q 'cypher-brain keygen' "$F_KIT_PATH" || { echo "[FAIL] no-backup kit does not explain generating a backup key for real kit-only recovery later"; exit 1; }
grep -q 'still valid, useful' "$F_KIT_PATH" || { echo "[FAIL] no-backup kit does not note the save-locator/pin-recipients sections remain valid regardless"; exit 1; }
echo "[PASS] no-backup kit is honest: no BACKUP IDENTITY block or dependent instructions, explains primary-identity-only recovery + the keygen path to real kit-only recovery later"

echo "== (g2) the accepted pin suggestion, and the kit heading it lands under, both name config.env (issue #299) =="
# Test (f) is the only run here that answers YES to the pin suggestion, so its
# transcript and its kit carry the two artifacts the pre-#286 shell-rc advice used to
# live in: the suggested line itself (which was `export KEY="..."`, shell syntax) and
# the kit's own heading (which told the reader to put it in ~/.zshrc). config.env takes
# `KEY=value` lines, so an `export` prefix is not what should be suggested first.
F_PIN_PUB="$(head -n1 "$F_CB_HOME/recipient.txt")"
grep -qF "CYPHER_BRAIN_PIN_RECIPIENTS=\"$F_PIN_PUB\"" "$TMP/wizard-pass.log" || { echo "[FAIL] the pin=yes run never printed a suggested line containing this run's own recipient"; cat "$TMP/wizard-pass.log"; exit 1; }
if grep -qE '^export CYPHER_BRAIN_PIN_RECIPIENTS=' "$TMP/wizard-pass.log"; then echo "[FAIL] the suggested line is still shell-rc syntax (export ...) rather than a config.env KEY=value line"; cat "$TMP/wizard-pass.log"; exit 1; fi
grep -qF "Add this line to $F_CB_HOME/config.env" "$TMP/wizard-pass.log" || { echo "[FAIL] the pin=yes run does not tell the user which file to add the line to"; cat "$TMP/wizard-pass.log"; exit 1; }
grep -qF -- '--- CYPHER_BRAIN_PIN_RECIPIENTS (add to $CYPHER_BRAIN_HOME/config.env' "$F_KIT_PATH" || { echo "[FAIL] the printed recovery kit's pin heading does not name config.env"; exit 1; }
if grep -qF 'add to your shell rc, e.g. ~/.zshrc' "$F_KIT_PATH"; then echo "[FAIL] the printed recovery kit still carries the pre-#286 shell-rc instruction"; exit 1; fi
grep -qF "CYPHER_BRAIN_PIN_RECIPIENTS=\"$F_PIN_PUB\"" "$F_KIT_PATH" || { echo "[FAIL] the kit does not inline the exact pin line the wizard suggested"; exit 1; }
echo "[PASS] pin=yes suggests a config.env KEY=value line (no export prefix), names the file to add it to, and the kit heading carries that same instruction onto the printed sheet"

# issue #622: the shell-rc alternative (still offered right below the config.env
# instruction, for the interactive-shells-only use case the prose above already
# explains) used to carry no caveat that it EXECUTES the suggested line as shell code,
# unlike config.env (which is parsed as KEY=value, never executed, per #299 above). A
# user who edits the suggested line to include shell metacharacters and follows the
# shell-rc alternative would source it as literal shell code on every new shell with no
# warning the two destinations differ. Test (f)'s run is the only one here that accepts
# the pin suggestion, so its transcript is what carries this instruction.
grep -qF 'SOURCES this line as literal shell code on every new shell' "$TMP/wizard-pass.log" || { echo "[FAIL] the shell-rc alternative does not caveat that it executes the line as shell code (issue #622)"; cat "$TMP/wizard-pass.log"; exit 1; }
echo "[PASS] the shell-rc alternative now caveats that it sources the suggested line as literal shell code, unlike config.env (issue #622 fixed)"

echo "== (g3) the init wizard also suggests CYPHER_BRAIN_MCP_SOURCE_ROOTS, naming the directories just chosen (#800/#820) =="
# Test (f)'s run picked profile 'none' with a single directory ($F_SRC) — the wizard
# must suggest a JSON-array CYPHER_BRAIN_MCP_SOURCE_ROOTS line naming exactly that
# directory, clearly labelled as MCP-only (the CLI itself has no such gate).
grep -qF "CYPHER_BRAIN_MCP_SOURCE_ROOTS='[\"$F_SRC\"]'" "$TMP/wizard-pass.log" \
  || { echo "[FAIL] the wizard did not suggest a CYPHER_BRAIN_MCP_SOURCE_ROOTS line naming the chosen directory"; cat "$TMP/wizard-pass.log"; exit 1; }
grep -qF 'Only needed if you will drive snapshots through the MCP server' "$TMP/wizard-pass.log" \
  || { echo "[FAIL] the CYPHER_BRAIN_MCP_SOURCE_ROOTS suggestion is not labelled MCP-only"; cat "$TMP/wizard-pass.log"; exit 1; }
echo "[PASS] init also suggests a CYPHER_BRAIN_MCP_SOURCE_ROOTS line naming the chosen directory, labelled MCP-only"

echo "== (h) rollback + clean retry: a failure AFTER identity creation must not brick a retry (P2 fix) =="
# The primary identity is created in step 1/6, well before later prompts that can
# fail/abort (declining the paid-backend spend consent, a cancelled prompt, ...) —
# an empty directory answer no longer belongs on this list (#492: it re-prompts
# instead of throwing, see (c) above). Before the fix, any such later failure left
# the identity behind — and
# `init` refuses unconditionally whenever an identity already exists — so a
# declined-then-retried run was permanently stuck needing the scarier `keygen
# --force`. Drive a run that succeeds through backup-key generation (so BOTH
# primary and backup identities exist), picks arweave with a wallet FILE present
# (so the #161 precheck above lets it through to the real consent prompt — see
# (o3) below, which proves that same precheck-bypass-then-decline path in
# isolation) and THEN declines the "spends real funds" consent, then prove (1)
# the rollback actually deleted every file this run wrote, and (2) a second,
# genuine `cypher-brain init` run against the SAME CYPHER_BRAIN_HOME starts clean
# and completes — the retry story working end-to-end, not just files
# disappearing. (#396 Phase B: the OLD version of this test used a free-text
# "not-a-real-backend" typo to reach this same post-identity failure point —
# select() makes that specific typo structurally unreachable now (askSelect's own
# doc comment in wizard.ts), so this test needed a different, still-genuine late
# failure; declining consent already existed as a throw path before this PR.)
RB_HOME="$TMP/rollback-home"; mkdir -p "$RB_HOME"
RB_CB_HOME="$TMP/rollback-cb-home"
RB_STORE="$TMP/rollback-store"
RB_SRC="$TMP/rollback-src"; mkdir -p "$RB_SRC"
printf 'rollback-marker\n' > "$RB_SRC/note.txt"
RB_BACKUP_HOME="${RB_CB_HOME}-backup" # the default sibling path the wizard suggests for the backup key
RB_WALLET="$TMP/rollback-wallet.json"
cb wallet create --out "$RB_WALLET" > "$TMP/rollback-walletcreate.log" 2>&1 \
  || { echo "[FAIL] test setup: could not create a wallet fixture for the rollback test"; cat "$TMP/rollback-walletcreate.log"; exit 1; }

cat > "$TMP/qa-rollback-fail.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$RB_SRC"],
  ["Choose a backend", "\u001b[A\u001b[A"],
  ["PAID, PERMANENT store", "n"]
]
JSON

if CYPHER_BRAIN_HOME="$RB_CB_HOME" CYPHER_BRAIN_FILE_DIR="$RB_STORE" HOME="$RB_HOME" CYPHER_BRAIN_AR_WALLET="$RB_WALLET" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-rollback-fail.json" --out "$TMP/rollback-fail.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not fail when the spend-consent prompt was declined"; cat "$TMP/rollback-fail.log"; exit 1
fi
grep -qi "aborted before spending" "$TMP/rollback-fail.log" || { echo "[FAIL] failure was not the expected declined-consent error"; cat "$TMP/rollback-fail.log"; exit 1; }
[ ! -f "$RB_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity survived a post-creation failure — rollback did not run"; exit 1; }
[ ! -f "$RB_CB_HOME/recipient.txt" ] || { echo "[FAIL] primary recipient survived a post-creation failure"; exit 1; }
[ ! -f "$RB_BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity survived a post-creation failure"; exit 1; }
[ ! -f "$RB_BACKUP_HOME/recipient.txt" ] || { echo "[FAIL] backup recipient survived a post-creation failure"; exit 1; }
echo "[PASS] a failure AFTER identity creation rolls back the primary + backup identity/recipient files this run wrote"

RB_KIT_PATH="$RB_HOME/recovery-kit.txt"
cat > "$TMP/qa-rollback-retry.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$RB_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$RB_KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$RB_CB_HOME" CYPHER_BRAIN_FILE_DIR="$RB_STORE" HOME="$RB_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-rollback-retry.json" --out "$TMP/rollback-retry.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] retry after rollback did not complete (pre-existing-identity refusal or another regression)"; cat "$TMP/rollback-retry.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/rollback-retry.log" || { echo "[FAIL] retry after rollback lacks its own completion marker"; cat "$TMP/rollback-retry.log"; exit 1; }
[ -f "$RB_CB_HOME/identity.age" ] || { echo "[FAIL] retry did not write a fresh primary identity"; exit 1; }
echo "[PASS] a second 'cypher-brain init' run against the same CYPHER_BRAIN_HOME starts clean and completes after rollback (the retry story actually works, not just file deletion)"

echo "== (i) '~' in interactive path answers expands to HOME, the same way a shell would (P3 fix) =="
# Path-like answers are read as plain strings (no shell involved), so a leading '~'
# would otherwise resolve to a literal '~'-named entry relative to cwd instead of the
# real home directory. Answer BOTH the directory-to-back-up prompt and the
# recovery-kit path prompt with a '~/...' path inside a controlled HOME fixture: if
# expansion did not happen, snapshot's tar step would try to read a nonexistent
# literal './~/...' path and the whole run would fail before completing.
TILDE_HOME="$TMP/tilde-home"; mkdir -p "$TILDE_HOME"
TILDE_SRC_REL="tilde-src" # answered as "~/$TILDE_SRC_REL"
mkdir -p "$TILDE_HOME/$TILDE_SRC_REL"
TILDE_MARKER="tilde-thought-$(od -An -N6 -tx1 /dev/urandom | tr -d ' ')"
printf '%s\n' "$TILDE_MARKER" > "$TILDE_HOME/$TILDE_SRC_REL/note.txt"
TILDE_CB_HOME="$TMP/tilde-cb-home"
TILDE_STORE="$TMP/tilde-store"

cat > "$TMP/qa-tilde.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "~/$TILDE_SRC_REL"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "~/tilde-recovery-kit.txt"]
]
JSON

CYPHER_BRAIN_HOME="$TILDE_CB_HOME" CYPHER_BRAIN_FILE_DIR="$TILDE_STORE" HOME="$TILDE_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-tilde.json" --out "$TMP/tilde.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the '~'-path scripted run did not complete (path expansion likely did not happen)"; cat "$TMP/tilde.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/tilde.log" || { echo "[FAIL] '~'-path run lacks its own completion marker"; cat "$TMP/tilde.log"; exit 1; }
[ -f "$TILDE_HOME/tilde-recovery-kit.txt" ] || { echo "[FAIL] recovery kit was not written under the expanded HOME (~/tilde-recovery-kit.txt did not expand)"; exit 1; }
[ ! -e "$ROOT/~" ] || { echo "[FAIL] a literal '~' file/dir was created relative to cwd — '~' was not expanded"; exit 1; }
echo "[PASS] '~/...' directory-to-back-up and recovery-kit path answers both expanded to the real HOME, matching shell behavior"

echo "== (j0) a failure BEFORE push() succeeds still rolls back the identity AND the snapshot artifact =="
# Establishes the OTHER side of the 6th-round P2 rollback-boundary fix: everything
# BEFORE push() succeeds must still roll back exactly as before (only failures AFTER
# a successful push change behavior — see (j)/(j2) below). Fail deterministically
# inside push()'s file-backend put() by pointing CYPHER_BRAIN_FILE_DIR at a path
# whose PARENT is a plain FILE, so fileBackend().put()'s own
# `mkdir(FILE_DIR, { recursive: true })` throws ENOTDIR before push() ever returns —
# i.e. before pushSucceeded flips true in wizard.ts. The QA script intentionally
# stops at the backend prompt: push() throws before the recovery-kit path is ever
# asked, so scripting that prompt would leave it unconsumed and fail drive-init.mjs
# itself (ed1f2d6) rather than testing what we want here.
J0_HOME="$TMP/prepush-rollback-home"; mkdir -p "$J0_HOME"
J0_CB_HOME="$TMP/prepush-rollback-cb-home"
J0_STORE_BLOCKED_PARENT="$TMP/prepush-rollback-store-blocked-parent"
: > "$J0_STORE_BLOCKED_PARENT" # plain FILE — FILE_DIR nests a dir UNDER this
J0_STORE="$J0_STORE_BLOCKED_PARENT/subdir-store"
J0_SRC="$TMP/prepush-rollback-src"; mkdir -p "$J0_SRC"
printf 'prepush-rollback-marker\n' > "$J0_SRC/note.txt"

cat > "$TMP/qa-prepush-rollback-fail.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$J0_SRC"],
  ["Choose a backend", ""]
]
JSON

if CYPHER_BRAIN_HOME="$J0_CB_HOME" CYPHER_BRAIN_FILE_DIR="$J0_STORE" HOME="$J0_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-prepush-rollback-fail.json" --out "$TMP/prepush-rollback-fail.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not fail when the file backend's store dir has a blocked parent"; cat "$TMP/prepush-rollback-fail.log"; exit 1
fi
grep -qi "ENOTDIR\|not a directory" "$TMP/prepush-rollback-fail.log" || { echo "[FAIL] failure was not the expected pre-push ENOTDIR error"; cat "$TMP/prepush-rollback-fail.log"; exit 1; }
[ ! -f "$J0_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity survived a PRE-push failure — rollback should still fire here"; exit 1; }
[ ! -f "$J0_CB_HOME/recipient.txt" ] || { echo "[FAIL] primary recipient survived a PRE-push failure"; exit 1; }
J0_LEFTOVER="$(find "$J0_CB_HOME" -maxdepth 1 -name 'brain-*.age*' 2>/dev/null | head -n1)"
[ -z "$J0_LEFTOVER" ] || { echo "[FAIL] a snapshot artifact/sidecar survived a PRE-push failure: $J0_LEFTOVER"; exit 1; }
echo "[PASS] a failure BEFORE push() succeeds (push() itself throwing) still rolls back the identity AND the snapshot artifact + sidecars, exactly as before the P2 fix"

echo "== (j) a failure AFTER push() succeeds preserves the identity + snapshot instead of rolling them back (6th-round P2 fix) =="
# The OLD behavior (5th round, fb293ff/0565194) rolled back the identity + snapshot
# artifact for ANY post-creation failure, including one AFTER push() had already
# durably written the ciphertext to the backend's store. For a paid backend
# (arweave/turbo) that upload is PERMANENT and IRREVERSIBLE — deleting the only keys
# that can ever decrypt it would turn a mere "kit step needs a retry" into
# unrecoverable data + money loss. Reuses the exact repro that used to prove the OLD
# (now-wrong) behavior: make the very last step — the recovery kit's own
# mkdir/write — fail by pre-creating the kit path's PARENT as a plain FILE, so
# mkdir(dirname(kitPath), { recursive: true }) throws ENOTDIR AFTER snapshot() and
# push() have both already succeeded.
SNAP_HOME="$TMP/snap-preserve-home"; mkdir -p "$SNAP_HOME"
SNAP_CB_HOME="$TMP/snap-preserve-cb-home"
SNAP_STORE="$TMP/snap-preserve-store"
SNAP_SRC="$TMP/snap-preserve-src"; mkdir -p "$SNAP_SRC"
printf 'snap-preserve-marker\n' > "$SNAP_SRC/note.txt"
BLOCKED_PARENT="$SNAP_HOME/blocked-kit-parent"
: > "$BLOCKED_PARENT" # plain FILE — the kit path nests a dir UNDER this, so mkdir -p
                      # must traverse it as a parent component (ENOTDIR), not just
                      # target it directly (which would be EEXIST instead)
BLOCKED_KIT_PATH="$BLOCKED_PARENT/subdir/recovery-kit.txt"

cat > "$TMP/qa-snap-preserve-fail.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$SNAP_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$BLOCKED_KIT_PATH"]
]
JSON

if CYPHER_BRAIN_HOME="$SNAP_CB_HOME" CYPHER_BRAIN_FILE_DIR="$SNAP_STORE" HOME="$SNAP_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-snap-preserve-fail.json" --out "$TMP/snap-preserve-fail.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not fail when the recovery-kit path's parent is a plain file"; cat "$TMP/snap-preserve-fail.log"; exit 1
fi
grep -qi "ENOTDIR\|not a directory" "$TMP/snap-preserve-fail.log" || { echo "[FAIL] failure was not the expected kit-write ENOTDIR error"; cat "$TMP/snap-preserve-fail.log"; exit 1; }
[ -f "$SNAP_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity was DELETED after a successful push — this is the data-loss regression the P2 fix prevents"; exit 1; }
[ -f "$SNAP_CB_HOME/recipient.txt" ] || { echo "[FAIL] primary recipient was DELETED after a successful push"; exit 1; }
SNAP_SURVIVOR="$(find "$SNAP_CB_HOME" -maxdepth 1 -name 'brain-*.age' 2>/dev/null | head -n1)"
[ -n "$SNAP_SURVIVOR" ] || { echo "[FAIL] the dated snapshot artifact was DELETED after a successful push"; exit 1; }
grep -qi "already created and pushed" "$TMP/snap-preserve-fail.log" || { echo "[FAIL] failure message does not clearly state the snapshot was already pushed"; cat "$TMP/snap-preserve-fail.log"; exit 1; }
grep -qi "PRESERVED" "$TMP/snap-preserve-fail.log" || { echo "[FAIL] failure message does not clearly say the identity/snapshot files are preserved"; cat "$TMP/snap-preserve-fail.log"; exit 1; }
grep -qF "$SNAP_CB_HOME/identity.age" "$TMP/snap-preserve-fail.log" || { echo "[FAIL] failure message does not name the preserved primary identity path"; cat "$TMP/snap-preserve-fail.log"; exit 1; }
echo "[PASS] a failure AFTER push() succeeds (kit write) preserves the identity, recipient, AND the dated snapshot artifact — nothing is rolled back — and the error clearly states what already succeeded and what is preserved"

echo "== (j2) retry after a post-push failure correctly REFUSES — identity + snapshot are still there, not silently regenerated =="
# Because (j) above no longer deletes anything, a same-day retry against the SAME
# CYPHER_BRAIN_HOME must hit the ordinary pre-existing-identity refusal (test (a)) —
# starting "clean" here would be wrong: it would silently abandon the real,
# already-pushed snapshot (and, on a paid backend, already-spent money) in favor of
# a brand new identity that cannot decrypt it.
SNAP_RETRY_RC=0
CYPHER_BRAIN_HOME="$SNAP_CB_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 10 node "${BIN_DEV_ARGS[@]}" "$BIN" init < /dev/null > "$TMP/snap-preserve-retry.log" 2>&1 || SNAP_RETRY_RC=$?
[ "$SNAP_RETRY_RC" != "0" ] || { echo "[FAIL] a retry after a post-push failure did not refuse — it should, since the identity/snapshot are preserved"; cat "$TMP/snap-preserve-retry.log"; exit 1; }
[ "$SNAP_RETRY_RC" != "137" ] || { echo "[FAIL] the retry did not refuse promptly -- it hung until the 10s with_timeout watchdog SIGKILLed it"; cat "$TMP/snap-preserve-retry.log"; exit 1; }
grep -qi "already exists" "$TMP/snap-preserve-retry.log" || { echo "[FAIL] retry's refusal was not the expected pre-existing-identity error"; cat "$TMP/snap-preserve-retry.log"; exit 1; }
[ -f "$SNAP_CB_HOME/identity.age" ] || { echo "[FAIL] the preserved primary identity vanished between the two runs"; exit 1; }
[ -n "$(find "$SNAP_CB_HOME" -maxdepth 1 -name 'brain-*.age' 2>/dev/null | head -n1)" ] || { echo "[FAIL] the preserved snapshot artifact vanished between the two runs"; exit 1; }
echo "[PASS] a second 'cypher-brain init' run against the same CYPHER_BRAIN_HOME correctly refuses (identity + snapshot from the successful push are still there, exactly as promised) instead of silently starting over"

echo "== (k) push() succeeding but --save-locator's own write failing preserves everything + surfaces the locator (7th-round P1 fix, finding 1) =="
# backend.put() (the actual, possibly PAID/PERMANENT upload) is the point of no
# return; --save-locator's own bookkeeping write happens strictly AFTER it. Force
# JUST that local write to fail (not the upload) by pre-creating the locator's
# target path as a DIRECTORY: push()'s tmp-write succeeds (a distinctly-named
# sibling filename), but its rename(tmp, save_locator) then fails EISDIR — same
# "blocking file/dir at the exact target path" technique (j)/(j2) already use for
# the kit path. Before the P1 fix, push() rejecting here (regardless of WHY) made
# the wizard treat the whole run as if nothing had happened yet and delete the
# primary identity — even though the upload above it already durably succeeded.
K_HOME="$TMP/locator-preserve-home"; mkdir -p "$K_HOME"
K_CB_HOME="$TMP/locator-preserve-cb-home"
K_STORE="$TMP/locator-preserve-store"
K_SRC="$TMP/locator-preserve-src"; mkdir -p "$K_SRC"
printf 'locator-preserve-marker\n' > "$K_SRC/note.txt"
K_LOCATOR_PATH="$K_CB_HOME/latest-locator.tsv"
mkdir -p "$K_LOCATOR_PATH"  # pre-create AS A DIRECTORY at the wizard's fixed --save-locator path

cat > "$TMP/qa-locator-preserve-fail.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$K_SRC"],
  ["Choose a backend", ""]
]
JSON
# (Same reasoning as (j0)'s QA script: push() throws right after the backend prompt,
# before the recovery-kit path is ever asked — scripting that prompt would leave it
# unconsumed and fail drive-init.mjs itself rather than testing what we want here.)

if CYPHER_BRAIN_HOME="$K_CB_HOME" CYPHER_BRAIN_FILE_DIR="$K_STORE" HOME="$K_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-locator-preserve-fail.json" --out "$TMP/locator-preserve-fail.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not fail when --save-locator's target path is a directory"; cat "$TMP/locator-preserve-fail.log"; exit 1
fi
grep -qi "EISDIR\|is a directory" "$TMP/locator-preserve-fail.log" || { echo "[FAIL] failure was not the expected locator-write EISDIR error"; cat "$TMP/locator-preserve-fail.log"; exit 1; }
grep -qi "ACTION REQUIRED" "$TMP/locator-preserve-fail.log" || { echo "[FAIL] failure message does not carry the ACTION REQUIRED hand-record instruction"; cat "$TMP/locator-preserve-fail.log"; exit 1; }
grep -qi "already happened and cannot be undone" "$TMP/locator-preserve-fail.log" || { echo "[FAIL] failure message does not state the upload already happened"; cat "$TMP/locator-preserve-fail.log"; exit 1; }
grep -q "NOT SAVED" "$TMP/locator-preserve-fail.log" || { echo "[FAIL] the outer message still prints a stale/null locator path instead of NOT SAVED"; cat "$TMP/locator-preserve-fail.log"; exit 1; }
grep -qF "$K_STORE" "$TMP/locator-preserve-fail.log" || { echo "[FAIL] failure message does not surface the backend's locator value for hand-recording"; cat "$TMP/locator-preserve-fail.log"; exit 1; }
[ -n "$(find "$K_STORE" -maxdepth 1 -name '*.age' 2>/dev/null | head -n1)" ] || { echo "[FAIL] no object landed in the file-backend store — the upload itself did not actually happen, this test proves nothing"; exit 1; }
[ -f "$K_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity was DELETED after a successful push (locator-write failure wrongly treated as pre-push) — the finding-1 regression"; exit 1; }
[ -f "$K_CB_HOME/recipient.txt" ] || { echo "[FAIL] primary recipient was DELETED after a successful push"; exit 1; }
K_SNAP="$(find "$K_CB_HOME" -maxdepth 1 -name 'brain-*.age' 2>/dev/null | head -n1)"
[ -n "$K_SNAP" ] || { echo "[FAIL] the dated snapshot artifact was DELETED after a successful push"; exit 1; }
K_TMP_LEFTOVER="$(find "$K_CB_HOME" -maxdepth 1 -name 'latest-locator.tsv.*.tmp' 2>/dev/null | head -n1)"
[ -z "$K_TMP_LEFTOVER" ] || { echo "[FAIL] a .tmp sibling of the locator file survived: $K_TMP_LEFTOVER"; exit 1; }
echo "[PASS] a locator-write failure AFTER a successful push preserves the identity, recipient, AND the dated snapshot artifact — the error surfaces the ACTION-REQUIRED locator value instead of losing it"

echo "== (k2) retry after the finding-1 locator-write failure correctly REFUSES (identity + snapshot preserved, exactly as (j2)) =="
LOCATOR_RETRY_RC=0
CYPHER_BRAIN_HOME="$K_CB_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 10 node "${BIN_DEV_ARGS[@]}" "$BIN" init < /dev/null > "$TMP/locator-preserve-retry.log" 2>&1 || LOCATOR_RETRY_RC=$?
[ "$LOCATOR_RETRY_RC" != "0" ] || { echo "[FAIL] a retry after a finding-1 locator-write failure did not refuse — it should, since the identity/snapshot are preserved"; cat "$TMP/locator-preserve-retry.log"; exit 1; }
[ "$LOCATOR_RETRY_RC" != "137" ] || { echo "[FAIL] the retry did not refuse promptly -- it hung until the 10s with_timeout watchdog SIGKILLed it"; cat "$TMP/locator-preserve-retry.log"; exit 1; }
grep -qi "already exists" "$TMP/locator-preserve-retry.log" || { echo "[FAIL] retry's refusal was not the expected pre-existing-identity error"; cat "$TMP/locator-preserve-retry.log"; exit 1; }
echo "[PASS] a second 'cypher-brain init' run against the same CYPHER_BRAIN_HOME correctly refuses instead of silently starting over on top of the preserved, already-uploaded snapshot"

echo "== (l) backup keygen refuses when a stray recipient.txt pre-exists at the backup path — no identity.age is ever written, so no orphan is possible (#121 fix; supersedes the old 7th-round P2 finding-2b EACCES repro) =="
# Before #121, keygenAt() (keys.ts) wrote identity.age (wx, exclusive-create) THEN
# recipient.txt with NO existence check at all on recipientPath — a stray pre-existing
# recipient.txt got silently clobbered. The 7th-round P2 finding-2b fix below this test
# used to repro "identity.age written, recipient.txt write throws" by pre-creating
# recipient.txt as WRITE-DENIED (0444) so only its write failed with EACCES; that relied
# on the old ordering (identity write happens first, unconditionally). #121 adds its own
# up-front no-clobber check on recipientPath, run BEFORE identity.age is generated or
# written at all — so a pre-existing recipient.txt now refuses immediately, and the
# specific "identity.age written but recipient.txt write throws" partial state this test
# used to construct is no longer reachable via a pre-existing recipient.txt. Prove the
# stronger guarantee directly: nothing is written on this path AT ALL, so there is no
# orphan for the wizard's own cleanup (tested separately in (l2)/(l3) below) to catch.
L_HOME="$TMP/backup-partial-home"; mkdir -p "$L_HOME"
L_CB_HOME="$TMP/backup-partial-cb-home"
L_STORE="$TMP/backup-partial-store"
L_SRC="$TMP/backup-partial-src"; mkdir -p "$L_SRC"
printf 'backup-partial-marker\n' > "$L_SRC/note.txt"
L_BACKUP_HOME="${L_CB_HOME}-backup" # the default sibling path the wizard suggests for the backup key
mkdir -p "$L_BACKUP_HOME"
L_BLOCKED_RECIPIENT="$L_BACKUP_HOME/recipient.txt"
printf 'stale\n' > "$L_BLOCKED_RECIPIENT"

cat > "$TMP/qa-backup-partial-fail.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""]
]
JSON
# (Push never happens on this run — it fails in step 2/6, long before step 6 — so the
# QA script stops right after the one prompt this failure is reached through.)

if CYPHER_BRAIN_HOME="$L_CB_HOME" CYPHER_BRAIN_FILE_DIR="$L_STORE" HOME="$L_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-backup-partial-fail.json" --out "$TMP/backup-partial-fail.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not fail when the backup keypair's recipient.txt path already exists"; cat "$TMP/backup-partial-fail.log"; exit 1
fi
grep -qi "recipient already exists" "$TMP/backup-partial-fail.log" || { echo "[FAIL] failure was not keygenAt's new recipientPath no-clobber refusal (#121)"; cat "$TMP/backup-partial-fail.log"; exit 1; }
[ ! -f "$L_BACKUP_HOME/identity.age" ] || { echo "[FAIL] a backup identity.age was written despite the recipientPath refusal — the #121 up-front check did not run before the identity write"; exit 1; }
cmp -s "$L_BACKUP_HOME/recipient.txt" <(printf 'stale\n') || { echo "[FAIL] the stray recipient.txt fixture was modified — it must be left byte-identical"; exit 1; }
[ ! -f "$L_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity survived (the pre-existing generic rollback should still have cleared it)"; exit 1; }
echo "[PASS] a stray pre-existing recipient.txt at the backup path refuses up front (#121) — no backup identity.age is ever written, and the stray file is left untouched"

echo "== (l2) retry after clearing the stray recipient.txt succeeds (same default backup path, backup=yes again) =="
# (l)'s stray recipient.txt is still sitting at L_BACKUP_HOME and keygenAt() (#121)
# will keep refusing it on every retry, same as (l3) below proves for a REAL
# pre-existing backup identity — the wizard cannot tell "stale leftover fixture" apart
# from "genuine pre-existing key" any more than it can tell "stale" apart from
# "genuine" in general, and must not guess; it correctly leaves the file untouched
# rather than removing something it did not itself create (see test (l3) below for
# the case where that file IS a real key). A real user would notice the leftover
# obstruction from the failed run and clear it by hand before retrying; simulate
# exactly that one manual step here so this test still proves the REST of the retry
# story (a clean retry succeeds once nothing is actually left in the way).
rm -f "$L_BLOCKED_RECIPIENT"

cat > "$TMP/qa-backup-partial-retry.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$L_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$L_HOME/recovery-kit.txt"]
]
JSON
CYPHER_BRAIN_HOME="$L_CB_HOME" CYPHER_BRAIN_FILE_DIR="$L_STORE" HOME="$L_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-backup-partial-retry.json" --out "$TMP/backup-partial-retry.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] retry after clearing the stray recipient.txt did not complete (still blocked, or another regression)"; cat "$TMP/backup-partial-retry.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/backup-partial-retry.log" || { echo "[FAIL] retry after clearing the stray recipient.txt lacks its own completion marker"; cat "$TMP/backup-partial-retry.log"; exit 1; }
[ -f "$L_BACKUP_HOME/identity.age" ] || { echo "[FAIL] retry did not write a fresh backup identity at the same default path"; exit 1; }
echo "[PASS] a retry against the same CYPHER_BRAIN_HOME (same default backup path, backup=yes again) succeeds once the stray recipient.txt is cleared — the #121 refusal is not a permanent brick"

echo "== (l3) pointing the backup-path prompt at an EXISTING real backup identity refuses without destroying it (round-8 regression fix) =="
# Round 7's own fix (6177702) wrapped the backup keygenAt() call in a try/catch that
# unconditionally rm'd identityPath/recipientPath on ANY failure, before rethrowing.
# keygenAt() (keys.ts) has its own precondition check — it throws BEFORE writing
# anything if identityPath already exists — so pointing the backup-path prompt at a
# directory that already holds a REAL, previously-set-up backup identity (e.g.
# re-running this step against an existing offline backup location) made that catch
# delete the real key for no reason other than "keygenAt declined to overwrite it":
# strictly worse than the bug it was fixing (permanent, unrecoverable key loss vs. a
# blocked retry). Prove the fix: a REAL backup identity pre-exists at the answered
# path (created via a real keygen, not a hand-rolled stand-in), keygenAt still
# refuses (unchanged behavior), and the pre-existing files survive completely
# untouched — byte-identical, not just "still present".
M_HOME="$TMP/backup-preexist-home"; mkdir -p "$M_HOME"
M_CB_HOME="$TMP/backup-preexist-cb-home"
M_STORE="$TMP/backup-preexist-store"
M_SRC="$TMP/backup-preexist-src"; mkdir -p "$M_SRC"
printf 'backup-preexist-marker\n' > "$M_SRC/note.txt"
M_BACKUP_HOME="$TMP/backup-preexist-existing-backup" # a REAL, already-set-up backup identity lives here BEFORE the wizard ever runs

CYPHER_BRAIN_HOME="$M_BACKUP_HOME" cb keygen > "$TMP/backup-preexist-setup.log" 2>&1 \
  || { echo "[FAIL] test setup: could not create a real pre-existing backup identity"; cat "$TMP/backup-preexist-setup.log"; exit 1; }
[ -f "$M_BACKUP_HOME/identity.age" ] || { echo "[FAIL] test setup: pre-existing backup identity.age was not created"; exit 1; }
[ -f "$M_BACKUP_HOME/recipient.txt" ] || { echo "[FAIL] test setup: pre-existing backup recipient.txt was not created"; exit 1; }
cp "$M_BACKUP_HOME/identity.age" "$TMP/backup-preexist-identity.age.orig"
cp "$M_BACKUP_HOME/recipient.txt" "$TMP/backup-preexist-recipient.txt.orig"

cat > "$TMP/qa-backup-preexist-fail.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", "$M_BACKUP_HOME"]
]
JSON
# (Same as test (l): the failure happens in step 2/6, well before push — the QA
# script stops right after the one prompt this failure is reached through.)

if CYPHER_BRAIN_HOME="$M_CB_HOME" CYPHER_BRAIN_FILE_DIR="$M_STORE" HOME="$M_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-backup-preexist-fail.json" --out "$TMP/backup-preexist-fail.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not refuse when the backup-path prompt points at an existing real backup identity"; cat "$TMP/backup-preexist-fail.log"; exit 1
fi
grep -qi "identity already exists" "$TMP/backup-preexist-fail.log" || { echo "[FAIL] failure was not keygenAt's own pre-existing-identity refusal"; cat "$TMP/backup-preexist-fail.log"; exit 1; }
[ -f "$M_BACKUP_HOME/identity.age" ] || { echo "[FAIL] the PRE-EXISTING real backup identity.age was DELETED — the round-8 regression"; exit 1; }
[ -f "$M_BACKUP_HOME/recipient.txt" ] || { echo "[FAIL] the PRE-EXISTING real backup recipient.txt was DELETED — the round-8 regression"; exit 1; }
cmp -s "$M_BACKUP_HOME/identity.age" "$TMP/backup-preexist-identity.age.orig" || { echo "[FAIL] the pre-existing backup identity.age survived but its CONTENT changed — not byte-identical"; exit 1; }
cmp -s "$M_BACKUP_HOME/recipient.txt" "$TMP/backup-preexist-recipient.txt.orig" || { echo "[FAIL] the pre-existing backup recipient.txt survived but its CONTENT changed — not byte-identical"; exit 1; }
[ ! -f "$M_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity survived (the pre-existing generic rollback should still have cleared it)"; exit 1; }
echo "[PASS] pointing the backup-path prompt at a pre-existing real backup identity refuses (keygenAt's own guard, unchanged) and leaves it completely untouched, byte-identical — the round-8 regression is fixed"

echo "== (l4) pointing the backup-path prompt at the PRIMARY CYPHER_BRAIN_HOME itself refuses with an explicit self-collision message (issue #621) =="
# Before this fix, answering the backup-path prompt with the exact same path as
# CYPHER_BRAIN_HOME (a plausible copy-paste mistake, e.g. re-typing $CYPHER_BRAIN_HOME
# out of habit) sailed straight into keygenAt(), which correctly refuses to overwrite
# identityPath/recipientPath (#121's own no-clobber guard, same one test (l3) above
# exercises against a DIFFERENT pre-existing backup) — but here those targets ARE the
# primary identity/recipient this same run just wrote in step 1, so the error read as
# "error: identity already exists at .../identity.age (refusing to overwrite — losing
# it = losing the brain)", as if some unrelated stale file were blocking the backup
# keypair, with no hint that it was actually about to roll back the primary identity
# this run just created (confirmed live via drive-init.mjs against the PRE-fix code
# before this was closed). The fix detects resolve(backupHome) === resolve(HOME)
# BEFORE calling keygenAt and refuses immediately with a message naming the actual
# collision. The primary identity STILL gets rolled back by the outer catch (that part
# is correct, standard behavior, unchanged by this fix — see MEM_CB_HOME's own check
# below) — only the confusing error message is what this closes.
MEM_HOME="$TMP/backup-self-collision-home"; mkdir -p "$MEM_HOME"
MEM_CB_HOME="$TMP/backup-self-collision-cb-home"
MEM_STORE="$TMP/backup-self-collision-store"

cat > "$TMP/qa-backup-self-collision.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", "$MEM_CB_HOME"]
]
JSON
if CYPHER_BRAIN_HOME="$MEM_CB_HOME" CYPHER_BRAIN_FILE_DIR="$MEM_STORE" HOME="$MEM_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-backup-self-collision.json" --out "$TMP/backup-self-collision.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init did not refuse when the backup-path prompt points at the primary CYPHER_BRAIN_HOME itself"; cat "$TMP/backup-self-collision.log"; exit 1
fi
grep -qF "the backup keypair path cannot be the same as your primary CYPHER_BRAIN_HOME" "$TMP/backup-self-collision.log" || { echo "[FAIL] failure does not carry the new, explicit self-collision message"; cat "$TMP/backup-self-collision.log"; exit 1; }
if grep -qi "refusing to overwrite" "$TMP/backup-self-collision.log"; then echo "[FAIL] the old confusing keygenAt no-clobber message still leaked through instead of the new explicit refusal"; cat "$TMP/backup-self-collision.log"; exit 1; fi
[ ! -f "$MEM_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity survived (the standard rollback should still clear it — only the message changed, not this behavior)"; exit 1; }
echo "[PASS] a backup-path answer that collides with the primary CYPHER_BRAIN_HOME refuses immediately with an explicit message naming the collision, before ever reaching keygenAt's own no-clobber guard (issue #621 fixed)"

echo "== THE DRILL (issue #68 acceptance criterion 2): kit-ONLY restore on a simulated fresh, fully isolated machine =="
# Isolation: a BRAND NEW temp dir with NO shared CYPHER_BRAIN_HOME, no leftover
# identity/config from the run above — the same "simulate a fresh machine"
# discipline scripts/selftest-arweave-nodeps.mjs and scripts/selftest-recovery.sh
# already use for their own recovery claims. Only what the KIT FILE ITSELF contains
# is extracted and used; the wizard's live CYPHER_BRAIN_HOME/BACKUP_HOME above are
# never read from here on. The file backend's store dir stands in for "the network"
# (same precedent selftest-recovery.sh uses for its own disk-death simulation) — a
# fresh machine in real life would reach arweave/turbo over the network instead.
DRILL="$TMP/drill-fresh-machine"; mkdir -p "$DRILL"

# Exact-line-anchored (^...$) so the human-readable prose in the kit's "RECOVERY
# STEPS" section — which describes these same two block names in a sentence — can
# never be mistaken for the real BEGIN/END delimiter lines.
awk '/^BEGIN BACKUP IDENTITY FILE$/{f=1;next}/^END BACKUP IDENTITY FILE$/{f=0}f' "$KIT_PATH" > "$DRILL/restore-identity.age"
awk '/^BEGIN SAVE-LOCATOR LINE$/{f=1;next}/^END SAVE-LOCATOR LINE$/{f=0}f' "$KIT_PATH" > "$DRILL/restore-locator.tsv"
[ -s "$DRILL/restore-identity.age" ] || { echo "DRILL RESULT: [FAIL] extracted backup identity from the kit is empty"; exit 1; }
[ -s "$DRILL/restore-locator.tsv" ] || { echo "DRILL RESULT: [FAIL] extracted save-locator line from the kit is empty"; exit 1; }
grep -q '^AGE-SECRET-KEY-1' "$DRILL/restore-identity.age" || { echo "DRILL RESULT: [FAIL] extracted identity does not look like an age secret key"; exit 1; }

CYPHER_BRAIN_FILE_DIR="$WIZ_STORE" HOME="$DRILL" CYPHER_BRAIN_HOME="$DRILL/no-such-home" \
  cb pull --from-locator-file "$DRILL/restore-locator.tsv" --out "$DRILL/restored.age" > "$TMP/drill-pull.log" 2>&1 \
  || { echo "DRILL RESULT: [FAIL] pull --from-locator-file (kit's locator alone) failed"; cat "$TMP/drill-pull.log"; exit 1; }
CYPHER_BRAIN_HOME="$DRILL/no-such-home" \
  cb restore --in "$DRILL/restored.age" --out-dir "$DRILL/restored" --identity "$DRILL/restore-identity.age" > "$TMP/drill-restore.log" 2>&1 \
  || { echo "DRILL RESULT: [FAIL] restore --identity (kit's backup identity alone) failed"; cat "$TMP/drill-restore.log"; exit 1; }

TARFILE="$(find "$DRILL/restored" -maxdepth 1 -name '*.tar.gz' | head -n1)"
[ -n "$TARFILE" ] || { echo "DRILL RESULT: [FAIL] no archived component found in the restored tree"; exit 1; }
tar -xzf "$TARFILE" -C "$DRILL/restored"
RESTORED_SRC_DIR="$DRILL/restored/$(basename "$SRC")"
[ -d "$RESTORED_SRC_DIR" ] || { echo "DRILL RESULT: [FAIL] restored tree does not contain the extracted source directory"; exit 1; }
diff -r "$SRC" "$RESTORED_SRC_DIR" > "$TMP/drill-diff.log" 2>&1 \
  || { echo "DRILL RESULT: [FAIL] restored content differs from the source"; cat "$TMP/drill-diff.log"; exit 1; }
grep -q "$MARKER" "$RESTORED_SRC_DIR/note.txt" || { echo "DRILL RESULT: [FAIL] restored content does not contain the source's unique marker"; exit 1; }
echo "DRILL RESULT: [PASS] kit-only restore on a simulated fresh, isolated machine is byte-identical to the original source (issue #68 acceptance criterion 2 — recorded)"

echo "== (m) a detected gbrain config prompts for --pg and actually threads it into the snapshot (issue #84) =="
# Before the fix, --pg was unreachable from `init` at all (grep never found it in
# wizard.ts) — a gbrain user answering the profile/directory prompts naturally (none +
# ~/.gbrain) got a backup of gbrain's CONFIG only, never its real data (Postgres). Prove
# both halves: (1) the new prompt actually appears when a local gbrain config exists,
# defaulting to YES, and (2) the resulting snapshot/kit genuinely carry a pg_dump
# component end-to-end — not just a flag the wizard silently drops. pg_dump is SHIMMED
# (via CYPHER_BRAIN_PG_BIN) so this needs no real Postgres server, the same technique
# scripts/selftest-schedule.sh's own --pg test already uses.
PG_HOME="$TMP/pg-home"; mkdir -p "$PG_HOME/.gbrain"
printf '{"schema_pack":"gbrain-base-v2"}\n' > "$PG_HOME/.gbrain/config.json"
PG_CB_HOME="$TMP/pg-cb-home"
PG_STORE="$TMP/pg-store"
PG_SRC="$TMP/pg-src"; mkdir -p "$PG_SRC"
printf 'pg-marker\n' > "$PG_SRC/note.txt"
PG_KIT_PATH="$PG_HOME/recovery-kit.txt"
# Passwords are deliberately included in BOTH places libpq allows one — the userinfo
# authority (user:pass@) AND an ordinary ?password= query parameter (Fugu review found
# the query-param form initially survived redaction untouched) — the kit must strip
# both while the username and other query params (sslmode) stay visible.
TEST_PG_PASSWORD_AUTH="s3cr3t-auth-pw"
TEST_PG_PASSWORD_QUERY="s3cr3t-query-pw"
TEST_PG_CONN="postgres://tester:${TEST_PG_PASSWORD_AUTH}@localhost:5432/gbrain-selftest?password=${TEST_PG_PASSWORD_QUERY}&sslmode=require"
TEST_PG_CONN_REDACTED="postgres://tester@localhost:5432/gbrain-selftest?password=REDACTED&sslmode=require"

FAKE_PGBIN="$TMP/fake-pgbin-snapshot"; mkdir -p "$FAKE_PGBIN"
cat > "$FAKE_PGBIN/pg_dump" <<'SHIM'
#!/usr/bin/env bash
set -eu
# args: -Fc --no-owner --no-privileges [-t table ...] -f <dumpPath> <conn> — find -f's value
out=""; prev=""
for a in "$@"; do
  if [ "$prev" = "-f" ]; then out="$a"; fi
  prev="$a"
done
: "${out:?fake pg_dump: no -f <path> found in argv}"
printf 'fake-pg-dump-content\n' > "$out"
# PG_DUMP_ARGV_LOG is OPTIONAL (unlike the -f path above) -- most callers of this shim
# only care that pg_dump ran at all, but a caller that needs to prove WHICH connection
# string actually reached pg_dump (e.g. a fallback-default test, where every call
# produces identical fixture content regardless of argv) can point this at a log file.
if [ -n "${PG_DUMP_ARGV_LOG:-}" ]; then printf '%s\n' "$@" > "$PG_DUMP_ARGV_LOG"; fi
SHIM
chmod +x "$FAKE_PGBIN/pg_dump"

cat > "$TMP/qa-pg.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$PG_SRC"],
  ["Include a Postgres database dump", ""],
  ["Postgres connection string", "$TEST_PG_CONN"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$PG_KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$PG_CB_HOME" CYPHER_BRAIN_FILE_DIR="$PG_STORE" HOME="$PG_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN" \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-pg.json" --out "$TMP/wizard-pg.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the gbrain-detected pg scripted run did not complete"; cat "$TMP/wizard-pg.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-pg.log" || { echo "[FAIL] pg run: wizard log lacks its own completion marker"; cat "$TMP/wizard-pg.log"; exit 1; }
grep -qF "Detected a gbrain config at $PG_HOME/.gbrain/config.json" "$TMP/wizard-pg.log" || { echo "[FAIL] wizard did not detect the gbrain config fixture"; cat "$TMP/wizard-pg.log"; exit 1; }
grep -q 'postgres:          included (pg_dump)' "$TMP/wizard-pg.log" || { echo "[FAIL] completion summary does not report the Postgres dump as included"; cat "$TMP/wizard-pg.log"; exit 1; }
echo "[PASS] a detected gbrain config prompts for --pg (defaulting to yes) and the wizard reports it as included"

PG_SNAP="$(find "$PG_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$PG_SNAP" ] || { echo "[FAIL] no brain-*.age snapshot found for the pg run"; exit 1; }
PG_RESTORE_DIR="$TMP/pg-restored"
CYPHER_BRAIN_HOME="$PG_CB_HOME" cb restore --in "$PG_SNAP" --out-dir "$PG_RESTORE_DIR" > "$TMP/pg-restore.log" 2>&1 \
  || { echo "[FAIL] restoring the pg run's snapshot failed"; cat "$TMP/pg-restore.log"; exit 1; }
[ -f "$PG_RESTORE_DIR/db.dump" ] || { echo "[FAIL] restored tree has no db.dump — --pg was not actually threaded into snapshot()"; exit 1; }
grep -qF 'fake-pg-dump-content' "$PG_RESTORE_DIR/db.dump" || { echo "[FAIL] db.dump does not contain the shimmed pg_dump output — the wizard is not really invoking pg_dump"; exit 1; }
grep -q 'pg_dump:custom' "$PG_RESTORE_DIR/manifest.json" || { echo "[FAIL] manifest.json does not record a pg_dump:custom component"; cat "$PG_RESTORE_DIR/manifest.json"; exit 1; }
echo "[PASS] the snapshot genuinely contains a pg_dump component (shimmed pg_dump was invoked and its real output archived, not just a flag threaded through)"

[ -f "$PG_KIT_PATH" ] || { echo "[FAIL] recovery kit was not written for the pg run"; exit 1; }
grep -qF "Postgres dump: included (connection: $TEST_PG_CONN_REDACTED)" "$PG_KIT_PATH" || { echo "[FAIL] kit header does not record the (redacted) Postgres connection used"; cat "$PG_KIT_PATH"; exit 1; }
grep -q 'THIS BACKUP ALSO INCLUDES A POSTGRES DUMP' "$PG_KIT_PATH" || { echo "[FAIL] kit is missing the pg-restore safety block"; cat "$PG_KIT_PATH"; exit 1; }
grep -qF "Its SOURCE connection was: $TEST_PG_CONN_REDACTED" "$PG_KIT_PATH" || { echo "[FAIL] pg-restore safety block does not name the (redacted) source connection"; cat "$PG_KIT_PATH"; exit 1; }
grep -q 'SCRATCH database' "$PG_KIT_PATH" || { echo "[FAIL] pg-restore safety block does not point at a SCRATCH database"; cat "$PG_KIT_PATH"; exit 1; }
# Fugu review finding: the kit is a long-lived, physically-stored document — it must
# never contain the raw DB password, only the (already-asserted-above) redacted form.
if grep -qF "$TEST_PG_PASSWORD_AUTH" "$PG_KIT_PATH"; then echo "[FAIL] recovery kit leaks the raw Postgres password (userinfo authority form) in plaintext"; cat "$PG_KIT_PATH"; exit 1; fi
if grep -qF "$TEST_PG_PASSWORD_QUERY" "$PG_KIT_PATH"; then echo "[FAIL] recovery kit leaks the raw Postgres password (?password= query form) in plaintext"; cat "$PG_KIT_PATH"; exit 1; fi
# Fugu review finding: the printed restore command must NOT auto-embed the SOURCE
# connection as the restore --pg target — pg_restore --clean would DROP/replace objects
# in whatever database --pg names, so a verbatim copy-paste could clobber a live DB.
# Check against the REDACTED connection (independent of the password checks above,
# which already guarantee the RAW connection can't appear anywhere in the kit — matching
# only the raw form here would make this assertion pass vacuously even if the wizard
# embedded the still-dangerous-but-password-free redacted source as --pg), across the
# quoting styles a restore command could plausibly use.
if grep -qF -- "--pg \"$TEST_PG_CONN_REDACTED" "$PG_KIT_PATH" \
  || grep -qF -- "--pg '$TEST_PG_CONN_REDACTED" "$PG_KIT_PATH" \
  || grep -qF -- "--pg $TEST_PG_CONN_REDACTED" "$PG_KIT_PATH"; then
  echo "[FAIL] kit restore command auto-embeds the (redacted) SOURCE connection as --pg — copy-paste risks clobbering the live database"; cat "$PG_KIT_PATH"; exit 1
fi
echo "[PASS] the recovery kit records the Postgres connection with its password redacted, never auto-embeds --pg with the source, and warns to restore into a SCRATCH database"

echo "== (m2) declining the gbrain-detected Postgres prompt proceeds without --pg (opt-out works, Grok review coverage gap) =="
# The auto-detect default is YES ((m) above), but a real user can say no — prove the
# decline is actually honored end-to-end (no --pg threaded, no db.dump produced), not
# just that the wizard doesn't crash. Reuses PG_HOME/PG_SRC/FAKE_PGBIN from (m) above —
# a fresh CYPHER_BRAIN_HOME/store/kit path so this run does not collide with it.
PG2_CB_HOME="$TMP/pg2-cb-home"
PG2_STORE="$TMP/pg2-store"
PG2_KIT_PATH="$PG_HOME/recovery-kit-2.txt"

cat > "$TMP/qa-pg-decline.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$PG_SRC"],
  ["Include a Postgres database dump", "n"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$PG2_KIT_PATH"]
]
JSON

CYPHER_BRAIN_HOME="$PG2_CB_HOME" CYPHER_BRAIN_FILE_DIR="$PG2_STORE" HOME="$PG_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN" \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-pg-decline.json" --out "$TMP/wizard-pg-decline.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the gbrain-detected pg-DECLINE scripted run did not complete"; cat "$TMP/wizard-pg-decline.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-pg-decline.log" || { echo "[FAIL] pg-decline run: wizard log lacks its own completion marker"; cat "$TMP/wizard-pg-decline.log"; exit 1; }
grep -qF "Detected a gbrain config at $PG_HOME/.gbrain/config.json" "$TMP/wizard-pg-decline.log" || { echo "[FAIL] pg-decline run: wizard did not detect the gbrain config fixture"; cat "$TMP/wizard-pg-decline.log"; exit 1; }
if grep -q 'postgres:          included' "$TMP/wizard-pg-decline.log"; then echo "[FAIL] declining the Postgres prompt still reported it as included"; cat "$TMP/wizard-pg-decline.log"; exit 1; fi
grep -qF 'Postgres dump: not included' "$PG2_KIT_PATH" || { echo "[FAIL] kit does not record the declined Postgres dump as not included"; cat "$PG2_KIT_PATH"; exit 1; }
PG2_SNAP="$(find "$PG2_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$PG2_SNAP" ] || { echo "[FAIL] no brain-*.age snapshot found for the pg-decline run"; exit 1; }
PG2_RESTORE_DIR="$TMP/pg2-restored"
CYPHER_BRAIN_HOME="$PG2_CB_HOME" cb restore --in "$PG2_SNAP" --out-dir "$PG2_RESTORE_DIR" > "$TMP/pg2-restore.log" 2>&1 \
  || { echo "[FAIL] restoring the pg-decline run's snapshot failed"; cat "$TMP/pg2-restore.log"; exit 1; }
if [ -f "$PG2_RESTORE_DIR/db.dump" ]; then echo "[FAIL] declining the Postgres prompt still produced a db.dump component"; exit 1; fi
echo "[PASS] declining the gbrain-detected Postgres prompt (auto-detect defaults to yes, but a real 'n' is honored) proceeds without --pg — no db.dump, kit says not included"

echo "== (m3) a whitespace-only answer to the Postgres connection-string prompt falls back to the default, not a silently-skipped pg_dump (P2 fix) =="
# clack's text() only substitutes defaultValue for a TRULY EMPTY submission (zero
# characters) — a whitespace-only answer (a stray space, an accidental tab) is
# non-empty input as far as clack itself is concerned, so before askLine's own
# trim-then-fallback this became the literal string "   " -> .trim() -> "" -> a
# FALSY snapshotOpts.pg -> snapshot() silently SKIPS pg_dump entirely, producing a
# backup that looks complete but contains no database at all (Codex review finding).
# Reuses PG_HOME/PG_SRC/FAKE_PGBIN from (m)/(m2) above, answering the SAME prompt
# those tests leave at its default with three spaces instead of a bare Enter.
PG3_CB_HOME="$TMP/pg3-cb-home"
PG3_STORE="$TMP/pg3-store"
PG3_KIT_PATH="$PG_HOME/recovery-kit-3.txt"

cat > "$TMP/qa-pg-whitespace.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$PG_SRC"],
  ["Include a Postgres database dump", ""],
  ["Postgres connection string", "   "],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", "$PG3_KIT_PATH"]
]
JSON

# PG_DUMP_ARGV_LOG: the shim always writes identical fixture content regardless of the
# connection string it received, so "db.dump exists and contains the fixture" alone
# would ALSO pass if the fallback silently used the whitespace answer verbatim, or an
# empty string, instead of the real default -- prove the connection string pg_dump
# actually got (its own last positional argument, see snapshot.ts's pg_dump call) is
# the non-blank fallback, not the whitespace this test answered with.
PG3_ARGV_LOG="$TMP/pg3-dump-argv.txt"
CYPHER_BRAIN_HOME="$PG3_CB_HOME" CYPHER_BRAIN_FILE_DIR="$PG3_STORE" HOME="$PG_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 CYPHER_BRAIN_PG_BIN="$FAKE_PGBIN" PG_DUMP_ARGV_LOG="$PG3_ARGV_LOG" \
  with_timeout 90 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-pg-whitespace.json" --out "$TMP/wizard-pg-whitespace.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the whitespace-only pg connection-string run did not complete"; cat "$TMP/wizard-pg-whitespace.log"; exit 1; }
grep -q 'cypher-brain init: complete' "$TMP/wizard-pg-whitespace.log" || { echo "[FAIL] whitespace-pg run: wizard log lacks its own completion marker"; cat "$TMP/wizard-pg-whitespace.log"; exit 1; }
grep -q 'postgres:          included (pg_dump)' "$TMP/wizard-pg-whitespace.log" || { echo "[FAIL] a whitespace-only connection-string answer did not fall back to the default — pg_dump was silently skipped (the P2 regression)"; cat "$TMP/wizard-pg-whitespace.log"; exit 1; }
[ -s "$PG3_ARGV_LOG" ] || { echo "[FAIL] pg_dump's argv was never logged — the shim did not run"; exit 1; }
# printf '%s\n' "$@" (in the shim) writes one argv item per line -- the connection
# string is pg_dump's own LAST positional argument (snapshot.ts's pg_dump call), i.e.
# the log file's last line.
PG3_ACTUAL_CONN="$(tail -n1 "$PG3_ARGV_LOG")"
case "$PG3_ACTUAL_CONN" in
  ''|' '|'   ') echo "[FAIL] pg_dump was invoked with a blank/whitespace connection string ('$PG3_ACTUAL_CONN') — the whitespace answer reached pg_dump instead of falling back to the default"; cat "$PG3_ARGV_LOG"; exit 1 ;;
  postgres://*localhost:5432/gbrain) ;;
  *) echo "[FAIL] pg_dump's connection string ('$PG3_ACTUAL_CONN') does not match the documented default shape (postgres://<user>@localhost:5432/gbrain)"; cat "$PG3_ARGV_LOG"; exit 1 ;;
esac
PG3_SNAP="$(find "$PG3_CB_HOME" -maxdepth 1 -name 'brain-*.age' | head -n1)"
[ -n "$PG3_SNAP" ] || { echo "[FAIL] no brain-*.age snapshot found for the whitespace-pg run"; exit 1; }
PG3_RESTORE_DIR="$TMP/pg3-restored"
CYPHER_BRAIN_HOME="$PG3_CB_HOME" cb restore --in "$PG3_SNAP" --out-dir "$PG3_RESTORE_DIR" > "$TMP/pg3-restore.log" 2>&1 \
  || { echo "[FAIL] restoring the whitespace-pg run's snapshot failed"; cat "$TMP/pg3-restore.log"; exit 1; }
[ -f "$PG3_RESTORE_DIR/db.dump" ] || { echo "[FAIL] restored tree has no db.dump — a whitespace-only connection-string answer silently dropped the Postgres backup entirely (the P2 regression)"; exit 1; }
grep -qF 'fake-pg-dump-content' "$PG3_RESTORE_DIR/db.dump" || { echo "[FAIL] db.dump does not contain the shimmed pg_dump output"; exit 1; }
echo "[PASS] a whitespace-only answer to the Postgres connection-string prompt falls back to the default connection string instead of silently skipping pg_dump"

echo "== (n) the yes/no prompt structurally cannot misread an ambiguous answer as 'no' (issue #96, re-verified post-#230) =="
# Issue #96's original bug (and this test's original form): a free-text y/n reader
# that silently coerced any unrecognized answer to false. The OLD askYesNo() (plain
# node:readline) re-prompted on anything that was not literally y/yes/n/no, and this
# test drove that re-prompt loop with "yeah".
#
# Issue #230 replaced that free-text reader with @clack/prompts' confirm() — a
# two-option TOGGLE (Yes/No), not parsed text — so there is no longer any "answer
# string" to misread in the first place: confirm() submits the instant it sees a "y"
# or "n" keypress (@clack/core's ConfirmPrompt), and any OTHER character just moves
# the toggle's cursor/highlight, never a value. "Answer 'yeah' as three keypresses
# and see if it re-prompts" is no longer a meaningful drive-init.mjs scenario against
# this prompt type: the SAME first "y" keypress that used to start "yeah" now submits
# true immediately, before the rest of the string is even sent — that is the
# structural improvement, not a regression to re-test the OLD way.
#
# What is still worth proving here: the specific #96 failure mode (a non-explicit
# answer silently landing as "no" on a prompt whose default is YES — the tool's own
# main defense against identity loss) cannot happen via the one input path confirm()
# actually accepts for "no answer at all": a bare Enter, which must still honor the
# prompt's own default (initialValue: true) rather than silently defaulting to false.
NODEFAULT_HOME="$TMP/confirm-default-home"
NODEFAULT_USER_HOME="$TMP/confirm-default-user-home"; mkdir -p "$NODEFAULT_USER_HOME"
NODEFAULT_SRC="$TMP/confirm-default-src"; mkdir -p "$NODEFAULT_SRC"
printf 'confirm-default-marker\n' > "$NODEFAULT_SRC/note.txt"
cat > "$TMP/qa-confirm-default.json" <<JSON
[
  ["Generate an offline backup keypair now?", ""],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$NODEFAULT_SRC"],
  ["Choose a backend", "\u001b[A\u001b[A"]
]
JSON
# #492 changed the directory prompt from "throws on empty" to "loops until non-empty"
# (see (c) above), so this test can no longer use an empty directory answer as its
# shortcut to a fast exit before push. It now uses the SAME shortcut as test (o)
# below: a real directory + picking "arweave" with no CYPHER_BRAIN_AR_WALLET
# configured, which the wizard refuses BEFORE the spend-consent prompt (issue #161)
# — no push, no network call, and it happens right after the backend prompt this QA
# script already answers. Non-zero exit (issue #731 — see (c2) above for the same
# inversion and why), not "exit 0" as this comment used to claim.
unset CYPHER_BRAIN_AR_WALLET # this suite's own environment must not already have one set
if CYPHER_BRAIN_HOME="$NODEFAULT_HOME" HOME="$NODEFAULT_USER_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-confirm-default.json" --out "$TMP/confirm-default.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #731: the confirm-default run exited 0 via the no-wallet backend precheck (should be non-zero — no push happened)"; cat "$TMP/confirm-default.log"; exit 1
fi
grep -qi 'backup identity written to' "$TMP/confirm-default.log" || { echo "[FAIL] a bare Enter on the backup-keypair prompt did not honor its stated default (Yes) — it should have generated a backup keypair"; cat "$TMP/confirm-default.log"; exit 1; }
if grep -qi 'Skipping the backup key' "$TMP/confirm-default.log"; then echo "[FAIL] a bare Enter on the backup-keypair prompt was silently read as 'no' — the exact #96 failure mode"; cat "$TMP/confirm-default.log"; exit 1; fi
echo "[PASS] a bare-Enter answer on the security-relevant backup-keypair prompt honors its stated Yes default (never silently reads as 'no') — confirm()'s toggle UI also makes the OLD free-text misread (#96) structurally unreachable"

echo "== (o) paid backend chosen with no CYPHER_BRAIN_AR_WALLET configured refuses before the spend-consent prompt — no rollback, non-zero exit (issues #161/#731) =="
# Before the fix, picking arweave/turbo with no wallet set sailed past the "spends
# real funds" consent prompt, then failed deep inside push() (`arweave put needs
# CYPHER_BRAIN_AR_WALLET ...`) — pushSucceeded stayed false, so the outer catch
# rolled back the identity/backup key/recipient-pin choices this same run just spent
# several steps creating. Drive a run through backup=yes (so both primary AND backup
# identities exist), then answer the backend prompt with "arweave": the wizard must
# print the wallet-setup guidance WITHOUT ever reaching the consent prompt, and
# WITHOUT touching anything already on disk. Non-zero exit (issue #731): this run
# never pushed a snapshot, so it must not share exit 0 with a completed run.
O_HOME="$TMP/wallet-precheck-home"; mkdir -p "$O_HOME"
O_CB_HOME="$TMP/wallet-precheck-cb-home"
O_SRC="$TMP/wallet-precheck-src"; mkdir -p "$O_SRC"
printf 'wallet-precheck-marker\n' > "$O_SRC/note.txt"
O_BACKUP_HOME="${O_CB_HOME}-backup" # the default sibling path the wizard suggests for the backup key

cat > "$TMP/qa-wallet-precheck.json" <<JSON
[
  ["Generate an offline backup keypair now?", "y"],
  ["Path for the backup keypair", ""],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$O_SRC"],
  ["Choose a backend", "\u001b[A\u001b[A"]
]
JSON
# Two Up-arrows move the select() cursor from its initial `file` (last in
# BACKEND_NAMES) to `arweave` (second) -- see (c2) above for the same technique.
# (Same reasoning as (j0)/(k)'s QA scripts: the wizard returns right after the
# backend prompt on this path — never reaching the recovery-kit path prompt — so
# the QA script intentionally stops there too.)

unset CYPHER_BRAIN_AR_WALLET # this suite's own environment must not already have one set
if CYPHER_BRAIN_HOME="$O_CB_HOME" HOME="$O_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-wallet-precheck.json" --out "$TMP/wallet-precheck.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #731: the no-wallet paid-backend run exited 0 despite never pushing a snapshot"; cat "$TMP/wallet-precheck.log"; exit 1
fi
grep -qF 'needs a funded wallet to push' "$TMP/wallet-precheck.log" || { echo "[FAIL] wizard did not print the wallet-precheck guidance"; cat "$TMP/wallet-precheck.log"; exit 1; }
grep -q 'cypher-brain wallet create' "$TMP/wallet-precheck.log" || { echo "[FAIL] guidance does not mention wallet create"; cat "$TMP/wallet-precheck.log"; exit 1; }
grep -q 'cypher-brain wallet address' "$TMP/wallet-precheck.log" || { echo "[FAIL] guidance does not mention wallet address"; cat "$TMP/wallet-precheck.log"; exit 1; }
if grep -qF 'PAID, PERMANENT store' "$TMP/wallet-precheck.log"; then echo "[FAIL] the spend-consent prompt was reached despite no wallet being configured"; cat "$TMP/wallet-precheck.log"; exit 1; fi
if grep -q 'cypher-brain init: complete' "$TMP/wallet-precheck.log"; then echo "[FAIL] wizard reported completion despite exiting early on the wallet precheck"; cat "$TMP/wallet-precheck.log"; exit 1; fi
echo "[PASS] choosing arweave with no wallet configured prints setup guidance and exits non-zero (issue #731), never reaching the spend-consent prompt"

[ -f "$O_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity was deleted on the wallet-precheck early exit — this must be a graceful exit, not a rollback"; exit 1; }
[ -f "$O_CB_HOME/recipient.txt" ] || { echo "[FAIL] primary recipient was deleted on the wallet-precheck early exit"; exit 1; }
[ -f "$O_BACKUP_HOME/identity.age" ] || { echo "[FAIL] backup identity was deleted on the wallet-precheck early exit"; exit 1; }
[ -f "$O_BACKUP_HOME/recipient.txt" ] || { echo "[FAIL] backup recipient was deleted on the wallet-precheck early exit"; exit 1; }
O_SNAP_LEFTOVER="$(find "$O_CB_HOME" -maxdepth 1 -name 'brain-*.age' 2>/dev/null | head -n1)"
[ -z "$O_SNAP_LEFTOVER" ] || { echo "[FAIL] a snapshot was produced despite exiting before step 6's snapshot+push"; exit 1; }
echo "[PASS] the wallet-precheck early exit preserves the identity/recipient/backup-key this run already created, and never produces a snapshot"

echo "== (o2) CYPHER_BRAIN_AR_WALLET set to a NONEXISTENT file behaves exactly like unset (issue #161: check 'set AND exists', not just 'set') =="
O2_HOME="$TMP/wallet-precheck-missing-home"; mkdir -p "$O2_HOME"
O2_CB_HOME="$TMP/wallet-precheck-missing-cb-home"
O2_SRC="$TMP/wallet-precheck-missing-src"; mkdir -p "$O2_SRC"
printf 'wallet-precheck-missing-marker\n' > "$O2_SRC/note.txt"
O2_WALLET="$TMP/no-such-wallet.json" # set but deliberately never created

# Three Up-arrows move the select() cursor from its initial `file` (last in
# BACKEND_NAMES) all the way to `turbo` (first) -- see (c2) above for the
# same technique.
cat > "$TMP/qa-wallet-precheck-missing.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$O2_SRC"],
  ["Choose a backend", "\u001b[A\u001b[A\u001b[A"]
]
JSON

if CYPHER_BRAIN_HOME="$O2_CB_HOME" HOME="$O2_HOME" CYPHER_BRAIN_AR_WALLET="$O2_WALLET" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-wallet-precheck-missing.json" --out "$TMP/wallet-precheck-missing.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #731: the missing-wallet-file turbo run exited 0 despite never pushing a snapshot"; cat "$TMP/wallet-precheck-missing.log"; exit 1
fi
grep -qF 'needs a funded wallet to push' "$TMP/wallet-precheck-missing.log" || { echo "[FAIL] wizard did not print the wallet-precheck guidance for a nonexistent wallet file"; cat "$TMP/wallet-precheck-missing.log"; exit 1; }
[ -f "$O2_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity was deleted on the missing-wallet-file early exit"; exit 1; }
echo "[PASS] CYPHER_BRAIN_AR_WALLET pointing at a nonexistent file is treated the same as unset — guidance shown, primary identity preserved, non-zero exit (issue #731)"

echo "== (o3) a wallet file actually present on disk still reaches the existing spend-consent prompt unchanged (issue #161: precheck only gates when the wallet is MISSING) =="
O3_HOME="$TMP/wallet-precheck-present-home"; mkdir -p "$O3_HOME"
O3_CB_HOME="$TMP/wallet-precheck-present-cb-home"
O3_SRC="$TMP/wallet-precheck-present-src"; mkdir -p "$O3_SRC"
printf 'wallet-precheck-present-marker\n' > "$O3_SRC/note.txt"
O3_WALLET="$TMP/wallet-precheck-present-wallet.json"
cb wallet create --out "$O3_WALLET" > "$TMP/wallet-precheck-present-walletcreate.log" 2>&1 \
  || { echo "[FAIL] test setup: could not create a wallet fixture"; cat "$TMP/wallet-precheck-present-walletcreate.log"; exit 1; }

cat > "$TMP/qa-wallet-precheck-present.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$O3_SRC"],
  ["Choose a backend", "\u001b[A\u001b[A"],
  ["PAID, PERMANENT store", "n"]
]
JSON

if CYPHER_BRAIN_HOME="$O3_CB_HOME" HOME="$O3_HOME" CYPHER_BRAIN_AR_WALLET="$O3_WALLET" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-wallet-precheck-present.json" --out "$TMP/wallet-precheck-present.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] declining the spend-consent prompt should still abort (unchanged existing behavior)"; cat "$TMP/wallet-precheck-present.log"; exit 1
fi
grep -qF 'PAID, PERMANENT store' "$TMP/wallet-precheck-present.log" || { echo "[FAIL] the spend-consent prompt was never reached despite a configured, present-on-disk wallet"; cat "$TMP/wallet-precheck-present.log"; exit 1; }
if grep -qF 'needs a funded wallet to push' "$TMP/wallet-precheck-present.log"; then echo "[FAIL] the wallet-precheck guidance fired despite a configured, present-on-disk wallet"; cat "$TMP/wallet-precheck-present.log"; exit 1; fi
grep -qi "aborted before spending" "$TMP/wallet-precheck-present.log" || { echo "[FAIL] declined-consent error message missing (unchanged existing behavior expected)"; cat "$TMP/wallet-precheck-present.log"; exit 1; }
[ ! -f "$O3_CB_HOME/identity.age" ] || { echo "[FAIL] declining consent should still roll back the identity (unchanged existing behavior, issue #161 non-goal)"; exit 1; }
echo "[PASS] a configured, present-on-disk wallet still reaches the existing spend-consent prompt unchanged, and declining it still aborts + rolls back exactly as before"

echo "== (o4) a wallet created at the DEFAULT path (no CYPHER_BRAIN_AR_WALLET set) is recognized by the same precheck 'wallet create' itself documents (issue #735) =="
# wallet.ts's own walletConfigured() default parameter is AR_WALLET alone — but
# 'wallet create's OWN completion message (wallet.ts) tells users push/estimate/
# 'wallet address'/'balance' already find a default-path wallet.json with NO env var
# set at all. The wizard's precheck used to call walletConfigured() with no argument
# (falling back to that same AR_WALLET-only default), so a wallet that exists ONLY at
# the default path — exactly what a bare `wallet create` (no --out) produces — was
# incorrectly reported as "not configured", abandoning the rest of setup even though
# push itself would have found and used it without any trouble.
O4_HOME="$TMP/wallet-precheck-defaultpath-home"; mkdir -p "$O4_HOME"
O4_CB_HOME="$TMP/wallet-precheck-defaultpath-cb-home"; mkdir -p "$O4_CB_HOME"
O4_SRC="$TMP/wallet-precheck-defaultpath-src"; mkdir -p "$O4_SRC"
printf 'wallet-precheck-defaultpath-marker\n' > "$O4_SRC/note.txt"
unset CYPHER_BRAIN_AR_WALLET # this suite's own environment must not already have one set
CYPHER_BRAIN_HOME="$O4_CB_HOME" cb wallet create > "$TMP/wallet-precheck-defaultpath-walletcreate.log" 2>&1 \
  || { echo "[FAIL] test setup: could not create a default-path wallet fixture"; cat "$TMP/wallet-precheck-defaultpath-walletcreate.log"; exit 1; }

cat > "$TMP/qa-wallet-precheck-defaultpath.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$O4_SRC"],
  ["Choose a backend", "\u001b[A\u001b[A"],
  ["PAID, PERMANENT store", "n"]
]
JSON

if CYPHER_BRAIN_HOME="$O4_CB_HOME" HOME="$O4_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-wallet-precheck-defaultpath.json" --out "$TMP/wallet-precheck-defaultpath.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] declining the spend-consent prompt should still abort (unchanged existing behavior)"; cat "$TMP/wallet-precheck-defaultpath.log"; exit 1
fi
grep -qF 'PAID, PERMANENT store' "$TMP/wallet-precheck-defaultpath.log" || { echo "[FAIL] the spend-consent prompt was never reached despite a wallet at the default path"; cat "$TMP/wallet-precheck-defaultpath.log"; exit 1; }
if grep -qF 'needs a funded wallet to push' "$TMP/wallet-precheck-defaultpath.log"; then rc=0; else rc=$?; fi
if [ "$rc" -eq 0 ]; then
  echo "[FAIL] issue #735: the wallet-precheck guidance fired despite a wallet existing at the default path with no CYPHER_BRAIN_AR_WALLET set"; cat "$TMP/wallet-precheck-defaultpath.log"; exit 1
elif [ "$rc" -ne 1 ]; then
  echo "[FAIL] could not read $TMP/wallet-precheck-defaultpath.log to confirm the wallet-precheck guidance did not fire (grep rc=$rc)"; exit 1
fi
echo "[PASS] a wallet at the default path (CYPHER_BRAIN_HOME/wallet.json), with no CYPHER_BRAIN_AR_WALLET set, is recognized by the paid-backend precheck — matching 'wallet create's own documented default (issue #735)"

echo "== (p) CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 with FILE-redirected (non-pipe) stdin surfaces the real cancellation, not a masking TypeError (P2 fix) =="
# Node's process.stdin is a plain fs.ReadStream (no unref()/ref()) when stdin comes
# from a HEREDOC or a `< file` redirection — unlike a pipe (net.Socket), which is
# ALL every other scripted run in this file uses (drive-init.mjs spawns the child
# with stdio:['pipe',...]), so none of them ever exercised this path. Before the
# fix, init()'s own `finally` block called process.stdin.unref() unconditionally,
# which throws "process.stdin.unref is not a function" on an fs.ReadStream and
# REPLACES whatever real error (here, InitCancelledError from the Ctrl+C byte below)
# was already propagating out of the wizard (Codex review finding — confirmed
# empirically before the fix: this exact repro printed "error: process.stdin.unref
# is not a function" instead of the cancellation message asserted below).
# with_timeout itself can't be reused here as-is: bash nulls an asynchronous
# command's stdin unless THAT EXACT backgrounded command carries its own explicit
# redirection (see bash's "Command Execution Environment") — with_timeout's `"$@" &`
# does not qualify just because with_timeout's OWN invocation was redirected from a
# file, so it silently replaces this test's Ctrl+C byte with /dev/null (confirmed
# empirically: every other with_timeout call site in this file is unaffected only
# because it either already redirects from /dev/null or never needed real stdin
# content in the first place — this is the first one that does). `<&0` makes the
# dup an explicit redirection ON the backgrounded command itself, which is enough to
# opt back out of bash's default. scripts/selftest-lib.sh's with_stdin_timeout does
# exactly this (plus the same #569 hardening as with_timeout).

P_HOME="$TMP/nonpipe-stdin-home"; mkdir -p "$P_HOME"
P_CB_HOME="$TMP/nonpipe-stdin-cb-home"
printf '\x03' > "$TMP/ctrlc-byte.bin" # a raw Ctrl+C byte — clack decodes this as a cancel keypress

NONPIPE_RC=0
CYPHER_BRAIN_HOME="$P_CB_HOME" HOME="$P_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_stdin_timeout 30 node "${BIN_DEV_ARGS[@]}" "$BIN" init < "$TMP/ctrlc-byte.bin" > "$TMP/nonpipe-stdin.log" 2>&1 || NONPIPE_RC=$?
[ "$NONPIPE_RC" != "0" ] || { echo "[FAIL] init did not fail on a Ctrl+C byte delivered via file-redirected stdin"; cat "$TMP/nonpipe-stdin.log"; exit 1; }
[ "$NONPIPE_RC" != "137" ] || { echo "[FAIL] init did not fail promptly on the Ctrl+C byte -- it hung until the 30s with_stdin_timeout watchdog SIGKILLed it"; cat "$TMP/nonpipe-stdin.log"; exit 1; }
grep -qi "cypher-brain init: cancelled" "$TMP/nonpipe-stdin.log" || { echo "[FAIL] the real InitCancelledError was not surfaced (masked by something else?)"; cat "$TMP/nonpipe-stdin.log"; exit 1; }
if grep -qi "is not a function" "$TMP/nonpipe-stdin.log"; then echo "[FAIL] process.stdin.unref() crashed and masked the real error — the P2 regression"; cat "$TMP/nonpipe-stdin.log"; exit 1; fi
[ ! -f "$P_CB_HOME/identity.age" ] || { echo "[FAIL] primary identity survived the cancellation — rollback should still fire on this path"; exit 1; }
echo "[PASS] file-redirected (non-pipe) stdin under CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 surfaces the real InitCancelledError instead of a masking 'unref is not a function' crash"

echo "== (q) issue #464: a piped automation transcript with NO_COLOR=1 is free of clack's OWN color escape codes — but still carries clack's non-color cursor-movement escapes (doc-comment accuracy check, wizard.ts header) =="
# wizard.ts's own header comment (just above InitCancelledError) used to assert "a
# real terminal is always on the other end of that output" whenever
# CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 is used -- false for the EXACT way this
# repo's own scripts/drive-init.mjs drives the wizard for this very selftest (piped
# stdin AND stdout, no TTY at all). #464 rewrote that comment; this case is the
# regression guard for what it now claims: (1) Node's own util.styleText -- which
# every clack render call goes through for COLOR -- already suppresses every color
# escape code on a non-TTY output stream on its own (so a captured automation
# transcript is never colorized by accident) -- test (c) above sets NO_COLOR=1
# explicitly (matching the original issue's own repro) AND unsets FORCE_COLOR (a
# caller's FORCE_COLOR would force color back on regardless of NO_COLOR -- the doc
# comment's other point -- which would fail this assertion for a reason unrelated to
# this test); (2) clack's OWN cursor-movement/hide/show/erase escapes (sisteransi, a
# separate mechanism NOT gated by NO_COLOR/FORCE_COLOR/isTTY at all) are still written
# unconditionally, so the transcript is NOT plain text either -- reusing test (c)'s
# own already-captured "$TMP/nodir.log" rather than spawning a whole extra wizard run
# for this.
python3 - "$TMP/nodir.log" <<'PY'
import re
import sys

data = open(sys.argv[1], "rb").read()
color_codes = re.findall(rb"\x1b\[[0-9;]*m", data)
if color_codes:
    print(f"[FAIL] found {len(color_codes)} SGR color escape code(s) in a plain piped automation transcript -- styleText should have suppressed all of them on this non-TTY output stream (issue #464)")
    sys.exit(1)
esc_bytes = data.count(b"\x1b")
if esc_bytes == 0:
    print("[FAIL] expected clack's own cursor-movement escapes (sisteransi) to still be present per the doc comment's own claim, but found zero ESC bytes -- this fixture may no longer exercise a real clack render")
    sys.exit(1)
print(f"[PASS] zero SGR color escape codes in the piped, NO_COLOR=1 automation transcript (styleText's own isTTY check holds); {esc_bytes} non-color cursor-movement ESC byte(s) remain, exactly as the corrected doc comment now says")
PY

echo "== (r) init refuses to reuse a MISMATCHED existing signing pair instead of silently baking an unverifiable public key into the recovery kit (issue #736) =="
# Arrange sign-identity.key/sign-recipient.pub to come from two DIFFERENT setups: a
# real "keygen --sign" run (A), then a --force regeneration (B) that replaces BOTH
# files with a NEW keypair, then manually restoring ONLY the public half back to A's
# — sign-identity.key is now B's private key, sign-recipient.pub is A's public key: a
# genuinely mismatched pair, exactly the #736 repro shape.
MISMATCH_HOME="$TMP/mismatch-home"; mkdir -p "$MISMATCH_HOME"
MISMATCH_CB_HOME="$TMP/mismatch-cb-home"
MISMATCH_SRC="$TMP/mismatch-src"; mkdir -p "$MISMATCH_SRC"
printf 'mismatch-marker\n' > "$MISMATCH_SRC/note.txt"

CYPHER_BRAIN_HOME="$MISMATCH_CB_HOME" cb keygen --sign > "$TMP/mismatch-setup-a.log" 2>&1 \
  || { echo "[FAIL] test setup: could not generate signing keypair A"; cat "$TMP/mismatch-setup-a.log"; exit 1; }
cp "$MISMATCH_CB_HOME/sign-recipient.pub" "$TMP/mismatch-recipient-a.pub"

CYPHER_BRAIN_HOME="$MISMATCH_CB_HOME" cb keygen --sign --force > "$TMP/mismatch-setup-b.log" 2>&1 \
  || { echo "[FAIL] test setup: could not regenerate signing keypair B"; cat "$TMP/mismatch-setup-b.log"; exit 1; }
cp "$TMP/mismatch-recipient-a.pub" "$MISMATCH_CB_HOME/sign-recipient.pub"
# Checksummed BEFORE the run under test: "-f still exists" alone does not prove the
# file is untouched -- a truncate-and-rewrite (even to identical-looking content, or
# garbage) would still pass an existence check.
MISMATCH_IDENTITY_SHA_BEFORE=$(sha "$MISMATCH_CB_HOME/sign-identity.key")
MISMATCH_RECIPIENT_SHA_BEFORE=$(sha "$MISMATCH_CB_HOME/sign-recipient.pub")

cat > "$TMP/qa-mismatch.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"]
]
JSON

# No CYPHER_BRAIN_HOME/identity.age exists yet (only the signing files above), so
# init's own top-level "an identity already exists" refusal does not fire here — it
# proceeds through step 1 (primary keygen), skips the backup keypair (step 2, "n"),
# then reaches step 3's "already exists — reusing it" branch with NO prompt of its
# own, where the new consistency check should throw immediately.
if CYPHER_BRAIN_HOME="$MISMATCH_CB_HOME" HOME="$MISMATCH_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-mismatch.json" --out "$TMP/mismatch.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #736: init completed despite a mismatched signing keypair — it should refuse before reusing an inconsistent pair"; cat "$TMP/mismatch.log"; exit 1
fi
grep -qi "does not match" "$TMP/mismatch.log" || { echo "[FAIL] issue #736: no mismatch-related error message found"; cat "$TMP/mismatch.log"; exit 1; }
[ ! -f "$MISMATCH_CB_HOME/identity.age" ] || { echo "[FAIL] issue #736: the primary identity this run created was not rolled back after the signing-pair mismatch was detected"; exit 1; }
[ -f "$MISMATCH_CB_HOME/sign-identity.key" ] || { echo "[FAIL] issues #736/#719: the pre-existing (mismatched) signing identity was deleted — it must never be touched by this run"; exit 1; }
[ -f "$MISMATCH_CB_HOME/sign-recipient.pub" ] || { echo "[FAIL] issues #736/#719: the pre-existing (mismatched) signing public key was deleted — it must never be touched by this run"; exit 1; }
[ "$(sha "$MISMATCH_CB_HOME/sign-identity.key")" = "$MISMATCH_IDENTITY_SHA_BEFORE" ] || { echo "[FAIL] issues #736/#719: the pre-existing (mismatched) signing identity's bytes changed — it must never be touched by this run"; exit 1; }
[ "$(sha "$MISMATCH_CB_HOME/sign-recipient.pub")" = "$MISMATCH_RECIPIENT_SHA_BEFORE" ] || { echo "[FAIL] issues #736/#719: the pre-existing (mismatched) signing public key's bytes changed — it must never be touched by this run"; exit 1; }
echo "[PASS] init refuses to reuse a mismatched signing keypair, rolls back only what this run created, and leaves the pre-existing (mismatched) signing files untouched (issues #736, #719)"

echo "== (r2) init also refuses a signing pair whose CRYPTOGRAPHIC keys match but whose recorded key ids disagree (issue #736, review-hardening) =="
# The minisign wire format's 8-byte key id is NOT derived from the key material —
# it is chosen independently at random and both files only happen to agree because
# keygenSignAt() writes both from the same in-memory value. A hand-edited identity
# file (or a bad manual merge) could carry the SAME real private key but a stale/
# wrong "# key id:" comment — signingKeypairMatches()'s sign->verify round trip alone
# would pass such a pair (the keys genuinely correspond), but restore/verify's own
# verifyDetached() rejects any signature whose embedded key id does not match the
# id recorded in the public file, making the "reused" pair unusable regardless. Only
# the identity file's COMMENT is edited below — the PEM private key body is
# untouched, so the actual keypair still matches.
KEYID_HOME="$TMP/keyid-mismatch-home"; mkdir -p "$KEYID_HOME"
KEYID_CB_HOME="$TMP/keyid-mismatch-cb-home"

CYPHER_BRAIN_HOME="$KEYID_CB_HOME" cb keygen --sign > "$TMP/keyid-mismatch-setup.log" 2>&1 \
  || { echo "[FAIL] test setup: could not generate a signing keypair"; cat "$TMP/keyid-mismatch-setup.log"; exit 1; }
python3 - "$KEYID_CB_HOME/sign-identity.key" <<'PY'
import re
import sys

path = sys.argv[1]
text = open(path).read()
m = re.search(r'^# key id: ([0-9a-f]{16})$', text, re.MULTILINE)
assert m, "no '# key id:' line found in " + path
old = m.group(1)
new = old[:-1] + ('0' if old[-1] != '0' else '1')
assert new != old
text = text.replace(f'# key id: {old}\n', f'# key id: {new}\n', 1)
open(path, 'w').write(text)
PY
# Checksummed AFTER the python3 edit above (the actual pre-existing state the run under
# test must leave untouched) -- "-f still exists" alone would also pass a truncate-and-
# rewrite of either file.
KEYID_IDENTITY_SHA_BEFORE=$(sha "$KEYID_CB_HOME/sign-identity.key")
KEYID_RECIPIENT_SHA_BEFORE=$(sha "$KEYID_CB_HOME/sign-recipient.pub")

cat > "$TMP/qa-keyid-mismatch.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"]
]
JSON

if CYPHER_BRAIN_HOME="$KEYID_CB_HOME" HOME="$KEYID_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-keyid-mismatch.json" --out "$TMP/keyid-mismatch.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #736: init completed despite a key-id mismatch between the signing identity and its public key"; cat "$TMP/keyid-mismatch.log"; exit 1
fi
grep -qi "does not match" "$TMP/keyid-mismatch.log" || { echo "[FAIL] issue #736: no mismatch-related error message found for the key-id-only mismatch"; cat "$TMP/keyid-mismatch.log"; exit 1; }
[ -f "$KEYID_CB_HOME/sign-identity.key" ] || { echo "[FAIL] the pre-existing signing identity was deleted"; exit 1; }
[ -f "$KEYID_CB_HOME/sign-recipient.pub" ] || { echo "[FAIL] the pre-existing signing public key was deleted"; exit 1; }
[ "$(sha "$KEYID_CB_HOME/sign-identity.key")" = "$KEYID_IDENTITY_SHA_BEFORE" ] || { echo "[FAIL] the pre-existing signing identity's bytes changed"; exit 1; }
[ "$(sha "$KEYID_CB_HOME/sign-recipient.pub")" = "$KEYID_RECIPIENT_SHA_BEFORE" ] || { echo "[FAIL] the pre-existing signing public key's bytes changed"; exit 1; }
echo "[PASS] init also refuses a pair whose cryptographic keys match but whose recorded key ids disagree (issue #736, review-hardening)"

echo "== (s) EOF on stdin mid-wizard (a closed pipe / Ctrl-D) triggers the SAME cancel+rollback path as Ctrl-C, not a silent exit 0 with orphaned key material (issue #718) =="
EOF_HOME="$TMP/eof-home"; mkdir -p "$EOF_HOME"
EOF_CB_HOME="$TMP/eof-cb-home"
cat > "$TMP/qa-eof.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"]
]
JSON
# drive-init-eof.mjs (see its own header comment) answers the two prompts above
# normally, then — the instant the NEXT prompt's own text appears — calls
# child.stdin.end() instead of sending an answer, simulating a closed pipe/Ctrl-D
# mid-wizard. Before #718's fix this produced a silent exit 0 with the primary
# identity/recipient this run already generated left orphaned on disk.
if CYPHER_BRAIN_HOME="$EOF_CB_HOME" HOME="$EOF_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 30 node "$ROOT/scripts/drive-init-eof.mjs" --qa "$TMP/qa-eof.json" \
  --eof-after "Protect the primary identity with a passphrase now?" \
  --out "$TMP/eof.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] issue #718: init exited 0 despite stdin hitting EOF mid-wizard — should cancel + roll back, exit non-zero"; cat "$TMP/eof.log"; exit 1
fi
grep -qi "cancelled" "$TMP/eof.log" || { echo "[FAIL] issue #718: no cancellation message printed after EOF on stdin"; cat "$TMP/eof.log"; exit 1; }
[ ! -f "$EOF_CB_HOME/identity.age" ] || { echo "[FAIL] issue #718: the primary identity was not rolled back after stdin hit EOF mid-wizard"; exit 1; }
[ ! -f "$EOF_CB_HOME/recipient.txt" ] || { echo "[FAIL] issue #718: the primary recipient was not rolled back after stdin hit EOF mid-wizard"; exit 1; }
echo "[PASS] EOF on stdin mid-wizard cancels the run (same rollback path as Ctrl-C) instead of silently exiting 0 with orphaned key material (issue #718)"

echo "== (u) recovery kit default path is scoped to CYPHER_BRAIN_HOME, not the OS \$HOME — two different identities sharing one \$HOME never collide on a bare-Enter kit path (issue #717) =="
DEFKIT_OS_HOME="$TMP/defkit-os-home"; mkdir -p "$DEFKIT_OS_HOME"
DEFKIT_CB_HOME_1="$TMP/defkit-cb-home-1"
DEFKIT_CB_HOME_2="$TMP/defkit-cb-home-2"
DEFKIT_SRC_1="$TMP/defkit-src-1"; mkdir -p "$DEFKIT_SRC_1"
DEFKIT_SRC_2="$TMP/defkit-src-2"; mkdir -p "$DEFKIT_SRC_2"
printf 'defkit-marker-1\n' > "$DEFKIT_SRC_1/note.txt"
printf 'defkit-marker-2\n' > "$DEFKIT_SRC_2/note.txt"

cat > "$TMP/qa-defkit-1.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$DEFKIT_SRC_1"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", ""]
]
JSON
CYPHER_BRAIN_HOME="$DEFKIT_CB_HOME_1" CYPHER_BRAIN_FILE_DIR="$TMP/defkit-store-1" HOME="$DEFKIT_OS_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-defkit-1.json" --out "$TMP/defkit-1.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the first defkit run did not complete"; cat "$TMP/defkit-1.log"; exit 1; }
[ -f "$DEFKIT_CB_HOME_1/recovery-kit.txt" ] || { echo "[FAIL] issue #717: the default kit path was not scoped under the FIRST identity's CYPHER_BRAIN_HOME"; cat "$TMP/defkit-1.log"; exit 1; }
DEFKIT_1_SHA="$(sha "$DEFKIT_CB_HOME_1/recovery-kit.txt")"

cat > "$TMP/qa-defkit-2.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$DEFKIT_SRC_2"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", ""]
]
JSON
# SAME OS $HOME as the first run above (os.homedir()-based defaults would collide
# here), but a DIFFERENT CYPHER_BRAIN_HOME — exactly the two-identities-one-machine
# repro from issue #717.
CYPHER_BRAIN_HOME="$DEFKIT_CB_HOME_2" CYPHER_BRAIN_FILE_DIR="$TMP/defkit-store-2" HOME="$DEFKIT_OS_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-defkit-2.json" --out "$TMP/defkit-2.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the second defkit run (SAME OS \$HOME, DIFFERENT CYPHER_BRAIN_HOME) did not complete"; cat "$TMP/defkit-2.log"; exit 1; }
[ -f "$DEFKIT_CB_HOME_2/recovery-kit.txt" ] || { echo "[FAIL] issue #717: the default kit path was not scoped under the SECOND identity's CYPHER_BRAIN_HOME"; cat "$TMP/defkit-2.log"; exit 1; }
[ ! -e "$DEFKIT_OS_HOME/recovery-kit.txt" ] || { echo "[FAIL] issue #717: a kit was ALSO written at the OS \$HOME-level default path — the old os.homedir()-based default is still in play"; exit 1; }
[ "$(sha "$DEFKIT_CB_HOME_1/recovery-kit.txt")" = "$DEFKIT_1_SHA" ] || { echo "[FAIL] issue #717: the FIRST identity's recovery kit changed after the SECOND identity's init run — it was silently overwritten"; exit 1; }
grep -qF "$DEFKIT_CB_HOME_1/identity.age" "$DEFKIT_CB_HOME_1/recovery-kit.txt" || { echo "[FAIL] first kit no longer references its own identity"; exit 1; }
grep -qF "$DEFKIT_CB_HOME_2/identity.age" "$DEFKIT_CB_HOME_2/recovery-kit.txt" || { echo "[FAIL] second kit does not reference its own identity"; exit 1; }
echo "[PASS] two identities sharing one OS \$HOME each get their OWN default recovery-kit path under their own CYPHER_BRAIN_HOME — no cross-identity collision, no shared OS-\$HOME kit written at all (issue #717)"

echo "== (u2) an existing, REAL (non-empty) recovery kit is never silently overwritten — declining the new confirm() leaves it byte-for-byte untouched (issue #717) =="
# The maintainer's own prior selftest (test (f) above) only ever seeded an EMPTY
# placeholder file at the kit path — this seeds a REAL, previously-generated kit
# (defkit-1's own, from test (u) above) at a SECOND identity's default kit path, then
# DECLINES the new overwrite confirmation, proving the pre-existing content survives
# byte-for-byte and the wizard instead asks for (and writes to) a different path.
DECLINE_HOME="$TMP/decline-os-home"; mkdir -p "$DECLINE_HOME"
DECLINE_CB_HOME="$TMP/decline-cb-home"
DECLINE_SRC="$TMP/decline-src"; mkdir -p "$DECLINE_SRC"
printf 'decline-marker\n' > "$DECLINE_SRC/note.txt"
mkdir -p "$DECLINE_CB_HOME"
cp "$DEFKIT_CB_HOME_1/recovery-kit.txt" "$DECLINE_CB_HOME/recovery-kit.txt" # a REAL, non-empty, previously-generated kit — not an empty placeholder
DECLINE_PRE_SHA="$(sha "$DECLINE_CB_HOME/recovery-kit.txt")"
DECLINE_ALT_KIT="$TMP/decline-alt-recovery-kit.txt"

cat > "$TMP/qa-decline.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$DECLINE_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", ""],
  ["Overwrite it?", "n"],
  ["Choose a different path for the recovery kit", "$DECLINE_ALT_KIT"]
]
JSON
CYPHER_BRAIN_HOME="$DECLINE_CB_HOME" CYPHER_BRAIN_FILE_DIR="$TMP/decline-store" HOME="$DECLINE_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-decline.json" --out "$TMP/decline.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the decline-overwrite run did not complete"; cat "$TMP/decline.log"; exit 1; }
[ "$(sha "$DECLINE_CB_HOME/recovery-kit.txt")" = "$DECLINE_PRE_SHA" ] || { echo "[FAIL] issue #717: the pre-existing, real recovery kit changed after declining the overwrite confirmation — it was overwritten anyway"; exit 1; }
[ -f "$DECLINE_ALT_KIT" ] || { echo "[FAIL] issue #717: no kit was written at the alternate path offered after declining the overwrite"; exit 1; }
grep -qF "$DECLINE_CB_HOME/identity.age" "$DECLINE_ALT_KIT" || { echo "[FAIL] the alternate-path kit does not reference this run's own identity"; exit 1; }
echo "[PASS] declining the overwrite confirmation leaves a real, pre-existing recovery kit byte-for-byte untouched, and the wizard writes to the alternate path instead (issue #717)"

echo "== (v) the per-day snapshot filename uses the operator's LOCAL calendar day, not UTC (issue #761) =="
TZDATE_HOME="$TMP/tzdate-home"; mkdir -p "$TZDATE_HOME"
TZDATE_CB_HOME="$TMP/tzdate-cb-home"
TZDATE_STORE="$TMP/tzdate-store"
TZDATE_SRC="$TMP/tzdate-src"; mkdir -p "$TZDATE_SRC"
printf 'tzdate-marker\n' > "$TZDATE_SRC/note.txt"
# Pacific/Kiritimati (UTC+14, the largest standard UTC offset) maximizes the window
# during which the LOCAL calendar day is already one ahead of the UTC one — the exact
# divergence issue #761 is about (JST, UTC+9, hits the same bug class for a smaller
# window each day). Forced via TZ on the wizard's own child process only — nothing
# else in this suite depends on the machine's local timezone.
TZDATE_LOCAL="$(TZ='Pacific/Kiritimati' date '+%Y-%m-%d')"
TZDATE_UTC="$(date -u '+%Y-%m-%d')"

cat > "$TMP/qa-tzdate.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$TZDATE_SRC"],
  ["Choose a backend", ""],
  ["Path to write the recovery kit", ""]
]
JSON

TZ='Pacific/Kiritimati' CYPHER_BRAIN_HOME="$TZDATE_CB_HOME" CYPHER_BRAIN_FILE_DIR="$TZDATE_STORE" HOME="$TZDATE_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-tzdate.json" --out "$TMP/tzdate.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init \
  || { echo "[FAIL] the TZ-forced wizard run did not complete"; cat "$TMP/tzdate.log"; exit 1; }
[ -f "$TZDATE_CB_HOME/brain-${TZDATE_LOCAL}.age" ] || { echo "[FAIL] issue #761: no brain-${TZDATE_LOCAL}.age snapshot found under CYPHER_BRAIN_HOME (LOCAL date, TZ=Pacific/Kiritimati) — actual: $(ls "$TZDATE_CB_HOME" | grep '^brain-' || true)"; exit 1; }
if [ "$TZDATE_LOCAL" != "$TZDATE_UTC" ]; then
  [ ! -f "$TZDATE_CB_HOME/brain-${TZDATE_UTC}.age" ] || { echo "[FAIL] issue #761: a brain-${TZDATE_UTC}.age (UTC date) snapshot was ALSO written — the old UTC-based dateStamp regression"; exit 1; }
  echo "[PASS] snapshot filename uses the LOCAL calendar day (${TZDATE_LOCAL}), not the UTC one (${TZDATE_UTC}) — issue #761"
else
  # BLOCKED != PASS: local and UTC coincide at this exact moment, so this run cannot
  # distinguish a correct local-date implementation from the old UTC-based regression
  # (#761) — both would produce the identical filename here. Say so as a [SKIP], not a
  # [PASS] that would otherwise silently claim to have verified something it did not.
  echo "[SKIP] issue #761 coverage: local and UTC dates coincide at this exact moment (both ${TZDATE_LOCAL}), so this run cannot distinguish a correct local-date implementation from the old UTC-based regression — re-run to exercise the divergent window"
fi

echo "== (w) a snapshot already sitting at today's dated --out path is NEVER deleted by rollback — snapshot()'s own no-clobber refusal must not look like something THIS run created (issue #733, review-hardening) =="
# #733's fix records snapshotOutPath BEFORE calling snapshot(), so rollback also
# covers a durable artifact snapshot() managed to promote before a LATER step inside
# it throws. Naively doing that unconditionally would make rollback delete a file
# THIS run never created whenever snapshot()'s own no-clobber check refuses (the
# dated --out is once-per-day, so a stray/leftover file already sitting there is a
# real scenario) — this proves that specific regression does not exist: a
# pre-existing, non-empty file at today's exact dated path must survive byte-for-byte.
PREEXIST_HOME="$TMP/preexist-snap-home"; mkdir -p "$PREEXIST_HOME"
PREEXIST_CB_HOME="$TMP/preexist-snap-cb-home"; mkdir -p "$PREEXIST_CB_HOME"
PREEXIST_SRC="$TMP/preexist-snap-src"; mkdir -p "$PREEXIST_SRC"
printf 'preexist-snap-marker\n' > "$PREEXIST_SRC/note.txt"
PREEXIST_DATESTAMP="$(date '+%Y-%m-%d')"
PREEXIST_OUT="$PREEXIST_CB_HOME/brain-${PREEXIST_DATESTAMP}.age"
printf 'a pre-existing snapshot this run did NOT create\n' > "$PREEXIST_OUT"
PREEXIST_PRE_SHA="$(sha "$PREEXIST_OUT")"

cat > "$TMP/qa-preexist-snap.json" <<JSON
[
  ["Generate an offline backup keypair now?", "n"],
  ["Generate a signing keypair now?", "n"],
  ["Protect the primary identity with a passphrase now?", "n"],
  ["Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line", "n"],
  ["Profile (what to back up)", ""],
  ["Directory path(s) to back up", "$PREEXIST_SRC"],
  ["Choose a backend", ""]
]
JSON

if CYPHER_BRAIN_HOME="$PREEXIST_CB_HOME" CYPHER_BRAIN_FILE_DIR="$TMP/preexist-snap-store" HOME="$PREEXIST_HOME" CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 \
  with_timeout 60 node "$ROOT/scripts/drive-init.mjs" --qa "$TMP/qa-preexist-snap.json" --out "$TMP/preexist-snap.log" \
  -- node "${BIN_DEV_ARGS[@]}" "$BIN" init; then
  echo "[FAIL] init completed despite the dated --out path already existing — snapshot()'s own no-clobber refusal should have fired"; cat "$TMP/preexist-snap.log"; exit 1
fi
grep -qi "already exists" "$TMP/preexist-snap.log" || { echo "[FAIL] no no-clobber refusal message found in the transcript"; cat "$TMP/preexist-snap.log"; exit 1; }
[ "$(sha "$PREEXIST_OUT")" = "$PREEXIST_PRE_SHA" ] || { echo "[FAIL] issue #733: the pre-existing file at today's dated snapshot path was modified/deleted by rollback — it was never this run's to touch"; exit 1; }
[ ! -f "$PREEXIST_CB_HOME/identity.age" ] || { echo "[FAIL] the primary identity this run created was not rolled back"; exit 1; }
echo "[PASS] a pre-existing file at today's dated snapshot path survives rollback byte-for-byte — snapshot()'s own no-clobber refusal is never mistaken for something this run created (issue #733, review-hardening)"

echo
echo "INIT SELFTEST PASS"
