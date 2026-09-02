#!/usr/bin/env node
// #800: the MCP snapshot policy — fail-closed, operator-configured, CLI unchanged.
//
// snapshot_now is the one tool on this server where an untrusted caller picks BOTH the
// plaintext (`dirs`) and the key it is encrypted to (`recipients`), and the free `file`
// backend reaches it with no consent gate at all. The policy takes both halves back:
//
//   - CYPHER_BRAIN_PIN_RECIPIENTS must resolve to >= 1 age1… key, or every call is refused;
//   - a call naming `dirs` is refused unless every entry realpath-resolves inside one of
//     the absolute roots in CYPHER_BRAIN_MCP_SOURCE_ROOTS.
//
// What this file asserts, stated narrowly:
//
//   1. Each red case comes back as ERR_POLICY_DENIED carrying cb_code CB-E025 — the code
//      an agent branches on. Recipient MEMBERSHIP is checked at this layer too, and case
//      11b pins down why that is not redundant: snapshot.ts's check is authoritative but
//      never runs on an idempotency replay, so the CLI arm asserts it is still there
//      underneath (CB-E005) while the MCP arm asserts the gate in front of it.
//   2. A denied call leaves NOTHING behind: no `out` file, no object in the file-backend
//      store, and no line in the idempotency log. That is what makes "the gate runs before
//      output creation, the secret scan, the snapshot and the upload" a measured claim
//      rather than a reading of the source.
//   3. A replay is not grandfathered: a key recorded while the policy allowed the call is
//      refused once the policy no longer does, and writes no locator file on the way out.
//   4. The green cases still work, and the CLI is untouched by any of it.
//   5. #838: a CYPHER_BRAIN_MCP_SOURCE_ROOTS root must exist on disk as a directory — a
//      nonexistent or non-directory root fails the WHOLE policy closed (naming the
//      offending root), rather than realpathOfNearestAncestor()'s "dirs entry" fallback
//      silently authorizing its nearest existing ancestor instead. A root that is itself
//      a symlink to a directory is still accepted, resolved-target compared, same as
//      every other path this gate compares.
//
// Each `snapshot_now` case gets its own server process because the policy inputs are env
// vars this server reads at module load — which is also the honest shape of the feature:
// an operator changes them and restarts.
//
// Exits 0 on success, 1 on the first failure with context on stderr.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink, realpath, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = join(ROOT, 'dist', 'mcp.mjs');
const CLI_PATH = join(ROOT, 'dist', 'cli.mjs');
const TIMEOUT_MS = 30_000;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (msg) => {
  throw new Error(msg);
};

function parseFrames(buf) {
  const out = [];
  for (const line of buf.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      /* incomplete JSON line — ignore */
    }
  }
  return out;
}

// One snapshot_now call against a server started with `env`. Returns the tool result
// frame. The server is always torn down, including on a thrown assertion.
async function callSnapshotNow(env, args) {
  const child = spawn(process.execPath, [SERVER_PATH], { stdio: ['pipe', 'pipe', 'pipe'], env });
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d) => {
    stdoutBuf += d.toString('utf8');
  });
  child.stderr.on('data', (d) => {
    stderrBuf += d.toString('utf8');
  });
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const waitFor = async (id) => {
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      const frame = parseFrames(stdoutBuf).find((f) => f.id === id);
      if (frame) return frame;
      await wait(100);
    }
    throw new Error(`no response for id=${id} within ${TIMEOUT_MS}ms; stderr=${stderrBuf.slice(-800)}`);
  };
  try {
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'policy-test', version: '0' } },
    });
    await waitFor(1);
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await wait(100);
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'snapshot_now', arguments: args } });
    return await waitFor(2);
  } finally {
    child.kill();
  }
}

const structured = (frame) => frame.result?.structuredContent ?? {};

// The three "nothing happened" assertions, made together because a gate that runs before
// SOME side effects but not others is the failure this is written to catch.
async function assertNoArtifacts(label, { out, store, idempotencyLog, key }) {
  if (existsSync(out)) fail(`${label}: a denied call still produced the snapshot artifact at ${out}`);
  const objects = existsSync(store) ? await readdir(store) : [];
  if (objects.length) fail(`${label}: a denied call still put ${JSON.stringify(objects)} in the file-backend store`);
  if (key && existsSync(idempotencyLog)) {
    const text = await readFile(idempotencyLog, 'utf8');
    if (text.includes(key)) fail(`${label}: a denied call still recorded idempotency_key ${key} in ${idempotencyLog}`);
  }
}

function assertPolicyDenied(label, frame) {
  if (!frame.result?.isError) {
    fail(`${label}: expected a refusal, got success: ${JSON.stringify(frame.result).slice(0, 400)}`);
  }
  const sc = structured(frame);
  if (sc.code !== 'ERR_POLICY_DENIED') {
    fail(
      `${label}: expected code ERR_POLICY_DENIED, got ${JSON.stringify(sc.code)} — ${JSON.stringify(sc.message).slice(0, 400)}`,
    );
  }
  if (sc.cb_code !== 'CB-E025') {
    fail(
      `${label}: expected cb_code CB-E025, got ${JSON.stringify(sc.cb_code)} — ${JSON.stringify(sc.message).slice(0, 400)}`,
    );
  }
  if (!/refusing to snapshot over MCP/.test(sc.message ?? '')) {
    fail(`${label}: refusal did not carry the policy sentence: ${JSON.stringify(sc.message).slice(0, 400)}`);
  }
  console.log(`  [PASS] ${label} — ERR_POLICY_DENIED / CB-E025, nothing created`);
}

async function main() {
  if (!existsSync(SERVER_PATH)) fail(`${SERVER_PATH} not found — run \`npm run build\` first`);
  // realpath the scratch tree up front: on macOS $TMPDIR is under a symlinked /var, and
  // the policy compares REALPATHS. Comparing against the un-resolved path would make
  // every containment assertion here vacuous.
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'cb-mcp-policy-')));
  try {
    await run(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function run(tmp) {
  const home = join(tmp, 'home');
  const store = join(tmp, 'store');
  const rootsDir = join(tmp, 'roots');
  // `a` and `ab` are siblings on purpose: `/roots/ab` must NOT be covered by a
  // `/roots/a` root. That is a bare-string-prefix bug the containment helper this
  // policy reuses (pathCoveredBy) was written to prevent, and a policy that
  // re-derived the check by hand would be the natural place to reintroduce it.
  const rootA = join(rootsDir, 'a');
  const rootAb = join(rootsDir, 'ab');
  const rootB = join(rootsDir, 'b');
  const contained = join(rootA, 'notes');
  const outside = join(tmp, 'outside');
  const escapeLink = join(rootA, 'escape'); // symlink -> outside
  for (const d of [store, rootA, rootAb, rootB, contained, outside, join(rootB, 'second')]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(contained, 'note.md'), 'contained payload\n');
  await writeFile(join(rootAb, 'note.md'), 'sibling-prefix payload\n');
  await writeFile(join(rootB, 'second', 'note.md'), 'second-root payload\n');
  await writeFile(join(outside, 'secret.md'), 'the plaintext an untrusted caller must not be able to name\n');
  await symlink(outside, escapeLink);

  const keygen = spawnSync(process.execPath, [CLI_PATH, 'keygen'], {
    env: { ...process.env, CYPHER_BRAIN_HOME: home },
    encoding: 'utf8',
  });
  if (keygen.status !== 0) fail(`keygen failed (${keygen.status}): ${keygen.stderr || keygen.stdout}`);
  const recipientPath = join(home, 'recipient.txt');
  const idempotencyLog = join(home, 'idempotency-log.jsonl');

  // A SECOND, unrelated keypair in its own home — the recipient the pin must reject.
  const otherHome = join(tmp, 'other-home');
  const otherKeygen = spawnSync(process.execPath, [CLI_PATH, 'keygen'], {
    env: { ...process.env, CYPHER_BRAIN_HOME: otherHome },
    encoding: 'utf8',
  });
  if (otherKeygen.status !== 0) fail(`second keygen failed: ${otherKeygen.stderr || otherKeygen.stdout}`);
  const otherRecipientPath = join(otherHome, 'recipient.txt');

  const baseEnv = { ...process.env, CYPHER_BRAIN_HOME: home, CYPHER_BRAIN_FILE_DIR: store };
  const pinned = { ...baseEnv, CYPHER_BRAIN_PIN_RECIPIENTS: recipientPath };
  const withRoots = (roots, env = pinned) => ({ ...env, CYPHER_BRAIN_MCP_SOURCE_ROOTS: roots });
  const okRoots = JSON.stringify([rootA, rootB]);

  let outSeq = 0;
  const nextOut = () => join(tmp, `out-${++outSeq}.age`);
  const baseArgs = (out, extra = {}) => ({
    dirs: [contained],
    recipients: [recipientPath],
    out,
    backend: 'file',
    ...extra,
  });

  console.log('MCP SNAPSHOT POLICY (#800): red cases');

  // ── 1. no recipient pin at all ────────────────────────────────────────────
  {
    const out = nextOut();
    const key = 'policy-red-nopin';
    // Roots ARE configured and the source IS contained: the ONLY thing missing is the
    // pin, so a pass here would mean the key half of the gate is not wired up.
    const frame = await callSnapshotNow(
      { ...baseEnv, CYPHER_BRAIN_MCP_SOURCE_ROOTS: okRoots },
      baseArgs(out, { idempotency_key: key }),
    );
    assertPolicyDenied('no CYPHER_BRAIN_PIN_RECIPIENTS', frame);
    if (!/CYPHER_BRAIN_PIN_RECIPIENTS/.test(structured(frame).message ?? ''))
      fail('no-pin refusal did not name CYPHER_BRAIN_PIN_RECIPIENTS');
    await assertNoArtifacts('no CYPHER_BRAIN_PIN_RECIPIENTS', { out, store, idempotencyLog, key });
  }

  // ── 2. a pin that resolves to no keys ─────────────────────────────────────
  {
    const emptyPin = join(tmp, 'empty-pin.txt');
    await writeFile(emptyPin, '# every key here is commented out\n#age1notakey\n');
    const out = nextOut();
    const frame = await callSnapshotNow(
      { ...baseEnv, CYPHER_BRAIN_PIN_RECIPIENTS: emptyPin, CYPHER_BRAIN_MCP_SOURCE_ROOTS: okRoots },
      baseArgs(out),
    );
    assertPolicyDenied('pin resolves to zero age1… keys', frame);
    await assertNoArtifacts('pin resolves to zero age1… keys', { out, store });
  }

  // ── 2b. a pin file that exists but cannot be read ─────────────────────────
  // A check that could not RUN has not passed (multi-model review, #800). Without the
  // fail-closed wrapper this surfaces as ERR_INTERNAL — "the server broke, retry" — for
  // what is in fact a policy that could not be evaluated. Skipped under root, where
  // chmod 000 prevents nothing: saying so is the honest report, per this repo's
  // BLOCKED-is-not-PASS rule.
  if (process.getuid?.() === 0) {
    console.log('  [SKIP] unreadable pin file — running as root, where chmod 000 does not prevent a read');
  } else {
    const lockedPin = join(tmp, 'locked-pin.txt');
    await writeFile(lockedPin, 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p\n');
    await chmod(lockedPin, 0o000);
    const out = nextOut();
    const frame = await callSnapshotNow(
      { ...baseEnv, CYPHER_BRAIN_PIN_RECIPIENTS: lockedPin, CYPHER_BRAIN_MCP_SOURCE_ROOTS: okRoots },
      baseArgs(out),
    );
    assertPolicyDenied('pin file exists but is unreadable', frame);
    await assertNoArtifacts('pin file exists but is unreadable', { out, store });
    await chmod(lockedPin, 0o600); // so the scratch tree can be removed
  }

  // ── 3-6. roots unset / empty / malformed, with dirs ───────────────────────
  const badRootCases = [
    ['roots unset', undefined],
    ['roots empty string', ''],
    ['roots not JSON', '/srv/brain:/home/me'],
    ['roots a JSON object', '{"a":"/srv/brain"}'],
    ['roots a JSON string', '"/srv/brain"'],
    ['roots with a non-absolute element', JSON.stringify(['relative/path'])],
    ['roots with a non-string element', JSON.stringify([42])],
    ['roots an empty JSON array', '[]'],
  ];
  for (const [label, roots] of badRootCases) {
    const out = nextOut();
    const env = roots === undefined ? { ...pinned } : withRoots(roots);
    if (roots === undefined) delete env.CYPHER_BRAIN_MCP_SOURCE_ROOTS;
    const frame = await callSnapshotNow(env, baseArgs(out));
    assertPolicyDenied(label, frame);
    if (!/CYPHER_BRAIN_MCP_SOURCE_ROOTS/.test(structured(frame).message ?? ''))
      fail(`${label}: refusal did not name CYPHER_BRAIN_MCP_SOURCE_ROOTS`);
    await assertNoArtifacts(label, { out, store });
  }

  // ── 6b. a configured root that does not exist on disk (#838) ─────────────
  // The bug this closes: realpathOfNearestAncestor() used to "resolve" a nonexistent
  // root to its nearest EXISTING ancestor instead of refusing it outright — so a typo'd
  // root silently authorized a BROADER directory than the operator named, rather than
  // being refused. rootA legitimately exists and covers `contained`, but rootGhost does
  // not exist at all: the whole call must be refused (naming rootGhost), not served by
  // silently falling back to rootA alone.
  {
    const rootGhost = join(rootsDir, 'ghost-does-not-exist');
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(JSON.stringify([rootA, rootGhost])), baseArgs(out));
    assertPolicyDenied('a configured root that does not exist on disk', frame);
    const msg = structured(frame).message ?? '';
    if (!msg.includes(rootGhost)) fail(`nonexistent-root refusal did not name the offending root: ${msg}`);
    await assertNoArtifacts('a configured root that does not exist on disk', { out, store });
  }

  // ── 6c. a configured root that exists but is a regular file, not a directory ──
  {
    const rootFile = join(rootsDir, 'not-a-directory');
    await writeFile(rootFile, 'a file, not a directory\n');
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(JSON.stringify([rootFile])), baseArgs(out));
    assertPolicyDenied('a configured root that is a regular file, not a directory', frame);
    const msg = structured(frame).message ?? '';
    if (!msg.includes(rootFile)) fail(`non-directory-root refusal did not name the offending root: ${msg}`);
    await assertNoArtifacts('a configured root that is a regular file, not a directory', { out, store });
  }

  // ── 6d. a configured root that is a symlink to a FILE — non-disclosure ────
  // Multi-model review, #838: the refusal must name the configured symlink (what the
  // operator wrote) and must NOT leak the resolved target's path — a uniquely-named
  // target file makes an accidental leak easy to catch by string search.
  {
    const uniqueTarget = join(tmp, 'unique-target-file-f83a91.txt');
    await writeFile(uniqueTarget, 'not a directory\n');
    const rootLinkToFile = join(rootsDir, 'link-to-a-file');
    await symlink(uniqueTarget, rootLinkToFile);
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(JSON.stringify([rootLinkToFile])), baseArgs(out));
    assertPolicyDenied('a configured root that is a symlink to a file', frame);
    const msg = structured(frame).message ?? '';
    if (!msg.includes(rootLinkToFile)) fail(`symlink-to-file root refusal did not name the configured root: ${msg}`);
    if (msg.includes(uniqueTarget)) fail(`symlink-to-file root refusal leaked the resolved target path: ${msg}`);
    await assertNoArtifacts('a configured root that is a symlink to a file', { out, store });
  }

  // ── 6e. a configured root that is a symlink LOOP (ELOOP) ──────────────────
  // Exercises the generic (non-ENOENT/ENOTDIR) branch of resolveConfiguredRoot()'s first
  // try/catch — a permission or loop error must still name the ORIGINAL root, not fall
  // through to underPolicy()'s generic "a root could not be resolved" wrapper, which
  // does not say WHICH root failed.
  {
    const loopA = join(rootsDir, 'loop-a');
    const loopB = join(rootsDir, 'loop-b');
    await symlink(loopB, loopA);
    await symlink(loopA, loopB);
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(JSON.stringify([loopA])), baseArgs(out));
    assertPolicyDenied('a configured root that is a symlink loop (ELOOP)', frame);
    const msg = structured(frame).message ?? '';
    if (!msg.includes(loopA)) fail(`symlink-loop root refusal did not name the offending root: ${msg}`);
    await assertNoArtifacts('a configured root that is a symlink loop (ELOOP)', { out, store });
  }

  // ── 7-10. a source the roots do not cover ─────────────────────────────────
  const escapeCases = [
    ['source outside every root', [outside], okRoots],
    // Separator-bounded containment: /roots/a must not cover /roots/ab.
    ['sibling-prefix source (/roots/a vs /roots/ab)', [rootAb], JSON.stringify([rootA])],
    ['source escaping through ..', [join(contained, '..', '..', '..', 'outside')], okRoots],
    ['source that is a symlink out of the roots', [escapeLink], okRoots],
    // One contained entry does not launder a second, uncontained one.
    ['one contained dir plus one outside dir', [contained, outside], okRoots],
  ];
  for (const [label, dirs, roots] of escapeCases) {
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(roots), {
      dirs,
      recipients: [recipientPath],
      out,
      backend: 'file',
    });
    assertPolicyDenied(label, frame);
    await assertNoArtifacts(label, { out, store });
  }

  // ── 11. an unpinned recipient ─────────────────────────────────────────────
  // The gate checks membership itself, at the MCP layer, because snapshot.ts's own
  // (authoritative) check never runs on an idempotency replay — case 13 below is the
  // bypass that forced it. So over MCP this is CB-E025, one gate earlier than the CLI.
  {
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(okRoots), {
      dirs: [contained],
      recipients: [otherRecipientPath],
      out,
      backend: 'file',
    });
    assertPolicyDenied('unpinned recipient', frame);
    await assertNoArtifacts('unpinned recipient', { out, store });
  }

  // ── 11a. a recipient file that resolves to nothing ────────────────────────
  // The membership loop must not pass vacuously on an emptied recipients file — on a
  // replay that would be a way straight through this gate (multi-model review round 2).
  {
    const emptyRec = join(tmp, 'empty-recipients.txt');
    await writeFile(emptyRec, '# nothing but a comment\n');
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(okRoots), {
      dirs: [contained],
      recipients: [emptyRec],
      out,
      backend: 'file',
    });
    assertPolicyDenied('recipient file that resolves to no recipients', frame);
    await assertNoArtifacts('recipient file that resolves to no recipients', { out, store });
  }

  // ── 11b. the refusal must not become a filesystem oracle ──────────────────
  // A containment refusal names the caller's own path and the variable to fix, and
  // NOTHING else: not the resolved target (which would let a caller read back where a
  // symlink points) and not the configured roots (the server's directory layout). The
  // detail goes to this server's stderr instead, where only the operator sees it.
  {
    // (a) the resolved target of a symlink the caller named must not come back. The
    //     caller's own path is under rootA, so rootA legitimately appears in the echo of
    //     it — what must NOT appear is where the link actually points.
    const linkFrame = await callSnapshotNow(withRoots(okRoots), {
      dirs: [escapeLink],
      recipients: [recipientPath],
      out: nextOut(),
      backend: 'file',
    });
    const linkMsg = structured(linkFrame).message ?? '';
    if (linkMsg.includes(outside)) fail('containment refusal leaked the resolved symlink target to the caller');

    // (b) the configured root list must not come back either. `outside` shares no prefix
    //     with any root, so a root appearing in this message could only have come from
    //     the server's own configuration.
    const outFrame = await callSnapshotNow(withRoots(okRoots), {
      dirs: [outside],
      recipients: [recipientPath],
      out: nextOut(),
      backend: 'file',
    });
    const outMsg = structured(outFrame).message ?? '';
    for (const root of [rootA, rootB]) {
      if (outMsg.includes(root)) fail(`containment refusal leaked a configured root (${root}) to the caller`);
    }
    if (!outMsg.includes('CYPHER_BRAIN_MCP_SOURCE_ROOTS')) fail('containment refusal did not name the variable to fix');
    console.log('  [PASS] containment refusal names the variable, not the resolved target or the root list');
  }

  // ── 11c. snapshot.ts's own pin check is still there underneath ────────────
  // The MCP gate shadows it, which is exactly how a duplicated check rots unnoticed.
  // Driving the same violation through the CLI — which has no MCP policy in front of it
  // — proves the authoritative check still refuses, under its own code.
  {
    const out = join(tmp, 'cli-unpinned.age');
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, 'snapshot', '--dir', contained, '--recipient', otherRecipientPath, '--out', out],
      {
        env: { ...process.env, CYPHER_BRAIN_HOME: home, CYPHER_BRAIN_PIN_RECIPIENTS: recipientPath },
        encoding: 'utf8',
      },
    );
    if (res.status === 0) fail("CLI pin check: an unpinned recipient was accepted — snapshot.ts's own check is gone");
    if (!/CB-E005/.test(res.stderr ?? ''))
      fail(`CLI pin check: expected CB-E005, got: ${(res.stderr ?? '').slice(-400)}`);
    if (existsSync(out)) fail('CLI pin check: refused but still wrote ciphertext');
    console.log("  [PASS] snapshot.ts's own pin check still refuses an unpinned recipient on the CLI (CB-E005)");
  }

  // ── 12. a replay is not grandfathered past a tightened policy ─────────────
  {
    const out = nextOut();
    const key = 'policy-replay-key';
    const locatorFile = join(home, 'replay-locator.tsv');
    const first = await callSnapshotNow(withRoots(okRoots), baseArgs(out, { idempotency_key: key }));
    if (first.result?.isError)
      fail(`replay setup: the permitted call failed: ${JSON.stringify(first.result).slice(0, 500)}`);
    if (!existsSync(idempotencyLog)) fail('replay setup: no idempotency log was written by the permitted call');
    // Same HOME (so the recorded key is still there), same arguments — but the operator
    // has since narrowed the roots so this source is no longer authorized. The replay
    // must be refused rather than served from cache, and must not write the locator file
    // the replay path would otherwise write.
    const second = await callSnapshotNow(withRoots(JSON.stringify([rootB])), {
      ...baseArgs(out, { idempotency_key: key }),
      locator_file: locatorFile,
    });
    assertPolicyDenied('replay of a now-denied call', second);
    if (existsSync(locatorFile)) fail('replay of a now-denied call still wrote its locator_file');
    console.log('  [PASS] replay of a now-denied call — denied before the idempotency lookup, no locator written');
  }

  // ── 13. a replay after the PIN changed ────────────────────────────────────
  // The other half of "replays are not grandfathered", and the one a naive gate misses
  // (multi-model review, #800 — Critical): the roots still cover the source, but the
  // operator has narrowed the pin, and snapshot.ts's own recipient check — the
  // authoritative one — never runs on a replay. Without a membership check at this
  // layer, the stored result for the now-unpinned recipient comes straight back out of
  // the cache, locator file and all.
  {
    const out = nextOut();
    const key = 'policy-replay-pin-key';
    const locatorFile = join(home, 'replay-pin-locator.tsv');
    const args = {
      dirs: [contained],
      recipients: [recipientPath],
      out,
      backend: 'file',
      idempotency_key: key,
    };
    const first = await callSnapshotNow(withRoots(okRoots), args);
    if (first.result?.isError)
      fail(`pin-replay setup: the permitted call failed: ${JSON.stringify(first.result).slice(0, 500)}`);
    // Same roots, same arguments — only the pin moved to a key this call does not name.
    const narrowed = { ...withRoots(okRoots), CYPHER_BRAIN_PIN_RECIPIENTS: otherRecipientPath };
    const second = await callSnapshotNow(narrowed, { ...args, locator_file: locatorFile });
    assertPolicyDenied('replay after the recipient pin narrowed', second);
    if (existsSync(locatorFile)) fail('replay after a narrowed pin still wrote its locator_file');
    console.log('  [PASS] replay after the recipient pin narrowed — denied, no locator written');
  }

  console.log('MCP SNAPSHOT POLICY (#800): green cases');

  // Clear the store/log between the red and green halves so the green assertions below
  // start from a known-empty state rather than inheriting case 12's artifacts.
  await rm(store, { recursive: true, force: true });
  await mkdir(store, { recursive: true });
  await rm(idempotencyLog, { force: true });

  // ── contained source, and multiple roots ──────────────────────────────────
  for (const [label, dir] of [
    ['contained source under the first root', contained],
    ['contained source under the SECOND root', join(rootB, 'second')],
  ]) {
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(okRoots), {
      dirs: [dir],
      recipients: [recipientPath],
      out,
      backend: 'file',
    });
    if (frame.result?.isError) fail(`${label}: expected success, got ${JSON.stringify(frame.result).slice(0, 500)}`);
    if (!existsSync(out)) fail(`${label}: reported success but wrote no ciphertext at ${out}`);
    if (structured(frame).pushed !== true)
      fail(`${label}: expected pushed:true, got ${JSON.stringify(structured(frame))}`);
    console.log(`  [PASS] ${label} — snapshot + push allowed`);
  }

  // ── a dirs entry that is exactly a root ───────────────────────────────────
  // Exact match, not just containment: a root is itself an authorized source.
  {
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(okRoots), {
      dirs: [rootB],
      recipients: [recipientPath],
      out,
      backend: 'file',
    });
    if (frame.result?.isError)
      fail(`dirs entry equal to a root: expected success, got ${JSON.stringify(frame.result).slice(0, 500)}`);
    console.log('  [PASS] a dirs entry that IS a root — allowed (exact match, not only containment)');
  }

  // ── a configured root that is a symlink to a directory is accepted (#838) ────
  // resolveConfiguredRoot() fully realpaths a root before checking it exists and is a
  // directory — a root that is ITSELF a symlink resolves to its target, and that
  // resolved target is what containment compares against: the same "resolve symlinks on
  // both sides before comparing" rule this policy already applies to every `dirs` entry.
  // Chosen over refusing a symlinked root outright for consistency with that existing
  // rule, rather than introducing a second, different symlink policy just for roots.
  {
    const rootLink = join(rootsDir, 'link-to-b');
    await symlink(rootB, rootLink);
    const out = nextOut();
    const frame = await callSnapshotNow(withRoots(JSON.stringify([rootLink])), {
      dirs: [join(rootB, 'second')],
      recipients: [recipientPath],
      out,
      backend: 'file',
    });
    if (frame.result?.isError)
      fail(
        `root that is a symlink to a directory: expected success, got ${JSON.stringify(frame.result).slice(0, 500)}`,
      );
    if (!existsSync(out)) fail('root-symlink case: reported success but wrote no ciphertext');
    console.log('  [PASS] a configured root that is a symlink to a directory — accepted, resolved target compared');
  }

  // ── a pinned pg-only call needs no roots at all ───────────────────────────
  // It cannot SUCCEED here (there is no Postgres to dump), and it is not this test's job
  // to stand one up. What it must not be is denied by the policy: the assertion is that
  // the refusal comes from the pg attempt, NOT from ERR_POLICY_DENIED / CB-E025.
  {
    const out = nextOut();
    const env = { ...pinned };
    delete env.CYPHER_BRAIN_MCP_SOURCE_ROOTS;
    const frame = await callSnapshotNow(env, {
      pg: 'postgres://nobody@127.0.0.1:1/nope',
      recipients: [recipientPath],
      out,
      backend: 'file',
    });
    const sc = structured(frame);
    if (sc.code === 'ERR_POLICY_DENIED' || sc.cb_code === 'CB-E025')
      fail(`pg-only call with no roots was denied by the policy: ${JSON.stringify(sc.message).slice(0, 400)}`);
    console.log('  [PASS] pinned pg-only call with NO roots configured — the policy lets it through');
  }

  // ── the CLI is unchanged ──────────────────────────────────────────────────
  // Same source the MCP server just refused (outside every root), with neither policy
  // variable set: the CLI must still snapshot it. #800 is an MCP-layer policy, and a
  // regression that leaked it into src/lib would break every existing CLI cadence.
  {
    const out = join(tmp, 'cli-out.age');
    const cliEnv = { ...process.env, CYPHER_BRAIN_HOME: home, CYPHER_BRAIN_FILE_DIR: store };
    delete cliEnv.CYPHER_BRAIN_PIN_RECIPIENTS;
    delete cliEnv.CYPHER_BRAIN_MCP_SOURCE_ROOTS;
    const res = spawnSync(
      process.execPath,
      [CLI_PATH, 'snapshot', '--dir', outside, '--recipient', recipientPath, '--out', out],
      { env: cliEnv, encoding: 'utf8' },
    );
    if (res.status !== 0) fail(`CLI snapshot regressed (${res.status}): ${res.stderr || res.stdout}`);
    if (!existsSync(out)) fail('CLI snapshot reported success but wrote no ciphertext');
    console.log('  [PASS] CLI `snapshot` of an unrooted, unpinned source — unchanged');
  }

  console.log('MCP SNAPSHOT POLICY: PASS');
}

main().catch((e) => {
  console.error(`[FAIL] ${e?.message ?? e}`);
  process.exit(1);
});
