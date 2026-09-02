#!/usr/bin/env node
// drive-init-eof.mjs — a sibling of drive-init.mjs (see its own header comment for
// the shared pacing rationale: answers are sent only once the child's own combined
// stdout+stderr contains the prompt they answer, never dumped upfront) purpose-built
// for issue #718's regression test: instead of answering the LAST scripted prompt,
// it closes the child's stdin (child.stdin.end() — the same thing a closed pipe, a
// piped process exiting upstream, or a real terminal's Ctrl-D does) the moment that
// prompt's own text appears, simulating stdin reaching EOF while the wizard is
// mid-prompt. Before #718's fix, @clack/prompts' text()/confirm()/select() Promises
// never settled on stdin's own 'end'/'close' events (only on a decoded keypress), so
// this left the wizard's own prompt call permanently unresolved — with nothing else
// pending, Node's event loop just drained and the process exited 0, silently, with
// whatever key material this run had already generated left orphaned on disk. The
// fix races every prompt against stdin ending, turning an EOF into the exact same
// cancel-and-roll-back path a real Ctrl-C already takes.
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';

function usage() {
  console.error(
    'usage: drive-init-eof.mjs --qa <qa.json> --eof-after <substring> --out <transcript.log> -- <cmd> [args...]',
  );
  process.exit(2);
}

const args = process.argv.slice(2);
const qaIdx = args.indexOf('--qa');
const eofIdx = args.indexOf('--eof-after');
const outIdx = args.indexOf('--out');
const sepIdx = args.indexOf('--');
if (qaIdx === -1 || eofIdx === -1 || outIdx === -1 || sepIdx === -1 || sepIdx + 1 >= args.length) usage();

const qa = JSON.parse(readFileSync(args[qaIdx + 1], 'utf8')); // [[waitForSubstring, answerToSend], ...] — answered normally, same as drive-init.mjs
const eofAfter = args[eofIdx + 1]; // once THIS substring appears, end stdin instead of answering anything further
const outPath = args[outIdx + 1];
const [cmd, ...cmdArgs] = args.slice(sepIdx + 1);

const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
let transcript = '';
let qaIndex = 0;
let eofSent = false;

function tryAdvance() {
  while (qaIndex < qa.length) {
    const [waitFor, send] = qa[qaIndex];
    if (!transcript.includes(waitFor)) return;
    child.stdin.write(`${send}\r`);
    qaIndex++;
  }
  if (!eofSent && transcript.includes(eofAfter)) {
    eofSent = true;
    child.stdin.end(); // the whole point of this driver — see the header comment above
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
if (!eofSent) {
  console.error(
    `drive-init-eof.mjs: FAIL — never saw the target prompt ${JSON.stringify(eofAfter)} before the child exited ` +
      `(rc=${exitCode}); ${qaIndex}/${qa.length} scripted prompt(s) were answered first — see ${outPath}`,
  );
  process.exit(1);
}
if (qaIndex < qa.length) {
  const unused = qa.slice(qaIndex).map(([waitFor]) => waitFor);
  console.error(
    `drive-init-eof.mjs: FAIL — only ${qaIndex}/${qa.length} scripted prompts were seen before the EOF point (rc=${exitCode}); ` +
      `${unused.length} scripted answer(s) were never consumed — see ${outPath}\n` +
      `unused prompts (waitFor):\n${unused.map((s) => `  - ${JSON.stringify(s)}`).join('\n')}`,
  );
  process.exit(1);
}
process.exit(exitCode);
