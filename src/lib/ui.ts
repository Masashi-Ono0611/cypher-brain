// Tiny pure-ASCII mascot for cypher-brain's human-facing TTY output (README
// banner, `--help`, and the `verify` VERDICT line) — see issue #147.
//
// This ASCII-fies the repo's OWN existing mascot brand rather than inventing a
// new one: `mascot.svg` / `favicon.svg` (both already in this repo — the
// landing page's cypherpunk hooded dog in sunglasses, with binary-digit "10"
// / "01" reflections in the lenses) is the source of truth for the motif.
// This is a deliberate deforme of that SVG down to its essentials for a 4-line
// terminal face: the SVG's floppy ear flaps (small peaks either side of the
// head) and connected sunglasses bar, with everything else (the SVG's rounder
// full-face outline, nose) dropped — the earlier "full face" attempt that
// tried to also carry a nose/hood/jaw outline read as cluttered, not cool.
//
// The bracket style on each lens doubles as a verification signal: `[..]`
// (square, "on straight") vs `(..)` (round, "slipping") — see FACES below.
// The `==` between the lenses is the sunglasses bridge joining them into one
// bar; it never changes with mood, so the bracket signal reads against a
// constant.
//
// Kept strictly ASCII (no unicode, not even the accent glyphs mira-harness
// allows itself) so it renders identically in any terminal/locale with zero
// alignment risk — decoration only, never part of machine-readable output
// (nothing here should be called on a --json / piped path).

/** PARTIAL mirrors `verify`'s third VERDICT (decryptability not proven on this
 *  box): one lens still square ("proven"), the other slipped round
 *  ("unproven") — a literal "half verified" face. */
export type Mood = 'neutral' | 'happy' | 'sad' | 'partial';

/** lensL/lensR: `[10]` (square, "sunglasses on straight") vs `(10)` (round,
 *  "sunglasses slipping") — verification-completeness, not emotion. mouth is
 *  a single smile/frown character at index 7, one column short of the face's
 *  own 7.5 center (the `==` bridge and face edges split evenly; a single
 *  character can't) — carrying the emotion: `-` neutral, `v` grin for PASS,
 *  `x` for FAIL, `~` uncertain for PARTIAL. deco is a small accent flanking
 *  the ears, ONLY on the two strong-emotion moods (a `+` shine for happy, a
 *  `!` for sad) — neutral/partial stay plain so the accent reads as signal,
 *  not noise on every render. */
const FACES: Record<Mood, { lensL: string; lensR: string; mouth: string; deco: string }> = {
  neutral: { lensL: '[10]', lensR: '[01]', mouth: '-', deco: '' },
  happy: { lensL: '[10]', lensR: '[01]', mouth: 'v', deco: '+' },
  sad: { lensL: '(10)', lensR: '(01)', mouth: 'x', deco: '!' },
  partial: { lensL: '[10]', lensR: '(01)', mouth: '~', deco: '' },
};

/**
 * The floppy-eared, sunglassed dog mascot, faced for `mood`. Used by the
 * README banner (neutral), `cypher-brain --help` (neutral), and `verify`'s
 * VERDICT line (mood mapped from PASS/FAIL/PARTIAL via `moodForVerdict`).
 */
export function mascot(mood: Mood = 'neutral'): string[] {
  const f = FACES[mood];
  // Each ear is "/\" (indices 2-3 and 12-13); only its INNER stroke (the "\"
  // at 3, the "/" at 12) lands on the lens row's own bracket columns below
  // (` | [10]==[01] |`, brackets at index 3 and 12), which is what puts the
  // ears directly over the sunglasses regardless of mood — this is measured
  // against that literal row, not assumed from a symmetry formula (an
  // earlier attempt used the row's own center-column mirror instead of the
  // lens row's actual bracket positions, which put the right ear a column
  // off from the lens under it). Decoration doesn't move either ear; it only
  // adds a column outside them. Undecorated rows total 15 chars (2 leading
  // spaces, 1 trailing) to match the lens/mouth/jaw rows' own 15-char total
  // below — the per-side margins don't match (those rows run 1 leading, 0
  // trailing), only the total width does. Deco'd rows widen to 16 (the
  // accent plus a 1-space gap outside each ear) without shifting either ear.
  const ears = f.deco ? `${f.deco} /\\        /\\ ${f.deco}` : '  /\\        /\\ ';
  return [ears, ` | ${f.lensL}==${f.lensR} |`, ` |     ${f.mouth}      |`, " '.__________.'"];
}

/** Maps `verify`'s three VERDICT strings onto a mascot mood: PASS is happy,
 *  FAIL is sad, PARTIAL (decryptability not proven on this box) is the
 *  one-lens-slipped "not fully verified" face. */
export function moodForVerdict(verdict: 'PASS' | 'FAIL' | 'PARTIAL'): Mood {
  if (verdict === 'PASS') return 'happy';
  if (verdict === 'FAIL') return 'sad';
  return 'partial';
}

// A closed downstream pipe surfaces as an EPIPE 'error' event on process.stderr
// ASYNCHRONOUSLY (Node re-throws it from inside its own event-loop dispatch a
// tick later — a try/catch around the write call does NOT see it), so the only
// reliable guard is a no-op 'error' listener on the stream itself, same idea as
// crypt.ts's `cons.stdin?.on('error', () => {})` for the age|tar pipeline.
// Installed lazily (only once printMascot is actually used) and only once.
let epipeGuardInstalled = false;
/** Exported so other decoration-only, STDERR-only modules (wisdom.ts's
 *  founder's note / precursor quotes, issue #195) can install the same
 *  EPIPE guard without duplicating it. */
export function installEpipeGuard(): void {
  if (epipeGuardInstalled) return;
  epipeGuardInstalled = true;
  process.stderr.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
  });
}

/**
 * Print the mascot to STDERR — decoration only, so it never lands in a
 * command's machine-readable stdout. A caller piping/grepping that stdout for
 * a specific line (e.g. `verify ... | grep -q 'VERDICT: PASS'`, or the same
 * with `2>&1` merging stderr in first) closes its end of the pipe the instant
 * it matches, which can be BEFORE this later, decoration-only write lands —
 * without the guard above, Node throws an uncaught EPIPE and kills the CLI.
 * A downstream reader that already got what it needed must never crash us.
 */
export function printMascot(mood: Mood): void {
  installEpipeGuard();
  console.error(mascot(mood).join('\n'));
}

// ---------- machine-readable stdout (--json, #211/#270) ----------
//
// Every --json document a command prints goes through printJson(), and NOTHING
// else writes JSON to stdout. That makes "has this run already produced its JSON
// document?" a fact the top-level error handler can ask (hasWrittenJson), instead
// of an invariant maintained by hoping — #270 appends an error object to stdout on
// failure, and a command that had already printed its own document would otherwise
// leave two JSON values on stdout, which no consumer can parse as one.
//
// Today no --json command can throw after printing (each prints last and returns),
// so this guard never fires; it exists so that stops being something a future
// command has to remember.
let jsonWritten = false;

/** True once printJson() has written a command's own JSON document to stdout. */
export const hasWrittenJson = (): boolean => jsonWritten;

// #737: installEpipeGuard() above only ever listens on process.stderr — right for
// printMascot/warn.ts/wisdom.ts (all stderr-only decoration), but printJson() is the
// one writer in this file that puts its output on STDOUT instead. A downstream
// consumer of `--json` output that closes its end early (e.g. `cypher-brain ledger
// --json | head -c1`) surfaces the exact same async EPIPE 'error' event this file
// already guards against, just on process.stdout — its own installed-flag/listener
// pair, since it is a different stream than installEpipeGuard()'s.
let stdoutEpipeGuardInstalled = false;
function installStdoutEpipeGuard(): void {
  if (stdoutEpipeGuardInstalled) return;
  stdoutEpipeGuardInstalled = true;
  process.stdout.on('error', (e: NodeJS.ErrnoException) => {
    if (e.code !== 'EPIPE') throw e;
  });
}

/** Print one JSON document to stdout — the single writer, see the note above. */
export function printJson(value: unknown): void {
  installEpipeGuard();
  installStdoutEpipeGuard();
  // Serialize BEFORE flipping jsonWritten (Codex review): a `value` that JSON.stringify
  // itself rejects (a circular structure, a BigInt) throws here, before anything reaches
  // stdout. The old order flipped the flag first, so hasWrittenJson() would then lie to
  // the top-level error handler ("a JSON document was already printed") for a call that
  // printed nothing at all — suppressing the JSON error object #270 exists to guarantee.
  const text = JSON.stringify(value);
  jsonWritten = true;
  console.log(text);
}
