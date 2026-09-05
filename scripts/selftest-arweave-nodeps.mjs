#!/usr/bin/env node
// Proof for #31: a gateway PULL of an arweave/turbo (ANS-104 bundled) artifact needs
// NO npm dependency. We run a COPY of the CLI from a directory with no node_modules
// (so `import('arweave')` fails) against a mock gateway and assert the pull still
// succeeds byte-identically — the documented "a fresh machine restores with just the
// tx id" must hold for the bundled path that the real 268 MB brain used.
//
// The mock gateway runs in a SEPARATE process: the pull is spawnSync (blocking), so an
// in-process server could not answer it. This script itself imports NO third-party pkg.
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DEV_ARGS } from './dev-node-flags.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', 'bin', 'cypher-brain.mjs');
const tmp = await mkdtemp(join(tmpdir(), 'cb-nodeps-'));
let failed = false;
const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.log(`[FAIL] ${m}`);
  failed = true;
};
let server;

try {
  // 1) make a small age artifact — keygen + snapshot are SDK-free
  const home = join(tmp, 'keys');
  // BIN (bin/cypher-brain.mjs) imports src/cli.ts directly (no build step); plain node
  // needs help resolving its internal `.js`-specifier imports back to sibling .ts files
  // (#63) — see scripts/dev-ts-resolve-hook.mjs. isoBin below is dist/cli.mjs (bundled,
  // pure JS) and needs none of this. DEV_ARGS (scripts/dev-node-flags.mjs) is passed as
  // literal argv elements — never via env.NODE_OPTIONS, which is whitespace-split by
  // node and would break under a checkout path containing a space.
  const cb = (...a) =>
    spawnSync('node', [...DEV_ARGS, BIN, ...a], { env: { ...process.env, CYPHER_BRAIN_HOME: home }, encoding: 'utf8' });
  if (cb('keygen').status !== 0) throw new Error('keygen failed');
  const src = join(tmp, 'brain');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'note.txt'), 'nodeps\n');
  const snap = join(tmp, 'snap.age');
  if (cb('snapshot', '--dir', src, '--out', snap).status !== 0) throw new Error('snapshot failed');
  const bytes = await readFile(snap);

  // 2) a SEPARATE-process mock gateway that serves those bytes (spawnSync below would
  //    otherwise block an in-process server's event loop)
  const srvFile = join(tmp, 'mockgw.mjs');
  await writeFile(
    srvFile,
    "import {createServer} from 'node:http'; import {readFileSync} from 'node:fs';\n" +
      'const f=process.argv[2]; const b=readFileSync(f);\n' +
      'const s=createServer((q,res)=>{res.writeHead(200);res.end(b);});\n' +
      "s.on('error',(e)=>{console.error('mockgw: '+e.message);process.exit(1);});\n" +
      "s.listen(0,'127.0.0.1',()=>console.log('READY:'+s.address().port)); // OS-assigned port — no hardcoded-port flake\n",
  );
  server = spawn('node', [srvFile, snap], { stdio: ['ignore', 'pipe', 'pipe'] });
  const PORT = await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('mock gateway did not start')), 5000);
    server.stdout.on('data', (d) => {
      const m = String(d).match(/READY:(\d+)/);
      if (m) {
        clearTimeout(to);
        res(m[1]);
      }
    });
    server.on('exit', (c) => {
      clearTimeout(to);
      rej(new Error(`mock gateway exited early (${c})`));
    });
  });

  // 3) a COPY of the CLI in a dir with NO node_modules -> import('arweave') fails there.
  //    Use the BUNDLED dist/cli.mjs — that is the artifact a fresh machine actually
  //    runs, with the crypto layer (typage) inlined and the storage SDKs external —
  //    so this proves the shipped file itself pulls with zero npm dependencies.
  const distCli = join(HERE, '..', 'dist', 'cli.mjs');
  const isoDir = join(tmp, 'iso');
  await mkdir(isoDir, { recursive: true });
  const isoBin = join(isoDir, 'cli.mjs');
  await copyFile(distCli, isoBin).catch(() => {
    throw new Error('dist/cli.mjs not found — run `npm run build` first');
  });

  // control: confirm arweave is genuinely unresolvable from the isolated dir, so the
  // pull's success below actually proves "no dependency" (not a leaked node_modules)
  const probe = spawnSync(
    'node',
    [
      '--input-type=module',
      '-e',
      "import('arweave').then(()=>process.exit(9)).catch(e=>process.exit(e&&e.code==='ERR_MODULE_NOT_FOUND'?0:9))",
    ],
    { cwd: isoDir, encoding: 'utf8' },
  );
  probe.status === 0
    ? pass('control: `arweave` is genuinely unresolvable from the isolated dir')
    : fail('control: `arweave` WAS resolvable — test is not isolating the dependency');

  // 4) pull via the gateway. AR_PORT=1 dead-ends the L1 chunk fallback; with no SDK that
  //    fallback is skipped and the pure-fetch gateway path must serve the bytes.
  const loc = 'A'.repeat(43);
  const out = join(tmp, 'got.age');
  const r = spawnSync('node', [isoBin, 'pull', '--backend', 'arweave', '--locator', loc, '--out', out], {
    env: { ...process.env, CYPHER_BRAIN_AR_PORT: '1', CYPHER_BRAIN_AR_GATEWAYS: `http://127.0.0.1:${PORT}` },
    encoding: 'utf8',
    timeout: 15000,
  });
  if (r.status !== 0) {
    fail(`gateway pull failed without the arweave package: ${(r.stderr || '').slice(0, 200)}`);
  } else {
    const got = await readFile(out);
    got.equals(bytes)
      ? pass('gateway pull works with NO arweave npm package (bundled recovery needs only the tx id)')
      : fail('pulled bytes differ from the source');
  }
} catch (e) {
  fail(`exception: ${e.message}`);
} finally {
  if (server) server.kill('SIGKILL');
  // This one really does hold a working age private key — the suite runs `keygen` into it —
  // and it was left behind on every run, which is what #328 was filed on. Same posture
  // snapshot() takes with its staged plaintext. Reported through fail() (not swallowed)
  // rather than thrown, so a cleanup failure cannot replace the error the test was actually
  // reporting, but a standalone run of this script — `npm run verify`'s own TMPDIR hygiene
  // check only inspects this directory when the suite runs through that wrapper — still
  // fails instead of quietly leaving key material behind.
  try {
    await rm(tmp, { recursive: true, force: true });
  } catch (e) {
    fail(`could not remove ${tmp} (private key material may remain there): ${e.message}`);
  }
}

console.log('');
if (failed) {
  console.log('ARWEAVE NO-DEPS: FAIL');
  process.exit(1);
}
console.log('ARWEAVE NO-DEPS: PASS (a gateway pull needs no npm dependency)');
