// gbrain — engine detection for the second brain this tool was built for (#367).
//
// gbrain ships TWO storage engines behind one contract, and PGLite (Postgres 17
// compiled to WASM, whose whole database is a DIRECTORY on disk) is the zero-config
// DEFAULT — not Postgres. cypher-brain had assumed a Postgres server unconditionally
// wherever it touched gbrain, so a default-configuration gbrain user was told their
// real data lives somewhere it does not, and had a live single-writer store copied
// out from under them with no consistency guard. Both consumers (the init wizard and
// snapshot's --dir staging) now branch on what is actually there.
//
// Credit: the engine defaults, the torn-store failure signature, and the
// `gbrain pglite-repair` recovery command are all gbrain's own — see
// https://github.com/garrytan/gbrain (v0.47.3.0 and its README's engine section;
// re-confirmed live against that tag's own src/core/config.ts for #541 — the
// resolution order and field names below are unchanged since the v0.42.75.0 citation
// this replaces, so only the version number needed refreshing).
// Nothing is copied from it; the rules below are reimplemented from the documented
// config contract and described here in our own words.
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

export type GbrainEngine = 'pglite' | 'postgres';

/** What a gbrain config file says about where the brain lives. See detectGbrainEngine. */
export interface GbrainEngineInfo {
  engine: GbrainEngine;
  /**
   * The configured PGLite store, as an absolute path — set ONLY when `database_path` is
   * itself absolute, which is what gbrain writes in practice. This is the one case where
   * the store's location is actually knowable from the config alone.
   */
  dataPath?: string;
  /**
   * The raw `database_path` when it is RELATIVE, in which case its location is NOT
   * knowable from here — see detectGbrainEngine. Never set together with `dataPath`;
   * exposed so a caller can quote the configured value while declining to resolve it.
   *
   * SHOWING THE RAW VALUE IS DELIBERATE, and is not a widening of the privacy boundary
   * (raised in review and rejected on the maintainer's call). It is a filesystem path —
   * the same category `dataPath` already returns — and an operator told only "your store
   * path is relative and I cannot resolve it", without being shown WHICH path, has been
   * handed a warning they cannot act on. The boundary that matters is unchanged: `engine`
   * and `database_path` are the only fields read, and a verdict plus a path is all that
   * leaves this module.
   */
  relativeDataPath?: string;
  /**
   * True ONLY when config.json could not be treated as a real config at all — missing,
   * unreadable (e.g. the path is a directory), unparseable JSON, or JSON that parses to
   * something other than an object (`null`, an array, a bare string/number). In every one
   * of those cases `engine` still falls back to 'postgres' (the safe pre-#367 default,
   * see detectGbrainEngine's own doc comment) — but it is a DEFAULT, not a DETECTION, and
   * a caller presenting that verdict to an operator should say so (#543). Never set when
   * the file parsed fine as an object and simply had no usable `engine`/`database_path`
   * fields — THAT is a genuine (if uninformative) read, not a failure.
   */
  readError?: true;
}

/**
 * Where gbrain's OWN config.json actually lives, mirroring `configDir()` in gbrain's
 * `src/core/config.ts` (re-confirmed live against v0.47.3.0, lines ~1550-1564, the same
 * tag detectGbrainEngine's own doc comment cites): `GBRAIN_HOME` is a PARENT directory
 * that gbrain appends `.gbrain` to itself — `GBRAIN_HOME=/srv/x` puts the config at
 * `/srv/x/.gbrain/config.json`, not `/srv/x/config.json`. Falls back to `~/.gbrain` only
 * when the env var is unset (or blank after trimming), same as gbrain.
 *
 * Both callers into detectGbrainEngine() (the init wizard's snapshot-source prompt, and
 * doctor's standalone `gbrain-engine-detection` check) used to hard-code
 * `join(homedir(), '.gbrain', 'config.json')` independently, so a machine that had
 * relocated its gbrain home via `GBRAIN_HOME` got a false "not set up" from both — a
 * fully configured gbrain silently reported as absent. detectGbrainEngine() itself only
 * reads whatever path it is handed; it has no opinion on where that path comes from. This
 * function is the one place that opinion lives, and every caller must go through it.
 *
 * gbrain VALIDATES the override and THROWS on a bad one (relative, or containing a `..`
 * segment) because it is about to `mkdir`/write there. This function never throws: an
 * operator's malformed `GBRAIN_HOME` is a problem for gbrain itself to surface the next
 * time it runs, not something a read-only wizard/doctor check should crash over. An
 * invalid override is treated the same as an unset one — falling back to `~/.gbrain` —
 * which is honest rather than merely convenient: gbrain would refuse to start against
 * that same invalid value too, so there is no real config to find at the override path
 * either way, and the fallback location is the only one that could possibly hold one.
 */
export function resolveGbrainConfigPath(): string {
  const override = process.env.GBRAIN_HOME;
  const trimmed = override?.trim();
  if (trimmed && isAbsolute(trimmed) && !trimmed.split(/[\\/]/).includes('..')) {
    return join(trimmed, '.gbrain', 'config.json');
  }
  return join(homedir(), '.gbrain', 'config.json');
}

/**
 * What a gbrain home is configured for, mirroring gbrain's OWN resolution order for the
 * config file (`fileConfig?.engine || (fileConfig?.database_path ? 'pglite' : 'postgres')`,
 * verified live against gbrain's current source for #541): a TRUTHY `engine` field wins
 * outright; otherwise the presence of `database_path` (the on-disk PGLite data directory)
 * implies PGLite; otherwise Postgres. Anything unreadable or unparseable falls back to
 * 'postgres' — the pre-#367 assumption, so a malformed config can never make this the
 * thing that breaks a run (see `readError` on GbrainEngineInfo for how a caller can tell
 * that fallback apart from a genuine "no engine configured" read, #543).
 *
 * "A truthy `engine` field wins outright" is doing real work (#534): gbrain's own `||`
 * resolution only falls through to the `database_path` heuristic when `engine` is FALSY
 * (absent, `null`, `''`) — a PRESENT-but-unrecognized value (a hand-edited typo like
 * `"Postgres"`, or a future gbrain engine type this union does not know about yet) is
 * truthy, so real gbrain would take that raw string as-is, never touching
 * `database_path` at all. This function's return type can only ever be `'pglite' |
 * 'postgres'`, so it cannot mirror that exactly — but the one thing it must NOT do is
 * what an earlier version did: treat a present-but-unrecognized value the same as an
 * ABSENT one and run the `database_path` heuristic anyway. That inverted the one case
 * this module explicitly documents as `engine` winning over a stale `database_path` the
 * moment the string was not byte-identical to `'pglite'`/`'postgres'` — the safe answer
 * for a value it cannot represent is the Postgres default, not a heuristic guess.
 *
 * READS EXACTLY TWO FIELDS, AND RETURNS THE VERDICT PLUS `database_path`. `config.json`
 * holds API keys, so nothing else in it is logged, echoed, copied, or returned. That is
 * a hard constraint on this function, not an implementation detail — an added "return
 * the parsed config for convenience" is how a key ends up in a transcript, and that
 * remains forbidden.
 *
 * `database_path` is the ONE deliberate exemption (multi-model review, P1). Returning
 * only a yes/no verdict forced the wizard to hard-code `~/.gbrain` when it told the
 * operator whether their chosen directories covered the store — so a brain configured
 * at, say, `/srv/gbrain` was confirmed as covered by a backup that did not contain the
 * database at all. That is the exact failure #367 exists to eliminate, in a new form.
 * The field is a filesystem path, not a credential, and it is the only way to answer
 * the question correctly. Nothing else follows it out of this function.
 *
 * A relative `database_path` is reported as `relativeDataPath` and NOT resolved, because
 * it cannot be (review round 2). An earlier version anchored it to the config file's own
 * directory, which sounds reasonable and is wrong: gbrain absolutizes the value with a
 * bare `resolve(cfg.database_path)` (see its `doctor.ts` and `migrate-engine.ts`), and
 * `resolve()` on a single relative argument is CWD-relative — so the store's real
 * location depends on which directory the operator happened to launch gbrain from, which
 * nothing here can observe. Guessing an anchor and then telling the operator their backup
 * covers the store would reproduce this issue's original failure in a narrower case: a
 * confident coverage claim that can be wrong. Saying "I cannot tell" is the honest answer
 * and the whole point of #367. In practice gbrain writes an absolute path, so this branch
 * is rare and costs nothing when it is not taken.
 *
 * FILE ONLY — `GBRAIN_DATABASE_URL` / `DATABASE_URL` are deliberately NOT consulted,
 * and gbrain's own runtime resolution must not be imported here to "fix" that. gbrain
 * lets such an env var win outright and force Postgres (it even clears `database_path`
 * in its merged config), which is right for the question IT is asking — "which engine
 * will this process connect to right now?". cypher-brain is asking a different one:
 * "what is on this disk, and does copying it need a warning?". An exported
 * DATABASE_URL does not make an existing PGLite directory stop existing, stop holding
 * data, or stop tearing when copied mid-write. Upstream hit exactly this as a P1 in a
 * gbrain doctor check (garrytan/gbrain#3879): a temporarily-exported DATABASE_URL made
 * a live PGLite brain look like Postgres and the check went on to advise deleting data
 * that was in use. Reading config.json directly was the fix there too. It also keeps
 * the wizard's advice from depending on which shell the operator launched it from.
 */
export async function detectGbrainEngine(configPath: string): Promise<GbrainEngineInfo> {
  try {
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    // A parsed-but-non-object JSON value (null, an array, a bare string/number) is just
    // as much "not a real config" as a read/parse failure below — flagged the same way
    // (#543), not silently folded into the ordinary "no engine field" read. `Array.isArray`
    // is checked explicitly: `typeof [] === 'object'` and `[] !== null`, so a bare JSON
    // array would otherwise slip past this guard and read back as an ordinary,
    // confidently-detected engine-less config (multi-model review).
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { engine: 'postgres', readError: true };
    }
    const cfg = parsed as { engine?: unknown; database_path?: unknown };
    const raw = typeof cfg.database_path === 'string' && cfg.database_path.length > 0 ? cfg.database_path : null;
    // Absolute: knowable, hand it over. Relative: quotable but NOT resolvable — see above.
    const where: Partial<GbrainEngineInfo> = raw
      ? isAbsolute(raw)
        ? { dataPath: resolve(raw) }
        : { relativeDataPath: raw }
      : {};
    if (cfg.engine === 'pglite') return { engine: 'pglite', ...where };
    if (cfg.engine === 'postgres') return { engine: 'postgres' }; // an explicit engine wins; a stale path is not the store
    // #534: a PRESENT but unrecognized `engine` (a typo, or a future gbrain engine type)
    // is truthy, so gbrain's own `||` resolution would never reach the database_path
    // heuristic for it either — it must NOT be treated the same as `engine` being absent.
    // This union cannot represent the raw value, so the safe fallback is Postgres, not a
    // database_path guess (see this function's own doc comment for why that inversion was
    // the bug). Only a genuinely FALSY engine (absent, null, '') falls through to the
    // heuristic below, matching gbrain's own short-circuit exactly.
    if (cfg.engine) return { engine: 'postgres' };
    return raw ? { engine: 'pglite', ...where } : { engine: 'postgres' };
  } catch {
    return { engine: 'postgres', readError: true };
  }
}

/**
 * Is `storePath` inside (or equal to) at least one of `dirs`? Both sides are resolved
 * first, and the containment test is on path SEGMENTS, never a bare string prefix —
 * otherwise `--dir /srv/gb` would report `/srv/gbrain` as covered.
 *
 * The separator is appended only when the root does not already end in one. `resolve()`
 * strips trailing separators from every path EXCEPT the filesystem root, where it
 * returns `/` — so the naive `${root}/` produced `//` and made `--dir /` fail to cover
 * anything at all (review round 2). A false negative on a coverage claim is the same
 * family of bug as the false positive this function was written to prevent.
 */
export function pathCoveredBy(storePath: string, dirs: readonly string[]): boolean {
  const target = resolve(storePath);
  return dirs.some((d) => {
    const root = resolve(d);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    return target === root || target.startsWith(prefix);
  });
}

// A PGLite store IS a PostgreSQL data directory, and carries Postgres's own two
// unmistakable markers: the PG_VERSION stamp file and the pg_wal/ directory. Keying on
// both (rather than, say, the directory's name, which the operator chooses via
// `database_path`) is what lets this find a store anywhere the scan reaches.
//
// WHAT THESE MARKERS DO NOT TELL US (multi-model review): they identify a Postgres-FORMAT
// data directory, not gbrain specifically — an ordinary PostgreSQL server's datadir under
// a --dir looks exactly the same, and there is no marker inside the directory that
// distinguishes a PGLite store from a server one. So the warnings below say "PostgreSQL
// data directory", name PGLite only as the reason a gbrain user has one, and offer
// `gbrain pglite-repair` as something to try IF it is a gbrain store rather than as a
// prescription. The hazard being warned about — copying a live cluster's files — is
// identical either way, which is why one detector legitimately covers both.
//
// The filesystem is the AUTHORITY here, and it answers alone: the detection below never
// consults config.json or the environment. What is about to be tar'd is what is on disk,
// so a store that a config no longer points at — or that an exported DATABASE_URL claims
// has been superseded — still gets the warning. That is precisely the case where an
// operator is most likely to be surprised, and the cost of being wrong is asymmetric: a
// spurious warning is noise, a missed one is a backup that looks fine until it is needed.
const PG_VERSION = 'PG_VERSION';
const PG_WAL = 'pg_wal';

/**
 * Cheap CANDIDATE filter: do these entry names, read from ONE directory, look like a
 * data directory? Names only — the listing path has no type information to work with —
 * so every hit is confirmed against the filesystem by confirmDataDir below.
 */
const marksDataDir = (names: Iterable<string>): boolean => {
  let version = false;
  let wal = false;
  for (const n of names) {
    if (n === PG_VERSION) version = true;
    else if (n === PG_WAL) wal = true;
    if (version && wal) return true;
  }
  return false;
};

/**
 * Confirm a candidate: PG_VERSION must be a FILE and pg_wal must be a DIRECTORY. A
 * directory named PG_VERSION, or a file named pg_wal, is not a cluster — matching on
 * names alone let both through (multi-model review). Two stat() calls per candidate,
 * and candidates are rare, so this costs nothing measurable.
 *
 * stat(), not lstat(): Postgres supports pg_wal being a symlink onto another volume, and
 * such a cluster is still a cluster. (tar archives that symlink as a link rather than
 * following it, which makes the resulting copy worse, not better — one more reason to
 * warn.)
 */
async function confirmDataDir(absDir: string): Promise<boolean> {
  try {
    const [version, wal] = await Promise.all([stat(join(absDir, PG_VERSION)), stat(join(absDir, PG_WAL))]);
    return version.isFile() && wal.isDirectory();
  } catch {
    return false; // either marker missing or unreadable — not something to warn about
  }
}

/**
 * Directories a PostgreSQL cluster cannot start without. Deliberately a SHORT,
 * uncontroversial floor rather than an attempt at the full layout: the WAL, and the two
 * directories holding the actual relations.
 */
const REQUIRED_DIRS = new Set([PG_WAL, 'base', 'global']);

/**
 * Single files whose absence alone stops a cluster starting, relative to the store root.
 * These are the only paths where losing ONE entry is by itself decisive.
 */
const MARKER_FILES = new Set([PG_VERSION, 'global/pg_control']);

/**
 * How much damage one excluded path does to a store. THREE levels, because the evidence
 * comes in three strengths and the wording has to match each (review round 3 — the third
 * appearance of the same over-claiming reflex, closed properly rather than narrowly):
 *
 *   'fatal'   — a marker FILE is gone, or an ENTIRE required directory is. Nothing opens
 *               without these, so "cannot be opened at all" is a fact.
 *   'partial' — paths were taken from INSIDE a required directory without removing it.
 *               Some of what lives in `pg_wal/`, `base/` or `global/` is disposable
 *               (`pg_wal/archive_status/*.done` is the canonical example — a cluster
 *               starts fine without those) and some is load-bearing, and NOTHING here can
 *               tell which was cut. So: "may prevent it opening", naming the component.
 *   'none'    — `postmaster.pid`, a log, transient stats. Reportable, not decisive.
 *
 * Deliberately NOT an enumeration of disposable paths. That list is long, version-
 * dependent, and a single wrong entry errs in the dangerous direction — silently
 * downgrading a fatal exclusion. Keying on what is provably decisive instead means the
 * uncertain middle stays uncertain, which is the honest place for it.
 */
type ExclusionImpact = 'fatal' | 'partial' | 'none';

/** Classify one excluded path (store-relative) against the layout above. */
const classifyExclusion = (inner: string): ExclusionImpact => {
  if (MARKER_FILES.has(inner)) return 'fatal'; // a decisive single file
  if (REQUIRED_DIRS.has(inner)) return 'fatal'; // the WHOLE directory pruned
  return REQUIRED_DIRS.has(inner.split('/', 1)[0]) ? 'partial' : 'none';
};

/** One PostgreSQL data directory found at or under a scanned source root. */
export interface PgDataDirFinding {
  /** POSIX path relative to the scanned root; `''` means the root itself is the store. */
  rel: string;
  /**
   * How many paths inside this store a `.cypherbrainignore` rule keeps OUT of the
   * archive. 0 = the whole store is archived (the ordinary case).
   */
  excludedInside: number;
  /** Of those, how many are 'fatal' — the only count that licenses a certainty. */
  excludedFatal: number;
  /** Of those, how many are 'partial' — licenses "may prevent it opening", nothing more. */
  excludedPartial: number;
  /** Required directories a 'partial' exclusion reached into, named in that warning. */
  touchedComponents: string[];
}

/** A path that lies strictly INSIDE `dir` (`''` = the scan root, so everything is inside it). */
const strictlyUnder = (p: string, dir: string): boolean => (dir === '' ? p.length > 0 : p.startsWith(`${dir}/`));

/** A scan-root-relative path, re-expressed relative to the store at `dir`. */
const innerPath = (p: string, dir: string): string => (dir === '' ? p : p.slice(dir.length + 1));

/**
 * PostgreSQL data directories at or under `rootAbs`.
 *
 * `listing`, when given, must be the COMPLETE set of paths the caller's own walk saw —
 * BOTH what it will archive and what it filtered out. snapshot passes scanDir's
 * `tarEntries` plus its excluded entries, so the detection runs entirely in memory: no
 * second traversal of a tree the caller just finished walking, at any depth.
 *
 * Passing only the archived half is a bug that hides the worst case (multi-model review,
 * measured): an ignore rule matching `pg_wal/` removes a marker, detection goes quiet,
 * and the run that produces a store which cannot open AT ALL is the one that says
 * nothing. `excludedInside` exists so that case gets its own, louder warning.
 *
 * WITHOUT a listing there is no walk to borrow, and this reads the root and its
 * IMMEDIATE subdirectories only — deliberately bounded, so pointing --dir at a large
 * tree does not pay for a full recursive walk just to produce an advisory. That covers
 * both layouts that occur in practice: --dir aimed straight at the store, and
 * `--dir ~/.gbrain` with the store one level down at the configured `database_path`. A
 * store nested deeper than one level is NOT found on this path, and the docs say so in
 * those words rather than promising "anywhere under the source" — see selftest
 * `selftest-gbrain-pglite.sh` (c), which pins the boundary in both directions.
 */
export async function findPgDataDirs(
  rootAbs: string,
  listing?: { included: readonly string[]; excluded: readonly string[] },
): Promise<PgDataDirFinding[]> {
  const candidates: string[] = [];
  if (listing) {
    // Group every known path by its parent directory ('' = the root itself), then apply
    // the candidate test to each group's child names.
    const childNames = new Map<string, string[]>([['', []]]);
    for (const rel of [...listing.included, ...listing.excluded]) {
      const cut = rel.lastIndexOf('/');
      const parent = cut === -1 ? '' : rel.slice(0, cut);
      const name = cut === -1 ? rel : rel.slice(cut + 1);
      const bucket = childNames.get(parent);
      if (bucket) bucket.push(name);
      else childNames.set(parent, [name]);
    }
    for (const [dir, names] of childNames) if (marksDataDir(names)) candidates.push(dir);
  } else {
    let top: Dirent[];
    try {
      top = await readdir(rootAbs, { withFileTypes: true });
    } catch {
      return []; // not a directory, or unreadable — nothing to advise about
    }
    if (marksDataDir(top.map((e) => e.name))) candidates.push('');
    else {
      for (const e of top) {
        if (!e.isDirectory()) continue;
        try {
          if (marksDataDir(await readdir(join(rootAbs, e.name)))) candidates.push(e.name);
        } catch {
          /* unreadable subdirectory — skip it, this is advisory only */
        }
      }
    }
  }
  const findings: PgDataDirFinding[] = [];
  for (const rel of candidates.sort()) {
    if (!(await confirmDataDir(rel ? join(rootAbs, rel) : rootAbs))) continue;
    const inside = listing ? listing.excluded.filter((p) => strictlyUnder(p, rel)) : [];
    const classified = inside.map((p) => {
      const inner = innerPath(p, rel);
      return { inner, impact: classifyExclusion(inner) };
    });
    const touched = new Set(classified.filter((c) => c.impact === 'partial').map((c) => c.inner.split('/', 1)[0]));
    findings.push({
      rel,
      excludedInside: inside.length,
      excludedFatal: classified.filter((c) => c.impact === 'fatal').length,
      excludedPartial: classified.filter((c) => c.impact === 'partial').length,
      touchedComponents: [...touched].sort(),
    });
  }
  return findings;
}

/** How a finding is named to the operator: the --dir they passed, plus where inside it. */
const storeLabel = (sourceLabel: string, rel: string): string => (rel ? `${sourceLabel}/${rel}` : sourceLabel);

/**
 * The warning for a source that carries a PostgreSQL data directory. Exported so the
 * selftest pins the wording against the single place it is written.
 *
 * A WARNING, never a refusal (#367): the whole point of `schedule install` is an
 * unattended nightly run, and a backup tool that declines to back up is worse than one
 * that backs up loudly.
 *
 * WHAT IT MAY AND MAY NOT CLAIM (multi-model review, P3). The load-bearing fact is a
 * documented property of PostgreSQL, not a reproduction: a running cluster's files
 * cannot be copied at the file level outside its own backup API, because a copy that
 * spans time captures different files at different instants and can tear a page
 * mid-write. What happens NEXT is genuinely uncertain — crash recovery salvages most
 * such copies, an inconsistent one can also open and carry latent damage, and a
 * WAL-focused repair cannot fix every kind of inconsistency. Fifteen bounded attempts
 * to produce a torn copy on one machine produced none, which is exactly why this says
 * "may" throughout and offers the repair command as something to try rather than as a
 * promise. Do not strengthen this wording without evidence that outranks that.
 */
export const pgDataDirCopyWarning = (sourceLabel: string, rel: string): string =>
  `"${storeLabel(sourceLabel, rel)}" is a PostgreSQL data directory — gbrain's default engine, PGLite, keeps its ` +
  `whole database as one. It is archived as a plain tar of that directory, and PostgreSQL does not support ` +
  `file-level copies of a running cluster outside its own backup API: the files can be captured at different ` +
  `instants, so the copy may be internally inconsistent. Crash recovery salvages most such copies, but it is not ` +
  `guaranteed to, and an inconsistent copy can also open with latent damage. verify will not tell you either way ` +
  `— it checks the ciphertext, which is well-formed regardless. Stop the writer (for gbrain, "gbrain serve") for ` +
  `the duration of the snapshot. Unlike --pg, which pg_dump makes point-in-time consistent, nothing here does it ` +
  `for you. If a restored gbrain store then fails to open, "gbrain pglite-repair" is worth trying.`;

/**
 * The STRONGER warning: an ignore rule removes part of a data directory from the archive.
 *
 * This is not the same hazard as the one above and must not share its sentence (review
 * round 1, measured): a mid-write copy MAY be inconsistent, whereas a data directory
 * missing required pieces of itself cannot be opened at all. It is also the case the
 * pre-fix code silently swallowed, because the excluded marker was the very thing
 * detection was looking for. Quiescing gbrain does not help here; removing the rule does.
 *
 * THREE STRENGTHS, because the certainty has to be earned and the evidence arrives in
 * three grades (review rounds 2 and 3 — see ExclusionImpact for the classification and
 * for why enumerating disposable paths would have been the wrong fix):
 *
 *   fatal   — a marker file or a whole required directory is gone: "cannot be opened at
 *             all", stated flatly, because it is.
 *   partial — paths taken from inside `pg_wal/`, `base/` or `global/`: "MAY prevent the
 *             restored copy from opening", naming the component, because some of what
 *             lives there is disposable and nothing here can tell what was cut.
 *   none    — nothing required was touched: reportable, hedged to "may still open".
 *
 * When in doubt the wording degrades, never escalates.
 */
export const pgDataDirTruncatedWarning = (sourceLabel: string, finding: PgDataDirFinding): string => {
  const { rel, excludedInside, excludedFatal, excludedPartial, touchedComponents } = finding;
  const head =
    `"${storeLabel(sourceLabel, rel)}" is a PostgreSQL data directory (gbrain's PGLite store is one) and a ` +
    `.cypherbrainignore rule keeps ${excludedInside} path(s) INSIDE it out of this snapshot`;
  const tail = `Remove the ignore rule that matches inside this directory, or point --dir somewhere that does not contain it.`;
  if (excludedFatal > 0) {
    return (
      `${head}, ${excludedFatal} of them removing a marker file or an entire directory a cluster cannot start ` +
      `without (${PG_VERSION}, ${[...REQUIRED_DIRS].join('/, ')}/). A data directory is only usable whole: this is ` +
      `not the "maybe inconsistent" risk of copying a live cluster, it is a copy that cannot be opened at all, and ` +
      `verify will still pass on it. ${tail}`
    );
  }
  if (excludedPartial > 0) {
    return (
      `${head}, ${excludedPartial} of them from inside ${touchedComponents.map((c) => `${c}/`).join(' and ')} — a ` +
      `directory the cluster needs, though not everything in it is load-bearing. Removing paths from inside it MAY ` +
      `prevent the restored copy from opening, and nothing here can tell whether what you cut was disposable. ` +
      `verify will pass either way. ${tail}`
    );
  }
  return (
    `${head}. None of them is inside a component a cluster needs, so the copy may still open — but a data ` +
    `directory is meant to be archived whole, and verify cannot tell you whether what is missing mattered. ${tail}`
  );
};
