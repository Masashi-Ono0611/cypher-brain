#!/usr/bin/env bash
# CLI smoke test for the bundled build: dist/cli.mjs must (a) print non-empty
# --help and exit 0, byte-identical to the unbundled bin shim, (b) run a real
# keygen into a temp CYPHER_BRAIN_HOME producing the identity + recipient files,
# and (c)-(g) exercise the `estimate` command (#159) — the free/paid-backend
# happy paths and its input validation (missing --in, bad --backend, a
# directory --in).
# Follows shell-ops discipline: explicit FAIL + exit 1 (no `cond && echo PASS`).
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist/cli.mjs"
BIN="$ROOT/bin/cypher-brain.mjs"
# run bin/cypher-brain.mjs straight against src/*.ts (no build step) under plain node —
# see scripts/dev-ts-resolve-hook.mjs for why both flags are required (#63). Passed as
# literal argv elements on the $BIN invocations only (never as a NODE_OPTIONS string,
# and never exported) — an exported NODE_OPTIONS would also leak onto the $DIST calls
# below, which must run under genuinely plain node with no dev flags, and NODE_OPTIONS
# is whitespace-split so interpolating this path into it breaks under a checkout
# directory with a space in it (the same bug already fixed in scripts/dev-shim-reexec.mjs
# for the bin/*.mjs shims themselves — argv arrays go straight to execve, never
# shell/whitespace-split, so a space in $ROOT is harmless here).
BIN_DEV_ARGS=(--experimental-strip-types --import "$ROOT/scripts/dev-cli-loader.mjs")
TMP="$(mktemp -d "${TMPDIR:-/tmp}/cb-smoke-XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$DIST" ]; then echo "[FAIL] $DIST missing — run npm run build first"; exit 1; fi

# (a) --help: exit 0, non-empty, identical to the unbundled CLI
node "$DIST" --help > "$TMP/help-dist.txt" 2>&1 || { echo "[FAIL] node dist/cli.mjs --help exited non-zero"; exit 1; }
if [ ! -s "$TMP/help-dist.txt" ]; then echo "[FAIL] --help output is empty"; exit 1; fi
node "${BIN_DEV_ARGS[@]}" "$BIN" --help > "$TMP/help-bin.txt" 2>&1 || { echo "[FAIL] node bin/cypher-brain.mjs --help exited non-zero"; exit 1; }
if ! diff -q "$TMP/help-bin.txt" "$TMP/help-dist.txt" >/dev/null; then
  echo "[FAIL] dist --help differs from bin --help"; diff "$TMP/help-bin.txt" "$TMP/help-dist.txt" | head -20; exit 1
fi
echo "[PASS] dist --help: exit 0, non-empty, byte-identical to bin"

# (b) keygen in a temp home: the key files must appear
export CYPHER_BRAIN_HOME="$TMP/home"
node "$DIST" keygen > "$TMP/keygen.log" 2>&1 || { echo "[FAIL] dist keygen exited non-zero"; cat "$TMP/keygen.log"; exit 1; }
if [ ! -f "$CYPHER_BRAIN_HOME/identity.age" ]; then echo "[FAIL] identity.age not created"; exit 1; fi
if [ ! -f "$CYPHER_BRAIN_HOME/recipient.txt" ]; then echo "[FAIL] recipient.txt not created"; exit 1; fi
echo "[PASS] dist keygen: identity.age + recipient.txt created in temp CYPHER_BRAIN_HOME"

# (c) wallet (#158): create at the default path (0600), address derives the SAME
# address create printed, no-clobber refuses a second create, --force replaces it with
# a genuinely fresh keypair (a different address).
WALLET_DEFAULT="$CYPHER_BRAIN_HOME/wallet.json"
node "$DIST" wallet create > "$TMP/wallet-create.log" 2>&1 || { echo "[FAIL] dist wallet create exited non-zero"; cat "$TMP/wallet-create.log"; exit 1; }
if [ ! -f "$WALLET_DEFAULT" ]; then echo "[FAIL] wallet.json not created at default path"; exit 1; fi
WALLET_MODE="$(stat -c '%a' "$WALLET_DEFAULT" 2>/dev/null || stat -f '%Lp' "$WALLET_DEFAULT")"
if [ "$WALLET_MODE" != "600" ]; then echo "[FAIL] wallet.json mode is $WALLET_MODE, expected 600"; exit 1; fi
ADDR1="$(node "$DIST" wallet address --wallet "$WALLET_DEFAULT")" || { echo "[FAIL] dist wallet address exited non-zero"; exit 1; }
if [ -z "$ADDR1" ]; then echo "[FAIL] wallet address printed nothing"; exit 1; fi
if ! grep -qF -- "$ADDR1" "$TMP/wallet-create.log"; then
  echo "[FAIL] wallet create's printed address does not match wallet address's own derivation"; cat "$TMP/wallet-create.log"; exit 1
fi
echo "[PASS] dist wallet create: wallet.json (mode 600) at default path; wallet address derives the SAME address create printed"

# (c1b) #472: a DEFAULT-path `wallet create` must say CYPHER_BRAIN_AR_WALLET is
# optional (push/estimate/wallet address/balance already find it there), not imply it
# must be exported unconditionally.
grep -Fq "already find it here by default" "$TMP/wallet-create.log" \
  || { echo "[FAIL] wallet create (default path) does not say CYPHER_BRAIN_AR_WALLET is optional (#472)"; cat "$TMP/wallet-create.log"; exit 1; }
if grep -Fq "then set CYPHER_BRAIN_AR_WALLET=" "$TMP/wallet-create.log"; then
  echo "[FAIL] wallet create (default path) still tells the operator to set CYPHER_BRAIN_AR_WALLET unconditionally (#472)"; cat "$TMP/wallet-create.log"; exit 1
fi
echo "[PASS] dist wallet create (default path): correctly says CYPHER_BRAIN_AR_WALLET is optional (#472)"

# (c1c) #472, other side: a NON-default --out path genuinely IS required to set
# CYPHER_BRAIN_AR_WALLET (or --wallet) for push/estimate to find it, so that message
# must still say so.
node "$DIST" wallet create --out "$TMP/custom-wallet.json" > "$TMP/wallet-create-custom.log" 2>&1 \
  || { echo "[FAIL] dist wallet create --out exited non-zero"; cat "$TMP/wallet-create-custom.log"; exit 1; }
grep -Fq "then set CYPHER_BRAIN_AR_WALLET=$TMP/custom-wallet.json" "$TMP/wallet-create-custom.log" \
  || { echo "[FAIL] wallet create --out (non-default path) lost the 'set CYPHER_BRAIN_AR_WALLET' guidance (#472)"; cat "$TMP/wallet-create-custom.log"; exit 1; }
echo "[PASS] dist wallet create --out (non-default path): still tells the operator to set CYPHER_BRAIN_AR_WALLET (#472)"

node "$DIST" wallet create > /dev/null 2>"$TMP/wallet-noclobber.log"
if [ $? -eq 0 ]; then echo "[FAIL] wallet create without --force overwrote an existing wallet"; exit 1; fi
if ! grep -q "already exists" "$TMP/wallet-noclobber.log"; then
  echo "[FAIL] wallet create's no-clobber refusal message missing"; cat "$TMP/wallet-noclobber.log"; exit 1
fi
echo "[PASS] dist wallet create: refuses to clobber an existing wallet without --force"

node "$DIST" wallet create --force > "$TMP/wallet-force.log" 2>&1 || { echo "[FAIL] dist wallet create --force exited non-zero"; cat "$TMP/wallet-force.log"; exit 1; }
ADDR2="$(node "$DIST" wallet address --wallet "$WALLET_DEFAULT")" || { echo "[FAIL] dist wallet address (post-force) exited non-zero"; exit 1; }
if [ "$ADDR2" = "$ADDR1" ]; then echo "[FAIL] wallet create --force did not generate a fresh keypair (address unchanged)"; exit 1; fi
echo "[PASS] dist wallet create --force: replaces the wallet with a fresh keypair (new address)"

# (c2) #164: `wallet address` with NEITHER --wallet NOR CYPHER_BRAIN_AR_WALLET set must
# fall back to the same default path `wallet create` just wrote to, not error out.
unset CYPHER_BRAIN_AR_WALLET
ADDR3="$(node "$DIST" wallet address)" || { echo "[FAIL] dist wallet address (no --wallet, no CYPHER_BRAIN_AR_WALLET) exited non-zero"; exit 1; }
if [ "$ADDR3" != "$ADDR2" ]; then
  echo "[FAIL] wallet address without --wallet did not fall back to the default wallet.json path (got '$ADDR3', expected '$ADDR2')"; exit 1
fi
echo "[PASS] dist wallet address: falls back to \$CYPHER_BRAIN_HOME/wallet.json when --wallet and CYPHER_BRAIN_AR_WALLET are both unset"

# (c3) #497: a syntactically-valid-JSON wallet file that is NOT shaped like a JWK
# (e.g. after a bad edit, or CYPHER_BRAIN_AR_WALLET pointed at the wrong file) must get
# THIS function's own "cannot read JWK wallet" treatment, not a raw, unprefixed error
# from arweave-js's internal jwkToAddress() (which used to surface as e.g. "error:
# Failed to decode string" — no "wallet address:" prefix, no mention of the wallet path).
NOTJWK="$TMP/not-a-jwk.json"
printf '{"foo":"bar"}' > "$NOTJWK"
chmod 600 "$NOTJWK"
NOTJWK_ERR=$(node "$DIST" wallet address --wallet "$NOTJWK" 2>&1); NOTJWK_RC=$?
if [ "$NOTJWK_RC" -eq 0 ]; then echo "[FAIL] wallet address accepted a non-JWK JSON file"; echo "$NOTJWK_ERR"; exit 1; fi
if ! printf '%s' "$NOTJWK_ERR" | grep -q "wallet address: $NOTJWK does not look like a JWK wallet"; then
  echo "[FAIL] a non-JWK wallet file did not get this function's own error treatment (got a raw/unprefixed error instead)"
  echo "$NOTJWK_ERR"; exit 1
fi
echo "[PASS] dist wallet address: a syntactically-valid but non-JWK wallet.json gets this function's own \"does not look like a JWK wallet\" error, never a raw arweave-js internal error"

# (d) estimate --backend file: offline, deterministic — sizes an existing file (the
# keygen'd recipient.txt) and must report the free-tier cost without touching the
# network. Read-only: no upload happens.
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend file > "$TMP/estimate-file.log" 2>&1 \
  || { echo "[FAIL] dist estimate --backend file exited non-zero"; cat "$TMP/estimate-file.log"; exit 1; }
grep -q "^cost: 0$" "$TMP/estimate-file.log" \
  || { echo "[FAIL] estimate --backend file did not report cost: 0"; cat "$TMP/estimate-file.log"; exit 1; }
echo "[PASS] dist estimate --backend file: cost: 0 for a local file"

# (d2) #481: estimate --backend ton's note must not leak an internal source file path
# (every other backend's note is free of one; ton used to be the sole exception).
# Free/no-network branch, same as (d) — no seeder box needed.
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend ton > "$TMP/estimate-ton.log" 2>&1 \
  || { echo "[FAIL] dist estimate --backend ton exited non-zero"; cat "$TMP/estimate-ton.log"; exit 1; }
if grep -Fq "src/lib/backends/ton.ts" "$TMP/estimate-ton.log"; then
  echo "[FAIL] estimate --backend ton note still leaks its internal source file path (#481)"; cat "$TMP/estimate-ton.log"; exit 1
fi
grep -Fq "seeds the bag from your OWN tonutils-storage box" "$TMP/estimate-ton.log" \
  || { echo "[FAIL] estimate --backend ton note lost its explanation entirely"; cat "$TMP/estimate-ton.log"; exit 1; }
echo "[PASS] dist estimate --backend ton: note explains itself without leaking a source file path (#481)"
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend ton --json > "$TMP/estimate-ton.json" 2>&1 \
  || { echo "[FAIL] dist estimate --backend ton --json exited non-zero"; cat "$TMP/estimate-ton.json"; exit 1; }
if grep -Fq "src/lib/backends/ton.ts" "$TMP/estimate-ton.json"; then
  echo "[FAIL] estimate --backend ton --json note still leaks its internal source file path (#481) — reaches MCP estimate_cost too"; cat "$TMP/estimate-ton.json"; exit 1
fi
echo "[PASS] dist estimate --backend ton --json: same fix reaches the JSON path MCP estimate_cost returns (#481)"

# (e) estimate --backend turbo — deterministic/offline either way, but the expected
# note depends on whether the OPTIONAL @ardrive/turbo-sdk happens to be installed in
# this environment (it is not a devDependency, only an optional peerDependency — see
# package.json — so `bun install --frozen-lockfile` normally leaves it absent, but a
# future lockfile change could add it): branch on its actual presence instead of
# assuming absence, so this test can't silently start failing on a healthy install.
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend turbo > "$TMP/estimate-turbo.log" 2>&1 \
  || { echo "[FAIL] dist estimate --backend turbo exited non-zero"; cat "$TMP/estimate-turbo.log"; exit 1; }
if [ -d "$ROOT/node_modules/@ardrive/turbo-sdk" ]; then
  grep -q "^backend: turbo$" "$TMP/estimate-turbo.log" \
    || { echo "[FAIL] estimate --backend turbo (sdk installed) did not report backend: turbo"; cat "$TMP/estimate-turbo.log"; exit 1; }
  echo "[PASS] dist estimate --backend turbo: SDK installed, ran without crashing"
else
  grep -q "^cost: unavailable$" "$TMP/estimate-turbo.log" \
    || { echo "[FAIL] estimate --backend turbo did not report cost: unavailable"; cat "$TMP/estimate-turbo.log"; exit 1; }
  echo "[PASS] dist estimate --backend turbo: cost: unavailable (optional dependency not installed)"
fi

# (f) estimate rejects a missing --in
node "$DIST" estimate --backend file > "$TMP/estimate-noin.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] estimate with no --in exited 0, expected non-zero"; cat "$TMP/estimate-noin.log"; exit 1; fi
grep -q -- "--in <file.age> required" "$TMP/estimate-noin.log" \
  || { echo "[FAIL] estimate with no --in did not report the expected error"; cat "$TMP/estimate-noin.log"; exit 1; }
echo "[PASS] dist estimate (no --in): rejected with '--in <file.age> required'"

# (g) estimate rejects a bad --backend value, same as it rejects a missing --in above
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend bogus > "$TMP/estimate-bad.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] estimate --backend bogus exited 0, expected non-zero"; cat "$TMP/estimate-bad.log"; exit 1; fi
grep -q "unknown backend" "$TMP/estimate-bad.log" \
  || { echo "[FAIL] estimate --backend bogus did not report 'unknown backend'"; cat "$TMP/estimate-bad.log"; exit 1; }
echo "[PASS] dist estimate --backend bogus: rejected with 'unknown backend'"

# (g2) #501: estimate's "unknown backend" usage text and push's (backends/index.ts's
# own, separate copy per estimate.ts's header comment) must both list the SAME
# canonical set, sourced from the one shared STORAGE_BACKEND_NAMES const (types.ts)
# instead of each hand-keeping its own copy (the exact drift #435 already caused once).
grep -Fq "file|arweave|turbo|rclone|ton|ton-provider" "$TMP/estimate-bad.log" \
  || { echo "[FAIL] estimate --backend bogus does not list the full canonical backend set (#501)"; cat "$TMP/estimate-bad.log"; exit 1; }
# pull hits backends/index.ts's OWN separate "unknown backend" copy (per estimate.ts's
# header comment on #159) without needing a real ciphertext --in (unlike push, which
# checks the age-header magic bytes before reaching backendFor()).
node "$DIST" pull --backend bogus --locator whatever --out "$TMP/pull-bad-backend.age" > "$TMP/pull-bad-backend.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] pull --backend bogus exited 0, expected non-zero"; cat "$TMP/pull-bad-backend.log"; exit 1; fi
grep -Fq "file|arweave|turbo|rclone|ton|ton-provider" "$TMP/pull-bad-backend.log" \
  || { echo "[FAIL] pull --backend bogus does not list the full canonical backend set (#501)"; cat "$TMP/pull-bad-backend.log"; exit 1; }
echo "[PASS] dist estimate/pull --backend bogus: both list the same canonical backend set, sourced from one shared const (#501)"

# (h) estimate rejects a directory --in (stat().size on a dir would otherwise produce
# a nonsensical-but-silent "estimate" instead of a clear error)
node "$DIST" estimate --in "$ROOT" --backend file > "$TMP/estimate-dir.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] estimate --in <dir> exited 0, expected non-zero"; cat "$TMP/estimate-dir.log"; exit 1; fi
grep -q "not a regular file" "$TMP/estimate-dir.log" \
  || { echo "[FAIL] estimate --in <dir> did not report 'not a regular file'"; cat "$TMP/estimate-dir.log"; exit 1; }
echo "[PASS] dist estimate --in <dir>: rejected with 'not a regular file'"

# (i) #253: an unrecognized/mistyped --flag must be a hard error, not silently
# stored and ignored. Covers both a typo of a value flag (--recipiant, for
# --recipient) and a typo of a repeatable array flag (--dirs, plural, for
# --dir) landing in the generic branch.
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend file --recipiant foo > "$TMP/unknown-flag.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] estimate with unknown --recipiant exited 0, expected non-zero"; cat "$TMP/unknown-flag.log"; exit 1; fi
grep -q "unknown flag: --recipiant" "$TMP/unknown-flag.log" \
  || { echo "[FAIL] unknown --recipiant did not report 'unknown flag: --recipiant'"; cat "$TMP/unknown-flag.log"; exit 1; }
echo "[PASS] dist estimate --recipiant (typo): rejected with 'unknown flag: --recipiant'"

# (i cont.) #425: generalizing #253's own "would be nice-to-have" mention of a
# did-you-mean suggestion beyond restore's --out/--out-dir special case (#277/#300).
# --recipiant is close enough to --recipient (edit distance 1) to get one; a
# genuinely unrelated unknown flag must NOT get a spurious suggestion.
grep -Fq -- 'did you mean --recipient?' "$TMP/unknown-flag.log" \
  || { echo "[FAIL] unknown --recipiant (close to --recipient) did not get a did-you-mean suggestion"; cat "$TMP/unknown-flag.log"; exit 1; }
echo "[PASS] dist estimate --recipiant (typo): also suggests 'did you mean --recipient?'"

node "$DIST" snapshot --out "$TMP/unrelated-flag.age" --xyzabc123 > "$TMP/unrelated-flag.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] snapshot with unknown --xyzabc123 exited 0, expected non-zero"; cat "$TMP/unrelated-flag.log"; exit 1; fi
if grep -qi "did you mean" "$TMP/unrelated-flag.log"; then
  echo "[FAIL] a genuinely unrelated unknown flag (--xyzabc123) got a spurious did-you-mean suggestion"; cat "$TMP/unrelated-flag.log"; exit 1
fi
echo "[PASS] dist snapshot --xyzabc123 (unrelated to any real flag): rejected with NO spurious did-you-mean suggestion"

node "$DIST" snapshot --out "$TMP/unknown-bool.age" --dirs "$CYPHER_BRAIN_HOME" > "$TMP/unknown-bool-flag.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] snapshot with unknown --dirs exited 0, expected non-zero"; cat "$TMP/unknown-bool-flag.log"; exit 1; fi
grep -q "unknown flag: --dirs" "$TMP/unknown-bool-flag.log" \
  || { echo "[FAIL] unknown --dirs did not report 'unknown flag: --dirs'"; cat "$TMP/unknown-bool-flag.log"; exit 1; }
grep -Fq -- 'did you mean --dir?' "$TMP/unknown-bool-flag.log" \
  || { echo "[FAIL] unknown --dirs (plural typo for --dir, a repeatable array flag handled outside BOOL_FLAGS/VALUE_FLAGS) did not get a did-you-mean suggestion"; cat "$TMP/unknown-bool-flag.log"; exit 1; }
if [ -f "$TMP/unknown-bool.age" ]; then echo "[FAIL] snapshot with an unknown flag still wrote --out"; exit 1; fi
echo "[PASS] dist snapshot --dirs (typo for --dir, plural): rejected with 'unknown flag: --dirs' + 'did you mean --dir?', no --out written"

# (i cont. 2) #441: "--flag=value" is rejected as an unknown flag naming the WHOLE
# token, with no hint that the flag itself (--dir) is real and just needs a space
# instead of "=". A known VALUE flag ("--dir=docs") gets the space-form hint; a known
# BOOL flag ("--pq=true", which takes no value at all) gets its own "drop the '='"
# phrasing rather than a bogus "--pq true" suggestion; a token that merely CONTAINS
# "=" but isn't a "known-flag=value" shape (--totallybogus=x) must NOT get a false hint.
node "$DIST" snapshot --out "$TMP/eq-form.age" --dir="$CYPHER_BRAIN_HOME" > "$TMP/eq-value-flag.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] snapshot with --dir=... exited 0, expected non-zero"; cat "$TMP/eq-value-flag.log"; exit 1; fi
grep -Fq -- "unknown flag: --dir=$CYPHER_BRAIN_HOME" "$TMP/eq-value-flag.log" \
  || { echo "[FAIL] '--dir=...' did not report 'unknown flag: --dir=...'"; cat "$TMP/eq-value-flag.log"; exit 1; }
grep -Fq -- "did you mean '--dir $CYPHER_BRAIN_HOME' (space-separated, not '=')?" "$TMP/eq-value-flag.log" \
  || { echo "[FAIL] '--dir=...' (known VALUE flag) did not get the space-separated-form hint"; cat "$TMP/eq-value-flag.log"; exit 1; }
if [ -f "$TMP/eq-form.age" ]; then echo "[FAIL] snapshot with --dir=... still wrote --out"; exit 1; fi
echo "[PASS] dist snapshot --dir=... (known VALUE flag with '='): rejected with a 'did you mean --dir <value> (space-separated)' hint, no --out written"

node "$DIST" keygen --pq=true > "$TMP/eq-bool-flag.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] keygen --pq=true exited 0, expected non-zero"; cat "$TMP/eq-bool-flag.log"; exit 1; fi
grep -Fq -- "unknown flag: --pq=true" "$TMP/eq-bool-flag.log" \
  || { echo "[FAIL] '--pq=true' did not report 'unknown flag: --pq=true'"; cat "$TMP/eq-bool-flag.log"; exit 1; }
grep -Fq -- "did you mean '--pq' (it takes no value — drop the '=')?" "$TMP/eq-bool-flag.log" \
  || { echo "[FAIL] '--pq=true' (known BOOL flag) did not get the 'drop the =' hint"; cat "$TMP/eq-bool-flag.log"; exit 1; }
echo "[PASS] dist keygen --pq=true (known BOOL flag with '='): rejected with a 'did you mean --pq (drop the =)' hint, not a bogus '--pq true' suggestion"

node "$DIST" snapshot --out "$TMP/eq-bogus.age" --totallybogus=x > "$TMP/eq-bogus-flag.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] snapshot with --totallybogus=x exited 0, expected non-zero"; cat "$TMP/eq-bogus-flag.log"; exit 1; fi
if grep -qi "did you mean" "$TMP/eq-bogus-flag.log"; then
  echo "[FAIL] '--totallybogus=x' (contains '=' but not a known-flag=value shape) got a spurious hint"; cat "$TMP/eq-bogus-flag.log"; exit 1
fi
if [ -f "$TMP/eq-bogus.age" ]; then echo "[FAIL] snapshot with --totallybogus=x still wrote --out"; exit 1; fi
echo "[PASS] dist snapshot --totallybogus=x (contains '=' but unrelated to any real flag): rejected with NO spurious hint, no --out written"

# (i cont. 3) #441 hardening: an EMPTY value after "=" ("--dir=") must not produce a
# fabricated "did you mean '--dir '" hint that reads as a valid correction when the
# value is still missing (Codex review finding) — a "<value>" placeholder instead.
node "$DIST" snapshot --out "$TMP/eq-empty.age" --dir= > "$TMP/eq-empty-value.log" 2>&1
if [ $? -eq 0 ]; then echo "[FAIL] snapshot with --dir= exited 0, expected non-zero"; cat "$TMP/eq-empty-value.log"; exit 1; fi
grep -Fq -- "did you mean '--dir <value>' (space-separated, not '=')?" "$TMP/eq-empty-value.log" \
  || { echo "[FAIL] '--dir=' (empty value) did not get the '<value>' placeholder hint"; cat "$TMP/eq-empty-value.log"; exit 1; }
if [ -f "$TMP/eq-empty.age" ]; then echo "[FAIL] snapshot with --dir= still wrote --out"; exit 1; fi
echo "[PASS] dist snapshot --dir= (known VALUE flag, empty value after '='): hint uses a '<value>' placeholder, not a fabricated empty correction, no --out written"

# a legitimate, fully-recognized flag set must still pass through untouched
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend file > "$TMP/known-flags.log" 2>&1 \
  || { echo "[FAIL] estimate with only recognized flags exited non-zero"; cat "$TMP/known-flags.log"; exit 1; }
echo "[PASS] dist estimate with only recognized flags: still exits 0 (no false-positive rejection)"

# (h) --version (#261): the BARE version on stdout, nothing else (so it can be
# captured straight into a variable), exit 0, and the SAME string from the
# bundled dist and the unbundled bin shim — the version is read out of
# package.json at runtime via a relative URL that has to resolve correctly from
# both layouts, so a regression there would silently split the two apart.
node "$DIST" --version > "$TMP/version-dist.txt" 2> "$TMP/version-dist.err" \
  || { echo "[FAIL] dist --version exited non-zero"; cat "$TMP/version-dist.err"; exit 1; }
# the path goes through argv, not string interpolation into the -p script, so a
# checkout directory containing a quote or a space cannot break the expression
PKG_VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json")"
if [ "$(cat "$TMP/version-dist.txt")" != "$PKG_VERSION" ]; then
  echo "[FAIL] dist --version printed '$(cat "$TMP/version-dist.txt")', expected the bare '$PKG_VERSION'"; exit 1
fi
node "${BIN_DEV_ARGS[@]}" "$BIN" --version > "$TMP/version-bin.txt" 2>&1 \
  || { echo "[FAIL] bin --version exited non-zero"; cat "$TMP/version-bin.txt"; exit 1; }
if ! diff -q "$TMP/version-bin.txt" "$TMP/version-dist.txt" >/dev/null; then
  echo "[FAIL] bin --version differs from dist --version"; diff "$TMP/version-bin.txt" "$TMP/version-dist.txt"; exit 1
fi
node "$DIST" -V > "$TMP/version-short.txt" 2>&1 \
  || { echo "[FAIL] dist -V exited non-zero"; cat "$TMP/version-short.txt"; exit 1; }
if ! diff -q "$TMP/version-short.txt" "$TMP/version-dist.txt" >/dev/null; then
  echo "[FAIL] -V differs from --version"; diff "$TMP/version-short.txt" "$TMP/version-dist.txt"; exit 1
fi
echo "[PASS] dist --version / -V: bare '$PKG_VERSION' on stdout, exit 0, identical from bin and dist"

# (i) <command> --help (#262): only that command's section, and the full
# reference is still what plain --help prints.
node "$DIST" verify --help > "$TMP/help-verify.txt" 2>/dev/null \
  || { echo "[FAIL] dist verify --help exited non-zero"; exit 1; }
grep -q "cypher-brain verify --in" "$TMP/help-verify.txt" \
  || { echo "[FAIL] 'verify --help' does not contain the verify section"; cat "$TMP/help-verify.txt"; exit 1; }
# Structural, not name-based: count the section headers rather than grepping for
# one other command's heading, so this keeps failing on a whole-help dump even if
# some command's usage line is later reworded (multi-model review finding).
HELP_SECTIONS="$(grep -c '^  cypher-brain ' "$TMP/help-verify.txt")"
if [ "$HELP_SECTIONS" -ne 1 ]; then
  echo "[FAIL] 'verify --help' has $HELP_SECTIONS command sections, expected exactly 1 (whole help dumped?)"; exit 1
fi
grep -q "^Env: CYPHER_BRAIN_HOME" "$TMP/help-verify.txt" \
  || { echo "[FAIL] 'verify --help' dropped the command-agnostic Env/Storage/Spend block"; exit 1; }
# an unknown command with --help falls back to the full reference rather than
# nothing. The baseline is re-captured HERE rather than reusing help-dist.txt
# from (a): HELP interpolates ${IDENTITY}, which (b) changed by exporting
# CYPHER_BRAIN_HOME, so the two would differ on that line alone.
node "$DIST" --help > "$TMP/help-full-now.txt" 2>&1 \
  || { echo "[FAIL] dist --help exited non-zero"; exit 1; }
node "$DIST" nosuchcommand --help > "$TMP/help-unknown.txt" 2>&1 \
  || { echo "[FAIL] dist nosuchcommand --help exited non-zero"; exit 1; }
if ! diff -q "$TMP/help-unknown.txt" "$TMP/help-full-now.txt" >/dev/null; then
  echo "[FAIL] unknown command + --help did not fall back to the full help"; exit 1
fi
echo "[PASS] dist <command> --help: scoped to that command, keeps the Env block, unknown command falls back to full help"

# (j) an unknown command (#269): everything on stderr, stdout EMPTY, exit 2, and a
# short answer — the command list + where to read more — instead of ~26 KB of help.
# stdout emptiness is the load-bearing part: `LOC=$(cypher-brain psh …)` used to
# capture the entire reference into the variable.
node "$DIST" definitelynotacommand > "$TMP/unknown-cmd.out" 2> "$TMP/unknown-cmd.err"
UNKNOWN_RC=$?
[ "$UNKNOWN_RC" = "2" ] || { echo "[FAIL] unknown command exited $UNKNOWN_RC, expected 2"; exit 1; }
[ ! -s "$TMP/unknown-cmd.out" ] \
  || { echo "[FAIL] unknown command wrote $(wc -c < "$TMP/unknown-cmd.out") bytes to stdout, expected none"; exit 1; }
grep -Fq 'error: unknown command: definitelynotacommand' "$TMP/unknown-cmd.err" \
  || { echo "[FAIL] unknown command did not name the offending command on stderr"; cat "$TMP/unknown-cmd.err"; exit 1; }
grep -Fq "cypher-brain <command> --help" "$TMP/unknown-cmd.err" \
  || { echo "[FAIL] unknown command did not point at --help"; cat "$TMP/unknown-cmd.err"; exit 1; }
# The advertised list is DERIVED from HELP's section headers, so compare it as a SET
# against the real command surface — catching both a command that stopped being listed
# and a bogus entry the derivation picked up (e.g. a non-command header). Sorted, so
# reordering HELP's sections is not a false failure; `\b` is avoided since word-boundary
# support differs between GNU and BSD grep (multi-model review finding).
LISTED=$(sed -n 's/^valid commands: //p' "$TMP/unknown-cmd.err" | tr ',' '\n' | tr -d ' ' | sort | tr '\n' ' ')
EXPECTED=$(printf '%s\n' init keygen wallet snapshot restore verify push pull publish-latest estimate recovery-kit schedule doctor ledger audit | sort | tr '\n' ' ')
[ "$LISTED" = "$EXPECTED" ] \
  || { echo "[FAIL] valid-commands list is [$LISTED], expected [$EXPECTED]"; cat "$TMP/unknown-cmd.err"; exit 1; }
UNKNOWN_LINES=$(wc -l < "$TMP/unknown-cmd.err" | tr -d ' ')
[ "$UNKNOWN_LINES" -le 5 ] \
  || { echo "[FAIL] the unknown-command reply is $UNKNOWN_LINES lines — the whole help is being dumped again"; exit 1; }
echo "[PASS] dist <unknown command>: exit 2, stdout empty, a ${UNKNOWN_LINES}-line stderr reply listing every valid command"

# (j cont.) #425: generalizing #253's own "would be nice-to-have" mention of a
# did-you-mean suggestion beyond restore's --out/--out-dir special case. "definitely-
# notacommand" above is unrelated to every real command name and correctly got no
# suggestion; "snapsho" (edit distance 1 from "snapshot") must get one.
node "$DIST" snapsho > "$TMP/typo-cmd.out" 2> "$TMP/typo-cmd.err"
[ "$?" = "2" ] || { echo "[FAIL] typo'd command 'snapsho' did not exit 2"; cat "$TMP/typo-cmd.err"; exit 1; }
grep -Fq 'error: unknown command: snapsho (did you mean snapshot?)' "$TMP/typo-cmd.err" \
  || { echo "[FAIL] 'snapsho' (typo for snapshot) did not get a did-you-mean suggestion"; cat "$TMP/typo-cmd.err"; exit 1; }
if grep -qi "did you mean" "$TMP/unknown-cmd.err"; then
  echo "[FAIL] 'definitelynotacommand' (unrelated to every real command) got a spurious did-you-mean suggestion"; cat "$TMP/unknown-cmd.err"; exit 1
fi
echo "[PASS] dist unknown command: 'snapsho' suggests 'did you mean snapshot?', 'definitelynotacommand' correctly gets no spurious suggestion"

# (j cont. 2) zero arguments (#427): same shape as the unknown-command reply above —
# exit 2, stdout EMPTY, a short stderr reply — instead of the #269 fix's own former gap:
# bare `cypher-brain` used to fall into the same case as explicit `--help` and dump the
# whole ~26 KB reference with exit 0. Explicit --help must still behave exactly as (a)
# above confirmed: full reference, exit 0 — this only changes NO arguments at all.
node "$DIST" > "$TMP/noargs.out" 2> "$TMP/noargs.err"
NOARGS_RC=$?
[ "$NOARGS_RC" = "2" ] || { echo "[FAIL] zero arguments exited $NOARGS_RC, expected 2"; cat "$TMP/noargs.err"; exit 1; }
[ ! -s "$TMP/noargs.out" ] \
  || { echo "[FAIL] zero arguments wrote $(wc -c < "$TMP/noargs.out") bytes to stdout, expected none"; exit 1; }
grep -Fq 'error: no command given' "$TMP/noargs.err" \
  || { echo "[FAIL] zero arguments did not print the no-command-given error"; cat "$TMP/noargs.err"; exit 1; }
grep -Fq "cypher-brain <command> --help" "$TMP/noargs.err" \
  || { echo "[FAIL] zero arguments did not point at --help"; cat "$TMP/noargs.err"; exit 1; }
NOARGS_LINES=$(wc -l < "$TMP/noargs.err" | tr -d ' ')
[ "$NOARGS_LINES" -le 5 ] \
  || { echo "[FAIL] the zero-arguments reply is $NOARGS_LINES lines — the whole help is being dumped again"; exit 1; }
echo "[PASS] dist zero arguments: exit 2, stdout empty, a ${NOARGS_LINES}-line stderr reply (explicit --help is unaffected, per (a) above)"

# (j cont. 3) #435 (follow-up to #425): the same nearestName() matcher, now also
# covering a NESTED subcommand typo (schedule/wallet's own sub-verb) and an
# ENUM-VALUED flag typo (--level/--backend/--chain) — neither got a suggestion
# before #435, only the generic "expected X | Y | Z" listing.
# Each typo below must REFUSE (non-zero), not just print a suggestion and carry on.
# #779/#781: a top-level unknown command and these nested/enum typos both exit 2 now
# (errors.ts's UsageError) — 'wallet adress' and the three enum typos below assert the
# exact code. 'schedule statuz' is schedule.ts's own separate sub-verb check, out of
# scope for this change (untouched, still exits 1) — its non-zero-only check stays as is.
node "$DIST" schedule statuz > /dev/null 2> "$TMP/nested-schedule.err"; RC=$?
[ "$RC" != "0" ] || { echo "[FAIL] 'schedule statuz' exited 0 — the typo was suggested but not refused"; cat "$TMP/nested-schedule.err"; exit 1; }
grep -Fq 'schedule: expected install | uninstall | status, got: statuz (did you mean status?)' "$TMP/nested-schedule.err" \
  || { echo "[FAIL] 'schedule statuz' did not suggest 'status'"; cat "$TMP/nested-schedule.err"; exit 1; }
node "$DIST" wallet adress > /dev/null 2> "$TMP/nested-wallet.err"
WALLET_ADRESS_RC=$?
grep -Fq 'wallet: expected create | address | balance, got: adress (did you mean address?)' "$TMP/nested-wallet.err" \
  || { echo "[FAIL] 'wallet adress' did not suggest 'address'"; cat "$TMP/nested-wallet.err"; exit 1; }
# #781: a mistyped sub-verb is a PARSER-LEVEL refusal (the command line itself was
# malformed), the same class the unknown-command/no-command replies above already
# exit 2 for — errors.ts's UsageError now routes this one through main().catch() the
# same way, so it exits 2 too instead of the generic-failure 1. Pinned only for
# 'wallet adress' here: 'schedule statuz' above is schedule.ts's own separate
# sub-verb check, out of scope for this change (untouched, still exits 1).
[ "$WALLET_ADRESS_RC" = "2" ] \
  || { echo "[FAIL] 'wallet adress' exited $WALLET_ADRESS_RC, expected 2 (a parser-level refusal, #781)"; exit 1; }
# a genuinely unrelated nested sub-verb still gets no suggestion (same #425 asymmetry
# the top-level unknown-command test above already covers).
node "$DIST" wallet xyz > /dev/null 2> "$TMP/nested-wallet-unrelated.err"
if grep -qi "did you mean" "$TMP/nested-wallet-unrelated.err"; then
  echo "[FAIL] 'wallet xyz' (unrelated to every sub-verb) got a spurious did-you-mean suggestion"; cat "$TMP/nested-wallet-unrelated.err"; exit 1
fi
echo "[PASS] dist nested subcommand typos: 'schedule statuz'/'wallet adress' suggest their real sub-verb, 'wallet xyz' correctly gets no spurious suggestion"

node "$DIST" verify --level remtoe --in "$TMP/does-not-exist.age" > /dev/null 2> "$TMP/enum-level.err"
ENUM_LEVEL_RC=$?
grep -Fq 'did you mean --level remote?' "$TMP/enum-level.err" \
  || { echo "[FAIL] '--level remtoe' did not suggest '--level remote'"; cat "$TMP/enum-level.err"; exit 1; }
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend fille > /dev/null 2> "$TMP/enum-backend.err"
ENUM_BACKEND_RC=$?
grep -Fq 'did you mean file?' "$TMP/enum-backend.err" \
  || { echo "[FAIL] '--backend fille' did not suggest 'file'"; cat "$TMP/enum-backend.err"; exit 1; }
node "$DIST" wallet create --chain tona > /dev/null 2> "$TMP/enum-chain.err"
ENUM_CHAIN_RC=$?
grep -Fq 'did you mean ton?' "$TMP/enum-chain.err" \
  || { echo "[FAIL] '--chain tona' did not suggest 'ton'"; cat "$TMP/enum-chain.err"; exit 1; }
# #781: an enum-valued flag's bad value is a parser-level refusal too — same UsageError
# treatment as 'wallet adress' above, exit 2 instead of the generic-failure 1.
[ "$ENUM_LEVEL_RC" = "2" ] \
  || { echo "[FAIL] '--level remtoe' exited $ENUM_LEVEL_RC, expected 2 (a parser-level refusal, #781)"; exit 1; }
[ "$ENUM_BACKEND_RC" = "2" ] \
  || { echo "[FAIL] '--backend fille' exited $ENUM_BACKEND_RC, expected 2 (a parser-level refusal, #781)"; exit 1; }
[ "$ENUM_CHAIN_RC" = "2" ] \
  || { echo "[FAIL] '--chain tona' exited $ENUM_CHAIN_RC, expected 2 (a parser-level refusal, #781)"; exit 1; }
# a genuinely unrelated enum value still gets no suggestion.
node "$DIST" verify --level bogus --in "$TMP/does-not-exist.age" > /dev/null 2> "$TMP/enum-level-unrelated.err"
if grep -qi "did you mean" "$TMP/enum-level-unrelated.err"; then
  echo "[FAIL] '--level bogus' (unrelated to every level) got a spurious did-you-mean suggestion"; cat "$TMP/enum-level-unrelated.err"; exit 1
fi
echo "[PASS] dist enum-valued flag typos: '--level remtoe'/'--backend fille'/'--chain tona' suggest the real value, '--level bogus' correctly gets no spurious suggestion"

# (j cont. 4) dogfooding gap in #814's own UsageError sweep: the TWO bare/multi-
# positional refusals in parseArgs() (a command that takes no positional at all, e.g.
# 'doctor foo'; a POSITIONAL_COMMANDS command given more than one sub-command word,
# e.g. 'schedule install status') still threw a plain Error and exited 1 — the same
# "an agent cannot tell malformed-invocation from a real failure by exit code alone"
# gap #814/#781 closed for every OTHER parser-level refusal. Both must now exit 2, and
# --json must print exit_code: 2 (not silently omit it, like the pre-#788 gap did for
# the top-level unknown-command reply).
node "$DIST" doctor foo --json > "$TMP/bare-positional.log" 2> "$TMP/bare-positional.err"
BARE_POSITIONAL_RC=$?
[ "$BARE_POSITIONAL_RC" = "2" ] \
  || { echo "[FAIL] 'doctor foo --json' exited $BARE_POSITIONAL_RC, expected 2 (a parser-level refusal)"; cat "$TMP/bare-positional.log" "$TMP/bare-positional.err"; exit 1; }
grep -Fq 'doctor does not take a bare argument' "$TMP/bare-positional.log" \
  || { echo "[FAIL] 'doctor foo --json' did not report the bare-argument refusal"; cat "$TMP/bare-positional.log"; exit 1; }
node -e '
  const o = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  if (o.exit_code !== 2) throw new Error("exit_code " + o.exit_code + " != 2");
' "$TMP/bare-positional.log" \
  || { echo "[FAIL] 'doctor foo --json' stdout is not {exit_code: 2}"; cat "$TMP/bare-positional.log"; exit 1; }
echo "[PASS] dist 'doctor foo --json' (a command that takes no bare positional): exit 2, --json reports exit_code: 2"

node "$DIST" schedule install status > /dev/null 2> "$TMP/multi-positional.err"
MULTI_POSITIONAL_RC=$?
[ "$MULTI_POSITIONAL_RC" = "2" ] \
  || { echo "[FAIL] 'schedule install status' exited $MULTI_POSITIONAL_RC, expected 2 (a parser-level refusal)"; cat "$TMP/multi-positional.err"; exit 1; }
grep -Fq 'schedule takes exactly one sub-command word' "$TMP/multi-positional.err" \
  || { echo "[FAIL] 'schedule install status' did not report the multi-positional refusal"; cat "$TMP/multi-positional.err"; exit 1; }
echo "[PASS] dist 'schedule install status' (more than one sub-command word): exit 2"

# #537: nearestName()'s editDistance() moved from plain to (restricted)
# Damerau-Levenshtein so an adjacent-letter TRANSPOSITION (not just a
# substitution like 'remtoe' above) also gets a suggestion — 'quikc' (the
# 'ck'/'kc' swap in 'quick') used to fall outside the 1-edit threshold and
# get no suggestion at all, unlike a same-distance case typo ('QUICK').
node "$DIST" verify --level quikc --in "$TMP/does-not-exist.age" > /dev/null 2> "$TMP/enum-level-transposed.err"
grep -Fq 'did you mean --level quick?' "$TMP/enum-level-transposed.err" \
  || { echo "[FAIL] '--level quikc' (transposition typo) did not suggest '--level quick'"; cat "$TMP/enum-level-transposed.err"; exit 1; }
echo "[PASS] dist enum-valued flag transposition typo: '--level quikc' suggests '--level quick' (#537)"

# (k) estimate --json (#268): all seven documented keys are ALWAYS present, whichever
# backend was asked about — the free ones used to drop unit/approx_ar/usd_estimate
# entirely, so `est.unit` was undefined and the caller could not tell "no unit" from
# "you asked wrong".
for JSON_BACKEND in file rclone turbo; do
  node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend "$JSON_BACKEND" --json \
    > "$TMP/est-$JSON_BACKEND.json" 2>/dev/null \
    || { echo "[FAIL] estimate --backend $JSON_BACKEND --json exited non-zero"; exit 1; }
  MISSING=$(node -e '
    const fs = require("node:fs");
    const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const want = ["backend", "size_bytes", "cost", "unit", "approx_ar", "usd_estimate", "note"];
    console.log(want.filter((k) => !(k in o)).join(","));
  ' "$TMP/est-$JSON_BACKEND.json")
  [ -z "$MISSING" ] \
    || { echo "[FAIL] estimate --backend $JSON_BACKEND --json is missing key(s): $MISSING"; cat "$TMP/est-$JSON_BACKEND.json"; exit 1; }
done
echo "[PASS] dist estimate --json: all seven documented keys present for file/rclone/turbo (null, not absent, when N/A)"

# (l) --json on the ERROR path (#270): stdout carries {error, code, exit_code} instead
# of nothing, so a JSON caller never has to scrape prose off stderr. `code` is the
# CB-E0xx identifier when the failure matches a known pattern.
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend nosuchbackend --json \
  > "$TMP/err.json" 2> "$TMP/err.txt"
ERR_RC=$?
[ "$ERR_RC" != "0" ] || { echo "[FAIL] estimate with a bogus backend exited 0"; exit 1; }
# exactly ONE JSON value on stdout (a second appended object would make the stream
# unparseable), and its exit_code must agree with the process's real exit status
ERR_LINES=$(wc -l < "$TMP/err.json" | tr -d ' ')
[ "$ERR_LINES" = "1" ] \
  || { echo "[FAIL] the --json error path wrote $ERR_LINES lines to stdout, expected exactly 1"; cat "$TMP/err.json"; exit 1; }
ERR_CODE=$(node -e '
  const fs = require("node:fs");
  const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof o.error !== "string" || !o.error) throw new Error("no error string");
  if (o.exit_code !== Number(process.argv[2])) throw new Error("exit_code " + o.exit_code + " != process exit " + process.argv[2]);
  console.log(o.code === null ? "null" : o.code);
' "$TMP/err.json" "$ERR_RC") || { echo "[FAIL] --json error output is not a well-formed error object (or exit_code disagrees with the real exit status $ERR_RC)"; cat "$TMP/err.json"; exit 1; }
[ "$ERR_CODE" = "CB-E013" ] \
  || { echo "[FAIL] the --json error object reported code '$ERR_CODE', expected CB-E013"; cat "$TMP/err.json"; exit 1; }
grep -Fq 'unknown backend' "$TMP/err.txt" \
  || { echo "[FAIL] stderr no longer carries the human-readable error"; cat "$TMP/err.txt"; exit 1; }
# and WITHOUT --json, stdout on the error path stays empty exactly as before
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend nosuchbackend > "$TMP/err-nojson.out" 2>/dev/null
[ ! -s "$TMP/err-nojson.out" ] \
  || { echo "[FAIL] the error path writes to stdout even without --json"; cat "$TMP/err-nojson.out"; exit 1; }
echo "[PASS] dist --json error path: {error, code: CB-E013, exit_code} on stdout, stderr unchanged, no stdout without --json"

# (l cont.) #781: an unknown COMMAND used to be one of two hand-rolled replies
# (cli.ts's `case undefined:`/`default:` arms) that set process.exitCode = 2 and
# returned directly — never reaching main().catch()'s --json branch above, so
# `cypher-brain bogus --json` printed NOTHING on stdout despite asking for --json.
# Both arms now throw errors.ts's UsageError instead, routing through the SAME
# generic handler as every other error.
node "$DIST" bogus --json > "$TMP/unknown-cmd.json" 2> "$TMP/unknown-cmd.txt"
UNKNOWN_CMD_RC=$?
[ "$UNKNOWN_CMD_RC" = "2" ] \
  || { echo "[FAIL] 'bogus --json' exited $UNKNOWN_CMD_RC, expected 2"; cat "$TMP/unknown-cmd.txt"; exit 1; }
UNKNOWN_CMD_LINES=$(wc -l < "$TMP/unknown-cmd.json" | tr -d ' ')
[ "$UNKNOWN_CMD_LINES" = "1" ] \
  || { echo "[FAIL] 'bogus --json' wrote $UNKNOWN_CMD_LINES lines to stdout, expected exactly 1 (a JSON error object)"; cat "$TMP/unknown-cmd.json"; exit 1; }
node -e '
  const fs = require("node:fs");
  const o = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (typeof o.error !== "string" || !o.error.includes("unknown command: bogus")) throw new Error("unexpected error text: " + o.error);
  if (o.code !== null) throw new Error("expected code: null (no CB-E0xx pattern matches this message), got " + o.code);
  if (o.exit_code !== 2) throw new Error("expected exit_code: 2, got " + o.exit_code);
' "$TMP/unknown-cmd.json" \
  || { echo "[FAIL] 'bogus --json' stdout is not the expected {error, code: null, exit_code: 2} object"; cat "$TMP/unknown-cmd.json"; exit 1; }
echo "[PASS] dist unknown command --json: {error, code: null, exit_code: 2} on stdout (#781 — previously nothing)"

### (m) restore REFUSES the --out it does not read, naming the flag and the near miss (#277)
# --out is the destination flag on snapshot/pull/wallet create, so typing it on restore
# is the natural mistake. It used to be accepted globally and never read, then answered
# with a hint from inside restore(); since #277 the dispatcher refuses it before restore()
# runs, and carries the same "did you mean" suggestion so the reply did not get worse.
node "$DIST" restore --in "$CYPHER_BRAIN_HOME/recipient.txt" --out "$TMP/nope" > "$TMP/m.out" 2> "$TMP/m.err"
M_RC=$?
[ "$M_RC" != "0" ] || { echo "[FAIL] restore with --out instead of --out-dir exited 0"; exit 1; }
grep -Fq -- 'did you mean --out-dir?' "$TMP/m.err" \
  || { echo "[FAIL] restore --out did not name the ignored flag"; cat "$TMP/m.err"; exit 1; }
grep -Fq -- 'does not read --out' "$TMP/m.err" \
  || { echo "[FAIL] restore --out was not refused as unread — it is being answered by a downstream check instead"; cat "$TMP/m.err"; exit 1; }

### (m1b) #460: ledger/audit REFUSE a sibling command's flag instead of silently
# accepting and ignoring it. --backend is push/pull/restore/estimate's own flag,
# naturally reached for on ledger (whose report groups by backend); --level is
# verify's own quick/remote/drill depth flag, naturally reached for on audit (whose
# own --help block sits right after verify's). Both used to run normally and produce
# the SAME output as without the flag — this proves they are refused instead.
node "$DIST" ledger --backend file > "$TMP/m1b-ledger.out" 2> "$TMP/m1b-ledger.err"
LEDGER_BACKEND_RC=$?
[ "$LEDGER_BACKEND_RC" != "0" ] || { echo "[FAIL] ledger --backend file exited 0 — it is still being silently accepted (#460)"; exit 1; }
grep -Fq -- 'does not read --backend' "$TMP/m1b-ledger.err" \
  || { echo "[FAIL] ledger --backend file was not refused as unread"; cat "$TMP/m1b-ledger.err"; exit 1; }
[ ! -s "$TMP/m1b-ledger.out" ] || { echo "[FAIL] ledger --backend file wrote to stdout on the error path"; cat "$TMP/m1b-ledger.out"; exit 1; }
node "$DIST" audit --level drill > "$TMP/m1b-audit.out" 2> "$TMP/m1b-audit.err"
AUDIT_LEVEL_RC=$?
[ "$AUDIT_LEVEL_RC" != "0" ] || { echo "[FAIL] audit --level drill exited 0 — it is still being silently accepted (#460)"; exit 1; }
grep -Fq -- 'does not read --level' "$TMP/m1b-audit.err" \
  || { echo "[FAIL] audit --level drill was not refused as unread"; cat "$TMP/m1b-audit.err"; exit 1; }
[ ! -s "$TMP/m1b-audit.out" ] || { echo "[FAIL] audit --level drill wrote to stdout on the error path"; cat "$TMP/m1b-audit.out"; exit 1; }
# A genuinely unknown flag on either command must still be refused the SAME pre-#460
# way (a global "unknown flag" error) — this is not the flag-relevance mechanism, it
# is the check #460 says stayed correct all along (the issue's own contrast case).
node "$DIST" audit --bogus-flag-xyz > /dev/null 2> "$TMP/m1b-bogus.err"
BOGUS_RC=$?
[ "$BOGUS_RC" != "0" ] || { echo "[FAIL] audit --bogus-flag-xyz exited 0"; exit 1; }
grep -Fq -- 'unknown flag: --bogus-flag-xyz' "$TMP/m1b-bogus.err" \
  || { echo "[FAIL] audit --bogus-flag-xyz did not get the plain unknown-flag error"; cat "$TMP/m1b-bogus.err"; exit 1; }
echo "[PASS] dist ledger --backend / audit --level: refused as unread flags, not silently ignored (#460)"

### (m2) #277: every command the SWITCH can dispatch has answered the flag-relevance
# question. A STATIC comparison of two things read out of src/cli.ts — the dispatch switch's
# case labels and FLAG_IRRELEVANT's keys — rather than a runtime probe. It has to be static:
# assertFlagsDeclared() deliberately stays quiet for a name it does not recognise, so that a
# TYPO still gets the friendly "unknown command" reply instead of an internal error, and a
# switch case that was never added to HELP is indistinguishable from a typo at run time.
# That is the exact gap this guard closes (multi-model review finding), and `help` — a real
# case that HELP does not document — is the proof such a case can exist.
node -e "
  const src = require('node:fs').readFileSync('$ROOT/src/cli.ts', 'utf8');
  const body = src.slice(src.indexOf('switch (cmd) {'));
  const cases = [...body.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]);
  const table = src.slice(src.indexOf('const FLAG_IRRELEVANT'));
  const decls = new Set([...table.slice(0, table.indexOf('\n};')).matchAll(/^  '?([-A-Za-z_]+)'?: \[/gm)].map((m) => m[1]));
  if (cases.length === 0) { console.error('no case labels found — the dispatch switch changed shape'); process.exit(1); }
  if (decls.size === 0) { console.error('no declarations parsed — FLAG_IRRELEVANT changed shape'); process.exit(1); }
  const missing = cases.filter((c) => !decls.has(c));
  if (missing.length) {
    console.error('commands the dispatch switch can reach with no flag-relevance declaration (#277): ' + missing.join(', '));
    console.error('add each to FLAG_IRRELEVANT in src/cli.ts, using [] if no flag another command accepts is ignored by this one');
    process.exit(1);
  }
  console.log('checked ' + cases.length + ' dispatch cases against ' + decls.size + ' declarations');
" || { echo "[FAIL] a command the dispatch switch can reach has no flag-relevance declaration (#277)"; exit 1; }
echo "[PASS] every command the dispatch switch can reach has a flag-relevance declaration (#277)"

### (m3) an empty declaration must not become a way to switch the check off: a command that
# declares [] still has to accept the flags it does read. `push` is the one probed here
# BECAUSE its declaration is empty — using a command with a non-empty one would prove
# nothing about that failure mode (multi-model review finding).
node "$DIST" push --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend file > /dev/null 2>&1
PUSH_RC=$?
[ "$PUSH_RC" != "2" ] || { echo "[FAIL] push --backend was refused by the relevance check — it is over-firing on an empty declaration"; exit 1; }
node "$DIST" estimate --in "$CYPHER_BRAIN_HOME/recipient.txt" --backend file > /dev/null 2>&1 \
  || { echo "[FAIL] estimate --backend was refused — the relevance check is over-firing"; exit 1; }
echo "[PASS] a declared-empty command still accepts what it reads, and a non-empty one is unaffected"
[ ! -s "$TMP/m.out" ] || { echo "[FAIL] restore wrote to stdout on the error path"; cat "$TMP/m.out"; exit 1; }
# and with NEITHER flag the message stays the plain one — the hint must not fire
# on the unrelated case of simply forgetting a destination
node "$DIST" restore --in "$CYPHER_BRAIN_HOME/recipient.txt" > /dev/null 2> "$TMP/m2.err"
M2_RC=$?
[ "$M2_RC" != "0" ] || { echo "[FAIL] restore without a destination exited 0"; exit 1; }
# match the WHOLE line, not a substring: a message that merely contains the old text
# plus new trailing prose would slip past a substring check
grep -qx -- 'error: --out-dir <dir> required' "$TMP/m2.err" \
  || { echo "[FAIL] restore without a destination no longer emits exactly 'error: --out-dir <dir> required'"; cat "$TMP/m2.err"; exit 1; }
echo "[PASS] dist restore: --out is named as ignored with a --out-dir hint; the plain error is unchanged without it"

### (m4) #781: recovery-kit/init/publish-latest --json used to be FORMAT-BY-OUTCOME —
# prose on success, but main().catch()'s --json branch fired on ANY throw regardless
# of whether the command itself ever implements a JSON success document, so a genuine
# FAILURE on one of these three commands with --json set printed a JSON error object
# even though a SUCCESSFUL run of the same command would have printed plain prose. A
# caller parsing --json output uniformly could not tell which shape to expect until
# after the fact. All three now have a FLAG_IRRELEVANT['json'] entry (the same #647
# treatment push/pull/wallet-address/wallet-create/restore/keygen/snapshot already
# had), so --json is refused upfront instead — reproduced here on recovery-kit's
# error path specifically, since that's the one this issue's audit demonstrated.
node "$DIST" recovery-kit --from-locator-file "$TMP/does-not-exist-locator" --json > /dev/null 2> "$TMP/m4-recovery-kit.err"
M4_RK_RC=$?
[ "$M4_RK_RC" = "2" ] \
  || { echo "[FAIL] 'recovery-kit --json' exited $M4_RK_RC, expected 2 (refused upfront as a flag it does not read)"; cat "$TMP/m4-recovery-kit.err"; exit 1; }
grep -Fq -- 'does not read --json' "$TMP/m4-recovery-kit.err" \
  || { echo "[FAIL] 'recovery-kit --json' was not refused as unread — it is still format-by-outcome"; cat "$TMP/m4-recovery-kit.err"; exit 1; }
node "$DIST" init --json > /dev/null 2> "$TMP/m4-init.err" < /dev/null
grep -Fq -- 'does not read --json' "$TMP/m4-init.err" \
  || { echo "[FAIL] 'init --json' was not refused as unread — it is still format-by-outcome"; cat "$TMP/m4-init.err"; exit 1; }
node "$DIST" publish-latest --domain example.ton --from-locator-file "$TMP/does-not-exist-locator" --json > /dev/null 2> "$TMP/m4-publish-latest.err"
grep -Fq -- 'does not read --json' "$TMP/m4-publish-latest.err" \
  || { echo "[FAIL] 'publish-latest --json' was not refused as unread — it is still format-by-outcome"; cat "$TMP/m4-publish-latest.err"; exit 1; }
echo "[PASS] dist recovery-kit/init/publish-latest --json: refused upfront (not format-by-outcome) (#781)"

### (m5) #832: the flag-relevance gate is an ALLOW-list (COMMAND_FLAGS), so the failure
# mode inverted. Under the old deny-list a forgotten entry was silent (that IS #832:
# `doctor --level remote` ran the full health check, exit 0, --level never mentioned);
# under an allow-list a forgotten entry REFUSES a valid invocation. Three static reads of
# src/cli.ts guard both directions — the same "read the source, not a runtime probe"
# reasoning m2 above documents, plus the probe loop in m6 below for the false-refusal side.
# This block also WRITES $TMP/probes.tsv, one probe per non-empty allow-list entry, which
# m6 then executes: the probes are derived from the table itself, so a command or flag
# added later is exercised without touching the smoke test.
node -e "
  const src = require('node:fs').readFileSync('$ROOT/src/cli.ts', 'utf8');
  const setNames = (start) => { const s = src.slice(src.indexOf(start)); return [...s.slice(0, s.indexOf(']);')).matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]); };
  const bools = new Set(setNames('const BOOL_FLAGS'));
  const values = new Set(setNames('const VALUE_FLAGS'));
  const repeatable = [...src.slice(src.indexOf('const REPEATABLE_FLAG_FIELDS')).slice(0, 400).matchAll(/\['([a-z_]+)', '[a-z_]+'\]/g)].map((m) => m[1]);
  const knownFlags = [...repeatable, ...bools, ...values];

  // Split a Record<string, …[]> literal into one body per key, so an entry written on one
  // line and one spread over ten parse the same way (both shapes exist in both tables).
  //
  // Codex review: a text parser's real failure mode is reading LESS than is there and
  // still passing — a key it cannot see is simply not checked, and the orphan check below
  // can stay green because some other command owns the skipped flags. So this refuses any
  // shape it does not fully understand rather than parsing what it can: a spread
  // (\`push: [...COMMON, 'wallet']\`) or a member written in a form \`forbidden\` describes
  // hides members, and a key written in a form the narrow regex misses is caught by
  // counting key-shaped lines and demanding the same number back.
  const bodies = (start, forbidden) => {
    const s = src.slice(src.indexOf(start));
    const text = s.slice(0, s.indexOf('\n};')).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    if (text.includes('...')) { console.error(start + ': contains a spread — this guard cannot see the flags it hides'); process.exit(1); }
    const bad = text.match(forbidden);
    if (bad) { console.error(start + ': ' + JSON.stringify(bad[0]) + ' is a member form this guard cannot read — it would silently skip it'); process.exit(1); }
    const marks = [...text.matchAll(/\n  '?([-A-Za-z][-A-Za-z0-9_ ]*)'?: \[/g)];
    const keyish = [...text.matchAll(/\n  \S[^\n]*?: \[/g)];
    if (marks.length !== keyish.length) { console.error(start + ': ' + (keyish.length - marks.length) + ' entr(ies) are written in a form this guard does not parse'); process.exit(1); }
    return marks.map((m, i) => [m[1], text.slice(m.index + m[0].length, i + 1 < marks.length ? marks[i + 1].index : text.length)]);
  };
  const entries = bodies('const COMMAND_FLAGS', /[\"\`]/).map(([k, b]) => [k, [...b.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1])]);
  if (entries.length === 0) { console.error('no allow-list entries parsed — COMMAND_FLAGS changed shape'); process.exit(1); }
  if (bools.size === 0 || values.size === 0 || repeatable.length !== 4) { console.error('flag sets changed shape — BOOL_FLAGS/VALUE_FLAGS/REPEATABLE_FLAG_FIELDS did not parse'); process.exit(1); }
  const allow = new Map(entries);

  // (a0) every name in the allow-list is a flag the parser actually knows. A typo here
  // would otherwise reach the CLI as an unknown flag, which m6's probe below would not
  // tell apart from a healthy run (Codex review).
  const unreal = [...allow].flatMap(([k, fs]) => fs.filter((f) => !knownFlags.includes(f)).map((f) => k + ' --' + f.replace(/_/g, '-')));
  if (unreal.length) {
    console.error('allow-list names the parser does not recognize as flags (#832): ' + unreal.join(', '));
    process.exit(1);
  }

  // (a) every command the dispatch switch can reach owns an allow-list entry.
  const body = src.slice(src.indexOf('switch (cmd) {'));
  const cases = [...body.matchAll(/^\s*case '([^']+)':/gm)].map((m) => m[1]);
  if (cases.length === 0) { console.error('no case labels found — the dispatch switch changed shape'); process.exit(1); }
  const undeclared = cases.filter((c) => !allow.has(c));
  if (undeclared.length) {
    console.error('commands the dispatch switch can reach with no flag allow-list (#832): ' + undeclared.join(', '));
    console.error('add each to COMMAND_FLAGS in src/cli.ts naming every flag it reads, using [] if it reads none');
    process.exit(1);
  }

  // (b) every flag the PARSER knows is owned by at least one command. An unowned flag is
  // one the CLI accepts and no command can ever use — refused everywhere, silently dead.
  const owned = new Set([].concat(...[...allow.values()]));
  const orphans = knownFlags.filter((f) => !owned.has(f));
  if (orphans.length) {
    console.error('flags the parser accepts that NO command declares reading (#832): ' + orphans.map((f) => '--' + f.replace(/_/g, '-')).join(', '));
    console.error('either add each to the COMMAND_FLAGS entry of the command that reads it, or drop it from BOOL_FLAGS/VALUE_FLAGS');
    process.exit(1);
  }

  // (c) no entry may both allow a flag and deny it — the deny-list only supplies the
  // REASON text now, so a flag in both tables is a contradiction that would never print.
  const denyEntries = bodies('const FLAG_IRRELEVANT', /flag:\s*[^'\s]/).map(([k, b]) => [k, [...b.matchAll(/flag: '([a-z_0-9]+)'/g)].map((m) => m[1])]);
  if (denyEntries.length === 0) { console.error('no declarations parsed — FLAG_IRRELEVANT changed shape'); process.exit(1); }
  const contradictions = [];
  for (const [key, denied] of denyEntries) {
    for (const f of denied) if ((allow.get(key) ?? []).includes(f)) contradictions.push(key + ' --' + f.replace(/_/g, '-'));
  }
  if (contradictions.length) {
    console.error('flags a command both allows and denies (#832): ' + contradictions.join(', '));
    process.exit(1);
  }

  // The probe list m6 runs: every flag of an entry at once, values pointed at paths that
  // do not exist so each command fails its own validation rather than doing work.
  const probes = [];
  for (const [key, flags] of entries) {
    if (flags.length === 0) continue;
    const argv = key.split(' ');
    for (const f of flags) {
      argv.push('--' + f.replace(/_/g, '-'));
      if (!bools.has(f)) argv.push('$TMP/probe-' + f.replace(/_/g, '-'));
    }
    probes.push(argv.join('\t'));
  }
  require('node:fs').writeFileSync('$TMP/probes.tsv', probes.join('\n') + '\n');
  console.log('checked ' + cases.length + ' dispatch cases and ' + knownFlags.length + ' known flags against ' + entries.length + ' allow-list entries (' + probes.length + ' probes)');
" || { echo "[FAIL] the COMMAND_FLAGS allow-list is incomplete or contradicts FLAG_IRRELEVANT (#832)"; exit 1; }
echo "[PASS] every dispatchable command has an allow-list, every known flag is owned, neither table contradicts the other (#832)"

### (m6) the two directions of #832, at run time.
# (m6a) it FIRES: a flag that belongs to another command is refused, naming the owner —
# `doctor --level quick` is the issue's own repro (it ran the full health check, exit 0).
node "$DIST" doctor --level quick > "$TMP/m6-doctor.out" 2> "$TMP/m6-doctor.err"
M6_RC=$?
[ "$M6_RC" = "2" ] \
  || { echo "[FAIL] 'doctor --level quick' exited $M6_RC, expected 2 (a flag belonging to another command must be refused)"; cat "$TMP/m6-doctor.err"; exit 1; }
[ ! -s "$TMP/m6-doctor.out" ] || { echo "[FAIL] doctor --level quick wrote to stdout on the error path"; cat "$TMP/m6-doctor.out"; exit 1; }
grep -Fq -- 'does not read --level' "$TMP/m6-doctor.err" \
  || { echo "[FAIL] 'doctor --level quick' was not refused as unread (#832)"; cat "$TMP/m6-doctor.err"; exit 1; }
grep -Fq -- 'it belongs to verify' "$TMP/m6-doctor.err" \
  || { echo "[FAIL] 'doctor --level quick' did not name the command --level belongs to"; cat "$TMP/m6-doctor.err"; exit 1; }
echo "[PASS] dist doctor --level: refused, exit 2, naming verify as the owner (#832)"

# (m6b) it does NOT over-fire: every command, handed its OWN whole allow-list, must get
# past this check. This is the regression an allow-list invites and a deny-list could not
# have — one forgotten flag and a valid invocation starts failing. The commands still fail
# (their values are paths that do not exist), which is the point: only the refusal
# SENTENCE is asserted against, never the exit code, so each probe can die in the
# command's own validation without doing work. Sub-verb keys are probed as themselves.
SENTINEL='a flag that is silently dropped looks exactly like one that was honored'
PROBE_HOME="$TMP/probe-home"
PROBED=0
while IFS=$'\t' read -r -a PROBE_ARGV; do
  [ "${#PROBE_ARGV[@]}" -gt 0 ] || continue
  CYPHER_BRAIN_HOME="$PROBE_HOME" node "$DIST" "${PROBE_ARGV[@]}" > /dev/null 2> "$TMP/m6-probe.err" < /dev/null
  if grep -Fq -- "$SENTINEL" "$TMP/m6-probe.err"; then
    echo "[FAIL] the allow-list refused a flag its own COMMAND_FLAGS entry declares: ${PROBE_ARGV[*]}"
    cat "$TMP/m6-probe.err"; exit 1
  fi
  # A probe that dies on "unknown flag" never reached the relevance check at all, so the
  # assertion above proved nothing about it (Codex review). (a0) makes this unreachable
  # from a typo'd table; it also catches a flag dropped from BOOL_FLAGS/VALUE_FLAGS.
  if grep -Fq -- 'unknown flag:' "$TMP/m6-probe.err"; then
    echo "[FAIL] an allow-list probe never reached the relevance check — the parser rejected the flag outright: ${PROBE_ARGV[*]}"
    cat "$TMP/m6-probe.err"; exit 1
  fi
  PROBED=$((PROBED + 1))
done < "$TMP/probes.tsv"
[ "$PROBED" -gt 0 ] || { echo "[FAIL] no allow-list probes ran — \$TMP/probes.tsv was empty"; exit 1; }
echo "[PASS] all $PROBED allow-list probes accepted every flag their own command declares (#832)"

echo "CLI SMOKE: PASS"
