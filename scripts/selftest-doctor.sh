#!/usr/bin/env bash
# Selftest for `cypher-brain doctor` (#201): the read-only environment health check.
#
# Covers, in order:
#   (a) a not-yet-set-up CYPHER_BRAIN_HOME: every check SKIPs, health_score 100, PASS.
#   (b) a freshly keygen'd home: home-dir-perms / identity-perms / identity-recipient-
#       pairing all PASS.
#   (c) a loose (group/other-accessible) identity.age is a NEW FAIL with a `chmod 600`
#       remediation, and the process exit code is 1.
#   (d) running doctor AGAIN with the SAME unfixed problem marks it "known" (carryover),
#       not 🆕 new — and health_score for the carryover run is HIGHER than the first
#       run's (the known-issue discount), while VERDICT stays FAIL and health_score
#       stays below 100 (the discount must never look like a full pass — the specific
#       regression this test exists to catch: an earlier draft of the scoring excluded
#       carryover issues ENTIRELY, so a single unfixed FAIL still read 100/100 next to
#       VERDICT: FAIL).
#   (e) fixing the permission is reported as [RESOLVED] on the next run, back to PASS.
#   (f) CYPHER_BRAIN_PIN_RECIPIENTS="" is a FAIL (matches snapshot()'s own #101
#       fail-closed behavior) with a remediation naming the variable.
#   (g) an identity/recipient pairing mismatch (recipient.txt replaced independently) is
#       a FAIL naming both paths.
#   (h) --json prints exactly one JSON document with the documented shape, and it agrees
#       with the human-readable report's verdict.
#   (i) the doctor-state.json bookkeeping file itself never holds key material.
#   (j) an EXTRA recipient injected into recipient.txt (alongside the real one) is a
#       FAIL on both identity-recipient-pairing and pin-recipients-primary-included,
#       not a silent PASS on either (a partial-match check used to let it ride along).
#   (k) a corrupted identity.age (bad bech32 checksum) FAILs without ever printing the
#       underlying library error or raw key material — that error embeds the FULL
#       (corrupt) identity string.
#   (l) a symlink pre-planted at doctor-state.json is REPLACED by an atomic rename, not
#       followed and truncated — its original target is left untouched.
#   (m) an explicitly-configured but missing CYPHER_BRAIN_AR_WALLET is a FAIL, not the
#       same SKIP an unconfigured wallet gets.
#   (o) audit-chain-integrity / receipt-ledger-readability (#456): SKIP on a machine that
#       has never run push/restore/verify or a paid push — no false WARN/FAIL for a
#       normal, not-yet-used state.
#   (p) a well-formed audit log entry / receipt ledger line: both checks PASS.
#   (q) POSITIVE CONTROL — a hand-corrupted audit log entry (content changed, hash not
#       recomputed, breaking the chain) is a FAIL naming the broken index, and doctor's
#       overall VERDICT is FAIL (exit 1) — the exact false-100/100 gap #456 was filed for.
#   (r) POSITIVE CONTROL — an unreadable line appended to the receipt ledger is a WARN
#       (not a FAIL — a data-quality issue, not a broken security boundary), and
#       doctor's overall VERDICT is PARTIAL (exit 2), never a silent PASS. Checked in
#       BOTH plain and --json output (#493: the --json half of this exact PARTIAL
#       fixture was previously unchecked — (h) below only exercises --json's general
#       shape against whatever verdict is ambient at that point in the script, never
#       specifically forcing PARTIAL — so a regression only visible in --json's
#       verdict/exit-code pairing could have shipped unnoticed).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cypher-brain.mjs"
source "$ROOT/scripts/dev-node-flags.sh"
TMP="$(mktemp -d)"
trap 'chmod -R u+rwX "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

# Start from a clean CYPHER_BRAIN_* environment (same reasoning as selftest-schedule.sh:
# a PIN_RECIPIENTS/AR_WALLET/etc. left over in whoever-runs-this's own shell would leak
# into every case below).
for _leaked in $(env | sed -n 's/^\(CYPHER_BRAIN_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$_leaked"; done
unset _leaked

# #542: the gbrain-engine-detection check reads $HOME/.gbrain/config.json directly (it
# is not scoped to CYPHER_BRAIN_HOME like every other check here) — export a default,
# empty HOME so the bulk of this file never touches whoever-runs-this's REAL ~/.gbrain.
# Cases that specifically exercise gbrain-engine-detection override HOME per-case below.
export HOME="$TMP/default-home"; mkdir -p "$HOME"

cb() { node "${BIN_DEV_ARGS[@]}" "$BIN" "$@"; }

echo "== (a) a not-yet-set-up home: every check SKIPs, health_score 100, PASS, exit 0 =="
export CYPHER_BRAIN_HOME="$TMP/fresh-home"
[ ! -e "$CYPHER_BRAIN_HOME" ] || { echo "[FAIL] test setup: $CYPHER_BRAIN_HOME already exists"; exit 1; }
RC=0
cb doctor > "$TMP/a.log" 2>&1 || RC=$?
[ "$RC" = "0" ] || { echo "[FAIL] doctor on a not-yet-set-up home exited $RC, expected 0"; cat "$TMP/a.log"; exit 1; }
grep -q '^health_score: 100/100 (no issues found)$' "$TMP/a.log" \
  || { echo "[FAIL] expected health_score 100/100 (no issues found)"; cat "$TMP/a.log"; exit 1; }
grep -q '^VERDICT: PASS$' "$TMP/a.log" || { echo "[FAIL] expected VERDICT: PASS"; cat "$TMP/a.log"; exit 1; }
[ ! -e "$CYPHER_BRAIN_HOME" ] \
  || { echo "[FAIL] doctor CREATED $CYPHER_BRAIN_HOME — it must stay read-only when nothing is set up yet"; exit 1; }
echo "[PASS] not-yet-set-up home: all SKIP, health_score 100/100, VERDICT PASS, no side effect"

echo "== (b) after keygen: home-dir-perms / identity-perms / identity-recipient-pairing all PASS =="
export CYPHER_BRAIN_HOME="$TMP/home"
cb keygen > "$TMP/keygen.log" 2>&1 || { echo "[FAIL] keygen exited non-zero"; cat "$TMP/keygen.log"; exit 1; }
cb doctor --json > "$TMP/b.json" 2>&1 || { echo "[FAIL] doctor --json exited non-zero after keygen"; cat "$TMP/b.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const byId = Object.fromEntries(j.checks.map((c) => [c.id, c]));
for (const id of ['home-dir-perms', 'identity-perms', 'identity-recipient-pairing']) {
  if (!byId[id] || byId[id].status !== 'pass') {
    throw new Error(id + ' expected status pass, got ' + JSON.stringify(byId[id]));
  }
}
if (j.verdict !== 'PASS') throw new Error('expected verdict PASS, got ' + j.verdict);
if (j.health_score !== 100) throw new Error('expected health_score 100, got ' + j.health_score);
" "$TMP/b.json"
echo "[PASS] freshly keygen'd home: home-dir-perms/identity-perms/identity-recipient-pairing PASS"

echo "== (c) a loose identity.age is a NEW FAIL with a chmod 600 remediation, exit 1 =="
chmod 644 "$CYPHER_BRAIN_HOME/identity.age"
RC=0
cb doctor > "$TMP/c.log" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] doctor with a loose identity.age exited $RC, expected 1"; cat "$TMP/c.log"; exit 1; }
grep -E '^\[FAIL\] .+ new .*identity \(private key\) at .*identity\.age is group/other-accessible \(mode 644\)' "$TMP/c.log" \
  || { echo "[FAIL] expected a NEW FAIL line for the loose identity.age"; cat "$TMP/c.log"; exit 1; }
grep -qF "remediation: chmod 600 $CYPHER_BRAIN_HOME/identity.age" "$TMP/c.log" \
  || { echo "[FAIL] expected the exact chmod 600 remediation command"; cat "$TMP/c.log"; exit 1; }
FIRST_SCORE="$(sed -n 's/^health_score: \([0-9]*\)\/100.*/\1/p' "$TMP/c.log")"
[ "$FIRST_SCORE" -lt 100 ] || { echo "[FAIL] health_score did not drop below 100 for a new FAIL (got $FIRST_SCORE)"; exit 1; }
echo "[PASS] loose identity.age: NEW FAIL, exact chmod remediation, exit 1, health_score $FIRST_SCORE/100"

echo "== (d) the SAME unfixed problem on the next run is 'known' (carryover), not new; VERDICT stays FAIL and health_score stays below 100 =="
RC=0
cb doctor > "$TMP/d.log" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] second doctor run (still unfixed) exited $RC, expected 1"; cat "$TMP/d.log"; exit 1; }
grep -E '^\[FAIL\] \(known since [0-9]{4}-[0-9]{2}-[0-9]{2}\) .*identity \(private key\)' "$TMP/d.log" \
  || { echo "[FAIL] expected the SAME unfixed FAIL to be marked '(known since ...)', not 🆕 new"; cat "$TMP/d.log"; exit 1; }
if grep -qF 'new age identity' "$TMP/d.log"; then
  echo "[FAIL] the already-seen identity.age FAIL was marked new again — carryover tracking is not working"; cat "$TMP/d.log"; exit 1
fi
SECOND_SCORE="$(sed -n 's/^health_score: \([0-9]*\)\/100.*/\1/p' "$TMP/d.log")"
grep -q '^VERDICT: FAIL$' "$TMP/d.log" || { echo "[FAIL] expected VERDICT: FAIL to persist while the problem is unfixed"; cat "$TMP/d.log"; exit 1; }
[ "$SECOND_SCORE" -lt 100 ] \
  || { echo "[FAIL] a lingering, known FAIL must still pull health_score below 100 (regression: a full score/verdict mismatch), got $SECOND_SCORE/100"; exit 1; }
[ "$SECOND_SCORE" -gt "$FIRST_SCORE" ] \
  || { echo "[FAIL] a known/carryover FAIL should cost LESS than a brand-new one (first=$FIRST_SCORE, second=$SECOND_SCORE)"; exit 1; }
echo "[PASS] carryover: marked known (not new), VERDICT FAIL persists, health_score $SECOND_SCORE/100 (discounted, still < 100)"

echo "== (e) fixing the permission is reported [RESOLVED] on the next run, back to PASS =="
chmod 600 "$CYPHER_BRAIN_HOME/identity.age"
RC=0
cb doctor > "$TMP/e.log" 2>&1 || RC=$?
[ "$RC" = "0" ] || { echo "[FAIL] doctor after fixing the permission exited $RC, expected 0"; cat "$TMP/e.log"; exit 1; }
grep -qF '[RESOLVED] identity-perms:' "$TMP/e.log" \
  || { echo "[FAIL] expected identity-perms to be reported [RESOLVED]"; cat "$TMP/e.log"; exit 1; }
grep -q '^VERDICT: PASS$' "$TMP/e.log" || { echo "[FAIL] expected VERDICT: PASS once the permission is fixed"; cat "$TMP/e.log"; exit 1; }
echo "[PASS] fixed permission: [RESOLVED] reported, back to VERDICT PASS"

echo "== (f) CYPHER_BRAIN_PIN_RECIPIENTS=\"\" is a FAIL naming the fix (#101 fail-closed behavior) =="
RC=0
CYPHER_BRAIN_PIN_RECIPIENTS="" cb doctor > "$TMP/f.log" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] doctor with an empty PIN_RECIPIENTS exited $RC, expected 1"; cat "$TMP/f.log"; exit 1; }
grep -qF 'CYPHER_BRAIN_PIN_RECIPIENTS is set but EMPTY' "$TMP/f.log" \
  || { echo "[FAIL] expected the empty-pin FAIL message"; cat "$TMP/f.log"; exit 1; }
grep -qF 'remediation: unset CYPHER_BRAIN_PIN_RECIPIENTS' "$TMP/f.log" \
  || { echo "[FAIL] expected a remediation naming CYPHER_BRAIN_PIN_RECIPIENTS"; cat "$TMP/f.log"; exit 1; }
echo "[PASS] empty CYPHER_BRAIN_PIN_RECIPIENTS: FAIL with the unset remediation"

echo "== (g) an identity/recipient pairing mismatch is a FAIL naming both files =="
cp "$CYPHER_BRAIN_HOME/recipient.txt" "$TMP/recipient.txt.bak"
# A syntactically valid but UNRELATED age1 recipient (68 bech32 chars after 'age1',
# matching AGE_PUBKEY_RE) — recipientEntries()/identityToRecipient() only care about
# shape, not that it maps to a real keypair, since this check never encrypts anything.
printf 'age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq5s0kwc\n' > "$CYPHER_BRAIN_HOME/recipient.txt"
RC=0
cb doctor > "$TMP/g.log" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] doctor with a mismatched recipient.txt exited $RC, expected 1"; cat "$TMP/g.log"; exit 1; }
grep -E "does not match $CYPHER_BRAIN_HOME/recipient\.txt" "$TMP/g.log" \
  || { echo "[FAIL] expected the identity/recipient pairing mismatch FAIL"; cat "$TMP/g.log"; exit 1; }
cp "$TMP/recipient.txt.bak" "$CYPHER_BRAIN_HOME/recipient.txt"
echo "[PASS] identity/recipient mismatch: FAIL naming both paths"

echo "== (h) --json: exactly one JSON document, shape matches the human-readable report =="
JOUT="$(cb doctor --json)"
LINES=$(printf '%s\n' "$JOUT" | wc -l | tr -d ' ')
[ "$LINES" = "1" ] || { echo "[FAIL] doctor --json printed $LINES stdout line(s), expected exactly 1"; echo "$JOUT"; exit 1; }
node -e "
const j = JSON.parse(process.argv[1]);
for (const key of ['checks', 'resolved', 'health_score', 'new_count', 'carryover_count', 'verdict', 'state_path', 'state_saved']) {
  if (!(key in j)) throw new Error('missing top-level key: ' + key);
}
if (!Array.isArray(j.checks) || j.checks.length === 0) throw new Error('expected a non-empty checks array');
for (const c of j.checks) {
  for (const key of ['id', 'status', 'message', 'marker']) {
    if (!(key in c)) throw new Error('check ' + JSON.stringify(c) + ' missing key: ' + key);
  }
  if (!['pass', 'warn', 'fail', 'skip'].includes(c.status)) throw new Error('unexpected status: ' + c.status);
  if (![null, 'new', 'carryover'].includes(c.marker)) throw new Error('unexpected marker: ' + c.marker);
}
if (!['PASS', 'FAIL', 'PARTIAL'].includes(j.verdict)) throw new Error('unexpected verdict: ' + j.verdict);
if (j.verdict !== 'PASS' && j.health_score >= 100) throw new Error('verdict ' + j.verdict + ' but health_score is ' + j.health_score + ' — score/verdict must not disagree');
if (typeof j.state_saved !== 'boolean') throw new Error('expected state_saved to be a boolean');
" "$JOUT"
echo "[PASS] --json: exactly one document, documented shape, score/verdict agree"

echo "== (i) the bookkeeping file itself never holds key material =="
STATE="$CYPHER_BRAIN_HOME/doctor-state.json"
[ -f "$STATE" ] || { echo "[FAIL] expected $STATE to have been written by now"; exit 1; }
if grep -qE 'AGE-SECRET-KEY|age1' "$STATE"; then
  echo "[FAIL] doctor-state.json contains what looks like key material — it must hold only check ids/timestamps"; cat "$STATE"; exit 1
fi
echo "[PASS] doctor-state.json holds no key material"

echo "== (j) an EXTRA recipient injected into recipient.txt is a FAIL, not a silent PASS (Codex review, #333: a partial-match check let an attacker recipient ride along with the real one) =="
cp "$CYPHER_BRAIN_HOME/recipient.txt" "$TMP/recipient.txt.bak2"
PRIMARY_RECIPIENT="$(cat "$CYPHER_BRAIN_HOME/recipient.txt")"
# A syntactically valid but UNRELATED age1 recipient, same one (g) uses — identityToRecipient()
# is never asked to derive FROM it, so it only needs to match AGE_PUBKEY_RE's shape.
EXTRA_RECIPIENT='age1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpq5s0kwc'
printf '%s\n%s\n' "$PRIMARY_RECIPIENT" "$EXTRA_RECIPIENT" > "$CYPHER_BRAIN_HOME/recipient.txt"
RC=0
CYPHER_BRAIN_PIN_RECIPIENTS="$PRIMARY_RECIPIENT" cb doctor --json > "$TMP/j.json" 2>&1 || RC=$?
[ "$RC" = "1" ] \
  || { echo "[FAIL] doctor with an injected extra recipient exited $RC, expected 1"; cat "$TMP/j.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const byId = Object.fromEntries(j.checks.map((c) => [c.id, c]));
const pairing = byId['identity-recipient-pairing'];
if (!pairing || pairing.status !== 'fail') {
  throw new Error('expected identity-recipient-pairing FAIL for an injected extra recipient, got ' + JSON.stringify(pairing));
}
if (!pairing.message.includes('$EXTRA_RECIPIENT')) {
  throw new Error('identity-recipient-pairing message does not name the unexpected recipient: ' + pairing.message);
}
const pin = byId['pin-recipients-primary-included'];
if (!pin || pin.status !== 'warn') {
  throw new Error('expected pin-recipients-primary-included WARN (not pass) when recipient.txt has an entry outside CYPHER_BRAIN_PIN_RECIPIENTS, got ' + JSON.stringify(pin));
}
if (!pin.message.includes('$EXTRA_RECIPIENT')) {
  throw new Error('pin-recipients-primary-included message does not name the un-allowlisted recipient: ' + pin.message);
}
" "$TMP/j.json"
cp "$TMP/recipient.txt.bak2" "$CYPHER_BRAIN_HOME/recipient.txt"
echo "[PASS] injected extra recipient: identity-recipient-pairing FAILs naming it, pin-recipients-primary-included WARNs (neither silently PASSes)"

echo "== (k) a corrupted identity.age (bad bech32 checksum) FAILs without ever printing the raw error or key material (Codex review, #333) =="
cp "$CYPHER_BRAIN_HOME/identity.age" "$TMP/identity.age.bak"
# age-encryption's bech32 decoder reports a bad checksum by echoing the FULL identity
# string back in its error ("Invalid checksum in AGE-SECRET-KEY-1...: expected ...") —
# flip one character well inside the data portion (past the 16-char "AGE-SECRET-KEY-1"
# prefix) so decoding fails on checksum, not on shape, and confirm that exact library
# message text never reaches doctor's output.
node -e "
const fs = require('node:fs');
const path = process.argv[1];
const lines = fs.readFileSync(path, 'utf8').split('\n');
const idx = lines.findIndex((l) => l.startsWith('AGE-SECRET-KEY-1'));
if (idx === -1) throw new Error('no AGE-SECRET-KEY-1 line found in ' + path);
const chars = lines[idx].split('');
const pos = 20; // inside the bech32 data, well past the 16-char prefix
chars[pos] = chars[pos] === 'Q' ? 'P' : 'Q';
lines[idx] = chars.join('');
fs.writeFileSync(path, lines.join('\n'));
" "$CYPHER_BRAIN_HOME/identity.age"
RC=0
cb doctor > "$TMP/k.log" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] doctor with a corrupted identity.age exited $RC, expected 1"; cat "$TMP/k.log"; exit 1; }
grep -qF 'does not parse as a valid age identity' "$TMP/k.log" \
  || { echo "[FAIL] expected a FAIL naming the corrupt identity"; cat "$TMP/k.log"; exit 1; }
if grep -qE 'AGE-SECRET-KEY-1[A-Za-z0-9]{10,}' "$TMP/k.log"; then
  echo "[FAIL] doctor's output contains what looks like raw identity key material"; cat "$TMP/k.log"; exit 1
fi
if grep -qF 'Invalid checksum' "$TMP/k.log"; then
  echo "[FAIL] doctor's output leaked the underlying 'Invalid checksum' library error, which embeds the full (corrupt) identity string"; cat "$TMP/k.log"; exit 1
fi
cp "$TMP/identity.age.bak" "$CYPHER_BRAIN_HOME/identity.age"
echo "[PASS] corrupted identity.age: FAIL with a sanitized message, no raw key material or library error text in the output"

echo "== (l) doctor-state.json write is symlink-safe: a pre-planted symlink is REPLACED via atomic rename, never followed to overwrite its target (Codex review, #333) =="
VICTIM="$TMP/doctor-state-victim.txt"
printf 'DO-NOT-OVERWRITE\n' > "$VICTIM"
rm -f "$CYPHER_BRAIN_HOME/doctor-state.json"
ln -s "$VICTIM" "$CYPHER_BRAIN_HOME/doctor-state.json"
[ -L "$CYPHER_BRAIN_HOME/doctor-state.json" ] || { echo "[FAIL] test setup: doctor-state.json is not a symlink"; exit 1; }
cb doctor > "$TMP/l.log" 2>&1 || true # exit code is irrelevant here — only the write's symlink safety is asserted
[ "$(cat "$VICTIM")" = "DO-NOT-OVERWRITE" ] \
  || { echo "[FAIL] the pre-planted symlink's target was overwritten by doctor's bookkeeping write — got: $(cat "$VICTIM")"; exit 1; }
[ ! -L "$CYPHER_BRAIN_HOME/doctor-state.json" ] \
  || { echo "[FAIL] doctor-state.json is STILL a symlink — the write never replaced it with a real file"; exit 1; }
[ -f "$CYPHER_BRAIN_HOME/doctor-state.json" ] \
  || { echo "[FAIL] expected doctor-state.json to now be a real, regular file"; exit 1; }
node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'))" "$CYPHER_BRAIN_HOME/doctor-state.json" \
  || { echo "[FAIL] doctor-state.json is not valid JSON after the write"; exit 1; }
echo "[PASS] a pre-planted symlink at doctor-state.json is replaced by a real file via atomic rename; its original target is left untouched"

echo "== (m) CYPHER_BRAIN_AR_WALLET explicitly set to a path with nothing there is a FAIL, not the same SKIP an unconfigured wallet gets (Codex review, #333) =="
RC=0
CYPHER_BRAIN_AR_WALLET="$TMP/no-such-wallet.json" cb doctor --json > "$TMP/m.json" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] doctor with a missing explicit CYPHER_BRAIN_AR_WALLET exited $RC, expected 1"; cat "$TMP/m.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const wallet = j.checks.find((c) => c.id === 'wallet-perms');
if (!wallet || wallet.status !== 'fail') throw new Error('expected wallet-perms FAIL, got ' + JSON.stringify(wallet));
if (!wallet.message.includes('$TMP/no-such-wallet.json')) throw new Error('wallet-perms message does not name the configured path: ' + wallet.message);
" "$TMP/m.json"
echo "[PASS] an explicitly-configured but missing CYPHER_BRAIN_AR_WALLET is a FAIL naming the path"

echo "== (n) build provenance (#348): the age of the running code is visible, and the warn boundary holds =="
# Run from this git checkout, the dev path derives commit/date live — the check must be
# pass-or-warn (never skip here) and must carry a commit hash and an age in days. The
# real incident (a 39-day-old hand-copied build silently missing features) would have
# been visible as exactly this line.
cb doctor --json > "$TMP/n.json" 2>&1 || true
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = j.checks.find((c) => c.id === 'build-provenance');
if (!b) throw new Error('no build-provenance check in doctor output');
if (b.status !== 'pass' && b.status !== 'warn') throw new Error('expected pass|warn inside a git checkout, got ' + b.status);
if (!/commit [0-9a-f]{7,}/.test(b.message)) throw new Error('no commit hash in: ' + b.message);
if (!/day\(s\) ago/.test(b.message)) throw new Error('no age in: ' + b.message);
" "$TMP/n.json"
echo "[PASS] doctor reports the running build's commit and age from a git checkout"

# The STAMPED path (dist bundle) must carry the same check with 'built from' — this
# exercises the define plumbing end-to-end, not just the live-git dev path.
if [ -f "$ROOT/dist/cli.mjs" ]; then
  CYPHER_BRAIN_HOME="$TMP/stamp-home" node "$ROOT/dist/cli.mjs" doctor --json > "$TMP/n2.json" 2>&1 || true
  node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const b = j.checks.find((c) => c.id === 'build-provenance');
if (!b) throw new Error('no build-provenance in the STAMPED dist run');
if (!/built from commit [0-9a-f]{7,}/.test(b.message)) throw new Error('stamped run did not say built-from: ' + b.message);
" "$TMP/n2.json"
  echo "[PASS] the stamped dist bundle reports 'built from' provenance (define plumbing round-trips)"
else
  echo "[SKIP] dist/cli.mjs not built — stamped-path assertion skipped"
fi

# The classifier is pure: 90 days is the boundary (pass at exactly 90, warn past it),
# an unparseable date classifies as null (UNKNOWN upstream), and a future date clamps
# to 0 rather than going negative.
node --experimental-strip-types --import ./scripts/dev-cli-loader.mjs -e "
import('./src/lib/buildinfo.ts').then((m) => {
  const now = Date.parse('2026-08-05T00:00:00Z');
  const day = 86400000;
  const at = (d) => new Date(now - d * day).toISOString();
  if (m.buildAgeDays(at(90), now) !== 90) throw new Error('90d boundary broke');
  if (m.BUILD_STALE_DAYS !== 90) throw new Error('threshold moved without updating this test');
  if (m.buildAgeDays(at(89), now) !== 89) throw new Error('under-boundary age wrong (89 must stay pass-side)');
  if (m.buildAgeDays(at(91), now) !== 91) throw new Error('past-boundary age wrong');
  if (m.buildAgeDays('not-a-date', now) !== null) throw new Error('unparseable date did not classify null');
  if (m.buildAgeDays(at(-3), now) !== 0) throw new Error('a future commit date must clamp to 0, not go negative');
  console.log('boundaries OK');
});
" | grep -q "boundaries OK" || { echo "[FAIL] buildAgeDays boundary/edge cases"; exit 1; }
echo "[PASS] buildAgeDays: 90-day boundary, unparseable-date null, future-date clamp"

echo "== (o) audit-chain-integrity / receipt-ledger-readability (#456): SKIP on a machine that has never run push/restore/verify or a paid push =="
export CYPHER_BRAIN_HOME="$TMP/audit-ledger-home"
[ ! -e "$CYPHER_BRAIN_HOME" ] || { echo "[FAIL] test setup: $CYPHER_BRAIN_HOME already exists"; exit 1; }
cb doctor --json > "$TMP/o.json" 2>&1 || { echo "[FAIL] doctor --json exited non-zero on a never-used home"; cat "$TMP/o.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const byId = Object.fromEntries(j.checks.map((c) => [c.id, c]));
for (const id of ['audit-chain-integrity', 'receipt-ledger-readability']) {
  if (!byId[id] || byId[id].status !== 'skip') {
    throw new Error(id + ' expected status skip on a never-used machine, got ' + JSON.stringify(byId[id]));
  }
}
" "$TMP/o.json"
[ ! -e "$CYPHER_BRAIN_HOME" ] \
  || { echo "[FAIL] doctor CREATED $CYPHER_BRAIN_HOME while checking the audit log/receipt ledger — both reads must stay side-effect-free"; exit 1; }
echo "[PASS] no audit log / receipt ledger yet: both checks SKIP, no side effect"

echo "== (p) a well-formed audit log entry / receipt ledger line: both checks PASS =="
node --experimental-strip-types --import ./scripts/dev-cli-loader.mjs -e "
Promise.all([import('./src/lib/audit.ts'), import('./src/lib/receipt.ts')]).then(async ([audit, receipt]) => {
  await audit.appendAuditEntry({
    timestamp: new Date().toISOString(),
    command: 'push',
    backend: 'file',
    locator: 'selftest-locator',
    artifact_sha256: 'a'.repeat(64),
    machine: 'selftest-host',
    recipients_fingerprint: null,
    exit_code: 0,
    duration_ms: 1,
  });
  await receipt.appendReceipt({
    timestamp: new Date().toISOString(),
    backend: 'turbo',
    locator: 'selftest-locator',
    artifact_sha256: 'a'.repeat(64),
    size_bytes: 123,
    payer_address: null,
    cost: '1000',
    unit: 'winc',
    raw: {},
  });
});
"
# The appends above created $CYPHER_BRAIN_HOME via mkdir(..., {recursive:true}) with
# whatever mode the process umask leaves — chmod it to 0700 so the UNRELATED
# home-dir-perms check does not also FAIL here and muddy this test's own assertions
# (this test is only about the two new #456 checks).
chmod 700 "$CYPHER_BRAIN_HOME"
cb doctor --json > "$TMP/p.json" 2>&1 || true
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const byId = Object.fromEntries(j.checks.map((c) => [c.id, c]));
const ac = byId['audit-chain-integrity'];
if (!ac || ac.status !== 'pass') throw new Error('expected audit-chain-integrity pass, got ' + JSON.stringify(ac));
if (!/1 entry/.test(ac.message)) throw new Error('expected the entry count in the message: ' + ac.message);
const rl = byId['receipt-ledger-readability'];
if (!rl || rl.status !== 'pass') throw new Error('expected receipt-ledger-readability pass, got ' + JSON.stringify(rl));
if (!/1 receipt/.test(rl.message)) throw new Error('expected the receipt count in the message: ' + rl.message);
" "$TMP/p.json"
echo "[PASS] well-formed audit entry / receipt line: both checks PASS"

echo "== (q) POSITIVE CONTROL — a hand-corrupted audit log entry breaks the hash chain: FAIL, doctor VERDICT FAIL (exit 1) =="
export CYPHER_BRAIN_HOME="$TMP/audit-broken-home"
[ ! -e "$CYPHER_BRAIN_HOME" ] || { echo "[FAIL] test setup: $CYPHER_BRAIN_HOME already exists"; exit 1; }
node --experimental-strip-types --import ./scripts/dev-cli-loader.mjs -e "
import('./src/lib/audit.ts').then(async (m) => {
  const base = {
    backend: 'file',
    locator: null,
    artifact_sha256: 'a'.repeat(64),
    machine: 'selftest-host',
    recipients_fingerprint: null,
    duration_ms: 1,
  };
  await m.appendAuditEntry({ ...base, timestamp: '2026-08-01T00:00:00.000Z', command: 'push', exit_code: 0 });
  await m.appendAuditEntry({ ...base, timestamp: '2026-08-01T00:01:00.000Z', command: 'restore', exit_code: 0 });
});
"
chmod 700 "$CYPHER_BRAIN_HOME"
AUDIT_LOG="$CYPHER_BRAIN_HOME/audit-log.jsonl"
[ -f "$AUDIT_LOG" ] || { echo "[FAIL] test setup: $AUDIT_LOG was not written"; exit 1; }
# Content changed, hash NOT recomputed — the exact "in-place edit of an entry" tamper
# verifyAuditChain() exists to catch (mirrors scripts/selftest-audit.mjs's own positive
# control for the same library function).
node -e "
const fs = require('node:fs');
const path = process.argv[1];
const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
const first = JSON.parse(lines[0]);
first.exit_code = 999;
lines[0] = JSON.stringify(first);
fs.writeFileSync(path, lines.join('\n') + '\n');
" "$AUDIT_LOG"
RC=0
cb doctor > "$TMP/q.log" 2>&1 || RC=$?
[ "$RC" = "1" ] || { echo "[FAIL] doctor with a hand-corrupted audit log exited $RC, expected 1"; cat "$TMP/q.log"; exit 1; }
grep -qE '^\[FAIL\].*audit log integrity check failed: chain broken at entry index 0' "$TMP/q.log" \
  || { echo "[FAIL] expected a FAIL naming the broken chain index"; cat "$TMP/q.log"; exit 1; }
grep -qF "remediation: run 'cypher-brain audit' for full detail" "$TMP/q.log" \
  || { echo "[FAIL] expected the audit-chain-integrity remediation pointing at 'cypher-brain audit'"; cat "$TMP/q.log"; exit 1; }
grep -q '^VERDICT: FAIL$' "$TMP/q.log" || { echo "[FAIL] expected doctor's overall VERDICT to be FAIL, not a false PASS (the exact #456 gap)"; cat "$TMP/q.log"; exit 1; }
# cypher-brain audit itself must agree — doctor's check reuses its exact verdict logic.
RC2=0
cb audit > "$TMP/q-audit.log" 2>&1 || RC2=$?
[ "$RC2" = "1" ] || { echo "[FAIL] 'cypher-brain audit' itself did not also report FAIL on the same corrupted log (exit $RC2)"; cat "$TMP/q-audit.log"; exit 1; }
grep -q '^VERDICT: FAIL' "$TMP/q-audit.log" || { echo "[FAIL] 'cypher-brain audit' did not print VERDICT: FAIL"; cat "$TMP/q-audit.log"; exit 1; }
echo "[PASS] hand-corrupted audit log: audit-chain-integrity FAIL naming the broken index, doctor VERDICT FAIL (exit 1), agrees with 'cypher-brain audit'"

echo "== (r) POSITIVE CONTROL — an unreadable receipt ledger line: WARN (not FAIL), doctor VERDICT PARTIAL (exit 2) =="
export CYPHER_BRAIN_HOME="$TMP/receipt-warn-home"
[ ! -e "$CYPHER_BRAIN_HOME" ] || { echo "[FAIL] test setup: $CYPHER_BRAIN_HOME already exists"; exit 1; }
node --experimental-strip-types --import ./scripts/dev-cli-loader.mjs -e "
import('./src/lib/receipt.ts').then(async (m) => {
  await m.appendReceipt({
    timestamp: new Date().toISOString(),
    backend: 'arweave',
    locator: 'selftest-locator',
    artifact_sha256: 'a'.repeat(64),
    size_bytes: 42,
    payer_address: null,
    cost: '500',
    unit: 'winston',
    raw: {},
  });
});
"
chmod 700 "$CYPHER_BRAIN_HOME"
RECEIPT_LEDGER_PATH="$CYPHER_BRAIN_HOME/receipt-ledger.jsonl"
[ -f "$RECEIPT_LEDGER_PATH" ] || { echo "[FAIL] test setup: $RECEIPT_LEDGER_PATH was not written"; exit 1; }
printf 'not json at all\n' >> "$RECEIPT_LEDGER_PATH"
RC=0
cb doctor > "$TMP/r.log" 2>&1 || RC=$?
[ "$RC" = "2" ] || { echo "[FAIL] doctor with an unreadable receipt ledger line exited $RC, expected 2 (PARTIAL — WARN only)"; cat "$TMP/r.log"; exit 1; }
grep -qE '^\[WARN\].*1 unreadable line\(s\) in the receipt ledger' "$TMP/r.log" \
  || { echo "[FAIL] expected a WARN naming the unreadable receipt ledger line"; cat "$TMP/r.log"; exit 1; }
if grep -qE '^\[FAIL\]' "$TMP/r.log"; then
  echo "[FAIL] an unreadable receipt ledger line must never escalate to FAIL — it is a data-quality issue, not a broken security boundary"; cat "$TMP/r.log"; exit 1
fi
grep -q '^VERDICT: PARTIAL$' "$TMP/r.log" || { echo "[FAIL] expected doctor's overall VERDICT to be PARTIAL, not a silent PASS"; cat "$TMP/r.log"; exit 1; }
echo "[PASS] unreadable receipt ledger line: receipt-ledger-readability WARN (not FAIL), doctor VERDICT PARTIAL (exit 2)"

# #493: the SAME fixture, but through --json — doctor's exit code is set once from
# report.verdict regardless of -o.json (doctor.ts's doctor()), so --json must agree with
# the plain-text assertions just made: exit 2, verdict "PARTIAL", the same check WARN
# (never fail), and score/verdict must not read as a healthy 100 next to a non-PASS
# verdict (the same discipline (h) already asserts generically, forced here onto this
# exact PARTIAL fixture instead of whatever verdict happens to be ambient).
RC=0
cb doctor --json > "$TMP/r.json" 2>&1 || RC=$?
[ "$RC" = "2" ] || { echo "[FAIL] doctor --json with an unreadable receipt ledger line exited $RC, expected 2 (PARTIAL — WARN only)"; cat "$TMP/r.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
if (j.verdict !== 'PARTIAL') throw new Error('expected --json verdict PARTIAL, got ' + j.verdict);
const rl = j.checks.find((c) => c.id === 'receipt-ledger-readability');
if (!rl || rl.status !== 'warn') throw new Error('expected --json receipt-ledger-readability warn, got ' + JSON.stringify(rl));
if (!/1 unreadable line/.test(rl.message)) throw new Error('--json message missing the unreadable-line count: ' + rl.message);
if (j.checks.some((c) => c.status === 'fail')) throw new Error('--json reported a fail-status check — an unreadable receipt ledger line must never escalate to FAIL');
if (typeof j.health_score !== 'number' || !Number.isFinite(j.health_score)) throw new Error('expected --json health_score to be a finite number, got ' + JSON.stringify(j.health_score));
if (j.health_score >= 100) throw new Error('verdict PARTIAL but --json health_score is ' + j.health_score + ' — score/verdict must not disagree');
" "$TMP/r.json"
echo "[PASS] the same fixture via --json: verdict PARTIAL, exit 2, receipt-ledger-readability warn (not fail), score/verdict agree"

echo "== (s) gbrain-engine-detection (#542): no ~/.gbrain config -> SKIP =="
export CYPHER_BRAIN_HOME="$TMP/gbrain-none-cb-home"
export HOME="$TMP/gbrain-none-home"; mkdir -p "$HOME"
cb doctor --json > "$TMP/s.json" 2>&1 || { echo "[FAIL] doctor --json exited non-zero with no gbrain config"; cat "$TMP/s.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const g = j.checks.find((c) => c.id === 'gbrain-engine-detection');
if (!g || g.status !== 'skip') throw new Error('expected gbrain-engine-detection skip with no ~/.gbrain, got ' + JSON.stringify(g));
if (j.verdict !== 'PASS') throw new Error('expected verdict PASS, got ' + j.verdict);
" "$TMP/s.json"
echo "[PASS] no gbrain config: gbrain-engine-detection SKIPs, doesn't affect verdict"

echo "== (t) gbrain-engine-detection: a genuine PGLite config -> PASS naming the engine and the store path =="
export CYPHER_BRAIN_HOME="$TMP/gbrain-pglite-cb-home"
export HOME="$TMP/gbrain-pglite-home"; mkdir -p "$HOME/.gbrain"
printf '{"engine":"pglite","database_path":"%s/.gbrain/.pglite","api_key":"sk-selftest-decoy"}\n' "$HOME" > "$HOME/.gbrain/config.json"
cb doctor --json > "$TMP/t.json" 2>&1 || { echo "[FAIL] doctor --json exited non-zero with a PGLite gbrain config"; cat "$TMP/t.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const g = j.checks.find((c) => c.id === 'gbrain-engine-detection');
if (!g || g.status !== 'pass') throw new Error('expected gbrain-engine-detection pass for a PGLite config, got ' + JSON.stringify(g));
if (!/PGLite/.test(g.message)) throw new Error('message does not name PGLite: ' + g.message);
if (!g.message.includes('.pglite')) throw new Error('message does not include the configured store path: ' + g.message);
if (g.message.includes('sk-selftest-decoy')) throw new Error('the config secret leaked into the doctor message: ' + g.message);
" "$TMP/t.json"
echo "[PASS] a genuine PGLite config: PASS naming PGLite and the configured store path, no config secret leaked"

echo "== (u) gbrain-engine-detection: a genuine Postgres config -> PASS naming Postgres =="
export CYPHER_BRAIN_HOME="$TMP/gbrain-postgres-cb-home"
export HOME="$TMP/gbrain-postgres-home"; mkdir -p "$HOME/.gbrain"
printf '{"engine":"postgres"}\n' > "$HOME/.gbrain/config.json"
cb doctor --json > "$TMP/u.json" 2>&1 || { echo "[FAIL] doctor --json exited non-zero with a Postgres gbrain config"; cat "$TMP/u.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const g = j.checks.find((c) => c.id === 'gbrain-engine-detection');
if (!g || g.status !== 'pass') throw new Error('expected gbrain-engine-detection pass for a Postgres config, got ' + JSON.stringify(g));
if (!/Postgres/.test(g.message)) throw new Error('message does not name Postgres: ' + g.message);
" "$TMP/u.json"
echo "[PASS] a genuine Postgres config: PASS naming Postgres"

echo "== (v) gbrain-engine-detection: an unreadable/malformed config -> WARN (never FAIL), doctor VERDICT PARTIAL =="
export CYPHER_BRAIN_HOME="$TMP/gbrain-broken-cb-home"
export HOME="$TMP/gbrain-broken-home"; mkdir -p "$HOME/.gbrain"
printf '{not valid json' > "$HOME/.gbrain/config.json"
RC=0
cb doctor --json > "$TMP/v.json" 2>&1 || RC=$?
[ "$RC" = "2" ] || { echo "[FAIL] doctor --json with a malformed gbrain config exited $RC, expected 2 (PARTIAL — WARN only)"; cat "$TMP/v.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const g = j.checks.find((c) => c.id === 'gbrain-engine-detection');
if (!g || g.status !== 'warn') throw new Error('expected gbrain-engine-detection warn for a malformed config, got ' + JSON.stringify(g));
if (!/could not be read/.test(g.message)) throw new Error('message does not say the config could not be read: ' + g.message);
if (j.checks.some((c) => c.status === 'fail')) throw new Error('a malformed gbrain config must never escalate to FAIL');
if (j.verdict !== 'PARTIAL') throw new Error('expected verdict PARTIAL, got ' + j.verdict);
" "$TMP/v.json"
echo "[PASS] an unreadable/malformed gbrain config: gbrain-engine-detection WARN (not FAIL), doctor VERDICT PARTIAL (exit 2)"

echo "== (w) gbrain-engine-detection: GBRAIN_HOME relocates the config away from ~/.gbrain, and is honored =="
# resolveGbrainConfigPath() (gbrain.ts) mirrors gbrain's own configDir(): GBRAIN_HOME is a
# PARENT directory gbrain appends '.gbrain' to itself. HOME here has NO .gbrain at all —
# so a build that still hard-codes join(homedir(), '.gbrain', 'config.json') would SKIP
# this check ("not set up") against a machine that is, in fact, fully configured.
export CYPHER_BRAIN_HOME="$TMP/gbrain-relocated-cb-home"
export HOME="$TMP/gbrain-relocated-home"; mkdir -p "$HOME"
GBRAIN_RELOCATED="$TMP/gbrain-relocated-elsewhere"; mkdir -p "$GBRAIN_RELOCATED/.gbrain"
printf '{"engine":"pglite","database_path":"%s/.gbrain/.pglite","api_key":"sk-selftest-decoy-gbrain-home"}\n' \
  "$GBRAIN_RELOCATED" > "$GBRAIN_RELOCATED/.gbrain/config.json"
GBRAIN_HOME="$GBRAIN_RELOCATED" cb doctor --json > "$TMP/w.json" 2>&1 \
  || { echo "[FAIL] doctor --json exited non-zero with a GBRAIN_HOME-relocated config"; cat "$TMP/w.json"; exit 1; }
node -e "
const j = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8'));
const g = j.checks.find((c) => c.id === 'gbrain-engine-detection');
if (!g || g.status !== 'pass') throw new Error('expected gbrain-engine-detection pass for a GBRAIN_HOME-relocated PGLite config, got ' + JSON.stringify(g));
if (!/PGLite/.test(g.message)) throw new Error('message does not name PGLite: ' + g.message);
if (!g.message.includes('$GBRAIN_RELOCATED')) throw new Error('message does not name the RELOCATED store path — looks like it fell back to the default ~/.gbrain: ' + g.message);
if (g.message.includes('sk-selftest-decoy-gbrain-home')) throw new Error('the relocated config secret leaked into the doctor message: ' + g.message);
" "$TMP/w.json"
echo "[PASS] GBRAIN_HOME relocated: gbrain-engine-detection reads \$GBRAIN_HOME/.gbrain/config.json instead of falsely SKIPping against the unset default ~/.gbrain"

echo
echo "all cypher-brain doctor selftests passed"
