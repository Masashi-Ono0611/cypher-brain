#!/usr/bin/env node
// Proof for #283: the cadence and format rules in src/lib/progress.ts.
//
// This is the one part of the feature that can be tested honestly and cheaply. The two
// backends it serves cannot: the turbo half needs a funded wallet and a real upload, and
// the rclone half needs a transfer slow enough to cross an interval boundary (covered
// separately, and slowly, in selftest-rclone.sh). What is left — "how often does it
// speak, and what does it say" — is pure logic, so it is exercised here with an injected
// clock and sink rather than by sleeping.
//
// The rules being pinned are not cosmetic. Each exists because getting it wrong
// reintroduces the problem #283 is about, from the other side:
//   - too chatty  -> the nightly runner's log (exec >>"$LOG" 2>&1, never rotated, kept
//                    forever) gains ~1800 lines a night, and an MCP tool that surfaces
//                    its captured output grows its RESULT with it.
//   - too quiet   -> a long upload is silent again, which is the original bug.
//   - a wrong rate/ETA is worse than none: an operator deciding whether to kill a stuck
//     push acts on it.
import { progressReporter, TTY_INTERVAL_MS, NON_TTY_INTERVAL_MS } from '../src/lib/progress.ts';
import { parseRcloneLogLine, rcloneArgs } from '../src/lib/backends/rclone.ts';
import { run } from '../src/lib/proc.ts';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// A reporter wired to a clock and sink we control. `at(ms)` moves time explicitly, so
// nothing here depends on how long the test itself takes to run.
function harness(component, intervalMs) {
  const lines = [];
  let clock = 1_000_000; // arbitrary non-zero epoch; only differences matter
  const r = progressReporter(component, {
    intervalMs,
    now: () => clock,
    write: (l) => lines.push(l),
  });
  return {
    lines,
    at(ms) {
      clock = 1_000_000 + ms;
      return this;
    },
    report(processed, total) {
      r.report(processed, total);
      return this;
    },
  };
}

// ---------- cadence ----------

{
  const h = harness('t', 1000);
  h.at(0).report(10, 100);
  check('the first meaningful sample is emitted immediately', h.lines.length === 1, JSON.stringify(h.lines));

  h.at(500).report(20, 100);
  check('a sample inside the interval is suppressed', h.lines.length === 1, JSON.stringify(h.lines));

  h.at(1500).report(30, 100);
  check('a sample past the interval is emitted', h.lines.length === 2, JSON.stringify(h.lines));
}

{
  // A stalled transfer must not look like a moving one. Backends call report() on a
  // timer (rclone) or per chunk (turbo/arweave); repeating the same byte count would
  // print a line that reads as progress while nothing is happening.
  const h = harness('t', 1000);
  h.at(0).report(50, 100);
  h.at(5000).report(50, 100);
  h.at(9000).report(50, 100);
  check('an unchanged byte count never emits again', h.lines.length === 1, JSON.stringify(h.lines));
  h.at(10000).report(51, 100);
  check('movement after a stall resumes reporting', h.lines.length === 2, JSON.stringify(h.lines));
}

{
  // "0 bytes so far" adds nothing the surrounding push/pull output has not already said,
  // and would put a 0% line in every unattended log.
  const h = harness('t', 1000);
  h.at(0).report(0, 100);
  check('a zero-byte sample is not reported', h.lines.length === 0, JSON.stringify(h.lines));
}

// ---------- format ----------

{
  const h = harness('rclone push', 1000);
  h.at(0).report(25, 100); // no elapsed window yet -> no rate, no ETA
  const first = h.lines[0];
  check('the component prefixes the line', first.startsWith('rclone push: '), first);
  check('the percentage is present', /\b25%/.test(first), first);
  check('bytes are shown as processed/total', /25 B\/100 B/.test(first), first);
  check(
    'rate and ETA are OMITTED before there is a window to compute them',
    !/\/s/.test(first) && !/ETA/.test(first),
    first,
  );

  // 75 B in the 2 s since the transfer started -> 37.5 B/s, which fmtBytes renders
  // whole at the B scale ("38 B/s"): sub-byte precision on a transfer rate is noise.
  h.at(2000).report(75, 100);
  const second = h.lines[1];
  check('the rate appears once there is a window', /38 B\/s/.test(second), second);
  check('the ETA appears with the rate', /ETA 1s/.test(second), second); // 25 B left at 37.5 B/s
}

{
  // The window is anchored when the reporter is CREATED, not at the first sample —
  // otherwise the first emitted line never carries a rate, and on an unattended run at
  // the 30s cadence that line is often the only one. This is the case measured by hand:
  // a real rclone push produced exactly one line for a ~50s transfer.
  const h = harness('rclone push', 1000);
  h.at(30_000).report(120, 200); // first sample, 30 s in
  const only = h.lines[0];
  check('the FIRST emitted line already carries a rate', /4 B\/s/.test(only), only);
  check('the FIRST emitted line already carries an ETA', /ETA 20s/.test(only), only);
}

{
  // A gateway that omits content-length still answers "is it moving?" — the reporter
  // must degrade to a byte count rather than printing a percentage of zero.
  const h = harness('arweave pull', 1000);
  h.at(0).report(4096, 0);
  const line = h.lines[0];
  check('a zero total prints bytes with no percentage', /^arweave pull: 4\.0 KB$/.test(line), line);
}

{
  // Percentages are floored and clamped: a backend that reports slightly more than the
  // declared total (rclone counts a little overhead) must not print 101%.
  const h = harness('t', 1000);
  h.at(0).report(150, 100);
  check('the percentage is clamped at 100', /\b100%/.test(h.lines[0]), h.lines[0]);
}

// ---------- the two cadences are actually different ----------

check(
  'the interactive cadence is faster than the unattended one',
  TTY_INTERVAL_MS < NON_TTY_INTERVAL_MS,
  `${TTY_INTERVAL_MS} vs ${NON_TTY_INTERVAL_MS}`,
);
check(
  'the unattended cadence is coarse enough for a nightly log',
  NON_TTY_INTERVAL_MS >= 10_000,
  `${NON_TTY_INTERVAL_MS}ms would put ${Math.round((30 * 60 * 1000) / NON_TTY_INTERVAL_MS)} lines in the log for a 30-minute upload`,
);

// ---------- a restarted transfer is not a slow one ----------
//
// rclone retries a failed copy from zero and a resumed upload re-reports from its new
// origin, so the byte count can go DOWN. Averaging across the abandoned attempt produced
// a confident "1 B/s, ETA 80s" describing neither attempt (multi-model review finding).

{
  const h = harness('rclone push', 1000);
  h.at(0).report(80, 100);
  h.at(10_000).report(20, 100); // the transfer restarted
  h.at(40_000).report(50, 100); // 30 B in the 30 s since the restart -> 1 B/s
  const after = h.lines[h.lines.length - 1];
  check('a rollback re-anchors the rate window', /1 B\/s/.test(after), after);
  check('the ETA after a rollback describes the new attempt', /ETA 50s/.test(after), after);
  check('the rollback sample itself carries no invented rate', !/\/s/.test(h.lines[1]), h.lines[1]);
}

// ---------- the default sink is the one MCP can see ----------
//
// Not a style preference. mcp.ts rebinds console.error and captures it (captureCall), and
// the tools that surface their captured output put it in the tool RESULT; a direct
// process.stderr.write bypasses that capture entirely and only ever reaches the server's
// own stderr. So progress written the other way would be invisible to exactly the caller
// who cannot look at a terminal to decide whether a push is still moving.
//
// This cannot be tested through a real MCP call — snapshot_now's backend enum has no
// rclone and no `remote` field, and turbo needs a funded wallet — so the sink itself is
// asserted here instead of being assumed. Note the sink being right is necessary, not
// sufficient: verify_restore/restore_now currently discard the CaptureResult of their
// pull, so those two collect the arweave download progress and drop it.
{
  const captured = [];
  const realConsoleError = console.error;
  console.error = (...a) => captured.push(a.join(' '));
  try {
    let clock = 0;
    const r = progressReporter('sink check', { intervalMs: 1, now: () => clock });
    clock = 5000;
    r.report(10, 100);
  } finally {
    console.error = realConsoleError;
  }
  check(
    'progress is written with console.error, so the MCP capture sees it',
    captured.length === 1 && captured[0].startsWith('sink check: '),
    JSON.stringify(captured),
  );
}

// ---------- rclone's JSON log, against a REAL captured line ----------
//
// This is the fragile seam: the format belongs to rclone, not to us. The line below is
// verbatim output from rclone v1.74.4 (`--stats 1s --stats-one-line --stats-log-level
// NOTICE --use-json-log`), trimmed only of fields we never read. If a future rclone
// moves the byte counts, this fails here rather than silently reporting nothing during
// a real upload — the exact failure mode that makes progress features rot unnoticed.

const REAL_STATS_LINE = JSON.stringify({
  time: '2026-07-25T21:10:18.278944+09:00',
  level: 'notice',
  msg: '   60.090 MiB / 120 MiB, 50%, 30.088 MiB/s, ETA 1s\n',
  stats: { bytes: 63008768, totalBytes: 125829120, elapsedTime: 1.99, errors: 0, speed: 31549555.58 },
  source: 'accounting/stats.go:551',
});

{
  const parsed = parseRcloneLogLine(REAL_STATS_LINE);
  check(
    'a real rclone stats line yields byte counts, not a message',
    parsed !== null && 'stats' in parsed && parsed.stats.bytes === 63008768 && parsed.stats.total === 125829120,
    JSON.stringify(parsed),
  );
}

{
  // rclone's own errors must survive as text. In JSON-log mode they are the only thing
  // standing between an operator and a raw JSON blob in the failure message.
  const err = JSON.stringify({ time: 't', level: 'error', msg: 'directory not found', source: 's' });
  const parsed = parseRcloneLogLine(err);
  check(
    'a non-stats line is kept as its message',
    parsed !== null && 'msg' in parsed && parsed.msg === 'directory not found',
    JSON.stringify(parsed),
  );
}

{
  // `object` names WHICH path the message is about. JSON-log mode is the only reason it
  // is a separate field instead of part of the sentence, so dropping it would make the
  // error strictly less useful than the plain-text one it replaces.
  const err = JSON.stringify({
    time: 't',
    level: 'error',
    msg: 'directory not found',
    object: 'Local file system at /nope',
    source: 's',
  });
  const parsed = parseRcloneLogLine(err);
  check(
    'the affected object is kept alongside the message',
    parsed !== null && 'msg' in parsed && parsed.msg === 'Local file system at /nope: directory not found',
    JSON.stringify(parsed),
  );
}

{
  const parsed = parseRcloneLogLine('not json at all');
  check(
    'a non-JSON line is kept as a message rather than dropped',
    parsed !== null && 'msg' in parsed && parsed.msg === 'not json at all',
    JSON.stringify(parsed),
  );
  check('a blank line yields nothing', parseRcloneLogLine('   ') === null);
}

{
  // The flags have to actually reach rclone: without --stats-log-level NOTICE the stats
  // are logged at INFO and the default --log-level NOTICE filters them out, so the
  // feature would be wired end to end and still produce silence.
  const args = rcloneArgs('copyto', ['src', 'dst'], 30_000);
  // Bare membership (Codex review) does not prove '30s'/'NOTICE' are each the VALUE of
  // their own flag — a malformed args array missing --stats or --stats-log-level
  // entirely (while '30s'/'NOTICE' still appear somewhere, e.g. as a stray positional)
  // would still pass. Requiring each value to sit immediately after its own flag name
  // is what actually pins statsFlags()'s pairing.
  // indexOf(...) !== -1 guarded explicitly (Codex review, 2nd pass): without it, a
  // missing --stats flag reads args[-1 + 1] === args[0] (the subcommand, 'copyto') —
  // harmless today since 'copyto' !== '30s', but a coincidental future subcommand/value
  // match would let a missing flag silently pass rather than fail on the missing flag.
  const statsIdx = args.indexOf('--stats');
  check(
    "the stats interval is expressed in whole seconds, as --stats's own value",
    statsIdx !== -1 && args[statsIdx + 1] === '30s',
    args.join(' '),
  );
  const statsLogLevelIdx = args.indexOf('--stats-log-level');
  check(
    "stats are raised to a level the default log level shows, as --stats-log-level's own value",
    statsLogLevelIdx !== -1 && args[statsLogLevelIdx + 1] === 'NOTICE',
    args.join(' '),
  );
  check('the machine-readable log format is requested', args.includes('--use-json-log'), args.join(' '));
  check(
    'a sub-second interval is floored to 1s rather than 0s',
    rcloneArgs('copyto', ['a', 'b'], 200).includes('1s'),
    rcloneArgs('copyto', ['a', 'b'], 200).join(' '),
  );

  // THE regression this pins. `--` ends option parsing, so a flag after it is read as a
  // positional argument — the first attempt appended the stats flags to the end and
  // rclone answered "Command copyto needs 2 arguments maximum: you provided 8". Every
  // flag must sit before the separator and every path after it.
  const sep = args.indexOf('--');
  check('the -- separator is present exactly once', sep !== -1 && args.indexOf('--', sep + 1) === -1, args.join(' '));
  check(
    'every flag is BEFORE the -- separator',
    args.slice(sep + 1).every((a) => !a.startsWith('--')),
    args.slice(sep + 1).join(' '),
  );
  check(
    'the positionals are the last two arguments, in order',
    args[args.length - 2] === 'src' && args[args.length - 1] === 'dst',
    args.join(' '),
  );
  check(
    'without progress there are no stats flags, and -- still separates',
    rcloneArgs('copyto', ['src', 'dst'], null).join(' ') === 'copyto -- src dst',
    rcloneArgs('copyto', ['src', 'dst'], null).join(' '),
  );
}

// ---------- proc.ts actually streams ----------
//
// The remaining seam: run() must hand over complete lines DURING the child's life. If it
// buffered them to the end, everything above would still pass and a real upload would
// still be silent until it finished.

{
  const seen = [];
  await run('sh', ['-c', 'printf "one\\ntwo\\n" >&2; printf "no-trailing-newline" >&2'], {
    onStderrLine: (l) => seen.push(l),
  });
  check('complete stderr lines are delivered', seen[0] === 'one' && seen[1] === 'two', JSON.stringify(seen));
  check(
    'a final line with no trailing newline is still delivered',
    seen[2] === 'no-trailing-newline',
    JSON.stringify(seen),
  );
}

{
  // The bounded tail is what makes asking a chatty child for progress affordable: the
  // pre-#283 buffer grew for the whole transfer and was then discarded on success.
  let threw = null;
  try {
    await run('sh', ['-c', 'i=0; while [ $i -lt 4000 ]; do echo "noise line $i" >&2; i=$((i+1)); done; exit 3'], {
      onStderrLine: () => {},
    });
  } catch (e) {
    threw = e;
  }
  check('a failing streamed child still rejects', threw !== null, String(threw));
  check(
    'the retained stderr is bounded, not the whole transcript',
    threw !== null && threw.message.length < 20_000,
    `message length ${threw?.message?.length}`,
  );
  check(
    'the retained stderr is the TAIL — where a tool puts its error',
    threw?.message.includes('noise line 3999'),
    threw?.message?.slice(-80),
  );
}

{
  // A multi-byte character split across two reads must survive. These lines carry paths
  // and error text, so mangling them into replacement characters corrupts exactly the
  // information the failure path exists to convey.
  // The sleep is what forces two separate reads, splitting the three bytes of "€"
  // (\342\202\254) across them — without it the shell would likely emit one chunk and
  // the test would pass whether or not the decoding is correct.
  const seen = [];
  await run('sh', ['-c', 'printf "cost: 5\\342\\202" >&2; sleep 0.2; printf "\\254 total\\n" >&2'], {
    onStderrLine: (l) => seen.push(l),
  });
  check(
    'a UTF-8 character split across chunks is reassembled, not mangled',
    seen.length === 1 && seen[0] === 'cost: 5€ total',
    JSON.stringify(seen),
  );
}

{
  // A child that never emits a newline must not grow the pending buffer for the whole
  // run — that would defeat the bound this streaming path exists to provide.
  //
  // 2000 iterations * 32 bytes = 64,000 bytes total (Codex review) — comfortably PAST
  // the 16,384-byte assertion below, not just past proc.ts's own internal flush
  // threshold. The original 400 iterations produced only 12,800 bytes total: even a
  // fully unbounded pending buffer (the exact regression this test exists to catch)
  // could never accumulate more than the child actually wrote, so `longest <= 16_384`
  // passed trivially regardless of whether the bound worked at all.
  let delivered = 0;
  let longest = 0;
  await run(
    'sh',
    ['-c', 'i=0; while [ $i -lt 2000 ]; do printf "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" >&2; i=$((i+1)); done'],
    {
      onStderrLine: (l) => {
        delivered++;
        longest = Math.max(longest, l.length);
      },
    },
  );
  check('a newline-free child still delivers its output', delivered > 0, `${delivered} fragments`);
  check('no single delivered fragment is unbounded', longest <= 16_384, `longest ${longest}`);
}

if (failed > 0) {
  console.log(`\nPROGRESS SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nPROGRESS SELFTEST PASS');
