#!/usr/bin/env bash
# Proof for #231 — Terraform-style plan/apply: `estimate --out <path.json>` pins an
# estimate to an artifact/backend/payer, and `push --plan <path.json>` re-validates it
# against the CURRENT state before proceeding. CI-safe: the arweave price query is a
# local mock HTTP server (same PATH-shim-free style as the ton-provider mock — a real
# gateway/URL substitution via CYPHER_BRAIN_AR_HOST/_PORT/_PROTOCOL, so the REAL
# estimate.ts/plan.ts code runs its real fetch, just against a server this script
# controls). The file backend (free, no network) covers the artifact/backend/expiry/
# malformed-plan checks; the mocked arweave backend covers price drift and payer
# binding, which need a real (mocked) priced query and a real (throwaway) JWK wallet.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
source "$ROOT/scripts/selftest-lib.sh" # cb()/sha(), see scripts/selftest-lib.sh (#572)

TMP="$(mktemp -d)"
MOCK_PID=""
cleanup() {
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

export CYPHER_BRAIN_HOME="$TMP/home"
mkdir -p "$CYPHER_BRAIN_HOME" "$TMP/src" "$TMP/store"

echo "hello plan/apply" > "$TMP/src/hello.txt"
cb keygen >/dev/null
cb snapshot --dir "$TMP/src" --out "$TMP/snap.age" >/dev/null 2>&1

# ---------------------------------------------------------------------------
# Part 1: file backend (free, no network) — artifact/backend/expiry/malformed checks
# ---------------------------------------------------------------------------

CYPHER_BRAIN_FILE_DIR="$TMP/store" cb estimate --in "$TMP/snap.age" --backend file --out "$TMP/plan.json" >"$TMP/estimate.out" 2>"$TMP/estimate.err"
grep -q '"cypher_brain_plan_version": 1' "$TMP/plan.json" || { echo "[FAIL] plan.json missing/wrong version field"; exit 1; }
grep -q "\"artifact_sha256\": \"$(sha "$TMP/snap.age")\"" "$TMP/plan.json" || { echo "[FAIL] plan.json artifact_sha256 does not match --in"; exit 1; }
grep -q '"backend": "file"' "$TMP/plan.json" || { echo "[FAIL] plan.json backend field wrong"; exit 1; }
grep -q "plan saved -> $TMP/plan.json" "$TMP/estimate.err" || { echo "[FAIL] estimate --out did not report where it saved the plan"; exit 1; }
echo "[PASS] estimate --out writes a plan.json with the expected shape"

# positive control (#470): a second "estimate --out" at the SAME path must refuse
# (same no-clobber posture as "snapshot --out", CB-E009) instead of silently
# discarding the prior plan. Uses a throwaway path so $TMP/plan.json (relied on by
# every test below) is never touched by this block.
CYPHER_BRAIN_FILE_DIR="$TMP/store" cb estimate --in "$TMP/snap.age" --backend file --out "$TMP/clobber-plan.json" >/dev/null 2>&1
BEFORE_HASH="$(sha "$TMP/clobber-plan.json")"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb estimate --in "$TMP/snap.age" --backend file --out "$TMP/clobber-plan.json" >"$TMP/clobber.out" 2>"$TMP/clobber.err"; then
  echo "[FAIL] estimate --out silently overwrote an existing plan file (#470 regression)"; exit 1
fi
grep -q "already exists — refusing to overwrite" "$TMP/clobber.err" || { echo "[FAIL] wrong no-clobber message"; cat "$TMP/clobber.err"; exit 1; }
[ "$(sha "$TMP/clobber-plan.json")" = "$BEFORE_HASH" ] || { echo "[FAIL] plan file content changed despite the refusal"; exit 1; }
echo "[PASS] estimate --out refuses to clobber an existing plan file without --force (#470)"

# --force overwrites anyway (the same escape hatch push/pull/wallet create use for
# this exact refusal) — the file's content actually changes (a fresh created_at).
sleep 1.1
CYPHER_BRAIN_FILE_DIR="$TMP/store" cb estimate --in "$TMP/snap.age" --backend file --out "$TMP/clobber-plan.json" --force >"$TMP/clobber-force.out" 2>"$TMP/clobber-force.err"
[ "$(sha "$TMP/clobber-plan.json")" != "$BEFORE_HASH" ] || { echo "[FAIL] --force did not actually rewrite the plan file"; exit 1; }
echo "[PASS] estimate --out --force overwrites an existing plan file"

CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan.json" >"$TMP/push.out" 2>"$TMP/push.err"
grep -q "validated" "$TMP/push.err" || { echo "[FAIL] push --plan did not report validation"; cat "$TMP/push.err"; exit 1; }
[ -s "$TMP/push.out" ] || { echo "[FAIL] push --plan produced no locator on stdout"; exit 1; }
echo "[PASS] push --plan happy path: validates and proceeds to a normal (free) push"

# positive control: a DIFFERENT artifact than the plan was built for is refused
echo "different content entirely" > "$TMP/src/hello2.txt"
CYPHER_BRAIN_FILE_DIR="$TMP/store" cb snapshot --dir "$TMP/src" --out "$TMP/snap3.age" >/dev/null 2>&1
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap3.age" --backend file --plan "$TMP/plan.json" >"$TMP/mismatch.out" 2>"$TMP/mismatch.err"; then
  echo "[FAIL] push --plan accepted a plan built for a DIFFERENT artifact"; exit 1
fi
grep -q "different artifact" "$TMP/mismatch.err" || { echo "[FAIL] wrong artifact-mismatch message"; cat "$TMP/mismatch.err"; exit 1; }
echo "[PASS] artifact-mismatch guard fired"

# positive control: backend mismatch (plan says file, push targets a different backend)
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend rclone --remote ":local:$TMP/store2" --plan "$TMP/plan.json" >"$TMP/backend-mismatch.out" 2>"$TMP/backend-mismatch.err"; then
  echo "[FAIL] push --plan accepted a plan built for a DIFFERENT backend"; exit 1
fi
grep -q 'is for backend "file"' "$TMP/backend-mismatch.err" || { echo "[FAIL] wrong backend-mismatch message"; cat "$TMP/backend-mismatch.err"; exit 1; }
echo "[PASS] backend-mismatch guard fired"

# positive control: expired plan (created_at/expires_at kept internally CONSISTENT —
# both pushed into the past by the same 15-minute TTL — so this exercises the expiry
# check specifically, not the tamper-consistency check below)
python3 -c "
import json
from datetime import datetime, timedelta, timezone
p = json.load(open('$TMP/plan.json'))
created = datetime(2020, 1, 1, tzinfo=timezone.utc)
p['created_at'] = created.strftime('%Y-%m-%dT%H:%M:%S.') + f'{created.microsecond // 1000:03d}Z'
expires = created + timedelta(milliseconds=900000)
p['expires_at'] = expires.strftime('%Y-%m-%dT%H:%M:%S.') + f'{expires.microsecond // 1000:03d}Z'
json.dump(p, open('$TMP/plan-expired.json', 'w'))
"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan-expired.json" >"$TMP/expired.out" 2>"$TMP/expired.err"; then
  echo "[FAIL] push --plan accepted an expired plan"; exit 1
fi
grep -q "plan expired at" "$TMP/expired.err" || { echo "[FAIL] wrong expired-plan message"; cat "$TMP/expired.err"; exit 1; }
echo "[PASS] expired-plan guard fired"

# positive control: tampered plan — ONLY expires_at bumped, created_at left alone, so
# the created_at+TTL relationship no longer holds (a naive attempt to extend a plan's
# deadline without regenerating it). Refused as malformed, distinct from the ordinary
# expiry check above.
python3 -c "
import json
p = json.load(open('$TMP/plan.json'))
p['expires_at'] = '2099-01-01T00:00:00.000Z'
json.dump(p, open('$TMP/plan-tampered.json', 'w'))
"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan-tampered.json" >"$TMP/tampered.out" 2>"$TMP/tampered.err"; then
  echo "[FAIL] push --plan accepted a plan with expires_at extended independently of created_at"; exit 1
fi
grep -q "created_at/expires_at are inconsistent" "$TMP/tampered.err" || { echo "[FAIL] wrong tampered-expiry message"; cat "$TMP/tampered.err"; exit 1; }
echo "[PASS] tampered-expiry guard fired"

# positive control: a plan with a non-numeric cost string (hand-edited or malformed) is
# refused cleanly instead of crashing on BigInt() parsing it
python3 -c "
import json
p = json.load(open('$TMP/plan.json'))
p['estimate']['cost'] = '12abc'
json.dump(p, open('$TMP/plan-bad-cost.json', 'w'))
"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan-bad-cost.json" >"$TMP/badcost.out" 2>"$TMP/badcost.err"; then
  echo "[FAIL] push --plan accepted a plan with a non-numeric cost"; exit 1
fi
grep -q "not a plain non-negative integer" "$TMP/badcost.err" || { echo "[FAIL] wrong bad-cost message (or a crash)"; cat "$TMP/badcost.err"; exit 1; }
echo "[PASS] malformed-cost guard fired (refused cleanly, did not crash)"

# positive control: malformed plan JSON
echo "not json" > "$TMP/bad-plan.json"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/bad-plan.json" >"$TMP/badjson.out" 2>"$TMP/badjson.err"; then
  echo "[FAIL] push --plan accepted malformed JSON"; exit 1
fi
grep -q "not valid JSON" "$TMP/badjson.err" || { echo "[FAIL] wrong malformed-JSON message"; cat "$TMP/badjson.err"; exit 1; }
echo "[PASS] malformed-plan-JSON guard fired"

# positive control: a plan missing required fields (right shape of JSON, wrong content)
echo '{"cypher_brain_plan_version": 1, "backend": "file"}' > "$TMP/incomplete-plan.json"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/incomplete-plan.json" >"$TMP/incomplete.out" 2>"$TMP/incomplete.err"; then
  echo "[FAIL] push --plan accepted a plan missing required fields"; exit 1
fi
grep -q "does not look like a cypher-brain plan file" "$TMP/incomplete.err" || { echo "[FAIL] wrong incomplete-plan message"; cat "$TMP/incomplete.err"; exit 1; }
echo "[PASS] incomplete-plan-shape guard fired"

# positive control (#471): an otherwise-VALID plan whose cypher_brain_plan_version is a
# future/different number gets its own specific message, distinct from the generic
# "does not look like a plan file" one above.
python3 -c "
import json
p = json.load(open('$TMP/plan.json'))
p['cypher_brain_plan_version'] = 2
json.dump(p, open('$TMP/plan-future-version.json', 'w'))
"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan-future-version.json" >"$TMP/futurever.out" 2>"$TMP/futurever.err"; then
  echo "[FAIL] push --plan accepted a plan with an unsupported version"; exit 1
fi
grep -q "unsupported plan version 2 (expected 1)" "$TMP/futurever.err" || { echo "[FAIL] wrong plan-version message"; cat "$TMP/futurever.err"; exit 1; }
if grep -q "does not look like a cypher-brain plan file" "$TMP/futurever.err"; then
  echo "[FAIL] version-mismatch case fell through to the generic malformed-plan message"; cat "$TMP/futurever.err"; exit 1
fi
echo "[PASS] unsupported-plan-version guard fired with its own specific message (#471)"

# positive control (#469): recipients_fingerprint is recorded in every plan.json but
# was NEVER read back by validatePlan() — a hand-edited value went completely
# unchecked. This is the exact repro from the issue: everything else in the plan is
# untouched/valid, only recipients_fingerprint is tampered.
python3 -c "
import json
p = json.load(open('$TMP/plan.json'))
p['recipients_fingerprint'] = 'deadbeef' * 8
json.dump(p, open('$TMP/plan-bad-fingerprint.json', 'w'))
"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan-bad-fingerprint.json" >"$TMP/badfp.out" 2>"$TMP/badfp.err"; then
  echo "[FAIL] push --plan accepted a plan with a tampered recipients_fingerprint (#469 regression)"; exit 1
fi
grep -q "plan was built for recipients fingerprint" "$TMP/badfp.err" || { echo "[FAIL] wrong recipients-fingerprint-mismatch message"; cat "$TMP/badfp.err"; exit 1; }
echo "[PASS] tampered-recipients-fingerprint guard fired (#469 — previously silently accepted)"

# positive control (#469): recipients_fingerprint null -> non-null crossing, the same
# asymmetric-null shape already covered for payer_address above.
python3 -c "
import json
p = json.load(open('$TMP/plan.json'))
p['recipients_fingerprint'] = None
json.dump(p, open('$TMP/plan-null-fingerprint.json', 'w'))
"
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/plan-null-fingerprint.json" >"$TMP/nullfp.out" 2>"$TMP/nullfp.err"; then
  echo "[FAIL] push --plan accepted a plan with no recipients fingerprint against a current sidecar that has one"; exit 1
fi
grep -q "plan was built with no recipients fingerprint recorded" "$TMP/nullfp.err" || { echo "[FAIL] wrong null-fingerprint-crossing message"; cat "$TMP/nullfp.err"; exit 1; }
echo "[PASS] recipients-fingerprint null->value crossing guard fired (#469)"

# positive control: nonexistent plan file
if CYPHER_BRAIN_FILE_DIR="$TMP/store" cb push --in "$TMP/snap.age" --backend file --plan "$TMP/no-such-plan.json" >"$TMP/noexist.out" 2>"$TMP/noexist.err"; then
  echo "[FAIL] push --plan accepted a nonexistent plan path"; exit 1
fi
grep -q "cannot read plan file" "$TMP/noexist.err" || { echo "[FAIL] wrong missing-plan-file message"; cat "$TMP/noexist.err"; exit 1; }
echo "[PASS] missing-plan-file guard fired"

# ---------------------------------------------------------------------------
# Part 2: mocked arweave backend — price drift + payer-address binding
# ---------------------------------------------------------------------------

PRICE_FILE="$TMP/mock-price.txt"
echo "1000000000000" > "$PRICE_FILE" # 1e12 winston, arbitrary baseline

cat > "$TMP/mock-arweave.mjs" <<MOCKEOF
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const priceFile = process.env.PRICE_FILE;
const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/price/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(readFileSync(priceFile, 'utf8').trim());
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(Number(process.env.MOCK_PORT), '127.0.0.1', () => {
  process.stdout.write('READY\n');
});
MOCKEOF

# Ephemeral port (same idiom as selftest-ton.sh/selftest-ton-dns.sh/selftest-ton-provider.sh's
# mock daemons, #575) — a hardcoded port collides with another process/stale daemon/
# parallel CI shard and turns into flakiness instead of a real failure.
MOCK_PORT=$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
PRICE_FILE="$PRICE_FILE" MOCK_PORT="$MOCK_PORT" node "$TMP/mock-arweave.mjs" >"$TMP/mock.log" 2>&1 &
MOCK_PID=$!
READY=0
for _ in $(seq 1 50); do
  grep -q READY "$TMP/mock.log" 2>/dev/null && { READY=1; break; }
  sleep 0.1
done
[ "$READY" = 1 ] || { echo "[FAIL] mock arweave price server did not come up"; cat "$TMP/mock.log"; exit 1; }

export CYPHER_BRAIN_AR_HOST=127.0.0.1
export CYPHER_BRAIN_AR_PORT="$MOCK_PORT"
export CYPHER_BRAIN_AR_PROTOCOL=http

cb wallet create --chain arweave --out "$TMP/wallet-a.json" >/dev/null 2>&1
cb wallet create --chain arweave --out "$TMP/wallet-b.json" >/dev/null 2>&1
WALLET_A_ADDR=$(cb wallet address --wallet "$TMP/wallet-a.json")

export CYPHER_BRAIN_AR_WALLET="$TMP/wallet-a.json"
cb estimate --in "$TMP/snap.age" --backend arweave --out "$TMP/ar-plan.json" >"$TMP/ar-estimate.out" 2>"$TMP/ar-estimate.err"
grep -q "\"payer_address\": \"$WALLET_A_ADDR\"" "$TMP/ar-plan.json" || {
  echo "[FAIL] plan.json did not record the configured wallet's payer_address"; cat "$TMP/ar-plan.json"; exit 1
}
echo "[PASS] estimate --out records payer_address from the configured wallet"

# positive control: price within tolerance (+5%) — plan validates, push still stops at
# the ordinary --yes consent gate (proves plan validation ran and passed FIRST)
echo "1050000000000" > "$PRICE_FILE"
if cb push --in "$TMP/snap.age" --backend arweave --plan "$TMP/ar-plan.json" >"$TMP/drift-ok.out" 2>"$TMP/drift-ok.err"; then
  echo "[FAIL] push without --yes unexpectedly succeeded"; exit 1
fi
grep -q "validated" "$TMP/drift-ok.err" || { echo "[FAIL] 5% drift: plan was not validated before the consent gate"; cat "$TMP/drift-ok.err"; exit 1; }
grep -q "spends real funds" "$TMP/drift-ok.err" || { echo "[FAIL] 5% drift: did not reach the normal --yes consent gate"; cat "$TMP/drift-ok.err"; exit 1; }
echo "[PASS] price drift within the 10% tolerance still validates (refused only by the separate --yes gate)"

# positive control: price drift beyond tolerance (+50%) — refused for drift, BEFORE
# the --yes gate (no 'spends real funds' text should appear)
echo "1500000000000" > "$PRICE_FILE"
if cb push --in "$TMP/snap.age" --backend arweave --plan "$TMP/ar-plan.json" >"$TMP/drift-bad.out" 2>"$TMP/drift-bad.err"; then
  echo "[FAIL] push with 50% price drift unexpectedly succeeded"; exit 1
fi
grep -q "price drifted" "$TMP/drift-bad.err" || { echo "[FAIL] 50% drift was not refused for drift"; cat "$TMP/drift-bad.err"; exit 1; }
grep -q "spends real funds" "$TMP/drift-bad.err" && { echo "[FAIL] 50% drift reached the --yes gate — should have refused earlier"; exit 1; }
echo "[PASS] price drift beyond the 10% tolerance is refused before the consent gate"

# positive control: payer swap — same artifact/backend/price, different configured wallet
echo "1000000000000" > "$PRICE_FILE"
export CYPHER_BRAIN_AR_WALLET="$TMP/wallet-b.json"
if cb push --in "$TMP/snap.age" --backend arweave --plan "$TMP/ar-plan.json" >"$TMP/payer-swap.out" 2>"$TMP/payer-swap.err"; then
  echo "[FAIL] push with a swapped payer wallet unexpectedly succeeded"; exit 1
fi
grep -q "was built for payer" "$TMP/payer-swap.err" || { echo "[FAIL] wrong payer-swap message"; cat "$TMP/payer-swap.err"; exit 1; }
echo "[PASS] payer-address-swap guard fired"

# positive control: same payer wallet — no payer refusal, proceeds to the --yes gate
export CYPHER_BRAIN_AR_WALLET="$TMP/wallet-a.json"
if cb push --in "$TMP/snap.age" --backend arweave --plan "$TMP/ar-plan.json" >"$TMP/payer-same.out" 2>"$TMP/payer-same.err"; then
  echo "[FAIL] push without --yes unexpectedly succeeded"; exit 1
fi
grep -q "was built for payer" "$TMP/payer-same.err" && { echo "[FAIL] same payer wallet wrongly triggered the payer-swap guard"; exit 1; }
grep -q "spends real funds" "$TMP/payer-same.err" || { echo "[FAIL] unexpected refusal reason for the matching-payer case"; cat "$TMP/payer-same.err"; exit 1; }
echo "[PASS] matching payer wallet does not trigger the payer guard"

# positive control: payer null -> non-null crossing — plan built with NO wallet
# configured (planning before funding one), then pushed with a wallet NOW configured.
# The original logic only compared when BOTH sides were non-null, so this crossing
# silently passed with zero scrutiny (Codex review finding — a real bypass, fixed).
unset CYPHER_BRAIN_AR_WALLET
cb estimate --in "$TMP/snap.age" --backend arweave --out "$TMP/ar-plan-nopayer.json" >"$TMP/ar-estimate-nopayer.out" 2>"$TMP/ar-estimate-nopayer.err"
grep -q '"payer_address": null' "$TMP/ar-plan-nopayer.json" || {
  echo "[FAIL] plan built with no wallet configured should record payer_address: null"; cat "$TMP/ar-plan-nopayer.json"; exit 1
}
export CYPHER_BRAIN_AR_WALLET="$TMP/wallet-a.json"
if cb push --in "$TMP/snap.age" --backend arweave --plan "$TMP/ar-plan-nopayer.json" >"$TMP/payer-null-to-addr.out" 2>"$TMP/payer-null-to-addr.err"; then
  echo "[FAIL] push accepted a plan with no payer against a NOW-configured wallet"; exit 1
fi
grep -q "plan was built with no payer configured" "$TMP/payer-null-to-addr.err" || {
  echo "[FAIL] wrong payer null->address message"; cat "$TMP/payer-null-to-addr.err"; exit 1
}
echo "[PASS] payer null->address crossing guard fired"

# positive control: payer non-null -> null crossing — the reverse direction. Plan built
# WITH a wallet configured, pushed with none configured.
unset CYPHER_BRAIN_AR_WALLET
if cb push --in "$TMP/snap.age" --backend arweave --plan "$TMP/ar-plan.json" >"$TMP/payer-addr-to-null.out" 2>"$TMP/payer-addr-to-null.err"; then
  echo "[FAIL] push accepted a plan with a payer against a NOW-unconfigured wallet"; exit 1
fi
grep -q "current push has no payer configured" "$TMP/payer-addr-to-null.err" || {
  echo "[FAIL] wrong payer address->null message"; cat "$TMP/payer-addr-to-null.err"; exit 1
}
echo "[PASS] payer address->null crossing guard fired"
export CYPHER_BRAIN_AR_WALLET="$TMP/wallet-a.json"

# positive control: --remote pinning (rclone) — only the backend NAME was pinned
# before this fix, so a plan validated for one rclone destination could silently apply
# against a completely different one (Codex review finding, fixed).
mkdir -p "$TMP/remote-a" "$TMP/remote-b"
cb estimate --in "$TMP/snap.age" --backend rclone --remote ":local:$TMP/remote-a" --out "$TMP/rclone-plan.json" >"$TMP/rclone-estimate.out" 2>"$TMP/rclone-estimate.err"
grep -q "\"remote\": \":local:$TMP/remote-a\"" "$TMP/rclone-plan.json" || {
  echo "[FAIL] plan.json did not record --remote"; cat "$TMP/rclone-plan.json"; exit 1
}
if cb push --in "$TMP/snap.age" --backend rclone --remote ":local:$TMP/remote-b" --plan "$TMP/rclone-plan.json" >"$TMP/remote-mismatch.out" 2>"$TMP/remote-mismatch.err"; then
  echo "[FAIL] push --plan accepted a plan built for a DIFFERENT --remote"; exit 1
fi
grep -q "plan was built for --remote" "$TMP/remote-mismatch.err" || { echo "[FAIL] wrong remote-mismatch message"; cat "$TMP/remote-mismatch.err"; exit 1; }
echo "[PASS] remote-mismatch guard fired"

# positive control: #468 — `estimate --out` with --backend rclone but NO --remote must
# refuse up front (a plan with remote: null can never validate against push --plan,
# which always has a real --remote for that backend), rather than silently writing a
# dead-end plan.json.
if cb estimate --in "$TMP/snap.age" --backend rclone --out "$TMP/rclone-no-remote-plan.json" >"$TMP/rclone-no-remote.out" 2>"$TMP/rclone-no-remote.err"; then
  echo "[FAIL] estimate --out --backend rclone without --remote unexpectedly succeeded"; exit 1
fi
grep -q -- "--remote <name>:<path> required" "$TMP/rclone-no-remote.err" || {
  echo "[FAIL] wrong missing-remote message"; cat "$TMP/rclone-no-remote.err"; exit 1
}
[ -e "$TMP/rclone-no-remote-plan.json" ] && { echo "[FAIL] a plan.json was written despite the refusal"; exit 1; }
echo "[PASS] estimate --out --backend rclone without --remote refuses cleanly (#468)"

echo "== plan/apply selftest: ALL PASS =="
