// Founder's note + cited precursor quotes — see issue #195. Same posture as
// ui.ts's mascot: pure decoration, STDERR-only, EPIPE-safe (reuses ui.ts's
// installEpipeGuard), and NEVER part of machine-readable output. Callers are
// limited, on purpose, to two moments in src/cli.ts's interactive dispatch:
//   - `init` completion (a note from the person who built this)
//   - a successful `push` to the arweave/turbo/ton-provider PAID backends (a
//     precursor quote) — never the free `file` backend, which is not the
//     "first paid, permanent upload" moment this is meant to mark.
// mcp.ts calls snapshot/push/verify directly (never through cli.ts's
// dispatch), so an MCP tool call never triggers either of these.
import { installEpipeGuard } from './ui.js';

/** A note from the person who built this: why key custody / memory
 *  sovereignty is the point, not a sales pitch. One variant today; more may
 *  be added later as long as the core point ("your memories, your key, not
 *  ours") stays the same. */
const FOUNDER_NOTES: readonly string[] = [
  'A note from the person who built this: your memories — the ideas, the conversations, the years of context — ' +
    "are yours. Not mine, not a company's, not whoever's server they happen to sit on today. That's the only " +
    'thing this tool is trying to guarantee.',
];

export interface Quote {
  quote: string;
  author: string;
  year: string;
  source: string;
}

// Only cited, independently-verified quotes go here (issue #195 — no
// fabricated or unverifiable attributions). Adding another requires the same
// bar: an exact quote AND a source that actually contains it.
const QUOTES: readonly Quote[] = [
  {
    quote: "The root problem with conventional currency is all the trust that's required to make it work.",
    author: 'Satoshi Nakamoto',
    year: '2009',
    source:
      'P2P Foundation forum post, 2009-02-11 — ' +
      'https://news.bitcoin.com/13-years-ago-today-satoshi-nakamoto-published-the-first-forum-post-introducing-bitcoin/',
  },
  {
    quote: 'The interesting thing about encryption is that it cannot be secure just for some people.',
    author: 'Pavel Durov',
    year: '2016',
    // Note: the issue's suggested dig.watch link does not itself contain this
    // exact quote (checked while implementing this) — cited here instead to
    // the CBS "60 Minutes" segment (Lesley Stahl interview) that does.
    source:
      '60 Minutes (CBS), interview with Lesley Stahl, 2016 — https://cbsnews.com/video/encryption-cannot-be-secure-just-for-some-people',
  },
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/**
 * Print the founder's note to STDERR, right after `init`'s own completion
 * summary. Decoration only — same EPIPE-safety as printMascot.
 */
export function printFounderNote(): void {
  installEpipeGuard();
  console.error(`\n${pick(FOUNDER_NOTES)}\n`);
}

/**
 * Print one precursor quote (random pick, no rotation bookkeeping needed —
 * this fires at most once per process, right after a successful push to any
 * paid backend: arweave/turbo/ton-provider) to STDERR. Decoration only —
 * same EPIPE-safety as printMascot.
 */
export function printWisdomQuote(): void {
  const q = pick(QUOTES);
  installEpipeGuard();
  console.error(`\n"${q.quote}"\n  — ${q.author}, ${q.year} (${q.source})\n`);
}
