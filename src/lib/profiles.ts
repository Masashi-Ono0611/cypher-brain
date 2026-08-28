// profiles — one-flag source presets (--profile) for the product's target users.
// A profile is a THIN VENEER over the existing --dir assembly: it only RESOLVES
// a list of source paths, which snapshot() then stages exactly as explicit
// --dir flags would (one tar.gz per path — the stage tar handles files as well
// as directories). No new snapshot machinery. Explicit --dir flags compose with
// a profile: they are appended AFTER the profile's paths. Every profile fails
// fast with an actionable error when its inputs are missing, so a mistyped run
// can never produce an empty "backup". Every returned path is realpath()-
// dereferenced: tar archives a symlink argument as the symlink itself, which
// would silently back up a pointer instead of the data.
import { readdir, realpath, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { exists } from './util.js';
import { didYouMean, nearestName } from './suggest.js';
import type { CliOptions } from './types.js';

export const PROFILE_NAMES = ['claude-code', 'obsidian', 'chatgpt-export', 'o2b'];

// #461: a plain NAME check, deliberately split out of resolveProfilePaths() below so a
// caller that must refuse a bad --profile before doing anything else (schedule.ts's
// install(), which writes a runner script + plist/cron entry — see its own call site
// comment) can do so without also paying for, or requiring at THIS moment, whatever
// filesystem inputs (--vault, --zip, --export) each individual profile needs to actually
// run. resolveProfilePaths() below calls this too, so `snapshot --profile <typo>` and
// `schedule install --profile <typo>` refuse with the exact same message — the two
// surfaces must not disagree about what a valid profile name is, same reasoning as
// assertExportRequiresO2bProfile() just below. Shares its matcher with #463 (did-you-mean
// for --profile): a future caller there needs only PROFILE_NAMES + nearestName(), both
// already here.
export function assertKnownProfile(profile: string | undefined): void {
  if (profile === undefined) return;
  if (PROFILE_NAMES.includes(profile)) return;
  const suggestion = nearestName(profile, PROFILE_NAMES);
  throw new Error(
    `unknown profile "${profile}"${suggestion ? ` (${didYouMean(suggestion)})` : ''} — valid profiles: ${PROFILE_NAMES.join(', ')}`,
  );
}

// --export (issue #206) is read ONLY by o2bPaths() below, and ONLY reached via
// resolveProfilePaths() — which snapshot.ts calls `if (o.profile)` and schedule.ts's
// install() never calls at all (it just bakes cfg.export into the runner's snapshot
// line unconditionally). So `--export <path>` given without `--profile o2b` — a typo'd
// or forgotten --profile, or --export left over from a different --profile — used to
// parse fine (a recognized VALUE_FLAG, src/cli.ts) and then be silently DROPPED: a
// `snapshot --dir X --export bank.json` with no --profile would exit 0 having archived
// nothing from the bundle, and a `schedule install` with the same mistake would bake a
// nightly that repeats that silently every night. That is the exact "flag accepted,
// never honored, looks identical to a flag that WAS" bug class #253/#277/#307 all
// refuse elsewhere — refused here too, called by both snapshot() and schedule's
// install() before either does anything else with o.export (multi-model review, PR #334).
export function assertExportRequiresO2bProfile(o: CliOptions): void {
  if (o.export === undefined) return;
  if (o.profile === 'o2b') return;
  throw new Error(
    `--export <path> only applies to --profile o2b (it is the bundle "o2b brain bank-export --out <file>" writes) — ` +
      (o.profile
        ? `this run's --profile is "${o.profile}", which does not read --export`
        : 'no --profile was given, so --export would otherwise be silently ignored') +
      `. Add --profile o2b to actually use --export, or drop --export if you meant --profile ${o.profile ?? '<name>'} on its own.`,
  );
}

// Resolve --profile to the concrete source paths it snapshots.
export async function resolveProfilePaths(o: CliOptions): Promise<string[]> {
  assertKnownProfile(o.profile);
  switch (o.profile) {
    case 'claude-code':
      return claudeCodePaths();
    case 'obsidian':
      return obsidianPaths(o);
    case 'chatgpt-export':
      return chatgptExportPaths(o);
    case 'o2b':
      return o2bPaths(o);
    default:
      // Unreachable: assertKnownProfile() above already refused anything not in
      // PROFILE_NAMES (with its own did-you-mean suggestion, shared with #463 — see
      // that function's comment). This default only exists to satisfy TS's return-type
      // check on the switch (o.profile is typed `string | undefined`, not a literal
      // union of PROFILE_NAMES, so the compiler can't see the cases are exhaustive on
      // its own).
      throw new Error(`unknown profile "${o.profile}" — valid profiles: ${PROFILE_NAMES.join(', ')}`);
  }
}

// claude-code: every ~/.claude/projects/*/memory/ dir (per-project auto-memory)
// plus ~/.claude/CLAUDE.md (global instructions), whichever of those exist. If
// NONE exist the profile errors listing what it looked for — a silently-empty
// snapshot would be worse than a refusal. homedir() honors $HOME, so tests
// point the profile at a synthetic home by faking that env var.
async function claudeCodePaths(): Promise<string[]> {
  const claude = join(homedir(), '.claude');
  const projects = join(claude, 'projects');
  const claudeMd = join(claude, 'CLAUDE.md');
  const paths: string[] = [];
  let entries: Dirent[] = [];
  try {
    entries = await readdir(projects, { withFileTypes: true });
  } catch {
    /* no projects dir — CLAUDE.md may still exist */
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const mem = join(projects, e.name, 'memory');
    if (await exists(mem)) paths.push(await realpath(mem));
  }
  if (await exists(claudeMd)) paths.push(await realpath(claudeMd));
  if (paths.length === 0) {
    throw new Error(
      `profile claude-code found nothing to snapshot — looked for ${join(projects, '*', 'memory')} and ${claudeMd}`,
    );
  }
  return paths;
}

// obsidian: the vault directory, whole. A real vault contains .obsidian/; a
// path without it is probably a typo (snapshotting the wrong tree feels like
// success until restore day), so refuse unless --force-vault says "I know".
async function obsidianPaths(o: CliOptions): Promise<string[]> {
  if (!o.vault) throw new Error('profile obsidian requires --vault <path> (the vault directory)');
  const vault = resolve(o.vault);
  const st = await stat(vault).catch(() => null);
  if (!st) throw new Error(`no vault at ${vault} — profile obsidian snapshots the vault directory`);
  if (!st.isDirectory()) throw new Error(`${vault} is not a directory — profile obsidian expects the vault directory`);
  if (!(await exists(join(vault, '.obsidian'))) && !o.force_vault) {
    throw new Error(
      `${vault} does not look like an Obsidian vault (no .obsidian/ inside) — pass --force-vault to snapshot it anyway`,
    );
  }
  return [await realpath(vault)];
}

// chatgpt-export: the official ChatGPT data-export zip, taken AS-IS. It is
// archived as one component file and never extracted, so the restored zip is
// byte-identical to what ChatGPT handed out.
async function chatgptExportPaths(o: CliOptions): Promise<string[]> {
  if (!o.zip) throw new Error('profile chatgpt-export requires --zip <path> (the official ChatGPT export zip)');
  const zip = resolve(o.zip);
  const st = await stat(zip).catch(() => null);
  if (!st?.isFile())
    throw new Error(`no export zip at ${zip} — profile chatgpt-export takes the official ChatGPT export zip`);
  if (!zip.endsWith('.zip'))
    throw new Error(
      `${zip} does not end in .zip — profile chatgpt-export takes the official export zip as-is (not an extracted tree; use --dir for that)`,
    );
  return [await realpath(zip)];
}

// o2b: an Open Second Brain (https://github.com/itechmeat/open-second-brain) bank-export
// bundle, taken AS-IS. `o2b brain bank-export [--vault <path>] [--out <file>]` serialises
// preferences + the page graph + per-page interchange contracts + the read-only sources
// dashboard into ONE deterministic, schema-versioned JSON document — the same "whole-brain,
// single-file, never re-derived" shape chatgpt-export's official export already is, which
// is why this profile follows that one almost verbatim. Upstream does NOT fix a filename or
// extension for --out (its own CLI test suite writes bundles named "bank.json"/"b.json"),
// so the ".json" check below is cypher-brain's OWN convention (mirroring chatgpt-export's
// ".zip" check), not something o2b itself requires — point bank-export's --out at a
// "*.json" path for this profile to accept it. Never parsed or expanded: restore hands the
// bundle back byte-identical, the same "carried, not reconstructed" honesty bank-import
// itself states about what it can and cannot restore from one.
async function o2bPaths(o: CliOptions): Promise<string[]> {
  if (!o.export)
    throw new Error(
      'profile o2b requires --export <path> (the bundle written by "o2b brain bank-export --out <file>")',
    );
  const bundle = resolve(o.export);
  const st = await stat(bundle).catch(() => null);
  if (!st?.isFile())
    throw new Error(
      `no bank-export bundle at ${bundle} — profile o2b takes the file "o2b brain bank-export --out <file>" writes`,
    );
  if (!bundle.endsWith('.json'))
    throw new Error(
      `${bundle} does not end in .json — profile o2b takes the bank-export bundle as-is (run "o2b brain bank-export --out <path>.json"; not an extracted/expanded form — use --dir for that)`,
    );
  return [await realpath(bundle)];
}
