#!/usr/bin/env node
// The check src/lib/errors.ts says does not exist (#295).
//
// CB-E### codes are attached by matching a REGEX against an already-formatted error
// message, deliberately, so the existing throw sites (296, as of writing) stay untouched
// (#212). The cost is stated in that file's own header: rewording a message can silently
// stop a pattern matching, "with no compiler or test to catch it". At least a dozen of
// the registry's 23 codes (as of writing — see src/lib/errors.ts's ERROR_CODES for the
// current, authoritative count) are exercised end-to-end somewhere: CB-E001, CB-E002,
// CB-E005, CB-E007, CB-E008, CB-E009, CB-E010, CB-E013, CB-E014, CB-E015, CB-E016, and
// CB-E017, across selftest.sh, selftest-storage.sh, selftest-verify-levels.sh,
// selftest-schedule.sh, cli-smoke.sh, selftest-minisign.sh, and mcp-smoke.mjs.
//
// What this asserts, stated narrowly because it is easy to overclaim: for every entry
// whose text WE write, the literal the pattern looks for still appears somewhere in the
// text of src/**.ts. Precisely:
//
//   - It catches the LAST occurrence of a literal disappearing from the source.
//   - It does NOT catch one of several occurrences being reworded. Some literals are
//     thrown from two files (CB-E006's is in both arweave.ts and turbo.ts); either site
//     can rot while the other keeps this green.
//   - It does NOT distinguish a real throw site from a comment or an unrelated string —
//     `includes()` over file text is all it does.
//   - It does NOT prove the code still ATTACHES at runtime for the codes that are NOT
//     among the dozen-plus exercised end-to-end (listed above).
//
// It is a cheap tripwire for the specific accident the header of errors.ts warns about,
// not a proof of correctness. Its value is that today there is nothing at all.
//
// Entries marked origin:'upstream' are skipped BY DESIGN and reported as skipped, not
// silently passed: their wording belongs to a dependency (arweave, @ardrive/turbo-sdk),
// so it is correctly absent from src/ and cannot be asserted here. 'mixed' entries span
// both and declare their own half in `assertLiterals`. Full end-to-end coverage of the
// whole registry is deliberately NOT attempted — several need a funded wallet or a
// specific gateway failure, and #212 scoped this feature to representative patterns.
//
// Exits 0 on success, 1 on the first failure with context on stderr.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ERRORS_TS = join(ROOT, 'src', 'lib', 'errors.ts');

const fail = (msg) => {
  console.error(`[FAIL] ${msg}`);
  process.exit(1);
};

// Read every .ts under src/ once — a pattern's literal may legitimately live in a file
// other than the one `source` names (that field is documented as "as of writing"), so a
// missing literal is only reported after searching the whole tree.
//
// errors.ts ITSELF is excluded, and that exclusion is the difference between this test
// working and being decorative. Most `source` fields quote the message they point at
// ('src/lib/pushpull.ts (pull, "sha256 mismatch: fetched …")'), so searching this file
// too makes every pattern match its own documentation. Caught by a negative test:
// rewording the real throw site in pushpull.ts still passed, because the literal
// survived inside errors.ts's own prose. Do not re-add it.
function readSrcTree(dir, acc = new Map()) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) readSrcTree(p, acc);
    else if (name.endsWith('.ts') && resolve(p) !== ERRORS_TS) acc.set(relative(ROOT, p), readFileSync(p, 'utf8'));
  }
  return acc;
}

// Turn one pattern into the literal alternatives it searches for. Only the constructs
// this table actually uses are handled; anything else returns null, which the caller
// treats as a FAILURE rather than a skip, so a future pattern shape cannot quietly opt
// itself out of the check.
//
// Every (?:a|b) group is expanded into the full cross-product before splitting on the
// remaining top-level `|`. An earlier version substituted a sentinel character instead:
// it handled only the FIRST group (silently wrong for a pattern with two) and the
// sentinel it used made this file binary to git, so the diff could not be reviewed.
function literals(patternSrc) {
  const GROUP = /\(\?:([^)]*)\)/;
  let variants = [patternSrc];
  for (let guard = 0; variants.some((v) => GROUP.test(v)); guard++) {
    if (guard > 8) return null; // pathological nesting — report rather than loop forever
    const next = [];
    for (const v of variants) {
      const m = v.match(GROUP);
      if (!m) {
        next.push(v);
        continue;
      }
      for (const alt of m[1].split('|')) next.push(v.replace(GROUP, alt));
    }
    variants = next;
  }
  const out = [];
  for (const branch of variants.flatMap((v) => v.split('|'))) {
    // NOT trimmed: whitespace at the edge of an alternative is part of what the regex
    // requires. CB-E014's first alternative ends in a space ("schedule not installed
    // (no "), and trimming it left the checker searching for "…(no" — a prefix of
    // "…(nothing configured)", so rewording the message that way would have PASSED here
    // while no longer matching the regex (multi-model review finding).
    const s = branch
      .replace(/\\([().?[\]/\-+])/g, '$1') // escaped punctuation -> the character itself
      .replace(/\\b/g, '');
    if (/[\\^$*{}]/.test(s)) return null; // a construct this checker does not model
    if (s.trim()) out.push(s); // an all-whitespace branch carries no information
  }
  return out.length ? out : null;
}

const src = readFileSync(ERRORS_TS, 'utf8');
const entryRe =
  /code: '(CB-E\d+)',\s*\n\s*title: '[^']*',\s*\n\s*pattern: \/(.*?)\/[a-z]*,\s*\n\s*origin: '(ours|upstream|mixed)',(?:(?:\s*\n\s*\/\/[^\n]*)*\s*\n\s*assertLiterals: \[([\s\S]*?)\],)?/g;
const entries = [...src.matchAll(entryRe)].map((m) => ({
  code: m[1],
  pattern: m[2],
  origin: m[3],
  assertLiterals: m[4] ? [...m[4].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((x) => x[1].replace(/\\'/g, "'")) : null,
}));

// The table is the source of truth for how many codes exist; if the regex above stops
// matching the file's shape, that must FAIL rather than silently check nothing.
const declared = (src.match(/code: 'CB-E\d+',/g) ?? []).length;
if (declared === 0) fail(`no CB-E### entries found in ${ERRORS_TS} — has the table's shape changed?`);
if (entries.length !== declared) {
  fail(
    `parsed ${entries.length} of ${declared} entries — an entry is missing its \`origin\` field, or the table's field order changed (expected code/title/pattern/origin[/assertLiterals])`,
  );
}

const tree = readSrcTree(join(ROOT, 'src'));
const inSrc = (lit) => [...tree.values()].some((t) => t.includes(lit));
let checked = 0;
const skipped = [];

for (const { code, pattern, origin, assertLiterals } of entries) {
  if (origin === 'upstream') {
    skipped.push(code);
    continue;
  }

  // 'mixed' names the alternatives WE write, because "any one of them is present" is
  // not good enough: the upstream half could start appearing under src/ for an
  // unrelated reason and hold the check up while our half rotted away.
  if (origin === 'mixed') {
    if (!assertLiterals?.length) {
      fail(`${code} (origin: mixed) must list the alternatives we write in \`assertLiterals\` — see errors.ts`);
    }
    // Each asserted literal must actually BE one of the pattern's alternatives.
    // Without this an entry could list any string that happens to exist in src/ and
    // pass while asserting nothing about the pattern (multi-model review finding).
    const alternatives = literals(pattern);
    if (!alternatives) {
      fail(`${code}: cannot extract literals from /${pattern}/ to validate assertLiterals against`);
    }
    const bogus = assertLiterals.filter((l) => !alternatives.some((a) => a.trim() === l.trim()));
    if (bogus.length) {
      fail(
        `${code} (origin: mixed) lists ${JSON.stringify(bogus)} in assertLiterals, but that is not an alternative of /${pattern}/.\n` +
          `        assertLiterals must name the pattern's OWN alternatives — otherwise it asserts something unrelated.`,
      );
    }
    const missing = assertLiterals.filter((l) => !inSrc(l));
    if (missing.length) {
      fail(
        `${code} (origin: mixed) declares ${JSON.stringify(missing)} as ours, but it is not in any .ts under src/.\n` +
          `        Pattern: /${pattern}/. Either that throw site was reworded without updating this table —\n` +
          `        so the code has silently stopped attaching to it — or the alternative belongs upstream now.`,
      );
    }
    checked++;
    continue;
  }

  const alts = literals(pattern);
  if (!alts) {
    fail(`${code}: cannot extract literals from /${pattern}/ — teach literals() this construct, or split the entry`);
  }
  const missing = alts.filter((a) => !inSrc(a));
  if (missing.length) {
    fail(
      `${code} (origin: ours) no longer matches src/: ${JSON.stringify(missing)} not found in any .ts under src/.\n` +
        `        Pattern: /${pattern}/. Either a throw site was reworded without updating the pattern —\n` +
        `        which means this code has silently stopped attaching — or the text now comes from a\n` +
        `        dependency, in which case the entry's origin should say so.`,
    );
  }
  checked++;
}

console.log(`[PASS] all ${checked} assertable CB-E### patterns still match a literal in src/`);
if (skipped.length) {
  console.log(`[SKIP] ${skipped.length} upstream-worded pattern(s) not asserted (by design): ${skipped.join(', ')}`);
}
console.log('ERROR CODE PATTERNS: PASS');
