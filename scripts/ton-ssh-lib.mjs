// Shared SSH injection-allowlist helper for the operator-run TON scripts
// (scripts/ton-dogfood.mjs, scripts/ton-provider-experiment.mjs) — mirrors the
// allowlist idea in src/lib/backends/ton.ts: every value interpolated into a
// REMOTE shell command line must pass a narrow character allowlist first,
// since the remote side is a real shell.
//
// Previously this exact block (HOST_RE/API_RE/HEX64_RE, assertSafe(),
// sshBaseArgs(), sshRun()) was copy-pasted byte-for-byte between the two call
// sites (#604) — a future hardening fix (e.g. tightening HOST_RE) applied to
// only one copy would silently reopen the shell-injection surface in the
// other. Single source of truth now, same as scripts/dev-node-flags.mjs /
// scripts/selftest-lib.sh are already shared.
import { spawnSync } from 'node:child_process';

export const HOST_RE = /^[A-Za-z0-9._-]+(?:@[A-Za-z0-9._-]+)?$/;
export const API_RE = /^[A-Za-z0-9.:-]+$/;
export const HEX64_RE = /^[0-9a-f]{64}$/;

export function assertSafe(value, what, re) {
  if (typeof value !== 'string' || !re.test(value) || value.startsWith('-')) {
    throw new Error(
      `${what} contains characters this script refuses to place in a remote command: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function sshBaseArgs() {
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10'];
  if (process.env.CYPHER_BRAIN_TON_SSH_KEY) args.push('-i', process.env.CYPHER_BRAIN_TON_SSH_KEY);
  return args;
}

export function sshRun(cmd, timeoutMs = 60_000) {
  const host = assertSafe(process.env.CYPHER_BRAIN_TON_SSH_HOST, 'CYPHER_BRAIN_TON_SSH_HOST', HOST_RE);
  const r = spawnSync('ssh', [...sshBaseArgs(), '--', host, cmd], { encoding: 'utf8', timeout: timeoutMs });
  if (r.error) throw new Error(`ssh failed: ${r.error.message}`);
  if (r.status !== 0) {
    throw new Error(
      `ssh exited ${r.status}${r.signal ? ` (signal ${r.signal})` : ''}: ${(r.stderr || '').trim().slice(-2000)}`,
    );
  }
  return r.stdout;
}
