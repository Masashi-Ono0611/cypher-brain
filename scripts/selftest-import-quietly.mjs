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
}

main().then(() => {
  if (process.exitCode) {
    console.error('IMPORT-QUIETLY SELFTEST FAIL');
  } else {
    console.log('IMPORT-QUIETLY SELFTEST PASS');
  }
});
