#!/usr/bin/env node
// Companion CHILD process for scripts/selftest-keyfile-fsync-cleanup.mjs's Part 3 — see
// that script's own header comment for the full picture. This process exists only
// because Part 3 needs a REAL signal (SIGTERM) to land while writeKeyFile() (src/lib/
// keys.ts) is suspended mid-fh.sync(), and a signal handler runs OUTSIDE the suspended
// async call stack entirely (signal-guard.ts's own header comment) — so the only way to
// prove signal-guard.ts's tracked-Set cleanup (not writeKeyFile()'s own try/catch, which
// never gets a chance to run here) is what removes the tmp file is to actually send one
// to a separate OS process and inspect what's left on disk afterward.
//
// Patches node:fs/promises's open() (via the underlying CJS require('fs').promises
// object) BEFORE keys.ts is imported below — see scripts/selftest-keyfile-fsync-
// cleanup.mjs's own Part 2 header comment for why the ORDER matters here: Node's ESM
// named exports for a builtin CJS module are a snapshot taken the FIRST time that
// module specifier is linked in this process, not a live getter re-read on every call
// — so this patch has to be in place before keys.ts's own `import { open } from
// 'node:fs/promises'` is first evaluated (which happens when keys.ts itself is
// imported, below), not merely before writeKeyFile() is CALLED. Once installed, this is
// visible to keys.ts for the rest of this process: for the ONE tmp file writeKeyFile()
// creates for our target path, fh.sync() drops a sentinel (proving the secret payload
// is already on disk) and then hangs forever — the parent sends SIGTERM once it sees
// that sentinel, which always wins the race against this promise ever settling.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const cjsFsPromises = require('node:fs').promises;
const realOpen = cjsFsPromises.open;

const [, , target, sentinelPath] = process.argv;
if (!target || !sentinelPath) {
  console.error('usage: selftest-keyfile-fsync-cleanup-child.mjs <target-path> <sentinel-path>');
  process.exit(2);
}

Object.defineProperty(cjsFsPromises, 'open', {
  value: async (...args) => {
    const fh = await realOpen.apply(cjsFsPromises, args);
    const p = args[0];
    if (typeof p === 'string' && p.startsWith(`${target}.`) && p.endsWith('.tmp')) {
      fh.sync = async () => {
        // fh.writeFile() has already returned by the time writeKeyFile() calls sync() —
        // the tmp file holds the FULL secret payload right now. Drop the sentinel
        // synchronously (writeFileSync, not the async writeFile — this must be visible to
        // the parent's poll loop the instant this line runs, not after some later await)
        // then hang. A REAL timer (setTimeout), not a bare `new Promise(() => {})`: a
        // promise with no associated timer/handle does not keep the event loop alive by
        // itself, and once nothing else is scheduled Node treats an outstanding top-level
        // await with an empty event loop as "unfinished top-level await" and exits on its
        // own (code 13) — racing ahead of, and unrelated to, the parent's SIGTERM
        // (reproduced during this test's own development: this exact race). A pending
        // timer keeps the process alive until SIGTERM actually lands.
        writeFileSync(sentinelPath, 'ready\n');
        await new Promise((resolve) => setTimeout(resolve, 60_000));
      };
    }
    return fh;
  },
  writable: true,
  configurable: true,
});

const { writeKeyFile } = await import('../src/lib/keys.ts');
await writeKeyFile(target, 'AGE-SECRET-KEY-PART3-MARKER-signal-guard-cleanup', 0o600, true);
// Unreachable in the intended run (the parent always kills this process first) — printed
// only so a run that somehow gets here (SIGTERM lost, sentinel poll too slow, ...) is
// visibly wrong in the parent's captured stdout rather than silently "just exiting".
console.log("unexpected: writeKeyFile() resolved — the parent should have SIGTERM'd this process first");
