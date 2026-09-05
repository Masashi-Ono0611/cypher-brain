#!/usr/bin/env node
// extractSection() (src/lib/runbook.ts): CRLF line-ending handling.
//
// `indexOf(`${heading}\n`)` requires the byte immediately after the heading to be a bare
// LF. A CRLF-terminated line's next byte is CR, not LF, so on CRLF input the match failed
// entirely and the WHOLE section vanished (extractSection returned '', and restoreRunbook()
// then throws "no restore runbook section found") rather than merely leaving stray \r
// characters in the extracted text. MANAGEMENT.md itself is LF today, but this function is
// generic text-slicing logic with no control over how a checkout/editor might normalize
// line endings (git's own autocrlf=true on Windows, a manual edit, etc.) — so this is a
// positive control for CRLF input specifically, not a regression test tied to one file.
//
// No server spawned, no CLI invoked: extractSection() is a pure string function, so this
// is an in-process unit test (same shape as selftest-ans104-sizing.mjs).
import { extractSection } from '../src/lib/runbook.ts';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) console.log(`[PASS] ${name}`);
  else {
    console.log(`[FAIL] ${name}${detail !== undefined ? `: ${detail}` : ''}`);
    failed++;
  }
};

const HEADING = '## Restore runbook';
const lf = `# Title\n\nintro text\n\n${HEADING}\nline one\nline two\n\n## Next section\nsomething else entirely\n`;
const crlf = lf.replace(/\n/g, '\r\n');

const lfResult = extractSection(lf, HEADING);
const crlfResult = extractSection(crlf, HEADING);

check(
  'LF input extracts the section (sanity baseline)',
  lfResult.startsWith(HEADING) && lfResult.includes('line one') && lfResult.includes('line two'),
  JSON.stringify(lfResult),
);
check(
  'CRLF input extracts a non-empty section (the bug made this return "")',
  crlfResult.length > 0,
  JSON.stringify(crlfResult),
);
check(
  'CRLF result, once normalized back to LF, is byte-identical to the LF result',
  crlfResult.replace(/\r\n/g, '\n') === lfResult,
  `lf=${JSON.stringify(lfResult)} crlf-normalized=${JSON.stringify(crlfResult.replace(/\r\n/g, '\n'))}`,
);
check(
  'CRLF result includes BOTH lines of the section body (not truncated to just the heading)',
  crlfResult.includes('line one') && crlfResult.includes('line two'),
  JSON.stringify(crlfResult),
);
check(
  'CRLF result does not bleed into the NEXT "## " section',
  !crlfResult.includes('something else entirely'),
  JSON.stringify(crlfResult),
);
check(
  'a heading not present in the text returns "" (both line-ending styles)',
  extractSection(lf, '## No Such Heading') === '' && extractSection(crlf, '## No Such Heading') === '',
);

if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
console.log('RUNBOOK SELFTEST: PASS');
