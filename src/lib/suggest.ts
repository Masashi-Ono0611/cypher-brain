// suggest — the ONE "did you mean X?" idiom, shared by every surface that has to
// answer a name the user got slightly wrong (#300).
//
// It started as a single hand-written sentence: `restore --out` names the flag it
// ignored and points at `--out-dir` (#277). That message is what makes the CLI's
// answer useful rather than merely correct, so the MCP server's unknown-argument
// refusal wants the same idiom — and a second, independently-worded copy of it is
// exactly the drift this repo keeps removing (#276 env names declared twice, #290
// the tool list, #293 a path check). Two exports, deliberately separate:
//
//   - didYouMean(name) is the PHRASING, and nothing else. A caller that already
//     knows the answer (restore.ts knows `--out-dir` is the flag that was meant)
//     uses only this, so its exact message never becomes contingent on a fuzzy
//     match happening to fire.
//   - nearestName(input, candidates) is the MATCH, for a caller that has a set of
//     valid names and has to work out which one was meant (the MCP dispatcher,
//     which only learns the tool's property names at call time).

/** The one phrasing, so every surface asks it with the same words. */
export const didYouMean = (name: string): string => `did you mean ${name}?`;

// Damerau-Levenshtein edit distance (restricted/"optimal string alignment"
// variant: an adjacent-character transposition costs 1, like a substitution,
// instead of the 2 that plain Levenshtein charges it as a delete+insert or
// two substitutions). Iterative three-row DP (no dependency for ~25 lines,
// and this runs once per rejected call — on a handful of short identifiers).
//
// Plain Levenshtein's 2-cost transposition was enough to push a common typo
// like `quikc` (for `quick`) outside nearEnough()'s 1-edit threshold, so a
// textbook "swapped two adjacent letters" mistake got no suggestion at all
// (#537) — the restricted variant is the standard, cheap fix, and exact for
// the single-typo case this function exists to catch.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prevPrev = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, substitution);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        curr[j] = Math.min(curr[j], prevPrev[j - 2] + 1);
      }
    }
    [prevPrev, prev, curr] = [prev, curr, prevPrev];
  }
  return prev[b.length];
}

// A typo is "near" when it is within a third of the shorter name's length (so
// `scan_secretz` → `scan_secrets` and `recipient` → `recipients` qualify, while
// two genuinely different fields do not), at least 1 so a single-character slip
// in a short name still counts.
const nearEnough = (a: string, b: string): number => Math.max(1, Math.floor(Math.min(a.length, b.length) / 3));

/**
 * The candidate `input` most plausibly meant, or undefined when nothing is close.
 *
 * Comparison is case-INSENSITIVE (so a `Out` for `out` is offered as the near miss
 * it is) even though the callers' own acceptance is case-sensitive — the suggestion
 * exists to explain a rejection, not to widen what is accepted.
 *
 * A candidate that EXTENDS the input (`out` → `out_dir`) also counts, whatever the
 * edit distance: that is #277's own case, where the wrong name is a real flag
 * elsewhere rather than a misspelling. Only that direction — a candidate that is a
 * prefix OF the input would make `outgoing` suggest `out`, which is not a near miss
 * at all. Distance wins over the prefix rule when both
 * find something, and ties keep the caller's declaration order, so the answer is
 * deterministic.
 */
export function nearestName(input: string, candidates: Iterable<string>): string | undefined {
  const list = [...candidates];
  const needle = input.toLowerCase();
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of list) {
    const d = editDistance(needle, candidate.toLowerCase());
    if (d <= nearEnough(needle, candidate) && d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  if (best) return best;
  // Nothing was close enough to be a misspelling — fall back to the "you named a real
  // field, just not this one's" case. Guarded on a non-empty input, or the empty-string
  // key every candidate trivially starts with would get a suggestion.
  if (needle.length === 0) return undefined;
  return list.find((c) => c.length > needle.length && c.toLowerCase().startsWith(needle));
}
