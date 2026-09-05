#!/usr/bin/env node
// Proof for #858's follow-up finding on src/lib/gbrain.ts's pathCoveredBy(): coverage
// used to be computed with node:path's `resolve()` alone — purely LEXICAL, never
// touching the filesystem — so a symlink anywhere in either the store path or a
// covered `--dir` was left exactly as written. That let a PGLite `database_path`
// which is itself a symlink pointing OUTSIDE every covered `--dir` be reported
// "covered" merely because the symlink FILE happened to sit inside one lexically —
// even though archiving that directory only captures the link itself (tar does not
// dereference), so the real data would silently be missing from the backup.
//
// This test also covers findings from this SAME fix's own diff-only Codex re-review,
// across two rounds:
//   - Round 1 (Critical): an earlier version resolved a `dirs` ENTRY through a symlink
//     exactly like `storePath`, which produced a NEW false positive — `tar` never
//     dereferences a TOP-LEVEL `--dir` symlink argument either, so a symlinked `dirs`
//     entry cannot cover anything through it no matter where it points. (c) below, and
//     its own tar positive control, prove that is now handled correctly. Round 1 also
//     flagged a dangling symlink (one whose target does not exist) being mistaken for a
//     merely not-yet-created path; (f) and (g) cover that.
//   - Round 2 (Warning): the (f)/(g) fixtures from round 1 sat OUTSIDE every covered
//     root, so they passed for the wrong reason (plain non-containment) even with the
//     dangling-symlink check removed entirely — proving nothing about that logic. Both
//     are now placed LEXICALLY INSIDE a covered root instead, making them genuine
//     positive controls (see the fixture comments below for how this was verified).
//     Round 2 also flagged `isSymlink()` swallowing every lstat() failure uniformly,
//     including a real error (EACCES/EIO) unrelated to "nothing is there" — fixed in
//     src/lib/gbrain.ts directly (propagate anything but ENOENT/ENOTDIR), no dedicated
//     fixture here since it needs a fault-injecting mock filesystem this file does not
//     build.
//
// Part 1 (positive control / grounding — proves the storePath-side bug was real): a
// faithful reimplementation of the PRE-FIX lexical-only algorithm, run directly (not
// imported — that code no longer exists in src/) against the escaping-symlink fixture
// below. Per this codebase's own "a guard is unverified until you have watched it
// fire" discipline, this must independently reproduce the false "covered" verdict; if
// it did not, the rest of this test would be proving nothing.
//
// Part 2 (the actual fix): the SAME fixtures, plus a dedicated fixture for the
// dirs-entry-is-a-symlink case, run against the REAL, CURRENT pathCoveredBy() from
// src/lib/gbrain.ts, covering:
//   (a) a symlink INSIDE a covered root pointing OUTSIDE it — must now be NOT covered
//       (closes the storePath-side #858 false positive)
//   (b) the necessary symmetric case: a symlink OUTSIDE every covered root pointing at
//       real data INSIDE one — must now be covered (the archive captures that data as
//       an ordinary directory when it walks the covered root, regardless of what path
//       was used to name it; the pre-fix lexical check produced a false NEGATIVE here)
//   (c) a `dirs` entry that is ITSELF a symlink to a real directory — must NOT be
//       treated as covering data under its target (closes the review-round false
//       positive: `tar` archives a top-level symlink `--dir` argument as the link
//       itself, never descending into it — proven directly below with a real `tar`
//       invocation, not just asserted)
//   (d) a storePath that does not exist yet, nested under a real covered root — must
//       still be covered (regression check: the walk-up-to-nearest-existing-ancestor
//       fallback must not turn "not created yet" into a false negative)
//   (e) plain non-symlink containment, both a hit and a miss — sanity baseline
//   (f) a storePath that IS a dangling symlink (target does not exist), LEXICALLY
//       inside a covered root — must NOT be covered: a dangling link never leads to
//       real, archivable data (round-2 positive control: placed inside the root so a
//       regressed check would misreport it as covered, not merely uncontained)
//   (g) same as (f), but the dangling symlink is an ANCESTOR of storePath rather than
//       storePath's own final component — must also NOT be covered
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

let failed = 0;
const check = (name, cond, detail) => {
  if (cond) {
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// Part 1: the exact pre-#858-followup implementation (node:path `resolve()` only, no
// filesystem access at all) — kept here, not in src/, since it is deliberately the
// buggy version.
function pathCoveredByLexicalOnly(storePath, dirs) {
  const target = resolve(storePath);
  return dirs.some((d) => {
    const root = resolve(d);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return target === root || target.startsWith(prefix);
  });
}

const { pathCoveredBy } = await import('../src/lib/gbrain.ts');

const tmp = await mkdtemp(join(tmpdir(), 'cb-path-covered-by-'));
try {
  // realpath the scratch tree up front: on macOS $TMPDIR is itself under a symlink
  // (/var -> private/var), which would otherwise make every "real path" assertion
  // below fail for reasons unrelated to what this test is actually checking (same
  // precaution scripts/selftest-mcp-snapshot-policy.mjs takes for the same reason).
  const base = await realpath(tmp);

  const rootA = join(base, 'rootA');
  const rootAData = join(rootA, 'data');
  const rootB = join(base, 'rootB');
  const outside = join(base, 'outside');
  const outsideTarget = join(outside, 'target');
  await mkdir(rootAData, { recursive: true });
  await mkdir(rootB, { recursive: true });
  await mkdir(outsideTarget, { recursive: true });

  // (a)/Part 1 fixture: a symlink INSIDE rootA pointing OUTSIDE it.
  const escapeLink = join(rootA, 'escape');
  await symlink(outsideTarget, escapeLink);

  // (b) fixture: a symlink OUTSIDE rootA pointing at real data INSIDE it.
  const inboundLink = join(outside, 'inbound');
  await symlink(rootAData, inboundLink);

  // (c) fixture: a `dirs` entry that is itself a symlink to a real directory.
  const rootLink = join(base, 'rootA-link');
  await symlink(rootA, rootLink);

  // (f)/(g) fixtures: BOTH placed INSIDE rootA (not merely somewhere unrelated), so a
  // check against [rootA] is a genuine positive control for the dangling-symlink logic
  // specifically — a regressed implementation that dropped the dangling check entirely
  // would otherwise fall back to ordinary lexical/walk-up containment and misreport
  // both as covered (verified: removing the dangling checks and re-running this file
  // flips both to a false PASS-as-covered, exactly the failure mode this test exists to
  // catch). Fixtures placed OUTSIDE every covered root would pass for the wrong reason
  // (plain non-containment) even with the dangling check removed, proving nothing.

  // (f) fixture: storePath itself is a dangling symlink (target never created).
  const danglingStore = join(rootA, 'dangling-store');
  await symlink(join(base, 'never-created'), danglingStore);

  // (g) fixture: an ANCESTOR of storePath is a dangling symlink.
  const danglingMid = join(rootA, 'dangling-mid');
  await symlink(join(base, 'also-never-created'), danglingMid);
  const throughDanglingMid = join(danglingMid, 'tail');

  // ── Part 1: positive control (storePath-side false positive) ───────────────
  check(
    'positive control: the pre-fix LEXICAL-only algorithm really does misreport the escaping symlink as covered',
    pathCoveredByLexicalOnly(escapeLink, [rootA]) === true,
    'if this is false, the fixture does not exercise the bug this test exists to catch',
  );

  // ── Positive control for (c): a real `tar` invocation, not just an assertion ─
  // Confirms this codebase's own documented claim (src/lib/profiles.ts,
  // src/lib/snapshot.ts) that a top-level `--dir` symlink argument is archived as the
  // link itself — never dereferenced, never descended into — which is exactly why a
  // `dirs` entry that is itself a symlink must not be reported as "covering" its
  // target below.
  const tarPath = join(base, 'control.tar');
  execFileSync('tar', ['-cf', tarPath, '-C', base, 'rootA-link']);
  const listing = execFileSync('tar', ['-tvf', tarPath], { encoding: 'utf8' }).trim();
  const listingLines = listing.split('\n').filter(Boolean);
  check(
    "positive control: a real tar archive of a symlinked --dir argument contains only the link entry itself, never the target's own files",
    listingLines.length === 1 && /^l/.test(listingLines[0]) && !listing.includes('/data'),
    `unexpected tar listing: ${listing}`,
  );

  // ── Part 2: the real, current pathCoveredBy() ───────────────────────────────
  check(
    '(e) plain containment — a real path under a covered root is covered',
    (await pathCoveredBy(rootAData, [rootA])) === true,
  );
  check(
    '(e) plain containment — a real path under an UNrelated root is not covered',
    (await pathCoveredBy(rootAData, [rootB])) === false,
  );
  check(
    '(a) a symlink INSIDE a covered root pointing OUTSIDE it is NOT covered (closes the #858 false positive)',
    (await pathCoveredBy(escapeLink, [rootA])) === false,
  );
  check(
    '(b) a symlink OUTSIDE every covered root, pointing at real data INSIDE one, IS covered (symmetric fix)',
    (await pathCoveredBy(inboundLink, [rootA])) === true,
  );
  check(
    '(c) a `dirs` entry that is itself a symlink to a real directory does NOT cover data under its target (tar never dereferences it)',
    (await pathCoveredBy(rootAData, [rootLink])) === false,
  );
  check(
    '(d) a storePath that does not exist yet, nested under a real covered root, is still covered (no regression)',
    (await pathCoveredBy(join(rootA, 'not-created-yet', 'store'), [rootA])) === true,
  );
  check(
    '(f) a storePath that is itself a dangling symlink, LEXICALLY inside a covered root, is still NOT covered ' +
      '(positive control: a naive lexical/walk-up fallback would misreport this as covered)',
    (await pathCoveredBy(danglingStore, [rootA])) === false,
  );
  check(
    '(g) a storePath whose own ANCESTOR is a dangling symlink, LEXICALLY inside a covered root, is still NOT ' +
      'covered (same positive control as (f), one level deeper)',
    (await pathCoveredBy(throughDanglingMid, [rootA])) === false,
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}

if (failed > 0) {
  console.log(`\nPATH-COVERED-BY SELFTEST FAIL (${failed})`);
  process.exit(1);
}
console.log('\nPATH-COVERED-BY SELFTEST PASS');
