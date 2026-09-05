#!/usr/bin/env node
// drive-init.mjs — a tiny, purpose-built driver for scripts/selftest-init.sh: spawns
// an interactive child process (`cypher-brain init`) and feeds it a SCRIPTED sequence
// of answers, each one sent only once the child's own combined stdout+stderr contains
// the corresponding expected prompt substring.
//
// Why not just pipe a static file of answers (like `printf 'y\n\nn\n...' | cb init`)?
// Node's readline (non-TTY/piped mode) does not queue 'line' events for later — if
// several answer lines are already sitting in the input pipe's kernel buffer when
// more than one arrives before the awaiting code has re-attached its NEXT
// `question()` listener (there is real async work — keygen, disk writes — between
// this wizard's prompts), the extra 'line' events fire with no listener attached and
// are silently DROPPED, wedging the wizard on its next `question()` forever
// (confirmed empirically while building this test). Pacing each answer to the
// prompt it actually answers — one at a time, only once that prompt has genuinely
// been printed — avoids ever having more than one answer in flight.
//
// Terminator: '\r', not '\n' (issue #230, the @clack/prompts migration). clack's
// prompt classes (@clack/core's Prompt.onKeypress) only treat a keypress named
// "return" as the submit trigger, and Node's readline keypress decoder maps the RAW
// '\r' byte to that "return" name — a plain '\n' byte decodes to a DIFFERENT key
// name ("enter") that clack's submit check does not match, so a wizard prompt fed
// '\n' just sits there forever instead of submitting (confirmed empirically: the
// exact same driver logic below hangs on the very first prompt with '\n', and
// completes normally with '\r' — this is why plain terminal input works fine while
// piped drivers need this care: a real terminal in raw mode sends '\r' for the Enter
// key itself, never '\n'). A confirm() prompt submits on its first "y"/"n" keypress
// alone (before this trailing '\r' is even read) — the leftover '\r' byte is not a
// problem: it is decoded into its own "return" keypress event on the underlying
// stream, but by the time that happens the prompt that just closed has already torn
// down its own keypress listener (@clack/core's Prompt.close()), and the NEXT
// prompt has not attached its own yet, so that stray keypress event fires with zero
// listeners and is silently dropped — verified with a standalone two-prompts-in-a-row
// harness before relying on it here.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

function usage() {
  console.error('usage: drive-init.mjs --qa <qa.json> --out <transcript.log> -- <cmd> [args...]');
  process.exit(2);
}

const args = process.argv.slice(2);
const qaIdx = args.indexOf('--qa');
const outIdx = args.indexOf('--out');
const sepIdx = args.indexOf('--');
if (qaIdx === -1 || outIdx === -1 || sepIdx === -1 || sepIdx + 1 >= args.length) usage();

const qa = JSON.parse(readFileSync(args[qaIdx + 1], 'utf8')); // [[waitForSubstring, answerToSend], ...]
const outPath = args[outIdx + 1];
const [cmd, ...cmdArgs] = args.slice(sepIdx + 1);

const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
let transcript = '';
let qaIndex = 0;
// Only ever search the transcript FORWARD from the end of the previous step's own
// match — never re-scan text this driver already consumed. Matching each step's
// waitFor against the FULL accumulated transcript (as this used to) let a LATER
// step's substring spuriously match stale text left over from an EARLIER prompt (or
// this driver's own already-sent answer bytes, which node's pty/pipe echo can put
// right back into the child's combined stdout+stderr) — firing that step's answer
// before the corresponding real prompt had actually printed.
let searchFrom = 0;

function tryAdvance() {
  while (qaIndex < qa.length) {
    const [waitFor, send] = qa[qaIndex];
    const idx = transcript.indexOf(waitFor, searchFrom);
    if (idx === -1) return;
    searchFrom = idx + waitFor.length;
    child.stdin.write(`${send}\r`);
    qaIndex++;
  }
}

child.stdout.on('data', (d) => {
  transcript += d.toString('utf8');
  tryAdvance();
});
child.stderr.on('data', (d) => {
  transcript += d.toString('utf8');
  tryAdvance();
});

const exitCode = await new Promise((resolve) => {
  child.on('close', (code) => resolve(code ?? 1));
  child.on('error', () => resolve(1));
});

writeFileSync(outPath, transcript);
if (qaIndex < qa.length) {
  const unused = qa.slice(qaIndex).map(([waitFor]) => waitFor);
  console.error(
    `drive-init.mjs: FAIL — only ${qaIndex}/${qa.length} scripted prompts were seen before the child exited (rc=${exitCode}); ` +
      `${unused.length} scripted answer(s) were never consumed — see ${outPath}\n` +
      `unused prompts (waitFor):\n${unused.map((s) => `  - ${JSON.stringify(s)}`).join('\n')}`,
  );
  process.exit(1);
}
process.exit(exitCode);
