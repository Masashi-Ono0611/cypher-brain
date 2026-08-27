#!/usr/bin/env node
// util.ts's importQuietly() (#422) exists to swallow ONE known-noisy third-party
// console.warn (bigint-buffer's "Failed to load bindings" line, emitted at MODULE LOAD
// time by @ardrive/turbo-sdk's own dependency chain, unprefixed, indistinguishable from
// a real cypher-brain error) without becoming a blanket "hide turbo SDK warnings"
// switch. This is exactly the class of guard CLAUDE.md's positive-control discipline
// warns about: a filter that never fires on anything is unverified, and a filter that
// fires on TOO MUCH silently hides a real problem. Prove both directions here — the
// known message is suppressed AND an unrelated message still reaches the console —
// rather than trusting the implementation reads correctly.

import { importQuietly } from '../src/lib/util.ts';

const pass = (m) => console.log(`[PASS] ${m}`);
const fail = (m) => {
  console.error(`[FAIL] ${m}`);
  process.exitCode = 1;
};

async function main() {
  const captured = [];
  const realWarn = console.warn;
  console.warn = (...args) => captured.push(args.join(' '));

  let returnValue;
  try {
    returnValue = await importQuietly(async () => {
      console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)');
      console.warn('some other totally unrelated warning that must NOT be swallowed');
      return 'load-result';
    });
  } finally {
    console.warn = realWarn;
  }

  if (returnValue !== 'load-result') {
    fail(`importQuietly did not return the wrapped load()'s own result (got ${JSON.stringify(returnValue)})`);
  } else {
    pass("importQuietly returns the wrapped load()'s own result unchanged");
  }

  if (captured.some((line) => line.startsWith('bigint: Failed to load bindings'))) {
    fail('the known-noisy bigint-buffer message was NOT suppressed');
  } else {
    pass('the known-noisy bigint-buffer message is suppressed');
  }

  if (captured.includes('some other totally unrelated warning that must NOT be swallowed')) {
    pass('an unrelated console.warn during the same call still reaches the real console.warn (not over-broad)');
  } else {
    fail('an unrelated console.warn was ALSO swallowed — the filter is too broad, hiding real warnings');
  }

  // console.warn must be restored to the real one even if load() throws — a leaked
  // monkey-patch would silently swallow every later console.warn in the process for
  // the rest of the CLI invocation.
  let restoredCorrectly = false;
  try {
    await importQuietly(async () => {
      throw new Error('deliberate failure inside load()');
    });
  } catch {
    restoredCorrectly = console.warn === realWarn;
  }
  if (restoredCorrectly) {
    pass('console.warn is restored to the original even when load() throws');
  } else {
    fail('console.warn was NOT restored after load() threw — the monkey-patch leaked');
  }

  await testOverlappingCalls(realWarn);
}

// Positive control for the exact race Codex review flagged: a naive save/restore (save
// console.warn on entry, restore the saved value in finally) breaks under FLAT,
// INDEPENDENT overlapping calls whose completion order is the REVERSE of their start
// order — e.g. the long-lived MCP server processing two `estimate_cost`/`snapshot_now
// --backend turbo` tool calls back to back, where the FIRST call's load() happens to
// resolve quickly and the SECOND call's load() is still in flight. (A NESTED call,
// where the inner call is awaited from inside the outer call's own load(), does NOT
// reproduce this — the completion order is structurally forced to match nesting order,
// which is why this test deliberately uses two independent, non-nested calls instead.)
// Confirmed against a standalone naive implementation before writing this test that the
// naive version actually breaks here: it leaks the suppressed message through to the
// real console.warn AND leaves console.warn permanently pointed at a stale, closed-over
// filter wrapper instead of the true original.
async function testOverlappingCalls(realWarn) {
  const captured = [];
  const captureWarn = (...args) => captured.push(args.join(' '));
  console.warn = captureWarn;

  // p1 starts FIRST but resolves FIRST (short: one microtask tick).
  // p2 starts SECOND but resolves LAST (long: several microtask ticks) — the exact
  // out-of-order completion that breaks a naive save/restore.
  const p1 = importQuietly(async () => {
    await Promise.resolve();
    return 'p1-result';
  });
  const p2 = importQuietly(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    console.warn('bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)');
    return 'p2-result';
  });
  const [r1, r2] = await Promise.all([p1, p2]);

  if (r1 !== 'p1-result' || r2 !== 'p2-result') {
    fail(`overlapping calls did not both resolve correctly (r1=${JSON.stringify(r1)}, r2=${JSON.stringify(r2)})`);
  } else {
    pass(
      'two overlapping importQuietly() calls with reversed start/completion order both resolve with their own load() result',
    );
  }

  const noisyLinesSeen = captured.filter((l) => l.startsWith('bigint: Failed to load bindings')).length;
  if (noisyLinesSeen === 0) {
    pass('the known-noisy message stays suppressed even when the shorter call finishes first');
  } else {
    fail(
      `the known-noisy message leaked through ${noisyLinesSeen} time(s) — the naive-save/restore race Codex flagged`,
    );
  }

  // Compare against captureWarn (what console.warn was set to right before p1/p2
  // started, i.e. this function's own "ambient" console.warn), NOT realWarn — the whole
  // test deliberately runs with console.warn pointed at captureWarn throughout, so the
  // correct post-condition is "back to what it was before importQuietly touched it", not
  // "back to the process's ultimate original". Restore to the true original after.
  const restoredCorrectly = console.warn === captureWarn;
  console.warn = realWarn;
  if (restoredCorrectly) {
    pass(
      'console.warn is restored to the original exactly once both overlapping calls have settled, despite the reversed completion order',
    );
  } else {
    fail(
      'console.warn was NOT restored to the original after both overlapping calls settled — permanently patched to a stale wrapper',
    );
  }
}

main().then(() => {
  if (process.exitCode) {
    console.error('IMPORT-QUIETLY SELFTEST FAIL');
  } else {
    console.log('IMPORT-QUIETLY SELFTEST PASS');
  }
});
