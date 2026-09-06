#!/usr/bin/env node
// Companion CHILD process for scripts/selftest-keyfile-fsync-cleanup.mjs's Part 4 — a
// regression test for a Critical finding from a SECOND Codex review pass of this fix
// (see keys.ts's writeKeyFile() own header comment, point 2): if the catch block's own
// `rm(tmp, {force:true})` cleanup ITSELF throws (a transient EACCES/EIO actually
// unlinking a file that exists, as opposed to the ENOENT `force` already swallows), the
// fix must NOT deregister the tmp file from signal-guard.ts's tracked Set — doing so
// unconditionally (the first-cut shape of this fix) would silently drop the only
// remaining safety net for a secret-bearing file still sitting on disk.
//
// This process: makes fh.sync() throw (as in Part 2/3) AND makes the async
// node:fs/promises `rm()` call ALSO throw when writeKeyFile()'s own catch block tries to
// clean up the tmp file — so writeKeyFile() throws having FAILED to remove its own tmp
// file. It then idles (kept alive by a real timer) and waits for a SIGTERM. Crucially,
// only the ASYNC `rm` (node:fs/promises, used by keys.ts) is mocked to fail — the
// SYNCHRONOUS `rmSync` (node:fs, used by signal-guard.ts's own cleanup handler) is left
// completely untouched. If the fix correctly left the tmp file registered despite the
// mocked rm() failure, signal-guard's real rmSync removes it once SIGTERM lands; if the
// (buggy, first-cut) fix had deregistered it anyway, nothing would remove it and it
// would still be there after the child dies.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const cjsFsPromises = require('node:fs').promises;
const realOpen = cjsFsPromises.open;
const realRm = cjsFsPromises.rm;

const [, , target, sentinelPath] = process.argv;
if (!target || !sentinelPath) {
  console.error('usage: selftest-keyfile-fsync-cleanup-child-rmfail.mjs <target-path> <sentinel-path>');
  process.exit(2);
}

Object.defineProperty(cjsFsPromises, 'open', {
  value: async (...args) => {
    const fh = await realOpen.apply(cjsFsPromises, args);
    const p = args[0];
    if (typeof p === 'string' && p.startsWith(`${target}.`) && p.endsWith('.tmp')) {
      fh.sync = async () => {
        throw new Error('SIMULATED_EIO: fh.sync() failed after write (Part 4)');
      };
    }
    return fh;
  },
  writable: true,
  configurable: true,
});
Object.defineProperty(cjsFsPromises, 'rm', {
  value: async (...args) => {
    const p = args[0];
    if (typeof p === 'string' && p.startsWith(`${target}.`) && p.endsWith('.tmp')) {
      throw new Error('SIMULATED_EACCES: rm() failed cleaning up the tmp file (Part 4)');
    }
    return realRm.apply(cjsFsPromises, args);
  },
  writable: true,
  configurable: true,
});

const { writeKeyFile } = await import('../src/lib/keys.ts');
let threw = null;
try {
  await writeKeyFile(target, 'AGE-SECRET-KEY-PART4-MARKER-rm-failure-still-tracked', 0o600, true);
} catch (e) {
  threw = e instanceof Error ? e.message : String(e);
}
// Synchronous, so it lands on disk before the parent's poll loop can observe it — see
// the sibling child script's own comment on why writeFileSync (not the async writeFile)
// matters here.
writeFileSync(sentinelPath, `writeKeyFile threw: ${threw ?? '(nothing — unexpected)'}\n`);
// A REAL timer, not a bare `new Promise(() => {})` — see the sibling child script's own
// comment: an unresolved promise with no associated handle does not keep the event loop
// alive, and Node would otherwise exit on its own (code 13, "unfinished top-level
// await") racing ahead of the parent's SIGTERM instead of waiting for it.
await new Promise((resolve) => setTimeout(resolve, 60_000));
console.log("unexpected: this process should have been SIGTERM'd before the timer fired");
