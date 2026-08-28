// buildinfo — WHEN was the code that is actually running built, and from what (#348).
//
// Motivation, measured: a hand-copied dist/cli.mjs ran the real snapshot host for 5+
// weeks while silently missing documented features (.cypherbrainignore, --dry-run, the
// turbo backend) — and, being pre-#277, silently IGNORING unknown flags, so a
// `snapshot --dry-run` against it performed a real 442 MB write. Nothing surfaced the
// build's age; it was discovered only when a documented feature visibly failed to
// exist. The version field cannot carry this signal — every build to date says 0.0.1.
//
// The provenance is the COMMIT hash and COMMIT date (not wall-clock build time, so
// rebuilding the same commit yields identical bytes), stamped into dist by
// scripts/build.ts via `define` — the same mechanism the restore runbook uses
// (src/lib/runbook.ts). A dev run (bin/cypher-brain.mjs executing src/ directly) has no
// stamp and derives the same facts live from git; a stampless, gitless run answers
// null, which doctor reports as "unknown" — never as "fresh".
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __CYPHER_BRAIN_BUILD_INFO__: string | undefined; // injected by scripts/build.ts (#348)

export interface BuildInfo {
  commit: string;
  commit_date: string; // ISO-8601, the commit's own date — not when `bun run build` ran
  dirty: boolean; // built from a tree with uncommitted changes
  source: 'stamped' | 'git'; // baked into dist at build time vs derived live (dev run)
}

function fromGit(): BuildInfo | null {
  try {
    const here = fileURLToPath(import.meta.url);
    if (!here.endsWith(join('src', 'lib', 'buildinfo.ts'))) {
      return null;
    }
    const dir = dirname(here);
    const out = execFileSync('git', ['log', '-1', '--format=%H %cI'], { cwd: dir, encoding: 'utf8' }).trim();
    const [commit, commitDate] = out.split(' ');
    if (!commit || !commitDate) return null;
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8' }).trim() !== '';
    return { commit, commit_date: commitDate, dirty, source: 'git' };
  } catch {
    return null;
  }
}

export function buildInfo(): BuildInfo | null {
  if (typeof __CYPHER_BRAIN_BUILD_INFO__ === 'string') {
    try {
      const parsed = JSON.parse(__CYPHER_BRAIN_BUILD_INFO__) as unknown;
      // A git-less BUILD stamps the literal null — and it STAYS null (reported as
      // "unknown"): a stamped-null bundle later run inside some checkout must not
      // pretend that checkout's HEAD built it. A malformed stamp is null too, checked
      // field-by-field — doctor renders these values, and a stamp that is not the
      // shape this file wrote must not reach it (Codex review).
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        typeof (parsed as BuildInfo).commit === 'string' &&
        typeof (parsed as BuildInfo).commit_date === 'string' &&
        typeof (parsed as BuildInfo).dirty === 'boolean'
      ) {
        const { commit, commit_date, dirty } = parsed as BuildInfo;
        return { commit, commit_date, dirty, source: 'stamped' };
      }
      return null;
    } catch {
      return null;
    }
  }
  return fromGit();
}

// Pure, injectable-clock age classifier so the WARN boundary is testable without
// faking a build stamp. Thresholded at 90 days (WARN at 90 full days and beyond —
// floor(age) >= 90, so the words and the arithmetic agree; Codex review): deploys of
// this tool follow the monthly push cadence, so ~3 missed cycles is drift worth
// flagging — while the age itself is ALWAYS printed (the incident build was 39 days
// old; the visible age line, not the warn, is what would have caught it).
export const BUILD_STALE_DAYS = 90;

export function buildAgeDays(commitDateIso: string, nowMs: number): number | null {
  const t = Date.parse(commitDateIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}
