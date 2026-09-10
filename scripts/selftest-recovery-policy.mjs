#!/usr/bin/env node
// Real local round trips, following the recipient-pin and MCP policy selftests.
// Optional group argument supports independent red/green mutation checks.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'cb-recovery-policy-'));
const group = process.argv[2];
assert.ok(!group || ['recipient', 'pq', 'signature', 'doctor'].includes(group), 'unknown test group');
const base = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !/^(CYPHER_BRAIN_|CIPHER_BRAIN_|OTEL_)/.test(key)),
);
Object.assign(base, {
  CYPHER_BRAIN_HOME: join(tmp, 'home'),
  GBRAIN_HOME: join(tmp, 'gbrain'),
  CYPHER_BRAIN_SCHEDULE_DIR: join(tmp, 'schedule'),
  CYPHER_BRAIN_FILE_DIR: join(tmp, 'store'),
  CYPHER_BRAIN_NO_MASCOT: '1',
  TMPDIR: join(tmp, 'stage'),
});
mkdirSync(base.TMPDIR);
const cli = (args, env = {}) => {
  const r = spawnSync(process.execPath, [join(root, 'dist/cli.mjs'), ...args], {
    env: { ...base, ...env },
    encoding: 'utf8',
    timeout: 30000,
  });
  assert.ifError(r.error);
  assert.equal(r.signal, null, `CLI signal: ${r.signal}`);
  return { ...r, output: r.stdout + r.stderr };
};
const ok = (r) => {
  assert.equal(r.status, 0, r.output);
  return r;
};
let passes = 0;
function test(name, fn) {
  fn();
  passes++;
  console.log(`[PASS] ${name}`);
}
const home = base.CYPHER_BRAIN_HOME;
const backup = join(tmp, 'backup');
const pq = join(tmp, 'pq');
const pq2 = join(tmp, 'pq2');
const rec = (dir) => join(dir, 'recipient.txt');
const key = (dir) =>
  readFileSync(rec(dir), 'utf8')
    .split('\n')
    .find((line) => line.startsWith('age1'));
const src = join(tmp, 'source');
mkdirSync(src);
writeFileSync(join(src, 'proof.txt'), 'policy positive control\n');
// A real tar wrapper records staging. A refusal must happen before even the first
// source archive is made, not merely before the final encrypted output is renamed.
const bin = join(tmp, 'bin');
mkdirSync(bin);
const tar = spawnSync('which', ['tar'], { encoding: 'utf8' }).stdout.trim();
assert.ok(tar.startsWith('/'));
writeFileSync(
  join(bin, 'tar'),
  `#!/bin/sh\nprintf 'tar\\n' >> "$POLICY_TAR_LOG"\nexec '${tar.replaceAll("'", "'\\''")}' "$@"\n`,
  { mode: 0o700 },
);
base.PATH = `${bin}:${base.PATH}`;
base.POLICY_TAR_LOG = join(tmp, 'tar.log');
let serial = 0;
function snapshot(recipients, env, refuse) {
  const out = join(home, `snapshot-${serial++}.age`);
  rmSync(base.POLICY_TAR_LOG, { force: true });
  const r = cli(
    [
      'snapshot',
      '--dir',
      src,
      '--scan-secrets',
      'off',
      '--no-sign',
      '--out',
      out,
      ...recipients.flatMap((r) => ['--recipient', r]),
    ],
    env,
  );
  if (refuse) {
    assert.notEqual(r.status, 0, `snapshot unexpectedly succeeded under ${refuse}`);
    assert.match(r.output, refuse);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(base.POLICY_TAR_LOG), false, 'refusal must precede plaintext staging');
    assert.deepEqual(readdirSync(base.TMPDIR), []);
  } else {
    ok(r);
    assert.ok(existsSync(out));
    assert.ok(existsSync(base.POLICY_TAR_LOG), 'positive control must actually stage and encrypt');
  }
  return out;
}
function proof(out, identity = join(home, 'identity.age')) {
  const report = JSON.parse(ok(cli(['verify', '--in', out, '--identity', identity, '--json'])).stdout);
  assert.equal(report.verdict, 'PASS');
}
async function mcp(name, args, env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'dist/mcp.mjs')],
    env: { ...base, ...env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'recovery-policy-selftest', version: '1' });
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}
async function mcpSnapshotPolicy(env, deniedRecipients, allowedRecipients, reason, identity) {
  const policyEnv = {
    CYPHER_BRAIN_PIN_RECIPIENTS: [home, backup, pq, pq2].map(key).join(','),
    CYPHER_BRAIN_MCP_SOURCE_ROOTS: JSON.stringify([src]),
    ...env,
  };
  for (const [recipients, denied] of [
    [deniedRecipients, true],
    [allowedRecipients, false],
  ]) {
    const out = join(home, `mcp-snapshot-${serial++}.age`);
    rmSync(base.POLICY_TAR_LOG, { force: true });
    const result = await mcp('snapshot_now', { dirs: [src], recipients, out, scan_secrets: 'off' }, policyEnv);
    test(`MCP snapshot ${reason}: ${denied ? 'refuses before staging' : 'round trips'}`, () => {
      if (denied) {
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.match(JSON.stringify(result), new RegExp(reason));
        assert.equal(existsSync(out), false);
        assert.equal(existsSync(base.POLICY_TAR_LOG), false);
      } else {
        assert.notEqual(result.isError, true, JSON.stringify(result));
        proof(out, identity);
      }
    });
  }
}

try {
  ok(cli(['keygen']));
  ok(cli(['keygen'], { CYPHER_BRAIN_HOME: backup }));
  ok(cli(['keygen', '--pq'], { CYPHER_BRAIN_HOME: pq }));
  ok(cli(['keygen', '--pq'], { CYPHER_BRAIN_HOME: pq2 }));
  if (!group || group === 'recipient') {
    const env = { CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(backup) };
    test('required recipient missing refuses before staging', () =>
      snapshot([rec(home)], env, /CYPHER_BRAIN_REQUIRE_RECIPIENT.*missing/));
    test('required recovery recipient present encrypts and decrypts with backup identity', () =>
      proof(snapshot([rec(home), rec(backup)], env), join(backup, 'identity.age')));
    test('comma-separated files require every key', () => {
      const both = { CYPHER_BRAIN_REQUIRE_RECIPIENT: `${rec(home)},${rec(backup)}` };
      snapshot([rec(home)], both, /CYPHER_BRAIN_REQUIRE_RECIPIENT.*missing/);
      proof(snapshot([rec(home), rec(backup)], both));
    });
    test('empty requirement fails closed', () =>
      snapshot([rec(home)], { CYPHER_BRAIN_REQUIRE_RECIPIENT: '' }, /CYPHER_BRAIN_REQUIRE_RECIPIENT is set but empty/));
    test('empty/comment-only file and missing file fail closed', () => {
      const empty = join(tmp, 'empty.txt');
      writeFileSync(empty, `# ${key(home)}\n`);
      for (const value of [empty, `${rec(home)},${empty}`, `${rec(home)},${tmp}/missing`, `${rec(home)},`])
        snapshot([rec(home)], { CYPHER_BRAIN_REQUIRE_RECIPIENT: value }, /CYPHER_BRAIN_REQUIRE_RECIPIENT.*no age1/);
    });
    test('literal 0 disables the requirement', () =>
      proof(snapshot([rec(home)], { CYPHER_BRAIN_REQUIRE_RECIPIENT: '0' })));
    test('required list and pin remain independent', () => {
      const env = { CYPHER_BRAIN_PIN_RECIPIENTS: rec(home), CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(backup) };
      snapshot([rec(home)], env, /CYPHER_BRAIN_REQUIRE_RECIPIENT.*missing/);
      snapshot([rec(home), rec(backup)], env, /NOT in CYPHER_BRAIN_PIN_RECIPIENTS/);
    });
    await mcpSnapshotPolicy(
      { CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(backup) },
      [rec(home)],
      [rec(home), rec(backup)],
      'CYPHER_BRAIN_REQUIRE_RECIPIENT',
      join(backup, 'identity.age'),
    );
  }
  if (!group || group === 'pq') {
    const env = { CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS: '1' };
    test('PQ policy rejects classical recipient before staging', () =>
      snapshot([rec(home)], env, /CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS=1/));
    test('PQ policy rejects mixed recipient set', () =>
      snapshot([rec(pq), rec(home)], env, /CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS=1/));
    test('all-PQ set with required keys and pin round trips', () => {
      const keys = `${key(pq)},${key(pq2)}`;
      proof(
        snapshot([rec(pq), rec(pq2)], {
          ...env,
          CYPHER_BRAIN_REQUIRE_RECIPIENT: `${rec(pq)},${rec(pq2)}`,
          CYPHER_BRAIN_PIN_RECIPIENTS: keys,
        }),
        join(pq2, 'identity.age'),
      );
    });
    test('PQ policy enables only for literal 1', () => {
      for (const value of ['0', 'true', ''])
        proof(snapshot([rec(home)], { CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS: value }));
    });
    await mcpSnapshotPolicy(
      env,
      [rec(home)],
      [rec(pq), rec(pq2)],
      'CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS',
      join(pq, 'identity.age'),
    );
  }
  if (!group || group === 'signature') {
    const out = snapshot([rec(home)], {});
    const env = { CYPHER_BRAIN_REQUIRE_SIGNATURE: '1' };
    const args = (cmd) => [
      cmd,
      '--in',
      out,
      ...(cmd === 'restore' ? ['--out-dir', join(tmp, `restored-${serial++}`)] : ['--json']),
    ];
    for (const cmd of ['restore', 'verify']) {
      test(`${cmd} env default refuses missing signature`, () => {
        const callArgs = args(cmd);
        const r = cli(callArgs, env);
        assert.notEqual(r.status, 0, `${cmd} unexpectedly accepted an unsigned artifact under env default`);
        if (cmd === 'restore')
          assert.equal(existsSync(callArgs.at(-1)), false, 'refused restore wrote an output directory');
        if (cmd === 'verify') {
          const report = JSON.parse(r.stdout);
          assert.equal(report.verdict, 'FAIL');
          assert.equal(report.checks.signature, 'fail');
        } else assert.match(r.output, /require-signature/);
      });
      test(`${cmd} explicit negative overrides env and performs recovery`, () => {
        const r = ok(cli([...args(cmd), '--no-require-signature'], env));
        if (cmd === 'verify') assert.equal(JSON.parse(r.stdout).checks.signature, 'skip');
        else assert.match(r.output, /warning:.*unsigned/);
      });
      test(`${cmd} explicit positive wins over disabled env`, () =>
        assert.notEqual(cli([...args(cmd), '--require-signature'], { CYPHER_BRAIN_REQUIRE_SIGNATURE: '0' }).status, 0));
      test(`${cmd} rejects conflicting flags`, () =>
        assert.match(
          cli([...args(cmd), '--require-signature', '--no-require-signature'], env).output,
          /mutually exclusive/,
        ));
      test(`${cmd} strict-1 parsing preserves legacy behavior`, () =>
        ok(cli(args(cmd), { CYPHER_BRAIN_REQUIRE_SIGNATURE: 'true' })));
    }
    for (const name of ['verify_restore', 'restore_now']) {
      for (const value of [undefined, false, true]) {
        const result = await mcp(
          name,
          {
            file: out,
            ...(name === 'restore_now' ? { out_dir: join(tmp, `mcp-restored-${serial++}`), confirm_write: true } : {}),
            ...(value === undefined ? {} : { require_signature: value }),
          },
          env,
        );
        test(`${name} MCP require_signature=${value} honors env/override`, () => {
          if (name === 'restore_now') assert.equal(result.isError === true, value !== false, JSON.stringify(result));
          if (name === 'verify_restore')
            assert.equal(result.structuredContent.verdict, value === false ? 'PASS' : 'FAIL');
        });
      }
    }
    for (const name of ['verify_restore', 'restore_now']) {
      const result = await mcp(
        name,
        {
          file: out,
          require_signature: true,
          ...(name === 'restore_now' ? { out_dir: join(tmp, 'mcp-true-off'), confirm_write: true } : {}),
        },
        { CYPHER_BRAIN_REQUIRE_SIGNATURE: '0' },
      );
      test(`${name} MCP explicit true overrides disabled env`, () => {
        if (name === 'restore_now') assert.equal(result.isError, true);
        else assert.equal(result.structuredContent.verdict, 'FAIL');
      });
    }
    ok(cli(['keygen', '--sign']));
    const signed = join(home, 'signed.age');
    ok(cli(['snapshot', '--dir', src, '--scan-secrets', 'off', '--out', signed]));
    test('signed snapshot passes signature env policy', () => {
      ok(cli(['verify', '--in', signed, '--json'], env));
      ok(cli(['restore', '--in', signed, '--out-dir', join(tmp, 'signed-restore')], env));
    });
    test('signature default also refuses a signed artifact without a trusted public key', () => {
      for (const cmd of ['restore', 'verify']) {
        const args = [
          cmd,
          '--in',
          signed,
          '--identity',
          join(home, 'identity.age'),
          ...(cmd === 'restore' ? ['--out-dir', join(tmp, 'missing-pubkey-restore')] : ['--json']),
        ];
        const noPub = { ...env, CYPHER_BRAIN_HOME: backup };
        const r = cli(args, noPub);
        assert.notEqual(r.status, 0);
        if (cmd === 'verify') assert.equal(JSON.parse(r.stdout).checks.signature, 'fail');
        else assert.match(r.output, /require-signature/);
        ok(cli([...args, '--no-require-signature'], noPub));
      }
    });
    const sig = `${signed}.minisig`;
    writeFileSync(sig, 'invalid signature\n');
    test('negative override never accepts an invalid signature', () => {
      for (const cmd of ['restore', 'verify'])
        assert.notEqual(
          cli(
            [
              cmd,
              '--in',
              signed,
              '--no-require-signature',
              ...(cmd === 'restore' ? ['--out-dir', join(tmp, 'invalid-restore')] : []),
            ],
            env,
          ).status,
          0,
        );
    });
  }
  if (!group || group === 'doctor') {
    function check(id, env, status) {
      const r = cli(['doctor', '--json'], env);
      const check = JSON.parse(r.stdout).checks.find((c) => c.id === id);
      assert.ok(check, r.output);
      assert.equal(check.status, status, JSON.stringify(check));
    }
    test('doctor required recipient drift and healthy controls', () => {
      check('require-recipient-config', { CYPHER_BRAIN_REQUIRE_RECIPIENT: '' }, 'fail');
      check('require-recipient-config', { CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(backup) }, 'warn');
      check('require-recipient-config', { CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(home) }, 'pass');
      check('require-recipient-config', { CYPHER_BRAIN_REQUIRE_RECIPIENT: '0' }, 'skip');
    });
    test('doctor PQ drift and healthy control', () => {
      check('require-pq-recipients', { CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS: '1' }, 'warn');
      check('require-pq-recipients', { CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS: '1', CYPHER_BRAIN_HOME: pq }, 'pass');
    });
    test('doctor detects incompatible recipient policies', () => {
      check(
        'require-recipient-config',
        { CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(home), CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS: '1' },
        'fail',
      );
      check(
        'require-recipient-config',
        { CYPHER_BRAIN_REQUIRE_RECIPIENT: rec(home), CYPHER_BRAIN_PIN_RECIPIENTS: rec(backup) },
        'fail',
      );
    });
    test('config.env loads all three policies and explicit environment wins', () => {
      const config = join(home, 'config.env');
      writeFileSync(
        config,
        `CYPHER_BRAIN_REQUIRE_RECIPIENT=${rec(home)}\nCYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS=1\nCYPHER_BRAIN_REQUIRE_SIGNATURE=1\n`,
        { mode: 0o600 },
      );
      try {
        check('require-recipient-config', {}, 'fail');
        check('require-pq-recipients', {}, 'warn');
        check('require-signature', { CYPHER_BRAIN_REQUIRE_SIGNATURE: '0' }, 'skip');
        check('require-recipient-config', { CYPHER_BRAIN_REQUIRE_PQ_RECIPIENTS: '0' }, 'pass');
      } finally {
        rmSync(config);
      }
    });
    test('doctor signature missing key and healthy control', () => {
      check('require-signature', { CYPHER_BRAIN_REQUIRE_SIGNATURE: '1', CYPHER_BRAIN_HOME: backup }, 'warn');
      if (!existsSync(join(home, 'sign-recipient.pub'))) ok(cli(['keygen', '--sign']));
      check('require-signature', { CYPHER_BRAIN_REQUIRE_SIGNATURE: '1' }, 'pass');
      writeFileSync(join(home, 'sign-recipient.pub'), 'malformed\n');
      check('require-signature', { CYPHER_BRAIN_REQUIRE_SIGNATURE: '1' }, 'fail');
    });
  }
  console.log(`Recovery policy selftest: ${passes} passed, 0 failed`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
