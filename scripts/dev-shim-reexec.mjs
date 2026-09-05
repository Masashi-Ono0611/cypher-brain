// Shared re-exec helper for bin/cypher-brain.mjs and bin/cypher-brain-mcp.mjs. Both
// shims try a plain `import` of their real entrypoint first and only fall back to this
// when that import fails with the tell-tale ERR_MODULE_NOT_FOUND (see those files for
// the full "why" — running straight from src/*.ts with no build step).
//
// Round-2 Codex review found two bugs in the original inline version of this fallback
// (both files used to build a NODE_OPTIONS string and call child_process.spawnSync):
//
//  1. Space-in-path corruption. NODE_OPTIONS is parsed by splitting on whitespace, so
//     interpolating an absolute filesystem path straight into a NODE_OPTIONS string
//     (`--import ${loader}`) breaks if the repo checkout lives under a directory
//     containing a space (e.g. "My Projects/cypher-brain") — the path silently splits
//     into two bogus tokens and the loader fails to register. Fix: never put the loader
//     path into a NODE_OPTIONS string. Pass `--experimental-strip-types` and `--import
//     <loader>` as literal argv elements to the child `node` invocation instead — argv
//     arrays given to spawn/spawnSync go straight to execve and are never shell- or
//     whitespace-split, unlike an env-var string, so a space in the path is harmless.
//  2. Orphaned child on signal. spawnSync blocks the parent synchronously and does not
//     forward signals sent to the parent's PID to the child. MCP/CLI clients manage the
//     server/process by signaling the PID they launched (this wrapper), not the child it
//     spawns, so a SIGTERM/SIGINT/SIGHUP to the wrapper left the child running and still
//     holding stdio after the client believed the process had stopped. Fix: use async
//     spawn, forward SIGINT/SIGTERM/SIGHUP from the wrapper to the child, and wait for
//     the child to actually exit before the wrapper exits (mirroring its signal/code).
//
// isMissingDevEntrypoint (multi-model review, round 3): both bin/*.mjs shims used to
// treat ANY `err.code === 'ERR_MODULE_NOT_FOUND'` out of their top-level
// `await import('../src/*.js')` as "needs the dev loader", too broad a match. The ONE
// scenario this whole file exists for is that top-level import itself failing because
// only the sibling `src/*.ts` exists and nothing has told node to remap `.js` -> `.ts`
// yet (see bin/cypher-brain.mjs's own header comment) — but src/cli.ts (or src/mcp.ts)
// goes on to import a long chain of its own `./lib/*.js`-specifier files, and if a
// caller's environment ALREADY has the dev loader active (NODE_OPTIONS carrying
// --experimental-strip-types --import dev-cli-loader.mjs, exactly what every
// selftest*.sh/cli-smoke.sh script sets) and one of THOSE nested imports is a genuine,
// unrelated bug (a typo'd path, a file moved without updating its importer), Node
// raises the exact same ERR_MODULE_NOT_FOUND code for that failure too. The old,
// unconditional check could not tell the two apart: it would re-exec a SECOND `node`
// process — with the SAME loader flags the environment already had active, changing
// nothing — that fails on the identical unrelated bug all over again, masking a real
// break behind a pointless extra spawn (and, since `CYPHER_BRAIN_DEV_SHIM_REEXEC=1` is
// only set on that second attempt, the confusing detour only ever costs one extra hop,
// never an actual infinite loop — but a wrong diagnosis and a wasted process either
// way). Node's ERR_MODULE_NOT_FOUND carries the failing specifier's own resolved URL on
// `err.url` (verified empirically against this repo's own dev-ts-resolve-hook.mjs: a
// nested missing import's `err.url` points at THAT specifier, never at the top-level
// entrypoint) — comparing it against the entrypoint's own URL is what narrows this back
// down to exactly the one scenario this shim is meant to work around.
export function isMissingDevEntrypoint(err, specifier, callerUrl) {
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return false;
  // `err.url` is not a documented, versioned part of Node's public error API — it is an
  // internal implementation detail of the ESM resolver that has been present and stable
  // across every currently-supported Node line (this repo's own `engines.node` floor,
  // >=22.6.0, through the latest). If some future Node version ever stops setting it,
  // `err.url` reads back `undefined`, which never strictly-equals a real file:// URL —
  // this narrows to "assume NOT the known scenario" (no re-exec, the original error
  // surfaces immediately) rather than silently reverting to the old too-broad match.
  return err.url === new URL(specifier, callerUrl).href;
}

export async function reexecUnderDevLoader(callerUrl, extraArgv) {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');

  const thisFile = fileURLToPath(callerUrl);
  // Co-located with dev-cli-loader.mjs, so resolve relative to THIS module's own URL
  // rather than the caller's — keeps the path correct regardless of which bin/*.mjs
  // shim is doing the re-exec.
  const loader = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dev-cli-loader.mjs');

  const nodeArgv = ['--experimental-strip-types', '--import', loader, thisFile, ...extraArgv];

  const child = spawn(process.execPath, nodeArgv, {
    stdio: 'inherit',
    env: { ...process.env, CYPHER_BRAIN_DEV_SHIM_REEXEC: '1' },
  });

  const forwardedSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const forwardSignal = (signal) => {
    // Guard against forwarding after the child has already exited (e.g. a second
    // signal arriving while we are already tearing down).
    if (child.exitCode === null && child.signalCode === null) {
      child.kill(signal);
    }
  };
  for (const signal of forwardedSignals) process.on(signal, forwardSignal);

  const [code, signal] = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve([code, signal]));
  });

  for (const signal of forwardedSignals) process.removeListener(signal, forwardSignal);

  if (signal) {
    // Mirror the child's signal-based termination on the wrapper itself so a process
    // manager watching THIS pid observes the same signal rather than a plain exit(0/1).
    // Set a POSIX-convention exit code as a fallback in case the re-raised signal is,
    // for whatever reason, not delivered before the event loop would otherwise drain.
    process.exitCode = 128;
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code === null ? 1 : code);
}
