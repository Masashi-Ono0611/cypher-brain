#!/usr/bin/env node
// Thin shim so `npm link` / the bash selftests / a bare source checkout run the CLI
// straight from the repo with no build step. The real CLI (arg parsing + command
// dispatch) lives in src/cli.ts; the bundled single-file build lands at dist/cli.mjs
// (`npm run build`) and never touches this file.
//
// src/cli.ts's internal imports use the OUTPUT extension (`./lib/config.js`, matching
// the eventual dist/tsc convention — #63), which plain node's module resolution does
// NOT remap to the sibling `.ts` file on its own — scripts/dev-ts-resolve-hook.mjs
// fixes that, but a resolve hook must be `register()`ed before the failing import
// happens, and (on Node < 22.18/23.6, where TS type-stripping isn't on by default yet)
// --experimental-strip-types must be a startup flag, not something turned on from
// inside an already-running plain-.mjs process. Internal callers (npm scripts,
// selftest*.sh, cli-smoke.sh) preload both via
// NODE_OPTIONS="--experimental-strip-types --import scripts/dev-cli-loader.mjs" set on
// the shell before invoking `node`.
//
// A bare `node bin/cypher-brain.mjs` (what README.md documents) has neither, so this
// shim tries the plain import first and, ONLY if that fails with the tell-tale
// resolution error, self-re-execs as a child `node` process with the flags above —
// forwarding argv/stdio/exit code (and, on an interrupted long-running command such as
// `snapshot`, the terminating signal too) — so the documented zero-setup command keeps
// working with no manual env-var dance. This costs one extra process spawn on that
// fallback path only; it never fires for the compiled/shipped `dist/cli.mjs`, nor for
// callers that already export the right NODE_OPTIONS (the import just succeeds on the
// first try).
//
// The re-exec itself (argv-safe flag passing, signal forwarding so a Ctrl-C/kill on
// this wrapper's PID doesn't orphan the child mid-command) lives in
// scripts/dev-shim-reexec.mjs — shared with bin/cypher-brain-mcp.mjs so the fix only
// needs to exist in one place.
try {
  await import('../src/cli.js');
} catch (err) {
  const alreadyReexeced = process.env.CYPHER_BRAIN_DEV_SHIM_REEXEC === '1';
  if (alreadyReexeced || !(err && err.code === 'ERR_MODULE_NOT_FOUND')) {
    throw err;
  }
  const { reexecUnderDevLoader, isMissingDevEntrypoint } = await import('../scripts/dev-shim-reexec.mjs');
  // Narrowed to the ONE known scenario this fallback exists for — see
  // isMissingDevEntrypoint's own doc comment in dev-shim-reexec.mjs for why a bare
  // ERR_MODULE_NOT_FOUND code alone is too broad a trigger.
  if (!isMissingDevEntrypoint(err, '../src/cli.js', import.meta.url)) {
    throw err;
  }
  await reexecUnderDevLoader(import.meta.url, process.argv.slice(2));
}
