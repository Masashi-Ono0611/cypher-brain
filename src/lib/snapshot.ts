// snapshot — stage components (pg_dump / dirs / manifest.json), then stream tar|age.
import { mkdir, writeFile, rm, stat, lstat, rename, link, readdir, readlink, readFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, basename, dirname, resolve, relative, sep } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import ignore, { type Ignore } from 'ignore';
import {
  RECIPIENT,
  PIN_RECIPIENTS,
  PIPE_TIMEOUT_MS,
  SIGN_IDENTITY,
  pgTool,
  MANIFEST_SCHEMA_VERSION,
} from './config.js';
import { run } from './proc.js';
import { newEncrypter, encryptToFile } from './crypt.js';
import { exists, fmtBytes, requirePath, sha256, errMsg, redactPgConn } from './util.js';
import { warn } from './warn.js';
import { findPgDataDirs, pgDataDirCopyWarning, pgDataDirTruncatedWarning } from './gbrain.js';
import { recipientEntries, resolvePinnedRecipients } from './keys.js';
import { loadSignIdentity, signDetached } from './minisign.js';
import {
  assertExportRequiresO2bProfile,
  assertPgFiltersRequirePg,
  assertVaultRequiresObsidianProfile,
  assertZipRequiresChatgptExportProfile,
  resolveProfilePaths,
} from './profiles.js';
import { installStageSignalGuard, setActiveStage, setActiveOutPart } from './signal-guard.js';
import {
  assertGitleaksAvailable,
  gitleaksAvailable,
  scanForSecrets,
  reportSecretFindings,
  isScanSecretsMode,
  SCAN_SECRETS_MODES,
  type ActiveScanMode,
  type SecretFinding,
} from './secrets-scan.js';
import type { CliOptions } from './types.js';

// Promote a finished .part to its final --out, no-clobber. Prefer link(): it is atomic
// and fails with EEXIST if out appeared meanwhile, giving a true exclusive no-clobber
// even under overlapping snapshots. But hard links are unsupported on exFAT/FAT and some
// network/cloud mounts (common backup media), where link throws EPERM/ENOTSUP — there,
// fall back to an exclusive create (writeFile with the 'wx' flag, the same no-clobber
// idiom keys.ts/wizard.ts already use) as the no-clobber GATE, instead of a racy
// exists()-then-rename() check-then-act: 'wx' atomically fails with EEXIST if `out`
// already exists, so of two overlapping snapshots at most one can win the create — the
// loser sees EEXIST and refuses, same as the link() path. The winner then owns `out`
// and folds the real content in via rename() (itself atomic: readers see either the
// empty placeholder or the complete file, never a torn write). The promotion DECISION
// is now race-free either way; no TOCTOU window remains there. Residual: an unclean
// kill (SIGKILL bypasses any in-process cleanup, on the link() path too) between the
// create and the rename can leave an empty placeholder at `out` — but that fails SAFE
// (a later run sees EEXIST and refuses with the same clobberErr, an operator can `rm`
// the empty file and retry) rather than the silent, undetectable clobber this fix closes.
async function promoteSnapshot(part: string, out: string): Promise<void> {
  const clobberErr = () =>
    new Error(`${out} already exists — refusing to overwrite a prior snapshot (move it aside or choose a new --out)`);
  try {
    await link(part, out);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === 'EEXIST') throw clobberErr();
    if (err?.code && ['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(err.code)) {
      try {
        await writeFile(out, '', { flag: 'wx' });
      } catch (createErr) {
        const ce = createErr as NodeJS.ErrnoException;
        if (ce && ce.code === 'EEXIST') throw clobberErr();
        throw createErr;
      }
      try {
        await rename(part, out);
      } catch (renameErr) {
        // best-effort: undo the placeholder create so a retry doesn't see a false
        // EEXIST; swallow any cleanup error so it never masks the real renameErr.
        try {
          await rm(out, { force: true });
        } catch {
          /* ignore */
        }
        throw renameErr;
      }
      return;
    }
    throw e;
  }
  await rm(part, { force: true }); // drop the redundant link; out is the durable copy
}

const hexOf = (s: string): string => createHash('sha256').update(s).digest('hex');

// Mode string shared by every tuple line below: octal rwx bits, what tar actually
// archives alongside an entry's bytes.
const modeOf = (st: { mode: number }): string => (st.mode & 0o777).toString(8).padStart(3, '0');

// One file's tuple line — the SAME format whether the file is the sole top-level
// source (a --dir-equivalent arg that is actually a single file: profile files/zips
// are explicitly supported this way) or one entry inside a directory walk. Sharing
// this helper (rather than a second, ad-hoc "just hash the file" path for the
// top-level-file case) is what makes a chmod-only change to a single-file source
// perturb the digest exactly like a chmod-only change to a file nested in a --dir
// source does (#70 review round 3).
async function fileTupleLine(rel: string, full: string): Promise<string> {
  const st = await stat(full);
  return `${rel}\tf\t${await sha256(full)}\t${st.size}\t${modeOf(st)}`;
}

// Deterministic PLAINTEXT content digest of one source path — the signal behind
// `push --skip-unchanged`. It has to come from the plaintext side: age generates an
// ephemeral file key per run, so identical content encrypts to DIFFERENT ciphertext
// bytes every time — the ciphertext sha256 can never say "unchanged". Explicitly
// independent of mtimes and of the tar byte stream (tar records mtimes/order):
//   - top-level symlink → the link's OWN identity (what it points to), never its
//            target's content. tar archives an explicit symlink argument as the
//            link itself (bsdtar/GNU tar both default to not dereferencing — the
//            same class of bug profiles.ts's realpath-dereference comment fixes
//            for --vault/--zip/claude-code paths), so a target swapped for a
//            different path — even one with byte-identical content — changes
//            what actually gets archived and must change the digest too.
//   - top-level file → hexOf of ITS OWN tuple line (fileTupleLine, same format a
//            nested file gets inside a directory walk) — so a chmod-only change to
//            a single-file source (e.g. a --profile file) changes the digest just
//            like it would for the same file nested in a --dir (#70 review round 3).
//   - top-level special (FIFO/socket/device: not a symlink, not a directory, not a
//            regular file) → the SAME bare kind marker the nested-walk's `else`
//            branch below hashes for a special file found inside a --dir, NEVER a
//            fileTupleLine read: a FIFO only yields bytes once something writes to
//            the other end, so sha256()-ing it (as a plain "unconditionally a
//            regular file" read would) can hang forever — outside PIPE_TIMEOUT_MS,
//            which only bounds the tar step, not this digest read (#70 review round 4).
//   - dir  → sha256 over the "\n"-joined, path-sorted lines
//            "<relpath>\t<kind>\t<per-file sha256>\t<size>\t<mode>" for everything
//            under it, PLUS one synthetic "." line carrying the top-level directory's
//            OWN mode (a chmod on the --dir arg itself, touching no file inside it,
//            still changes what tar archives and must still change the digest — #70
//            review round 3). The trailing <mode> (files and directories, octal rwx
//            bits) is what tar actually archives alongside the entry — `chmod +x
//            script.sh` or tightening a secret file/dir to 0600/0700 changes the tar
//            entry's permission bits without touching content, so a restore from a
//            digest that ignored mode could silently carry stale/wrong permissions
//            past --skip-unchanged (#70 review round 2 & 3). Nested symlinks hash
//            their target string; other specials (FIFOs, sockets) hash as a bare kind
//            marker — reading them could hang, and their presence still perturbs the
//            digest.
async function contentDigestOfPath(abs: string): Promise<string> {
  const top = await lstat(abs);
  if (top.isSymbolicLink()) return hexOf(`l\t${await readlink(abs)}`);
  if (!top.isDirectory() && !top.isFile()) return hexOf('s\t-\t0'); // FIFO/socket/device — never read, could hang
  if (!top.isDirectory()) return hexOf(`${await fileTupleLine(basename(abs), abs)}\n`);
  const lines = [`.\td\t-\t0\t${modeOf(top)}`]; // the --dir arg's own mode, never covered by readdir below
  for (const d of await readdir(abs, { recursive: true, withFileTypes: true })) {
    const full = join(d.parentPath, d.name);
    const rel = relative(abs, full).split(sep).join('/'); // POSIX-normalized so the digest is platform-stable
    if (d.isFile()) lines.push(await fileTupleLine(rel, full));
    else if (d.isSymbolicLink()) lines.push(`${rel}\tl\t${hexOf(await readlink(full))}\t0`);
    else if (d.isDirectory()) lines.push(`${rel}\td\t-\t0\t${modeOf(await stat(full))}`);
    else lines.push(`${rel}\ts\t-\t0`);
  }
  lines.sort();
  return hexOf(`${lines.join('\n')}\n`);
}

// #216: ".cypherbrainignore" (gitignore-compatible syntax) at the ROOT of a --dir (or a
// --profile-resolved directory) filters what gets archived from THAT directory —
// node_modules/, caches, credential files etc no longer have to be tar'd, encrypted and
// (on a paid backend) permanently stored just because they happened to live under a
// backed-up tree. Matching is delegated entirely to the `ignore` npm package (the same
// gitignore-semantics implementation widely used by eslint/gitbook/etc) rather than a
// hand-rolled glob — no wheel reinvented, and the syntax an operator already knows from
// .gitignore works here unchanged.
const IGNORE_FILE_NAME = '.cypherbrainignore';
// The pre-rename name, still honoured when the current one is absent so an existing tree
// keeps filtering exactly as before the cipher-brain -> cypher-brain rename.
const LEGACY_IGNORE_FILE_NAME = '.cipherbrainignore';

// Read a --dir root's own ignore file. Returns null when absent — the ONLY
// behavior-preserving path: every call site below falls back to the exact pre-#216 tar
// invocation when this is null, so a --dir with no ignore file is archived byte-for-byte
// as it always was. Root-only lookup (not a cascading per-subdirectory .gitignore
// stack): the issue asks for one ignore file per --dir/--profile root, and reimplementing
// git's full nested-.gitignore precedence rules is unneeded complexity this tool never
// asked for. The current name wins; the legacy name is only read when it is absent (never
// merged, so which file is in effect is always unambiguous).
async function loadIgnoreFile(dirAbs: string): Promise<{ ig: Ignore; name: string } | null> {
  for (const name of [IGNORE_FILE_NAME, LEGACY_IGNORE_FILE_NAME]) {
    const p = join(dirAbs, name);
    if (await exists(p)) return { ig: ignore().add(await readFile(p, 'utf8')), name };
  }
  return null;
}

// One LEAF (file/symlink/special) entry a --dir scan classified as included or excluded.
// `rel` is POSIX-relative to the --dir root — the SAME root scanDir() below walks, never
// the root's parent (a caller staging into a tar archive prefixes this with the root's
// own basename; --dry-run prints it as-is). `size` is meaningful only for kind 'file'
// (0 for a symlink/special, whose "size" doesn't describe archived content) and for a
// pruned excluded 'dir' entry, where it is the aggregate byte total of everything under
// that subtree (see dirByteSize) — an ignored node_modules/ is reported as ONE excluded
// 'dir' line with its whole-tree size, never as thousands of individual excluded file
// lines, which would make --dry-run's output useless for exactly the large, ignorable
// trees this feature exists to filter.
interface ScanEntry {
  rel: string;
  kind: 'file' | 'symlink' | 'dir' | 'other';
  size: number;
}

// Aggregate regular-file bytes under an (already-known-ignored) subtree — used only to
// give --dry-run's excluded-directory entries an approximate size. Best-effort: a file
// that vanishes mid-walk (a real, if narrow, race against a live tree) is just skipped
// rather than failing the scan — this is a read-only reporting path, not the archive
// itself, so an approximate total is fine (the CLI help calls it exactly that: "an
// approximate byte total").
async function dirByteSize(abs: string): Promise<number> {
  let total = 0;
  for (const d of await readdir(abs, { recursive: true, withFileTypes: true })) {
    if (!d.isFile()) continue;
    try {
      total += (await stat(join(d.parentPath, d.name))).size;
    } catch {
      /* vanished mid-walk — best-effort size, never fatal */
    }
  }
  return total;
}

// Walk a --dir root, applying `ig` (null = no filtering, every entry included) to decide
// what tar should actually archive. Returns:
//   - tarEntries: POSIX paths relative to the root, PARENT-BEFORE-CHILD, for every
//     INCLUDED dir/file/symlink/special — fed to `tar --no-recursion -T` (snapshot()
//     below) in place of tar's own recursion. An ignored directory is never even
//     descended into (pruned at the directory itself, ig.ignores() tested BEFORE
//     recursing), which is both what makes a large ignored node_modules/ cheap to skip
//     AND what matches real gitignore semantics: once a parent directory is excluded,
//     nothing under it can be un-excluded by a nested pattern (same rule git itself
//     applies — this walker enforces it structurally rather than by re-implementing
//     precedence).
//   - included / excluded: LEAF entries only (never bare directories, except a pruned
//     excluded subtree — see ScanEntry above), for --dry-run's file lists and byte
//     totals.
// `withSizes` gates the two costs that only --dry-run's reporting needs and the real
// snapshot's archive-building does not: dirByteSize's extra recursive walk per pruned
// directory, and a stat() per included file. snapshot() below calls this with
// `withSizes: false` when actually building the tar entry list (only `tarEntries` is
// read there) so filtering a real --dir with a large ignored node_modules/ does not pay
// to size the very subtree it just skipped; dryRun() calls it with the (default) true.
async function scanDir(
  root: string,
  ig: Ignore | null,
  opts: { withSizes: boolean } = { withSizes: true },
): Promise<{ tarEntries: string[]; included: ScanEntry[]; excluded: ScanEntry[] }> {
  const tarEntries: string[] = [];
  const included: ScanEntry[] = [];
  const excluded: ScanEntry[] = [];
  async function walk(rel: string): Promise<void> {
    const abs = rel ? join(root, rel) : root;
    const entries = await readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name)); // deterministic tar entry order
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const childAbs = join(abs, e.name);
      const isDir = e.isDirectory();
      // A trailing slash on the tested pathname is the `ignore` package's documented
      // convention for matching gitignore's dir-only patterns (e.g. "node_modules/")
      // — there is no separate "is this a directory" flag on .ignores().
      const ignored = ig ? ig.ignores(isDir ? `${childRel}/` : childRel) : false;
      if (isDir) {
        if (ignored) {
          excluded.push({ rel: childRel, kind: 'dir', size: opts.withSizes ? await dirByteSize(childAbs) : 0 });
        } else {
          tarEntries.push(childRel);
          await walk(childRel);
        }
        continue;
      }
      const kind: ScanEntry['kind'] = e.isSymbolicLink() ? 'symlink' : e.isFile() ? 'file' : 'other';
      const size =
        opts.withSizes && kind === 'file'
          ? await stat(childAbs).then(
              (s) => s.size,
              () => 0,
            )
          : 0;
      if (ignored) excluded.push({ rel: childRel, kind, size });
      else {
        tarEntries.push(childRel);
        included.push({ rel: childRel, kind, size });
      }
    }
  }
  await walk('');
  return { tarEntries, included, excluded };
}

// One entry in the manifest's `components` array — either the pg_dump (kind
// 'pg_dump:custom', no `source`) or one staged --dir/--profile path (kind 'dir'/'file').
interface ManifestComponent {
  name: string;
  kind: string;
  source?: string;
  tables?: string[] | 'all';
  // --pg-filter / --pg-exclude-table-data (issue #235): recorded verbatim, purely for
  // manifest transparency (same spirit as `tables` above) — never read back by
  // cypher-brain itself; a restore-time pg_restore doesn't need to know how the dump
  // was filtered.
  filter?: string;
  exclude_table_data?: string[];
  content_digest: string;
  captured_at: string;
  // #216: present (true) only when a .cypherbrainignore at this component's root
  // filtered what got archived; excluded_count is the number of top-level excluded
  // paths (individually-excluded files + pruned ignored subtrees, each subtree counted
  // once regardless of how many files it contained). Absent entirely (not `false`)
  // when no ignore file applied, so old manifests and new unfiltered ones look
  // identical — this is purely additive provenance, never a behavior signal restore
  // reads.
  cypherbrainignore?: boolean;
  excluded_count?: number;
  // Present only when --scan-secrets was passed (#215): gitleaks rule-ID + count for
  // this component, NEVER the matched secret/file path/line (see secrets-scan.ts).
  secrets_scan?: SecretFinding[];
}

export async function snapshot(o: CliOptions): Promise<void> {
  // #206/multi-model review: --export only feeds profile o2b — refuse it up front
  // rather than silently drop it when --profile o2b is missing or wrong (see
  // profiles.ts's assertExportRequiresO2bProfile doc comment).
  assertExportRequiresO2bProfile(o);
  // #525: --pg-table/--pg-filter/--pg-exclude-table-data only feed the `if (o.pg)` pg_dump
  // block far below — refuse up front, same reasoning as assertExportRequiresO2bProfile
  // just above (see profiles.ts's assertPgFiltersRequirePg doc comment). No --profile
  // interaction, so (unlike the --vault/--zip guards just below) there is no reason to
  // wait for resolveProfilePaths() first.
  assertPgFiltersRequirePg(o);
  // --profile is a thin veneer over --dir: it resolves to concrete source paths
  // (see profiles.ts) staged exactly like explicit --dir flags. Profile paths
  // come first; any extra --dir flags the user passed are appended after them.
  if (o.profile) o.dirs = [...(await resolveProfilePaths(o)), ...o.dirs];
  // #525/#535: --vault only feeds profile obsidian, --zip only feeds profile
  // chatgpt-export — refuse a mismatch here, AFTER resolveProfilePaths() above (not
  // before, unlike assertPgFiltersRequirePg), so that when --profile DOES match (e.g.
  // obsidian given --vault) but that profile's OWN required flag is what's actually
  // missing, obsidianPaths()'s more specific "requires --vault" refusal (#535) is what
  // the user sees instead of a generic mismatch message about some unrelated flag. Still
  // strictly before any staging/archiving work: resolveProfilePaths() only stats/resolves
  // paths. See profiles.ts's doc comment on these two guards for the full reasoning.
  assertVaultRequiresObsidianProfile(o);
  assertZipRequiresChatgptExportProfile(o);
  if (!o.pg && o.dirs.length === 0)
    throw new Error('nothing to snapshot: pass --profile <name>, --pg <conn> and/or --dir <path>');
  // #267: check every source path up front — before the --dry-run branch, before
  // --out is even required, and long before pg_dump or any staging — so a mistyped
  // --dir names itself instead of surfacing several steps later as a raw
  // "ENOENT: no such file or directory, lstat '<path>'". requirePath (not exists())
  // so a dangling top-level symlink, which snapshot archives on purpose, still passes.
  for (const d of o.dirs) await requirePath(resolve(d), 'snapshot source');
  // #216: --dry-run previews --dir/--profile .cypherbrainignore filtering WITHOUT
  // staging, encrypting or writing anything — checked HERE, before the --out
  // requirement below, since a preview has no output file (no --out needed).
  //
  // It also never stages plaintext, so gitleaks has nothing to look at: --scan-secrets
  // is REFUSED with it rather than skipped (#307, multi-model review). Skipping was the
  // pre-#307 behaviour and it let `--dry-run --scan-secrets deny` exit 0 having scanned
  // nothing — readable as a clean scan preflight — and `--dry-run --scan-secrets bogus`
  // exit 0 on a value the real run rejects. Same rule as the no-source case below: never
  // let a request for the gate come back successful having inspected nothing.
  if (o.dry_run) {
    if (o.scan_secrets !== undefined)
      throw new Error(
        `--scan-secrets cannot be combined with --dry-run: a dry run stages no plaintext, so there is nothing for ` +
          `gitleaks to scan and the preview would exit 0 having checked nothing. Drop --dry-run to run the gate for ` +
          `real, or drop --scan-secrets to preview the .cypherbrainignore filtering.`,
      );
    return dryRun(o);
  }
  if (!o.out) throw new Error('--out <file.age> required');
  // --scan-secrets warn|deny|off (#215/#301): gitleaks over each --dir/--profile source's staged
  // plaintext before it is archived+encrypted. Validated AND gitleaks-availability-checked
  // here, before any pg_dump/tar/staging work below — the same fail-fast posture the
  // --out parent dir / recipient checks below already follow.
  // Captured BEFORE the write-back at the end of this block: every later decision that
  // turns on "did the caller ASK for this gate" must read THIS, not o.scan_secrets, which
  // by then reports what actually ran.
  const scanExplicit = o.scan_secrets !== undefined;
  let scanMode: ActiveScanMode | undefined;
  if (o.scan_secrets !== undefined) {
    if (!isScanSecretsMode(o.scan_secrets))
      throw new Error(
        `--scan-secrets must be ${SCAN_SECRETS_MODES.map((m) => `"${m}"`).join(', ')} (got ${JSON.stringify(o.scan_secrets)})`,
      );
    // The scan runs per --dir/--profile component (see the staging loop below), so with
    // no such source there is nothing for it to look at: a --pg-only snapshot would
    // scan ZERO components while the manifest — and, since #307, the MCP result and
    // `schedule status` — all say the mode was in effect. Refuse instead of reporting a
    // gate that inspected nothing; a caller believing a snapshot was scanned when it was
    // not is worse than one who knows it was not. Scanning the pg_dump itself is a
    // feature, not something to fake by staying quiet here. Checked BEFORE
    // assertGitleaksAvailable() below so the answer does not depend on whether gitleaks
    // happens to be installed.
    // `off` is the explicit opt-out (#301) — it asks for NO scan, so none of the refusals
    // above it apply: there is nothing to be wrong about. It still has to be said out loud
    // rather than inferred, which is the whole point of it being a mode.
    if (o.scan_secrets !== 'off') {
      if (o.dirs.length === 0)
        throw new Error(
          `--scan-secrets ${o.scan_secrets} has nothing to scan: it covers --dir/--profile staged plaintext, and this ` +
            `snapshot has no --dir or --profile source (a --pg dump is not scanned). Add the source you meant to gate, ` +
            `or drop --scan-secrets — refusing rather than reporting a scan that would inspect no component.`,
        );
      scanMode = o.scan_secrets;
      await assertGitleaksAvailable();
    }
  } else if (o.dirs.length > 0 && (await gitleaksAvailable())) {
    // #301: the scan is no longer opt-in. cypher-brain's primary backends are un-deletable,
    // and the project's answer to "forget this one snapshot" is that there isn't one — so
    // the one PREVENTIVE measure it has cannot stay switched off by default.
    //
    // Two deliberate narrowings keep this from becoming a new requirement rather than a new
    // default. It only engages when there is a --dir/--profile source to look at (the same
    // condition the explicit path refuses on), and only when a scanner is already
    // resolvable — a machine without gitleaks keeps behaving exactly as it did, with no
    // error and no new dependency. Note this is the ONLY path allowed to skip quietly:
    // nobody asked for a gate here, so nobody is being told one ran. An EXPLICIT request
    // that cannot scan still refuses (#307/#314), and that asymmetry is the point.
    scanMode = 'warn';
    console.error(
      `scanning staged sources for secrets before they are sealed (--scan-secrets defaults to warn now that ` +
        `gitleaks is installed; pass --scan-secrets deny to refuse instead, or --scan-secrets off to skip). ` +
        `Anything pushed to arweave/turbo cannot be deleted afterwards.`,
    );
  }
  // Resolve the EFFECTIVE mode back onto the options object, the same way pull() fills its
  // resolved locator/backend/sha256 back in. Callers that report what happened — the MCP
  // snapshot_now result — otherwise echo their own input, which since #301 is no longer the
  // same thing: an omitted scan_secrets now means "warn ran" as often as it means "nothing
  // ran", and reporting null for both is exactly the ambiguity this default must not create.
  o.scan_secrets = scanMode ?? 'off';
  // #252: an EXPLICITLY-named --sign-identity that doesn't exist is a configuration
  // error (see the signing block far below) — checked HERE, fail-fast, before any
  // staging/ciphertext work, not after the ciphertext + digest/fingerprint sidecars
  // are already durably written. Checking it only at signing time (right before the
  // final "wrote <out>" line) meant the "refusing to write an unsigned snapshot"
  // error was untrue: an unsigned *.age (plus its sidecars) was already sitting at
  // --out by the time that throw fired, orphaned and easy to miss in a cron log.
  if (!o.no_sign && o.sign_identity && !(await exists(o.sign_identity))) {
    throw new Error(`--sign-identity ${o.sign_identity} does not exist — refusing to write an unsigned snapshot`);
  }
  // No-clobber: refuse to overwrite an existing snapshot (this is a backup tool — a
  // silent overwrite could destroy a prior, possibly only, copy of the brain). The old
  // `age -o o.out` write left this to age's version-dependent overwrite policy; the
  // atomic rename below would ALWAYS clobber, so enforce the safe behavior explicitly.
  if (await exists(o.out))
    throw new Error(
      `${o.out} already exists — refusing to overwrite a prior snapshot (move it aside or choose a new --out)`,
    );
  // Fail-fast (#109) on a bad --out PARENT directory (a typo'd path, an unwritable
  // mount) HERE — before pg_dump / --dir tar+extract+digest work below, which can take
  // minutes for a large brain. Without this, the bad path only surfaces once
  // encryptToFile's createWriteStream(part) tries to open the .part sibling deep into
  // the run (part lives next to o.out, so its parent dir is the same one). Mirrors the
  // mkdir(dirname(resolve(out)), { recursive: true }) file.ts:36 / arweave.ts:280
  // already do before their own writes; a no-op if the directory already exists, a real
  // ENOTDIR/EACCES if the path is genuinely bad.
  await mkdir(dirname(resolve(o.out)), { recursive: true });
  // Recipients = who can decrypt. Each --recipient is an `age1...` pubkey OR a
  // file of pubkeys; default to the keypair's own recipient. Passing more than one
  // is key recovery: encrypt to a primary AND an offline backup key so that losing
  // the primary identity does NOT lose the brain (any one identity restores).
  const recs = o.recipients.length ? o.recipients : [RECIPIENT];
  const entriesByRec = new Map<string, string[]>(); // recipient arg -> its effective age1… entries
  for (const r of recs) {
    if (!r.startsWith('age1') && !(await exists(r))) {
      throw new Error(`no recipient at ${r} — run "cypher-brain keygen" first, or pass an age1... pubkey`);
    }
    entriesByRec.set(r, await recipientEntries(r));
  }

  // Fail-fast on a flattened recipient list of ZERO entries (e.g. every recipients
  // file held only blank/comment lines): typage would happily encrypt to an EMPTY
  // stanza list — valid-looking ciphertext that NO identity can ever decrypt. The
  // old external `age -R` errored here; so must we, and at THIS point — before any
  // plaintext is staged or a .part is opened — so a refused run leaves nothing behind.
  const recipientList = [...entriesByRec.values()].flat();
  if (recipientList.length === 0) {
    throw new Error(
      `recipient file(s) ${recs.join(', ')} resolved to ZERO recipients (only blank/comment lines?) — refusing to snapshot: encrypting to an empty recipient list would create a snapshot NO identity can ever decrypt`,
    );
  }

  // Recipient pin (opt-in): fail-fast if any effective recipient is not allowlisted,
  // so a tampered recipient.txt or an injected extra --recipient cannot silently
  // re-key this (and every future) snapshot to an attacker.
  //
  // PIN_RECIPIENTS is `string | undefined`, not just a falsy check: `undefined` means
  // the var is genuinely unset (no pin configured, check skipped). An explicitly empty
  // string (CYPHER_BRAIN_PIN_RECIPIENTS="") is a misconfiguration — most likely a
  // broken template in an unattended cron/systemd unit — and must fail CLOSED, not be
  // silently treated as "no pin" (which would defeat the whole point of the pin).
  if (PIN_RECIPIENTS !== undefined) {
    if (PIN_RECIPIENTS === '') {
      throw new Error(
        'CYPHER_BRAIN_PIN_RECIPIENTS is set but empty — refusing to snapshot (an explicitly empty pin looks like a misconfiguration; unset the variable entirely to run without an allowlist)',
      );
    }
    const allowed = await resolvePinnedRecipients(PIN_RECIPIENTS);
    if (allowed.size === 0)
      throw new Error('CYPHER_BRAIN_PIN_RECIPIENTS is set but lists no age1… pubkeys — refusing to snapshot');
    for (const r of recs) {
      const entries = entriesByRec.get(r) ?? [];
      if (entries.length === 0)
        throw new Error(
          `recipient "${r}" has no recipients to check against CYPHER_BRAIN_PIN_RECIPIENTS (refusing to snapshot)`,
        );
      for (const e of entries) {
        // Fail-closed: every entry must be an allowlisted age1… key. A non-age1
        // recipient (e.g. an injected `ssh-ed25519 …` line) can't be on the
        // age1-only allowlist, so it is rejected — which is the point.
        if (!allowed.has(e))
          throw new Error(
            `recipient "${e}" (via "${r}") is NOT in CYPHER_BRAIN_PIN_RECIPIENTS — refusing to snapshot (an unexpected recipient could decrypt your brain)`,
          );
      }
    }
    console.error(`recipient pin OK: all recipient(s) are allowlisted`);
  }

  // The #1 footgun (documented in MANAGEMENT.md): a snapshot recoverable by exactly one
  // key — lose that identity and the brain is gone. The cadence examples use two keys, but
  // a copy-the-README run can forget the backup. Count DISTINCT effective recipient keys
  // (not --recipient args): a file may hold several keys, and two args may name the same
  // one — so dedupe across all entries. Warn loudly (stderr → unattended logs) on exactly one.
  const effectiveKeys = new Set<string>();
  for (const entries of entriesByRec.values()) for (const e of entries) effectiveKeys.add(e);
  if (effectiveKeys.size === 1) {
    warn(
      'snapshot encrypted to a SINGLE recipient key — if you lose that identity the brain is UNRECOVERABLE. Add a second --recipient (an offline backup public key) for key recovery; see MANAGEMENT.md.',
    );
  }

  // Recipients fingerprint: sha256 over the SORTED, de-duplicated set of effective
  // age1… recipient keys used to encrypt THIS run — sorted + newline-joined so it is
  // independent of --recipient arg order and of which arg/file each key came from
  // (only the resulting SET matters, same dedupe as effectiveKeys above). This is a
  // SEPARATE signal from content_digest (which stays pure-plaintext, unaffected by
  // recipients) that `push --skip-unchanged` additionally folds in (src/lib/
  // pushpull.ts): without it, re-snapshotting unchanged plaintext under a CHANGED
  // recipient set (a newly added offline recovery key, or a removed/revoked key)
  // would still skip and return the OLD locator — the new key could never decrypt
  // it, and/or a revoked key still could, even though the operator believes the
  // "current" backup no longer trusts it (#70 review round 2, real regression).
  const recipientsFingerprint = hexOf(`${[...effectiveKeys].sort().join('\n')}\n`);

  // Build the encrypter up front: an invalid recipient line (typage takes native age
  // recipients only) must fail HERE, before any plaintext is staged or a .part opened.
  const encrypter = newEncrypter(recipientList);

  installStageSignalGuard();
  // mkdtempSync (not async mkdtemp) so dir-creation and the ACTIVE_STAGE assignment
  // happen in one tick with no event-loop yield between them — otherwise a signal that
  // lands during the await could fire the handler while ACTIVE_STAGE is still null and
  // leave the just-created stage dir behind.
  const stage = mkdtempSync(join(tmpdir(), 'cypher-brain-'));
  setActiveStage(stage); // a signal now erases this staged plaintext (see installStageSignalGuard)
  const createdAt = new Date().toISOString(); // when this snapshot run began (top-level)
  try {
    const components: ManifestComponent[] = [];
    if (o.pg) {
      const dumpPath = join(stage, 'db.dump');
      const tableArgs = o.tables.flatMap((t) => ['-t', t]);
      // --pg-filter / --pg-exclude-table-data (issue #235): a LITERAL pass-through to
      // pg_dump's own standard flags — no cypher-brain-side SQL parsing/filtering. This is
      // what lets a "minimal recovery profile" run (raw conversation logs / embedding
      // caches / tool-run logs excluded) sit alongside a normal full snapshot, using
      // nothing but pg_dump's documented filtering surface:
      // https://www.postgresql.org/docs/current/app-pgdump.html#PG-DUMP-FILTERING
      // Both are additive to -t/tableArgs and to each other; omitted (the default), pg_dump
      // runs exactly as before — a full dump, no filtering.
      const filterArgs = o.pg_filter ? ['--filter', o.pg_filter] : [];
      const excludeTableDataArgs = (o.pg_exclude_table_data ?? []).flatMap((t) => ['--exclude-table-data', t]);
      await run(pgTool('pg_dump'), [
        '-Fc',
        '--no-owner',
        '--no-privileges',
        ...tableArgs,
        ...filterArgs,
        ...excludeTableDataArgs,
        '-f',
        dumpPath,
        o.pg,
      ]);
      // captured_at right AFTER pg_dump (pg_dump -Fc is internally point-in-time consistent
      // via one REPEATABLE READ txn; only the DB↔file boundary needs aligning — #44).
      // content_digest = sha256 of the dump bytes. Honest note: pg_dump output may not
      // be byte-stable across runs even for identical data (internal ordering, embedded
      // metadata), so DB sources will rarely trigger --skip-unchanged — that is
      // conservative (an unnecessary push, never a wrongly skipped one) and fine.
      components.push({
        name: 'db.dump',
        kind: 'pg_dump:custom',
        tables: o.tables.length ? o.tables : 'all',
        ...(o.pg_filter ? { filter: o.pg_filter } : {}),
        ...(o.pg_exclude_table_data?.length ? { exclude_table_data: o.pg_exclude_table_data } : {}),
        content_digest: await sha256(dumpPath),
        captured_at: new Date().toISOString(),
      });
    }
    const usedNames = new Set<string>();
    for (const d of o.dirs) {
      const abs = resolve(d);
      let name = `${basename(abs)}.tar.gz`;
      // multiple --dir with the same basename must not overwrite each other in the stage
      for (let n = 1; usedNames.has(name); n++) name = `${basename(abs)}-${n}.tar.gz`;
      usedNames.add(name);
      // a path can be a directory, a single file (profiles pass e.g. CLAUDE.md,
      // a ChatGPT export zip), or a top-level symlink — tar archives all three;
      // record which in the manifest. lstat() (not stat()) so this matches what
      // the tar -czf call below actually archives: a top-level symlink argument
      // is NOT dereferenced by GNU tar/bsdtar (same fact contentDigestOfPath's
      // lstat-based check above already relies on), so a directory-symlink here
      // must be recorded as 'symlink', never 'dir' — 'dir' would claim the
      // archive holds the target's tree when it actually holds just the link.
      // lstat() also does not throw on a DANGLING symlink (stat() would ENOENT
      // before tar ever ran), so a broken symlink source is now archived (as a
      // symlink entry) instead of failing snapshot() outright.
      const topStat = await lstat(abs);
      const kind = topStat.isSymbolicLink() ? 'symlink' : topStat.isDirectory() ? 'dir' : 'file';
      const archivePath = join(stage, name);
      // #216: a directory --dir source may carry its OWN ".cypherbrainignore" at its
      // root — a single-file/symlink source (kind !== 'dir') has no tree to filter, so
      // this is null there and the plain tar call below is unchanged. null also when a
      // directory source simply has no such file: the ONLY behavior-preserving path,
      // so every pre-#216 --dir (no ignore file yet) archives byte-for-byte as before.
      const ig = kind === 'dir' ? ((await loadIgnoreFile(abs))?.ig ?? null) : null;
      let excludedCount: number | undefined;
      // #367: the COMPLETE relative-path listing of this source, when a walk of it
      // already happened for filtering — BOTH halves, what tar will archive and what the
      // ignore file filtered out. Handed to findPgDataDirs below so the data-directory
      // check costs no second traversal of a tree we just finished walking.
      //
      // Both halves, not just tarEntries (multi-model review, measured): an ignore rule
      // matching `pg_wal/` deletes one of the two markers detection looks for, so passing
      // only the archived paths went SILENT on exactly the run that produces a store
      // which cannot be opened at all. The excluded half is also what tells the detector
      // a store is being archived in pieces, which earns a stronger warning than the
      // ordinary live-copy one.
      let scanned: { included: string[]; excluded: string[] } | undefined;
      if (ig) {
        // withSizes: false — building the real archive only needs WHICH paths to
        // include (tarEntries), never their byte sizes (that's --dry-run's job, via
        // dryRun() below) — skipping stat()/dirByteSize() here keeps filtering a
        // --dir with a large ignored node_modules/ fast rather than paying to size
        // the very subtree it just pruned.
        const { tarEntries, excluded } = await scanDir(abs, ig, { withSizes: false });
        excludedCount = excluded.length;
        scanned = { included: tarEntries, excluded: excluded.map((e) => e.rel) };
        // tar --no-recursion -T <listFile>: named directory entries are archived as
        // bare directory nodes (no auto-descend), so listing EVERY included dir/file/
        // symlink explicitly — parent before child, exactly what scanDir returns — is
        // what keeps a pruned excluded subtree (never named here) out of the archive
        // that a plain recursive `tar -czf ... basename(abs)` would otherwise re-add
        // the instant it saw the parent directory named.
        //
        // NUL-separated (--null), never newline-separated (Codex multi-model review,
        // Critical): both GNU tar and bsdtar give a -T list's lines SPECIAL,
        // non-literal handling unless --null is passed. Only the FIRST list line (the
        // bare `base` below) can ever start with "-" — every other line is prefixed
        // "<base>/<rel>" and so can never itself look like an option — but `base` is
        // exactly the --dir argument's OWN basename, which an operator backing up an
        // externally-named tree (an extracted archive, a cloned repo, an untrusted
        // download) does not fully control. Verified by hand: with a --dir literally
        // named "-C", the newline-only (pre-fix) list made tar consume the NEXT list
        // line as a "-C <dir>" directive's argument and every line after that as a
        // path relative to THAT directory instead of the intended root — silently
        // wrong (or, with a directory an attacker fully controls the naming of,
        // steerable) archive contents. --null makes every list entry a plain byte
        // string (NUL cannot appear in a filename), eliminating the
        // option-reinterpretation entirely — the fix, not just a mitigation. The
        // plain (no ignore file) branch below has always guarded this same class of
        // issue for its OWN positional `basename(abs)` argument via `--`; this is the
        // equivalent guard for the -T list's first line, which `--` does not reach.
        const listFile = join(stage, `.tarlist-${name}`);
        const base = basename(abs);
        await writeFile(listFile, `${[base, ...tarEntries.map((r) => `${base}/${r}`)].join('\0')}\0`);
        try {
          await run('tar', ['-czf', archivePath, '-C', dirname(abs), '--no-recursion', '--null', '-T', listFile], {
            timeoutMs: PIPE_TIMEOUT_MS,
          });
        } finally {
          await rm(listFile, { force: true }); // list file is scratch, never part of the snapshot
        }
      } else {
        await run('tar', ['-czf', archivePath, '-C', dirname(abs), '--', basename(abs)], {
          timeoutMs: PIPE_TIMEOUT_MS,
        }); // a FIFO/special file under --dir can't hang the pre-stage tar; the -- guards a basename that could otherwise be parsed as an option (e.g. a leading '-')
      }
      // #367: a --dir/--profile source that IS, or has directly inside it, a PostgreSQL
      // data directory (gbrain's default PGLite engine keeps its whole database as one)
      // was just tar'd as a plain directory tree — with none of the point-in-time
      // consistency the --pg path gets from pg_dump -Fc. Say so. A WARNING and never a
      // refusal: the whole point of `schedule install` is an unattended nightly run, and
      // blocking that would trade a possibly-inconsistent backup for a certainly-absent
      // one. Sited here, right after the archive step, because `scanned` (the ignore-file
      // walk's own complete listing, when one ran) makes the detection a pure in-memory
      // pass over paths this loop already walked — a source with no ignore file falls back
      // to the bounded readdir in findPgDataDirs, which is the only case that touches disk
      // again, and the only case whose reach stops one level below the source root.
      //
      // One warning per store, and a store the ignore file has cut into pieces gets the
      // stronger of the two: that copy cannot be opened at all, which is a different (and
      // worse) problem than the copy that merely might be inconsistent, so it must not be
      // reported in the same sentence.
      if (kind === 'dir') {
        for (const store of await findPgDataDirs(abs, scanned)) {
          warn(store.excludedInside > 0 ? pgDataDirTruncatedWarning(abs, store) : pgDataDirCopyWarning(abs, store.rel));
        }
      }
      // content_digest AFTER the tar, computed from the ARCHIVE'S OWN bytes (extract to a
      // throwaway dir and hash THAT with the unchanged contentDigestOfPath) rather than a
      // second, independent read of the live source. Two independent reads (a digest walk,
      // then tar's own read) leave a race: a source mutated in the narrow window between
      // them would archive NEW bytes while the digest still describes the OLD ones — a
      // stale-looking "unchanged" digest sitting next to genuinely different archived
      // content (#70 review). Hashing what tar itself just wrote closes that gap: the
      // digest can never describe content other than what got archived. Still independent
      // of mtimes/order and of the tar byte stream itself — contentDigestOfPath only reads
      // content bytes / symlink targets from the extraction, never tar's own headers.
      // -p (--preserve-permissions, supported by both GNU tar and macOS bsdtar — this
      // repo's CI matrix runs both) makes the re-read apply the ARCHIVE's stored mode
      // bits exactly, instead of masking them through this process's umask. A plain
      // `tar -xzf` (no -p) applies umask on extraction, so under a restrictive umask a
      // mode-only source change (e.g. 0644 -> 0600) can extract to the SAME mode both
      // times even though the tar header bytes differ — silently hiding the change
      // from the digest this verification re-read is supposed to prove (#70 review
      // round 3).
      const extractDir = join(stage, `.extract-${name}`);
      await mkdir(extractDir);
      let contentDigest: string;
      let secretsScan: SecretFinding[] | undefined;
      let secretsScanError: string | undefined;
      try {
        await run('tar', ['-xzf', archivePath, '-C', extractDir, '-p'], { timeoutMs: PIPE_TIMEOUT_MS });
        contentDigest = await contentDigestOfPath(join(extractDir, basename(abs)));
        // Scan the SAME extracted root the digest above just read (join(extractDir,
        // basename(abs)), NOT extractDir itself — gitleaks looks for "(target
        // path)/.gitleaks.toml", so passing the actual source root is what lets a
        // .gitleaks.toml dropped at the top of the scanned source be discovered, matching
        // the doc'd "drop a .gitleaks.toml into a scanned source" story; scanning the
        // parent extractDir one level up would look for it in the wrong place, multi-model
        // review finding) — the exact plaintext about to be folded into the final tar|age
        // stream, before extractDir is erased in the finally below. deny throws here,
        // unwinding out through this function's own try/finally (stage cleanup still
        // runs); warn just logs and falls through.
        if (scanMode) {
          try {
            secretsScan = await scanForSecrets(join(extractDir, basename(abs)));
          } catch (e) {
            // A DEFAULT must never fail a snapshot that would otherwise have succeeded
            // (#301). Found by the existing #267 test: a dangling top-level symlink is a
            // source snapshot deliberately archives as a symlink entry, and `gitleaks dir`
            // stats it and exits 1 — so switching the default on turned a working snapshot
            // into a hard error, on a source the tool supports on purpose. When the caller
            // ASKED for the gate the old fail-closed behaviour is exactly right and stays;
            // when the gate is merely the default, an unusable scanner degrades to a
            // warning and the snapshot proceeds unscanned, which is what it did before
            // this default existed. It is loud about being unscanned — the failure mode to
            // avoid is not "no scan", it is "no scan, reported as a scan".
            if (scanExplicit) throw e;
            warn(
              `the default secret scan could not run on "${name}" (${errMsg(e)}) — snapshotting it UNSCANNED. ` +
                `Pass --scan-secrets deny to make this a refusal instead, or --scan-secrets off to stop trying.`,
            );
            secretsScan = undefined;
            secretsScanError = errMsg(e);
          }
          if (secretsScan) reportSecretFindings(name, secretsScan, scanMode);
        }
      } finally {
        // must not leak into the snapshot: the final encryptToFile below tars stage/. whole
        await rm(extractDir, { recursive: true, force: true });
      }
      components.push({
        name,
        kind,
        source: abs,
        content_digest: contentDigest,
        captured_at: new Date().toISOString(),
        ...(ig ? { cypherbrainignore: true, excluded_count: excludedCount } : {}),
        // An empty array means "scanned, found nothing". A scan that could not RUN must
        // never produce it — the durable artifact would then claim a clean component that
        // was never inspected, which is the same lie the console was careful to avoid
        //. The error takes its place instead.
        ...(scanMode && !secretsScanError ? { secrets_scan: secretsScan ?? [] } : {}),
        ...(secretsScanError ? { secrets_scan_error: secretsScanError } : {}),
      }); // skew vs the DB is now detectable on restore
    }
    // Combined content digest = sha256 over each component's (declared identity, kind,
    // content_digest) joined in component order. Identity, not just bytes: hashing bare
    // content digests would leave `--dir old-path` and `--dir new-path` (or a renamed
    // --vault-like source) indistinguishable whenever the underlying bytes happen to be
    // byte-identical, so --skip-unchanged could return the OLD locator — whose restored
    // manifest/archive still labels things under the old name/path — for what was actually
    // asked to be a differently-named/sourced snapshot (#70 review). Identity is
    // deliberately the DECLARED source path (or name, for pg_dump which has no source
    // path) — never anything volatile like mtime. Same content, same identity, same
    // component order → same digest, regardless of mtimes or the (ephemeral-file-key)
    // ciphertext bytes.
    const contentDigest = hexOf(
      `${components.map((c) => `${c.source ?? c.name}\t${c.kind}\t${c.content_digest}`).join('\n')}\n`,
    );
    // manifest carries NO secrets — just what's inside (+ capture timestamps so a
    // DB↔files skew is detectable after the fact, + which --profile produced it,
    // if any), so restore is self-describing. recipients_fingerprint sits alongside
    // content_digest as a SEPARATE field — content_digest stays pure-plaintext
    // (unaffected by who can decrypt); recipients_fingerprint is the additional
    // signal push --skip-unchanged folds in (see its definition above).
    const manifestPath = join(stage, 'manifest.json');
    const manifestJson = JSON.stringify(
      {
        tool: 'cypher-brain',
        schema: MANIFEST_SCHEMA_VERSION,
        host: hostname(),
        created_at: createdAt,
        content_digest: contentDigest,
        recipients_fingerprint: recipientsFingerprint,
        ...(o.profile ? { profile: o.profile } : {}),
        ...(scanMode ? { scan_secrets_mode: scanMode } : {}),
        components,
      },
      null,
      2,
    );
    await writeFile(manifestPath, `${manifestJson}\n`);
    // tar the staged components into one stream, encrypt to all recipients (in-process
    // typage, streaming — bounded RSS at any snapshot size). Write to a PER-RUN-UNIQUE
    // .part so overlapping snapshots to the same --out never share/clobber each other's
    // in-progress file, and rename only on success, so a mid-pipeline failure (tar
    // error, ENOSPC, a killed run) never leaves a TRUNCATED *.age at o.out — which
    // would still start with the age magic and thus pass push()'s header-only gate,
    // letting an operator publish unrecoverable ciphertext to permanent paid storage.
    const part = `${o.out}.${process.pid}.${randomBytes(4).toString('hex')}.part`;
    setActiveOutPart(part); // a signal now also erases this partial ciphertext
    try {
      await encryptToFile(encrypter, 'tar', ['-cf', '-', '-C', stage, '.'], part, { timeoutMs: PIPE_TIMEOUT_MS });
      await promoteSnapshot(part, o.out);
      setActiveOutPart(null);
    } catch (e) {
      await rm(part, { force: true });
      setActiveOutPart(null);
      throw e;
    }
    // Plaintext digest sidecar next to the output — what lets `push --skip-unchanged`
    // detect "content unchanged" WITHOUT decrypting anything (the manifest copy sits
    // inside the ciphertext). A content digest leaks no content. Best-effort: the
    // snapshot itself is already durable at o.out, so a sidecar write failure only
    // costs the skip optimization, never the backup. Kept as its OWN single-line file
    // (never a second line appended here) — existing readers (push's contentDigestFor,
    // the selftest's `cat *.digest` comparisons) assume this file IS the content digest
    // verbatim; the recipients fingerprint is a genuinely separate signal and gets its
    // own sidecar right below, never folded into this one.
    try {
      await writeFile(`${o.out}.digest`, `${contentDigest}\n`);
    } catch (e) {
      console.error(
        `warning: could not write digest sidecar ${o.out}.digest (${errMsg(e)}) — push --skip-unchanged will not have a digest for this snapshot`,
      );
    }
    // Recipients fingerprint sidecar — the SEPARATE signal (#70 review round 2) that
    // push --skip-unchanged additionally requires to match before it will skip (see
    // src/lib/pushpull.ts). A leaked age1… pubkey is not a secret (it's the whole
    // point of a "recipient" — safe to copy), so this sidecar carries no secrets
    // either. Best-effort, same as the content digest sidecar above.
    try {
      await writeFile(`${o.out}.recipients-fingerprint`, `${recipientsFingerprint}\n`);
    } catch (e) {
      console.error(
        `warning: could not write recipients-fingerprint sidecar ${o.out}.recipients-fingerprint (${errMsg(e)}) — push --skip-unchanged will not have a recipients fingerprint for this snapshot`,
      );
    }
    // Authenticity sidecar (#214): age gives confidentiality + tamper detection, but
    // NOT authenticity — anyone holding a recipient's PUBLIC key (by design, not a
    // secret) can forge ciphertext that decrypts cleanly, claiming to be a real
    // snapshot. Signing the ciphertext bytes we just wrote closes that gap; restore/
    // verify check this BEFORE decrypting (src/lib/restore.ts). Automatic whenever a
    // signing identity is present (default $CYPHER_BRAIN_HOME/sign-identity.key, or
    // --sign-identity) — no separate opt-in flag, mirroring how snapshot already just
    // encrypts whenever a recipient is present — so running `keygen --sign` once is
    // the entire "turn signing on" step. --no-sign opts out even when a key is
    // present (e.g. a deliberately-unsigned test artifact). Fully backward compatible:
    // no key present -> no *.minisig -> restore/verify treat it exactly like every
    // pre-#214 snapshot (a WARN, never a FAIL).
    if (!o.no_sign) {
      const signIdentityPath = o.sign_identity || SIGN_IDENTITY;
      if (await exists(signIdentityPath)) {
        const { privateKey, keyId } = await loadSignIdentity(signIdentityPath);
        const minisig = await signDetached(privateKey, keyId, o.out);
        await writeFile(`${o.out}.minisig`, minisig);
        console.log(`signed: ${o.out}.minisig (minisign-compatible detached signature, key: ${signIdentityPath})`);
      } else if (o.sign_identity) {
        // The #252 fail-fast check above already refuses an explicitly-named
        // --sign-identity that's missing BEFORE any ciphertext is written, so this
        // only fires if the path existed at that check and was removed during the
        // (possibly minutes-long, for a large brain) staging/encrypt work above — a
        // narrow TOCTOU window, not the common case. o.out (+ its sidecars) is
        // already durably written at this point, so — unlike the early check —
        // this can't truthfully say "refusing to write."
        throw new Error(
          `--sign-identity ${signIdentityPath} no longer exists — ${o.out} was already written UNSIGNED (the identity existed when this run started but vanished before signing; there is no standalone "sign an existing snapshot" command, so treat ${o.out} as unsigned and re-run snapshot once the identity is back)`,
        );
      }
    }
    const sz = (await stat(o.out)).size;
    console.log(`wrote ${o.out} (${fmtBytes(sz)}, encrypted to ${recs.length} recipient(s): ${recs.join(', ')})`);
    console.log(`components: ${components.map((c) => c.name).join(', ')}`);
    console.log(`content digest: ${contentDigest} (sidecar: ${o.out}.digest)`);
    console.log(`recipients fingerprint: ${recipientsFingerprint} (sidecar: ${o.out}.recipients-fingerprint)`);
  } finally {
    await rm(stage, { recursive: true, force: true });
    setActiveStage(null);
  }
}

// #368: the per-source total --dry-run already prints is a useful gate, but tells you
// nothing about WHAT is in it — the exact gap that let a dead 906 MB brain.pglite ride
// along on paid, permanent storage for two and a half months before it was found by hand
// with `du`. This is a REDUCTION over scanDir()'s already-collected `included` sizes,
// never a second traversal or stat() call: bucket each included entry by its top-level
// path segment (one directory level deep, not full depth) so a huge nested tree — the
// pglite case was thousands of files several directories deep — reads as ONE line instead
// of drowning the report in per-file output. A root-level file (no '/' in `rel`) is its
// own bucket, unchanged; a root-level directory's bucket key carries a trailing '/' and
// sums every file anywhere beneath it, however deep.
interface Contributor {
  label: string;
  bytes: number;
}

const CONTRIBUTORS_LIMIT = 10;

// ALL buckets, sorted, unsliced — printContributors below owns the top-N cut so it can
// see (and report) what got left off, rather than this function silently discarding it.
function allContributors(entries: ScanEntry[]): Contributor[] {
  const buckets = new Map<string, number>();
  for (const e of entries) {
    const slash = e.rel.indexOf('/');
    const label = slash === -1 ? e.rel : `${e.rel.slice(0, slash)}/`;
    buckets.set(label, (buckets.get(label) ?? 0) + e.size);
  }
  // Ties broken by label so the printed order is deterministic run to run (Map iteration
  // order is insertion order, which is scanDir's already-sorted readdir order — stable,
  // but not obviously so to a reader of this file alone; the explicit tiebreak makes the
  // ordering guarantee visible here rather than borrowed silently from scanDir above).
  return [...buckets.entries()]
    .map(([label, bytes]) => ({ label, bytes }))
    .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
}

// Prints nothing when there is nothing worth breaking down: zero included bytes (an
// empty --dir, or every included entry is a zero-byte file/symlink) would otherwise print
// a heading followed by a division-by-zero-shaped 0.0% list, which is noise, not signal.
//
// Multi-model review (PR #370, Codex + Claude, independently): a bare `.slice(0, LIMIT)`
// with no accounting for what it cut is the wrong failure mode for a report whose whole
// point is "what am I paying to store" — with more than CONTRIBUTORS_LIMIT buckets, many
// similar-sized ones that collectively dominate would each look individually negligible
// and the true dominant mass would be invisible, while the shown BYTES silently stopped
// accounting for the whole source. Below CONTRIBUTORS_LIMIT buckets, EVERY bucket is
// shown, so "top N" would overclaim a truncation that never happened — the heading says
// exactly what is being shown either way, and a trailing "other (N more)" line carries
// the dropped buckets' combined bytes/share when (and only when) something was cut, so
// the printed lines reconcile to totalBytes in EVERY case (see the loop below — this is
// a BYTES guarantee, not a percentages one: each `share` is independently `toFixed(1)`,
// so the printed percentages can be off by up to a few tenths from summing to exactly
// 100.0 — a rounding artifact of display, never a sign that bytes went unaccounted for).
function printContributors(entries: ScanEntry[], totalBytes: number): void {
  if (totalBytes <= 0) return;
  const all = allContributors(entries);
  if (all.length === 0) return;
  const shown = all.slice(0, CONTRIBUTORS_LIMIT);
  const dropped = all.slice(CONTRIBUTORS_LIMIT);
  const heading =
    dropped.length > 0
      ? `  largest contributors (top ${CONTRIBUTORS_LIMIT} of ${all.length} by bytes, aggregated one directory level deep):`
      : `  largest contributors (${shown.length} by bytes, aggregated one directory level deep):`;
  console.log(heading);
  for (const c of shown) {
    const share = ((c.bytes / totalBytes) * 100).toFixed(1);
    console.log(`    ${c.label}  ${fmtBytes(c.bytes)} (${share}% of this source)`);
  }
  if (dropped.length > 0) {
    const droppedBytes = dropped.reduce((s, c) => s + c.bytes, 0);
    const share = ((droppedBytes / totalBytes) * 100).toFixed(1);
    console.log(`    other (${dropped.length} more)  ${fmtBytes(droppedBytes)} (${share}% of this source)`);
  }
}

// #216: `snapshot --dry-run` — preview --dir/--profile .cypherbrainignore filtering
// WITHOUT staging, encrypting or writing anything (no --out, no temp stage dir, no
// recipient resolution: none of that machinery is exercised here, on purpose — this is
// a read-only report). Uses the SAME scanDir() the real snapshot() call above feeds
// tar with, so the preview can never diverge from what an actual run would archive.
async function dryRun(o: CliOptions): Promise<void> {
  console.log('DRY RUN — previewing .cypherbrainignore filtering; nothing will be staged, encrypted, or written.');
  if (o.pg) {
    // pg_dump is never executed for a preview (it would mutate nothing, but it can
    // take real time against a live DB, and its size is unknowable before it runs) —
    // just note the source is present; the byte totals below cover --dir/--profile only.
    console.log(`\npg: ${redactPgConn(o.pg)} (not dumped in --dry-run; size is unknown until snapshot runs)`);
  }
  let totalIncluded = 0;
  let totalExcluded = 0;
  for (const d of o.dirs) {
    const abs = resolve(d);
    const top = await lstat(abs);
    console.log(`\n-- ${abs} --`);
    if (top.isSymbolicLink()) {
      console.log('  symlink source — archived as-is (not filterable by .cypherbrainignore)');
      continue;
    }
    if (!top.isDirectory()) {
      const sz = (await stat(abs)).size;
      console.log(`  file source, ${fmtBytes(sz)} (single file — not filterable by .cypherbrainignore)`);
      totalIncluded += sz;
      continue;
    }
    const loaded = await loadIgnoreFile(abs);
    const ig = loaded?.ig ?? null;
    const { included, excluded } = await scanDir(abs, ig);
    const incBytes = included.reduce((s, e) => s + e.size, 0);
    const excBytes = excluded.reduce((s, e) => s + e.size, 0);
    totalIncluded += incBytes;
    totalExcluded += excBytes;
    if (!ig) {
      console.log(`  no ${IGNORE_FILE_NAME} — all ${included.length} file(s) included (${fmtBytes(incBytes)})`);
      // #368: this is the branch the issue exists for — no ignore file means nobody has
      // audited this source yet, and it is the state that got the LEAST information
      // before this. Same breakdown as the filtered branch below, over the same
      // `included` entries scanDir() already sized.
      printContributors(included, incBytes);
      continue;
    }
    // loaded is set whenever ig is (same object) — name it so the report says which file
    // (current or legacy spelling) actually filtered this source.
    console.log(
      `  ${loaded?.name ?? IGNORE_FILE_NAME} found — ${included.length} file(s) included (${fmtBytes(incBytes)}), ${excluded.length} path(s) excluded (${fmtBytes(excBytes)})`,
    );
    // #368: breakdown of what SURVIVED filtering — a dominant contributor still hiding
    // behind an already-present .cypherbrainignore is exactly as worth surfacing as one
    // hiding behind no ignore file at all.
    printContributors(included, incBytes);
    console.log('  include:');
    for (const e of included) console.log(`    ${e.rel}`);
    console.log('  exclude:');
    for (const e of excluded) console.log(`    ${e.rel}${e.kind === 'dir' ? '/' : ''} (${fmtBytes(e.size)})`);
  }
  console.log(
    `\ntotal: ${fmtBytes(totalIncluded)} would be included; ${fmtBytes(totalExcluded)} excluded by ${IGNORE_FILE_NAME} rules (approximate — actual archive size differs due to compression/tar overhead)`,
  );
}
