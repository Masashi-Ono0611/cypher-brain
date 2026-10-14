#!/usr/bin/env node
// #960: tar's end-of-archive marker is not the encrypted stream's EOF. A reader
// that exits at the marker can close stdin while authenticated padding is still
// being decrypted, producing EPIPE. Force the ordering with 4 MiB of legal zero
// padding, rather than hoping a CI scheduler hits the small default padding tail.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEV_ARGS } from './dev-node-flags.mjs';
import { generateKeypair, identityFileText, newEncrypter, newDecrypter } from '../src/lib/crypt.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await mkdtemp(join(tmpdir(), 'cb-tar-eof-'));
let failed = 0;
const check = (name, ok) => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
  if (!ok) failed++;
};
const cli = (...args) =>
  spawnSync(process.execPath, [...DEV_ARGS, join(ROOT, 'bin/cypher-brain.mjs'), ...args], {
    env: { ...process.env, CYPHER_BRAIN_HOME: join(tmp, 'home'), CYPHER_BRAIN_FILE_DIR: join(tmp, 'store') },
    encoding: 'utf8',
    timeout: 30_000,
  });
try {
  const key = await generateKeypair();
  const backup = await generateKeypair();
  await mkdir(join(tmp, 'home'));
  await writeFile(join(tmp, 'home/identity.age'), identityFileText(key.identity, key.recipient), { mode: 0o600 });
  await writeFile(join(tmp, 'recipient.txt'), key.recipient);
  await writeFile(join(tmp, 'home/recipient.txt'), key.recipient);
  await writeFile(join(tmp, 'backup.age'), identityFileText(backup.identity, backup.recipient), { mode: 0o600 });
  await mkdir(join(tmp, 'source'));
  await writeFile(join(tmp, 'source/fixture.txt'), 'only synthetic data');
  const snapshot = cli(
    'snapshot',
    '--dir',
    join(tmp, 'source'),
    '--recipient',
    join(tmp, 'recipient.txt'),
    '--scan-secrets',
    'off',
    '--out',
    join(tmp, 'original.age'),
  );
  assert.equal(snapshot.status, 0, 'synthetic snapshot setup must succeed');
  const plain = await newDecrypter([key.identity]).decrypt(await readFile(join(tmp, 'original.age')));
  const padded = Buffer.concat([plain, Buffer.alloc(4 * 1024 * 1024)]);
  const encrypted = await newEncrypter([key.recipient, backup.recipient]).encrypt(padded);
  await writeFile(join(tmp, 'padded.age'), encrypted);
  const restore = cli('restore', '--in', join(tmp, 'padded.age'), '--out-dir', join(tmp, 'out'));
  check('authenticated zero padding restores without an early tar exit / EPIPE', restore.status === 0);
  if (restore.status === 0) {
    const tar = spawnSync('tar', ['-xzf', join(tmp, 'out/source.tar.gz'), '-C', join(tmp, 'out')]);
    check(
      'restored component content is intact',
      tar.status === 0 && (await readFile(join(tmp, 'out/source/fixture.txt'), 'utf8')) === 'only synthetic data',
    );
  } else check('restored component content is intact', false);
  const verify = cli('verify', '--in', join(tmp, 'padded.age'), '--json');
  let result;
  try {
    result = JSON.parse(verify.stdout);
  } catch {}
  check(
    'verify consumes the padded ciphertext and passes its positive control',
    verify.status === 0 && result?.checks?.positive_control === 'pass',
  );

  await mkdir(join(tmp, 'store'));
  const locator = async (name, bytes) => {
    const path = join(tmp, `${name}.tsv`);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const object = join(tmp, 'store', `${hash}.age`);
    await writeFile(object, bytes);
    await writeFile(path, `${object}\tfile\t${hash}\n`);
    return path;
  };
  const kit = cli(
    'recovery-kit',
    '--from-locator-file',
    await locator('padded', encrypted),
    '--backup-identity',
    join(tmp, 'backup.age'),
  );
  // The captured kit contains this test's synthetic private identity: never log it.
  check(
    'recovery-kit verifies the embedded identity against a padded target',
    kit.status === 0 && kit.stdout.includes('BEGIN BACKUP IDENTITY FILE'),
  );

  // Authentication must still finish after tar's logical EOF: no successful
  // restore/verify may hide a corrupt final age chunk in the padded tail.
  const corrupt = Buffer.from(encrypted);
  corrupt[corrupt.length - 1] ^= 1;
  await writeFile(join(tmp, 'corrupt.age'), corrupt);
  check(
    'corrupt authentication tag after logical tar EOF is rejected by restore',
    cli('restore', '--in', join(tmp, 'corrupt.age'), '--out-dir', join(tmp, 'bad-out')).status !== 0,
  );
  const corruptVerify = cli('verify', '--in', join(tmp, 'corrupt.age'), '--json');
  check('corrupt padded tail is rejected by verify', corruptVerify.status !== 0);
  const corruptKit = cli(
    'recovery-kit',
    '--from-locator-file',
    await locator('corrupt', corrupt),
    '--backup-identity',
    join(tmp, 'backup.age'),
  );
  check(
    'recovery-kit refuses to embed an identity when the padded target is corrupt',
    corruptKit.status !== 0 && !corruptKit.stdout.includes('BEGIN BACKUP IDENTITY FILE'),
  );

  check(
    'rejected ciphertext leaves neither promoted output nor plaintext scratch',
    !(await readdir(tmp)).some((name) => name === 'bad-out' || name.startsWith('bad-out.restore-')),
  );

  // --ignore-zeros also exposes concatenated entries to the SAME inspection as
  // extraction. A FIFO member after the first EOF must not bypass #218.
  assert.equal(spawnSync('mkfifo', [join(tmp, 'unexpected.pipe')]).status, 0, 'FIFO fixture setup must succeed');
  const extra = spawnSync('tar', ['-cf', join(tmp, 'extra.tar'), '-C', tmp, 'unexpected.pipe']);
  assert.equal(extra.status, 0, 'concatenated archive fixture setup must succeed');
  const concatenated = Buffer.concat([padded, await readFile(join(tmp, 'extra.tar'))]);
  await writeFile(join(tmp, 'concatenated.age'), await newEncrypter([key.recipient]).encrypt(concatenated));
  const hidden = cli('restore', '--in', join(tmp, 'concatenated.age'), '--out-dir', join(tmp, 'hidden-out'));
  check(
    'a concatenated FIFO is refused before extraction',
    hidden.status !== 0 && /fifo.*refusing to extract/i.test(hidden.stderr),
  );
  check(
    'concatenated archive rejection leaves no promoted output or scratch',
    !(await readdir(tmp)).some((name) => name === 'hidden-out' || name.startsWith('hidden-out.restore-')),
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
