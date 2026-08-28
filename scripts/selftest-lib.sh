#!/usr/bin/env bash
# Shared helpers for the bash-based scripts/selftest-*.sh suite (#569, #570, #572).
#
# Callers must set ROOT (absolute repo root, no trailing slash) and BIN (path to
# bin/cypher-brain.mjs) and source scripts/dev-node-flags.sh (which defines
# BIN_DEV_ARGS) BEFORE sourcing this file — cb() reads those as globals, exactly
# like the per-file wrappers this file replaces did.
#
# This file is meant to stay a thin, sourced collection of small functions, not a
# monolith: each selftest still owns its own TMP/trap setup and its own
# CYPHER_BRAIN_HOME/CYPHER_BRAIN_FILE_DIR exports (they vary too much file-to-file
# to fold in here), and a handful of selftests with genuinely parameterized
# call conventions (positional-home cb(), multiple concurrent homes) keep their
# own local wrapper instead of using cb() below — that's an intentional,
# case-by-case decision, not an oversight.

# cb: invoke bin/cypher-brain.mjs in dev mode (unbundled, straight against
# src/*.ts). Needs ROOT/BIN/BIN_DEV_ARGS already set by the caller. A caller that
# wants a one-off CYPHER_BRAIN_HOME (or any other env var) override for a single
# call can prefix the call itself, e.g. `CYPHER_BRAIN_HOME="$OTHER_HOME" cb ...` —
# bash applies that assignment only to this invocation of the function, exactly
# as it would for an external command (verified: it does not leak past the call).
cb() {
  node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"
}

# sha: sha256 of a file, as a bare lowercase hex string.
sha() {
  shasum -a 256 "$1" | cut -d' ' -f1
}

# _with_timeout_core: shared body for with_timeout/with_stdin_timeout (#569).
#
# Hardened per this machine's own shell-ops reflex doc (11 review rounds, kept
# out of this repo verbatim but the fixes are all applied here):
#   - runs the command in its OWN process group (`set -m`) so the watchdog can
#     kill -9 the WHOLE group (`-$c`), not just the direct child — this is the
#     actual bug fix: the old 4-file-duplicated version only killed the direct
#     child PID, leaking any grandchild (e.g. the inner CLI subprocess spawned
#     by `node scripts/drive-init.mjs`) as an orphan once the parent was killed.
#   - reaps the watchdog itself on the early-completion path (no orphaned sleep)
#   - kills the command's OWN process group unconditionally after `wait`, even
#     on the success path (the command may have backgrounded further children
#     of its own)
#   - every cleanup line is `... || :` so a non-zero exit from an
#     already-finished watchdog/child cannot abort the calling script under
#     `set -e`
#   - restores monitor mode only if the caller didn't already have it on
#   - validates the timeout value (digits only, 1..999999) BEFORE spawning
#     anything, so a bad value fails closed (`return 2`) instead of handing an
#     unparseable string to `sleep` and silently never arming the watchdog
#
# Known limitations (documented, not fixed here — see shell-ops.md for why):
# nesting with_timeout inside with_timeout does not compose, and cleanup is not
# trap-protected against a signal landing mid-wait. Neither applies to how this
# suite calls it (no nested calls, synchronous single-command use only).
_with_timeout_core() {
  local s="$1" stdin_mode="$2"
  shift 2
  case "$s" in '' | *[!0-9]*) return 2 ;; esac
  [ "${#s}" -le 6 ] && [ "$s" -ge 1 ] || return 2
  local had_monitor=0
  case $- in *m*) had_monitor=1 ;; esac
  set -m
  if [ "$stdin_mode" = "stdin" ]; then
    "$@" <&0 &
  else
    "$@" </dev/null &
  fi
  local c=$!
  (
    sleep "$s"
    kill -9 -- "-$c" 2>/dev/null
  ) >/dev/null 2>&1 &
  local w=$!
  local rc=0
  wait "$c" 2>/dev/null || rc=$?
  kill -9 -- "-$c" 2>/dev/null || :
  kill -9 -- "-$w" 2>/dev/null || :
  wait "$w" 2>/dev/null || :
  [ "$had_monitor" -eq 1 ] || set +m
  return $rc
}

# with_timeout <seconds> <command...>: run a command with a bounded, group-wide
# kill on timeout. The command's stdin is always /dev/null (matches every prior
# per-file with_timeout's behavior for the call sites that don't need real
# stdin content).
with_timeout() {
  [ "$#" -ge 2 ] || return 2
  _with_timeout_core "$1" null "${@:2}"
}

# with_stdin_timeout <seconds> <command...>: same as with_timeout, but passes
# the CALLER's real stdin through to the command (`<&0` on the backgrounded
# command itself, an explicit redirection — bash only exempts a backgrounded
# command from the automatic /dev/null stdin substitution when the redirection
# is on that exact command, not merely on the invocation that contains it).
# Needed by the one selftest-init.sh case that must deliver a real byte
# (a Ctrl+C keypress) through stdin to a timed, backgrounded wizard run.
with_stdin_timeout() {
  [ "$#" -ge 2 ] || return 2
  _with_timeout_core "$1" stdin "${@:2}"
}

# start_ton_seeder: stand up the mock TON seeder + PATH shims shared by
# scripts/selftest-ton.sh and scripts/selftest-ton-dns.sh (#570).
#
# Requires ROOT and TMP already set by the caller. Sets these as plain
# (non-local) globals for the caller to use afterward and to reference from its
# own EXIT trap:
#   SEEDER_HOME     - the fake seeder's home directory (bags land under here)
#   MOCK_TON_STORE  - exported; scripts/mock-tonutils.mjs's backing store
#   MOCK_PORT       - the ephemeral port the mock tonutils-storage daemon bound
#   SEEDER_PID      - pid of the backgrounded mock daemon (caller kills this)
#   SHIM            - the PATH-shim directory (ssh/scp/tonutils-storage)
#
# On readiness-poll failure this prints a [FAIL] line and returns 1 (the
# caller's `set -euo pipefail` turns that into the same hard exit the old
# inline `exit 1` produced).
start_ton_seeder() {
  SEEDER_HOME="$TMP/seeder-home"
  export MOCK_TON_STORE="$TMP/store"
  mkdir -p "$SEEDER_HOME" "$MOCK_TON_STORE"

  MOCK_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  node "$ROOT/scripts/mock-tonutils.mjs" --daemon --api "127.0.0.1:$MOCK_PORT" --db "$TMP/seeder-db" &
  SEEDER_PID=$!
  local ready=0
  for _ in $(seq 1 50); do
    if curl -s "http://127.0.0.1:$MOCK_PORT/api/v1/list" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.2
  done
  if [ "$ready" != 1 ]; then
    echo "[FAIL] mock seeder daemon did not come up on port $MOCK_PORT"
    return 1
  fi

  SHIM="$TMP/bin"
  mkdir -p "$SHIM"
  cat >"$SHIM/ssh" <<EOF
#!/usr/bin/env bash
# selftest shim: run the remote command line in the fake seeder home.
while [ \$# -gt 0 ] && [ "\$1" != "--" ]; do
  case "\$1" in -o|-i) shift 2;; *) shift;; esac
done
[ "\${1:-}" = "--" ] && shift
shift # host
cd "$SEEDER_HOME"
exec bash -c "\$*"
EOF
  cat >"$SHIM/scp" <<EOF
#!/usr/bin/env bash
# selftest shim: host:path means a path under the fake seeder home.
while [ \$# -gt 0 ] && [ "\$1" != "--" ]; do
  case "\$1" in -o|-i) shift 2;; *) shift;; esac
done
[ "\${1:-}" = "--" ] && shift
resolve() {
  case "\$1" in
    *:/*) printf '%s' "\${1#*:}";;
    *:*)  printf '%s/%s' "$SEEDER_HOME" "\${1#*:}";;
    *)    printf '%s' "\$1";;
  esac
}
cp "\$(resolve "\$1")" "\$(resolve "\$2")"
EOF
  cat >"$SHIM/tonutils-storage" <<EOF
#!/usr/bin/env bash
exec node "$ROOT/scripts/mock-tonutils.mjs" "\$@"
EOF
  chmod +x "$SHIM/ssh" "$SHIM/scp" "$SHIM/tonutils-storage"
  export PATH="$SHIM:$PATH"
  export CYPHER_BRAIN_TON_SSH_HOST="mock-seeder"
  export CYPHER_BRAIN_TON_REMOTE_API="127.0.0.1:$MOCK_PORT"
}
