// wizard — `cypher-brain init`: an interactive, end-to-end setup wizard for a FRESH
// machine (issue #68). It walks keygen -> backup-key guidance -> passphrase wrap ->
// recipient pin -> profile selection -> first snapshot+push -> a printable recovery
// kit, in one sitting.
//
// This is an ORCHESTRATION layer over the EXISTING primitives (keygen/snapshot/push)
// — it adds no new crypto, storage or consent logic of its own. Every safety check
// those primitives already enforce (identity no-clobber, the paid-backend --yes gate,
// the recipient-pin allowlist, snapshot's single-recipient warning, etc.) still fires
// exactly as it does when those commands are run directly, because the wizard calls
// the SAME functions with the SAME options — it never bypasses or duplicates them.
//
// Interactivity: non-secret yes/no and path/text prompts use @clack/prompts (issue
// #230) via the askLine/askYesNo wrappers below — cancel (Ctrl+C) detection and
// terminal-width wrapping come from the library instead of being hand-rolled.
//
// Coloring (verified empirically — #464 corrected this comment after the ORIGINAL
// version asserted a premise that does not hold under this wizard's own documented
// automation path): every clack render call goes through Node's own util.styleText
// for COLOR specifically, which already checks NO_COLOR/FORCE_COLOR/isTTY on the
// OUTPUT stream before emitting a color escape code — nothing extra to wire up here
// for that part. But clack's own rendering underneath styleText (cursor move/hide/
// show/erase, via sisteransi — a separate mechanism, gated on none of those three)
// writes those non-color escapes UNCONDITIONALLY, on every render, TTY or not. A
// transcript captured via this wizard's CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1
// escape hatch (requireTTY below) — piped stdin AND stdout, exactly how this repo's
// own scripts/drive-init.mjs drives it for scripts/selftest-init.sh — is NOT "a real
// terminal on the other end": it is thousands of bytes of cursor-movement noise
// (~1876 in a typical full wizard run, independently of NO_COLOR) around whatever
// text content the automation actually wants, e.g. `tee`'d to a file for an audit
// log. NO_COLOR genuinely does keep that transcript free of COLOR codes (confirmed:
// zero SGR color sequences with plain piped stdio, NO_COLOR set or not — isTTY=false
// alone is already enough for styleText to suppress them), but it cannot rescue a
// clean transcript if the caller's own environment happens to set FORCE_COLOR for
// unrelated tooling (confirmed: FORCE_COLOR=1 + NO_COLOR=1 together still produced
// hundreds of color codes — FORCE_COLOR wins). Neither case can be fixed from here:
// @clack/prompts has no documented option (in its README, its exported
// updateSettings()/CommonOptions, or its Prompt base class) to suppress its own
// cursor/erase escapes independent of TTY detection — only an `output: Writable`
// redirect point, which would require THIS project to write and maintain its own
// ANSI-stripping stream, a workaround the library itself does not provide. A caller
// that wants a genuinely plain transcript must pipe this wizard's combined
// stdout+stderr through a stripping tool (e.g. Node's own
// `util.stripVTControlCharacters`, which clack itself imports for exactly this
// purpose internally) rather than relying on NO_COLOR alone. Before @clack/prompts,
// each prompt ran on its own node:readline/promises
// Interface that had to be closed before crypt.ts's OWN raw-mode passphrase reader
// (promptHidden) touched the same stdin, then reopened afterwards — see the passphrase
// step below for why that dance is no longer needed. Anything secret (the passphrase)
// still reuses crypt.ts's EXISTING promptHidden-backed askNewPassphrase + wrapIdentity
// — never reimplemented here, and out of scope for #230 (promptHidden is shared with
// `keygen --passphrase`/`restore`, well beyond just this wizard). `init` is
// fundamentally an interactive command: it refuses immediately (requireTTY) if stdin
// is not a TTY — the same non-interactive-safety posture promptHidden already has —
// rather than hanging or behaving unpredictably under a CI/pipe invocation.
import { text, confirm, select, isCancel } from '@clack/prompts';
import { readFile, writeFile, rm, stat, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import {
  HOME,
  CONFIG_FILE_PATH,
  IDENTITY,
  RECIPIENT,
  SIGN_IDENTITY,
  SIGN_RECIPIENT,
  TON_PROVIDER_OWNER,
  TON_PROVIDER_MAX_SPEND,
  TON_PROVIDER_NOTIFY_BIN,
  readEnv,
} from './config.js';
import { keygen, keygenAt } from './keys.js';
import { askNewPassphrase, wrapIdentity } from './crypt.js';
import { keygenSignAt } from './minisign.js';
import { detectGbrainEngine, pathCoveredBy } from './gbrain.js';
import { PROFILE_NAMES } from './profiles.js';
import { snapshot } from './snapshot.js';
import { push, PushPartialSuccessError } from './pushpull.js';
import { estimateCost, formatEstimate } from './estimate.js';
import { BACKEND_NAMES } from './backends/index.js';
import { walletConfigured, tonWalletConfigured } from './wallet.js';
import { exists, errMsg } from './util.js';
import { buildRecoveryKit, writeRecoveryKitFile } from './recoverykit.js';
import type { BackupKey, SigningKey } from './recoverykit.js';
import type { CliOptions } from './types.js';

// Thrown when a clack prompt reports a cancel (Ctrl+C, or Esc on the ones that support
// it) — turning that into a normal thrown Error routes it through init()'s own
// try/catch below exactly like any other mid-wizard failure (an invalid profile name,
// a declined paid-backend consent, ...), so whatever THIS run already created gets
// rolled back (or, past the push, preserved) the same way. This is a behavioural
// improvement over the old readline-based wizard: a Ctrl+C there never ran through
// init()'s own catch at all (readline forwards SIGINT straight to the process, which
// signal-guard.ts's handler re-raises immediately — a path that never unwinds this
// async function), so a keygen or backup key already written before the interrupt was
// simply left behind. clack does not touch process signals at all here — see
// setRawMode in @clack/core, which only calls stdin.setRawMode() when isTTY, so a
// Ctrl-C byte arrives as ordinary input and is decoded into a cancel result instead.
class InitCancelledError extends Error {
  constructor() {
    super(
      'cypher-brain init: cancelled — anything this run already created is being rolled back (or, if a snapshot was already pushed, preserved and reported), same as any other error mid-wizard.',
    );
    this.name = 'InitCancelledError';
  }
}

// `init` is fundamentally interactive: a plain non-TTY invocation (piped/redirected
// stdin, a CI job with no terminal attached) must refuse cleanly here rather than
// hang forever on the first prompt (readline's question() never resolves on a stream
// that reaches EOF without a line — proven while building this: `init < /dev/null`
// hangs, it does not error). This mirrors promptHidden's own TTY posture (crypt.ts),
// but — same shape as that module's OWN escape hatch, where CYPHER_BRAIN_PASSPHRASE
// lets automation skip the hidden prompt entirely rather than needing a real TTY —
// deliberate automation (this repo's own scripts/selftest-init.sh) opts in with
// CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 instead of needing a genuine pseudo-tty.
// A real terminal never needs to set this; it exists solely so the wizard's own
// scripted end-to-end selftest can drive it deterministically.
function requireTTY(): void {
  if (process.stdin.isTTY) return;
  if (readEnv('CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE') === '1') return;
  throw new Error(
    'cypher-brain init is an interactive wizard and requires stdin to be a TTY — run it directly in a ' +
      'terminal, not via a pipe, a redirected file, or in CI (same posture keygen --passphrase already has ' +
      'for its passphrase prompt). For a non-interactive/scripted setup, drive the individual commands it ' +
      'wraps (keygen, snapshot, push, schedule) by hand instead; see MANAGEMENT.md.',
  );
}

async function askLine(question: string, def = ''): Promise<string> {
  // defaultValue: clack itself substitutes this ONLY when the user submits with
  // truly zero characters typed (TextPrompt's own "finalize" handler treats an
  // empty `this.value` as "use defaultValue") — it does NOT trigger for an answer
  // that is one or more whitespace characters (a space, a tab, ...), since that is
  // non-empty input as far as clack itself is concerned. The old rl.question()-based
  // version's contract was "blank answer -> def" where "blank" meant "trims to
  // nothing", not "literally zero keystrokes" — so a whitespace-only answer used to
  // fall back to the default too. Recreate that here by trimming FIRST and falling
  // back to `def` ourselves when the trimmed result is empty, rather than trusting
  // clack's own substitution to have already covered it. This matters well beyond
  // cosmetics: the Postgres connection-string prompt below (step 6/7) reuses this
  // same helper, and a whitespace-only answer landing as a literal `''` there makes
  // snapshotOpts.pg falsy — snapshot() then silently SKIPS pg_dump entirely, producing
  // a backup that looks complete but contains no database at all (Codex review
  // finding). placeholder just shows the default as dimmed ghost text before anything
  // is typed; pass undefined rather than '' so an empty def does not render a stray
  // placeholder.
  const answer = await text({ message: question, placeholder: def || undefined, defaultValue: def });
  if (isCancel(answer)) throw new InitCancelledError();
  return answer.trim() || def;
}

// A wizard prompt reads its answer as a plain string — no shell is ever involved, so a
// leading `~` in a path-like answer (a very natural thing to type, e.g. `~/vault`) is
// NOT expanded the way it would be if the same string were a shell argument to the
// equivalent manual CLI flag. Left alone this silently produces a wrong path (a literal
// `~`-named entry relative to cwd, or a nonexistent path) instead of the user's actual
// home directory. Mirrors just the common shell cases — bare `~` and `~/...` — not full
// `~username` expansion (out of scope here). Applied at every prompt below that collects
// a filesystem path.
function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

// An unrecognized answer (a typo, "yeah"/"sure", anything other than a y/n form) must
// NEVER be silently coerced to false: several callers below default to true for a
// security-relevant prompt (e.g. the offline backup keypair, #96's motivating case),
// so a misread "no" there would quietly skip the tool's main defense against identity
// loss with no indication anything went wrong. The old free-text version of this
// re-prompted on anything that wasn't y/yes/n/no; clack's confirm() prompt makes that
// entire class of misreading structurally impossible instead — it is a toggle between
// exactly two labelled options (default "Yes"/"No"), not a parsed string, so there is
// no "unrecognized answer" state left to re-prompt for.
async function askYesNo(question: string, def: boolean): Promise<boolean> {
  const answer = await confirm({ message: question, initialValue: def });
  if (isCancel(answer)) throw new InitCancelledError();
  return answer;
}

// #396 Phase B: the backend prompt below used to be free-text (askLine), which let a
// typo slip past this wizard's own validation with a confusing "unknown backend"
// re-throw AFTER the identity/backup-key steps had already run (#161's whole point was
// catching THIS class of late failure for the wallet check; the prompt itself was still
// exposed to it). clack's select() makes an invalid answer structurally impossible — the
// return type is one of the option `value`s, never arbitrary text — so the manual
// `BACKEND_NAMES.includes(backend)` guard that used to follow this prompt is gone too;
// there is nothing left for it to catch.
// Not generic over the option's value type (a `<T extends string>` wrapper around
// clack's own `select<Value>` does not typecheck here — @clack/prompts' `Option<Value>`
// is a CONDITIONAL type keyed on `Value extends Primitive`, and TS cannot resolve that
// branch against a still-generic `T`, only a concrete type). Callers narrow the
// returned string back to their own literal-union type themselves (safe: clack's
// select() can only return one of the `value`s it was given).
async function askSelect(
  question: string,
  options: { value: string; label: string; hint?: string }[],
  initialValue: string,
): Promise<string> {
  const answer = await select({ message: question, options, initialValue });
  if (isCancel(answer)) throw new InitCancelledError();
  return answer;
}

// One-line hints shown next to each BACKEND_NAMES choice in the select() prompt below
// (#396 Phase B — the acceptance criterion is a `select()` prompt with a hint per
// choice). Order matches BACKEND_NAMES (backends/index.ts); kept local to the wizard
// since --help/README already carry the fuller mechanical description elsewhere (cli.ts,
// README.md "## Backends") — this is UI prose, not a second copy of that reference.
// Keeping it a Record keyed by BACKEND_NAMES's own element type means a future backend
// added to BACKEND_NAMES without a matching entry here is a TYPE ERROR, not a silent
// "hint: undefined" in the prompt.
const BACKEND_HINTS: Record<(typeof BACKEND_NAMES)[number], string> = {
  turbo: 'Arweave via Turbo — pay once, permanent, ETH/USDC — recommended for most users',
  arweave: 'Arweave L1 direct — pay once, permanent, small files only (~10 MiB cap)',
  'ton-provider': 'TON Storage, pay a live provider — availability depends on it renewing, see docs/durability.md',
  file: 'local only — free, NOT reachable from another machine (not offsite)',
};

// BackupKey/SigningKey/KitInputs and buildRecoveryKit() moved to
// src/lib/recoverykit.ts (#364) so `init` and the standalone
// `cypher-brain recovery-kit` command render ONE canonical kit that cannot
// drift. The wizard-era design notes (1Password Emergency Kit lineage,
// plain-text-over-PDF, primary-not-duplicated) live there now.

export async function init(_o: CliOptions): Promise<void> {
  requireTTY();
  if (await exists(IDENTITY)) {
    throw new Error(
      `an identity already exists at ${IDENTITY} — "cypher-brain init" is for a FRESH setup, not overwriting ` +
        `one. To redo it deliberately, run "cypher-brain keygen --force" (overwrites the identity — you lose ` +
        `access to anything only that identity could decrypt) or drive keygen/snapshot/push/schedule by hand; ` +
        `see MANAGEMENT.md.`,
    );
  }

  console.log(
    'cypher-brain init — interactive setup: keygen, key recovery, authenticity signing, first snapshot + push, recovery kit.\n',
  );

  try {
    // ---------- 1. primary keygen (reuses keygen() verbatim — no reimplementation) ----------
    console.log('== 1/7: generating your primary identity ==');
    // keygen() -> keygenAt() (keys.ts) checks identity.age AND recipient.txt for
    // pre-existence UP FRONT, before writing either — so a stray pre-existing
    // recipient.txt (or a directory sitting at that path) now refuses cleanly before
    // identity.age is ever touched (#121). identity.age can still land on disk before
    // recipient.txt's own write fails for a reason the pre-flight check can't catch
    // (ENOSPC, a permission error, a concurrent process racing past the check, ...) —
    // this call is BEFORE the rollback-tracking try below even starts
    // (deliberately — everything inside that try is retry-safe via the catch further
    // down), so without this its own try/catch a partial keygen here would leave an
    // orphaned identity.age that nothing ever cleans up: every future `init` on this
    // CYPHER_BRAIN_HOME hits the "identity already exists" refusal forever, with no
    // rollback path to escape it (unlike every failure inside the try below).
    // IDENTITY itself is provably absent here — the exists() refusal above already
    // guarantees that, unconditionally, before this try even starts. RECIPIENT is not
    // covered by that same guarantee: it could already sit on disk as an orphan from
    // some earlier, unrelated mistake (a stray recipient.txt with no matching
    // identity.age) even though IDENTITY is absent. Checking THAT before this call —
    // and only deleting it in the catch if it did not already exist — keeps this
    // rollback to "only what this invocation itself created", the same principle the
    // backup-key rollback below applies.
    const recipientPreExisted = await exists(RECIPIENT);
    try {
      await keygen({ dirs: [], tables: [], recipients: [] });
    } catch (e) {
      await rm(IDENTITY, { force: true });
      if (!recipientPreExisted) await rm(RECIPIENT, { force: true });
      throw e;
    }

    // From here on, THIS invocation just created the primary identity — the exists()
    // refusal above already guarantees it did not exist before this run started, so any
    // failure in the rest of the flow (an invalid answer, a declined paid-backend
    // consent, a missing optional dependency, a recovery-kit write error, ...) must not
    // leave that identity behind. `init` refuses unconditionally whenever IDENTITY
    // already exists, so a half-finished run would otherwise permanently block a clean
    // retry — the user's only escape would be the scarier, undocumented-to-them
    // `keygen --force`. Roll back exactly what THIS run created (never anything from a
    // prior, already-completed setup — that case never reaches here, it was refused
    // above before this try started), then re-throw so the original error still
    // surfaces unchanged.
    let backup: BackupKey | null = null;
    let signing: SigningKey | null = null;
    // Set the moment snapshot() below actually succeeds — never before. snapshot()'s own
    // promote step (promoteSnapshot in snapshot.ts) only renames/links its .part onto
    // o.out on success, so if snapshot() itself throws, o.out (and its sidecars) were
    // never created and there is nothing here to roll back. If a LATER step fails (push,
    // the recovery-kit write, ...), the dated snapshot file it did produce — plus its
    // `.digest` / `.recipients-fingerprint` sidecars — must still be deleted: snapshot()
    // refuses to overwrite an existing --out (no-clobber), and the wizard's --out is
    // dated per-day, so leaving them behind would make a same-day retry fail again at
    // this exact step even though the rollback below already cleared the identity.
    let snapshotOutPath: string | null = null;
    // True once push() below actually returns successfully. From that point on the
    // ciphertext already exists, durably, in the chosen backend's store — for
    // arweave/turbo that store is PAID and PERMANENT (irreversible; real funds were
    // just spent), and even the free "file" backend now has an object keyed to these
    // identities. The primary/backup identities are the ONLY thing that can ever
    // decrypt that artifact from here on, so once this flips true the catch block
    // below must NEVER delete them, no matter what fails afterward (kit write,
    // chmod, ...) — doing so would turn "the kit step needs a retry" into "a
    // permanent, already-paid-for snapshot with no key left able to decrypt it,
    // ever." Only failures BEFORE this flips true still get the full rollback below.
    let pushSucceeded = false;
    let pushedBackend: string | null = null;
    let pushedLocatorPath: string | null = null;
    try {
      // ---------- 2. backup key guidance (MANAGEMENT.md Key recovery #1) ----------
      console.log('\n== 2/7: offline backup key (recommended) ==');
      console.log(
        'cypher-brain gives you two independent defenses against losing the primary identity; the first is a\n' +
          'second, OFFLINE backup keypair. If you encrypt every snapshot to BOTH the primary and the backup\n' +
          'public key, either identity alone can restore — see MANAGEMENT.md "Key recovery #1".',
      );
      if (await askYesNo('Generate an offline backup keypair now?', true)) {
        // Shown BEFORE the path prompt (and BEFORE keygenAt() below writes anything) —
        // not after, like it used to be. The old order printed this warning only once
        // the keypair was already on disk and a "backup identity written to: ..." success
        // line had already gone by, which reads as "done" and makes a one-line warning
        // easy to skim past. The default path below (`${HOME}-backup`) sits right next to
        // the primary identity on the SAME disk, so the "move this off-box" instruction
        // needs to land before the user accepts that default, not after.
        console.log('⚠  This will still be written ON this machine — move it OFF-BOX (encrypted USB, a second');
        console.log('   location, a trusted person) once it is written; the recovery kit at the end restates this.');
        const defaultBackupHome = `${HOME}-backup`;
        const backupHome = expandHome(
          await askLine(
            `Path for the backup keypair (same disk unless you change this) [${defaultBackupHome}]`,
            defaultBackupHome,
          ),
        );
        const identityPath = join(backupHome, 'identity.age');
        const recipientPath = join(backupHome, 'recipient.txt');
        // Same partial-write hazard as the primary keygen above (identity.age written,
        // then recipient.txt's write throws) — but here it CANNOT rely on the outer
        // catch's `if (backup) { rm(...) }` rollback, because `backup` itself is only
        // assigned a few lines below, AFTER this call returns successfully. If
        // keygenAt() throws here, `backup` is still null when that catch runs, so its
        // rollback branch never fires and the orphaned backup identity.age survives.
        // Clean up right here, independent of the `backup` variable's later assignment.
        //
        // Unlike the primary keygen above, this path CANNOT assume identityPath/
        // recipientPath are absent beforehand — backupHome is a user-typed answer, and
        // nothing stops them from pointing it at a directory that already holds a REAL,
        // previously-set-up backup identity (e.g. re-running this step against their
        // existing offline backup location). keygenAt() itself already refuses to
        // overwrite an existing identityPath OR recipientPath (see keys.ts, #121) and
        // throws BEFORE writing anything in that case — so an unconditional rm here
        // would delete that real, pre-existing backup identity for no reason other
        // than "keygenAt declined to clobber it", which is strictly worse than the
        // partial-write hazard this catch exists to fix (a blocked retry vs. permanent,
        // unrecoverable loss of a real key). Check existence of each target BEFORE
        // calling keygenAt, and only remove
        // whichever ones did NOT already exist beforehand.
        const identityPreExisted = await exists(identityPath);
        const recipientPreExisted = await exists(recipientPath);
        let recipient: string;
        try {
          ({ recipient } = await keygenAt({ home: backupHome, identityPath, recipientPath }));
        } catch (e) {
          if (!identityPreExisted) await rm(identityPath, { force: true });
          if (!recipientPreExisted) await rm(recipientPath, { force: true });
          throw e;
        }
        const identityText = await readFile(identityPath, 'utf8');
        backup = { identityPath, recipientPath, recipient, identityText };
        console.log(`backup identity written to: ${identityPath}`);
      } else {
        console.log(
          'Skipping the backup key. You can add one later at any time: CYPHER_BRAIN_HOME=<path> cypher-brain keygen',
        );
      }

      // ---------- 3. authenticity signing keypair (#214, README Threat model) ----------
      console.log('\n== 3/7: authenticity signing keypair (recommended) ==');
      console.log(
        'age proves confidentiality but NOT authenticity: a recipient public key is not secret, so anyone\n' +
          'holding it can forge ciphertext that decrypts cleanly, claiming to be a real snapshot. A separate,\n' +
          'minisign-compatible Ed25519 signing keypair closes this gap — snapshot signs each *.age it writes,\n' +
          'and restore/verify check that signature BEFORE decrypting. See README "Threat model".',
      );
      if ((await exists(SIGN_IDENTITY)) && (await exists(SIGN_RECIPIENT))) {
        // A signing keypair already exists (an earlier, independent "keygen --sign"
        // run, or a previous "init" that generated one) — reuse it rather than
        // asking. Answering "yes" below would just hit keygenSignAt's own
        // no-clobber guard and abort the ENTIRE wizard run over a step that was
        // never going to change anything; answering "no" would leave `signing`
        // null even though snapshot auto-signs with the pre-existing key
        // regardless of this wizard run, so the recovery kit would falsely omit
        // the signing public key a restore on another machine actually needs.
        console.log(`Authenticity signing keypair already exists (${SIGN_RECIPIENT}) — reusing it.`);
        signing = {
          identityPath: SIGN_IDENTITY,
          recipientPath: SIGN_RECIPIENT,
          pubkeyText: await readFile(SIGN_RECIPIENT, 'utf8'),
        };
      } else if (await askYesNo('Generate a signing keypair now?', true)) {
        // Same partial-write hazard/rollback shape as the backup keypair above: check
        // pre-existence BEFORE calling keygenSignAt (this branch only runs when
        // NEITHER path existed a moment ago, but keygenSignAt's own precondition
        // check is still the authority — belt and suspenders, same idiom as the
        // backup keypair section), and only remove what THIS call itself created
        // if it throws partway through.
        const signIdentityPreExisted = await exists(SIGN_IDENTITY);
        const signRecipientPreExisted = await exists(SIGN_RECIPIENT);
        let pubkeyText: string;
        try {
          ({ pubkeyText } = await keygenSignAt({
            home: HOME,
            identityPath: SIGN_IDENTITY,
            recipientPath: SIGN_RECIPIENT,
          }));
        } catch (e) {
          if (!signIdentityPreExisted) await rm(SIGN_IDENTITY, { force: true });
          if (!signRecipientPreExisted) await rm(SIGN_RECIPIENT, { force: true });
          throw e;
        }
        signing = { identityPath: SIGN_IDENTITY, recipientPath: SIGN_RECIPIENT, pubkeyText };
        console.log(`signing public key written to: ${SIGN_RECIPIENT}`);
      } else {
        console.log('Skipping authenticity signing. You can add it later at any time: cypher-brain keygen --sign');
      }

      // ---------- 4. passphrase wrap the primary identity (MANAGEMENT.md Key recovery #2) ----------
      console.log('\n== 4/7: protect the primary identity at rest (recommended) ==');
      console.log(
        'The identity file just written is a bare secret guarded only by file permissions (0600) — anyone who\n' +
          'copies it off this machine can decrypt every snapshot. A passphrase wrap (scrypt, the same "keygen\n' +
          '--passphrase" flag uses) makes an exfiltrated identity file useless without it. See MANAGEMENT.md\n' +
          '"Key recovery #2".',
      );
      if (await askYesNo('Protect the primary identity with a passphrase now?', false)) {
        // Reuses the EXACT same pieces keygen --passphrase uses (askNewPassphrase / wrapIdentity from
        // crypt.ts) — the identity was just written unwrapped above, so this wraps it in place rather
        // than re-generating (keygenAt's own wrap-at-creation path is for a keypair that does not exist
        // yet; here we already have the one we want to protect).
        //
        // Before the @clack/prompts migration (#230) this had to explicitly close() the wizard's own
        // readline Interface here and reopen a fresh one afterwards: askNewPassphrase() -> promptHidden
        // (crypt.ts) puts stdin into raw mode and manages its OWN 'data' listener directly, and having
        // that run while a readline Interface was ALSO still attached to the same stdin left stdin
        // unable to deliver input to a later rl.question() (confirmed empirically with a real pty
        // harness). clack's prompts don't hold a persistent Interface open between calls — each text()/
        // confirm() call above already attached and fully detached its own keypress listener by the time
        // its promise resolved (@clack/core's Prompt.prompt(), the `this.input.off('keypress', ...)`
        // cleanup on submit/cancel) — so by the time this line runs there is nothing left competing with
        // promptHidden's own raw-mode read, and no interface to close/reopen around it.
        const identityPlain = await readFile(IDENTITY, 'utf8');
        const payload = await wrapIdentity(identityPlain, await askNewPassphrase());
        await writeFile(IDENTITY, payload, { mode: 0o600 });
        console.log(`identity re-written, passphrase-wrapped: ${IDENTITY}`);
      } else {
        // NOT "keygen --passphrase --force": --force still calls generateKeypair()
        // unconditionally (keys.ts) and so DISCARDS this identity for a brand-new one,
        // making every snapshot already encrypted to it unrecoverable (#110). The
        // non-destructive option is --wrap-in-place, which reuses this exact same
        // keypair and only changes its on-disk encoding.
        console.log('Skipping the passphrase wrap. You can wrap it later by re-running "cypher-brain keygen');
        console.log('--wrap-in-place" (keeps this same key — do NOT use --force, which generates a NEW key and');
        console.log('makes every snapshot already encrypted to this one unrecoverable), or by full-disk-encrypting');
        console.log('the machine that holds the identity (MANAGEMENT.md recommends both).');
      }

      // ---------- 5. recipient pin suggestion (CYPHER_BRAIN_PIN_RECIPIENTS) ----------
      // The config file (#286) — not a shell rc — is what this step points at. init still
      // does not WRITE it (that is a separate consent question: this wizard has never
      // persisted a setting on the user's behalf, and a file that may hold secrets is not
      // the place to start doing it silently), so the suggestion stays a suggestion.
      // The path itself comes from config.ts (CONFIG_FILE_PATH) rather than being
      // re-derived here — the loader and this instruction must never be able to disagree
      // about the filename, or the user creates a file nothing ever reads, silently.
      console.log('\n== 5/7: recipient pin (optional, recommended) ==');
      console.log(
        'CYPHER_BRAIN_PIN_RECIPIENTS is a setting snapshot reads at run time: when set, it refuses to encrypt\n' +
          'to any recipient NOT on the list — so a tampered recipient.txt, or an injected extra --recipient, can\n' +
          'never silently re-key your snapshots to an attacker. init does not write the setting for you, but it\n' +
          'can suggest the exact line. The place to put it is the config file, which the CLI and the MCP server\n' +
          `both read:\n  ${CONFIG_FILE_PATH}   (one KEY=value per line; chmod 600 — it may hold secrets)\n` +
          'A shell rc (~/.zshrc / ~/.bashrc) also works, but only for the interactive shells you open yourself.\n' +
          'launchd/cron start the unattended nightly run with a bare environment, and "schedule install" bakes\n' +
          'in whatever is in effect when you run it — so a value in the config file covers the nightly run as\n' +
          'well as your own runs, while one in a shell rc covers the nightly run only if install happened to be\n' +
          'run from a shell that had sourced it. (Added it after "schedule install"? Re-run install to pick it up.)',
      );
      let pinRecipientsLine: string | null = null;
      if (await askYesNo('Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line for the config file?', true)) {
        const primaryPub = (await readFile(RECIPIENT, 'utf8')).trim();
        const defaultLine = `CYPHER_BRAIN_PIN_RECIPIENTS="${[primaryPub, backup?.recipient].filter(Boolean).join(' ')}"`;
        console.log(`Suggested line (edit or press Enter to accept):\n${defaultLine}`);
        pinRecipientsLine = await askLine('CYPHER_BRAIN_PIN_RECIPIENTS line', defaultLine);
        console.log(
          `\nAdd this line to ${CONFIG_FILE_PATH} (create the file if it does not exist yet, then chmod 600 it):\n` +
            `${pinRecipientsLine}\n` +
            'For a shell rc instead, prefix it with "export " and open a new shell — but see the note above about\n' +
            'the unattended nightly run. Either way it applies from the NEXT cypher-brain run onward: this\n' +
            'wizard read its configuration at startup, so the first snapshot it is about to take (step 7/7,\n' +
            'encrypting to the key(s) it just generated) is not itself checked against this list.',
        );
      } else {
        console.log('Skipping the recipient pin suggestion.');
      }

      // ---------- 6. profile selection ----------
      console.log('\n== 6/7: what to back up ==');
      console.log(`Available profiles (one-flag source presets): ${PROFILE_NAMES.join(', ')}. Or "none" to point at`);
      console.log('directories yourself (the same as passing --dir manually to snapshot later).');
      // #462: this used to be askLine() free text, so a single typo (e.g. "obsidan")
      // threw AFTER steps 1-5 had already written the primary identity, the offline
      // backup keypair, and the signing keypair to disk — and the catch block a few
      // hundred lines down rolls ALL of that back on any throw from inside this try,
      // since from its perspective an invalid answer here is indistinguishable from a
      // declined-consent abort. The backend step below already solved exactly this
      // shape of problem with askSelect() (#396 Phase B, see its own doc comment): a
      // clack select() menu can only ever return one of the `value`s it was given, so
      // there is no "invalid answer" path left for this step to throw on at all — the
      // typo becomes structurally impossible instead of caught-and-rolled-back.
      const PROFILE_HINTS: Record<string, string> = {
        'claude-code': 'every ~/.claude/projects/*/memory/ dir plus ~/.claude/CLAUDE.md',
        obsidian: 'an Obsidian vault directory (needs --vault at the next prompt)',
        'chatgpt-export': 'the official ChatGPT data-export .zip, as-is',
        o2b: 'an Open Second Brain bank-export bundle, as-is',
      };
      const profileChoice = await askSelect(
        'Profile (what to back up)',
        [
          { value: 'none', label: 'none', hint: 'pick directories yourself, like passing --dir manually' },
          ...PROFILE_NAMES.map((name) => ({ value: name, label: name, hint: PROFILE_HINTS[name] })),
        ],
        'none',
      );
      const snapshotOpts: CliOptions = { dirs: [], tables: [], recipients: [] };
      if (profileChoice === 'none') {
        // #492: this used to throw on the FIRST empty answer (Enter with nothing typed,
        // or only whitespace/commas) — same bug class as #462's profile prompt above,
        // and just as costly: this step runs after 1-5 have already written the primary
        // identity, the offline backup keypair, and the signing keypair, and the catch
        // block a few hundred lines down rolls ALL of that back on any throw from inside
        // this try. Unlike the profile prompt, this one genuinely cannot become a
        // select() menu (the paths are free-form, unbounded), so instead of throwing,
        // loop askLine until at least one directory is given — the same fix the
        // maintainer already chose for the sibling bug, applied here since a menu isn't
        // available.
        let dirs: string[] = [];
        while (dirs.length === 0) {
          const dirsInput = await askLine('Directory path(s) to back up, comma-separated (at least one, required)');
          dirs = dirsInput
            .split(',')
            .map((d) => expandHome(d.trim()))
            .filter(Boolean);
          if (dirs.length === 0) console.log('At least one directory is required — please try again.');
        }
        snapshotOpts.dirs = dirs;
      } else {
        // askSelect()/clack's select() can only return one of the `value`s it was
        // given, and every value above besides 'none' came straight from
        // PROFILE_NAMES itself — so this is always one of the known profile names,
        // no re-validation needed (unlike the old free-text prompt).
        snapshotOpts.profile = profileChoice;
        if (profileChoice === 'obsidian')
          snapshotOpts.vault = expandHome(await askLine('Path to your Obsidian vault (must contain .obsidian/)'));
        if (profileChoice === 'chatgpt-export')
          snapshotOpts.zip = expandHome(await askLine('Path to the official ChatGPT export .zip'));
        if (profileChoice === 'o2b')
          snapshotOpts.export = expandHome(
            await askLine('Path to the o2b bank-export bundle ("o2b brain bank-export --out <path>.json")'),
          );
      }

      // gbrain (this project's headline use case — README/MANAGEMENT.md) stores its
      // ACTUAL data (pages, embeddings, timeline, graph) in one of TWO engines, and
      // which one decides what a useful backup even looks like. On Postgres the
      // ~/.gbrain directory is only config/cache, so the natural-looking answer above
      // ("none" + ~/.gbrain) silently backs up the config and never the real data
      // (issue #84). On PGLite — gbrain's zero-config DEFAULT — the opposite is true:
      // the data IS a directory on disk and there is no server to dump, so the same
      // prose sends the user looking for a Postgres that does not exist and the --pg
      // default of yes hands them a pg_dump failure (issue #367). Only ask when a local
      // gbrain config is actually detected: everyone else's flow is completely
      // unchanged, and init already documents that anything beyond its opinionated fast
      // path is driven by hand (see requireTTY's own message above).
      const gbrainConfigPath = join(homedir(), '.gbrain', 'config.json');
      if (await exists(gbrainConfigPath)) {
        // Reads the engine verdict and, on PGLite, the configured store path — and
        // nothing else out of config.json, which holds API keys (see detectGbrainEngine's
        // own doc comment for why that one field is the single deliberate exemption).
        const gbrain = await detectGbrainEngine(gbrainConfigPath);
        if (gbrain.engine === 'pglite') {
          console.log(`\nDetected a gbrain config at ${gbrainConfigPath} — engine: PGLite (gbrain's default).`);
          console.log('PGLite keeps the whole database as a directory on disk, so there is no Postgres server to');
          console.log('dump: backing up that directory IS backing up the brain. No --pg is needed, and it is not');
          console.log('offered here.');
          // Answer the coverage question against the path the CONFIG names, never against
          // an assumed ~/.gbrain (review round 1). A brain configured at, say, /srv/gbrain
          // would otherwise be reported as covered by a backup containing no database at
          // all — the very mistake #367 exists to remove, wearing new clothes.
          //
          // Three outcomes, and only the first one is a coverage claim. A judgement is
          // made ONLY when the config gives an absolute path; otherwise this says it
          // cannot tell (review round 2). Half-knowing where the store is must not
          // produce a confident answer — that is how the original bug happened.
          if (gbrain.dataPath) {
            console.log(`\nIts config records the store at:\n  ${gbrain.dataPath}`);
            if (pathCoveredBy(gbrain.dataPath, snapshotOpts.dirs)) {
              console.log('The path(s) you gave above cover it, so the snapshot will contain the database.');
            } else {
              console.log('NONE of the paths you gave above covers it — as answered, this backup would NOT contain');
              console.log('the database. Re-run init with that path included, or add it as another --dir when you');
              console.log('drive "cypher-brain snapshot" by hand.');
            }
          } else if (gbrain.relativeDataPath) {
            console.log(`\nIts config records the store as a RELATIVE path:\n  ${gbrain.relativeDataPath}`);
            console.log('gbrain turns that into a real location using the directory it is RUN from, which this');
            console.log('wizard cannot observe — so the store could be almost anywhere and no coverage check here');
            console.log('would mean anything. Confirm yourself that the path(s) you gave above cover it. (Making');
            console.log('database_path absolute in the config removes this ambiguity for every tool, not just this');
            console.log('one.)');
          } else {
            console.log('\nIts config does not record a database_path, so this wizard cannot tell where the store');
            console.log('actually lives and will not guess. Check yourself that the path(s) you gave above cover');
            console.log("gbrain's data directory — a backup that misses it looks completely successful.");
          }
          console.log('\nOne caveat this backup cannot solve for you: PostgreSQL (which is what PGLite is) does not');
          console.log('support file-level copies of a running cluster, so a directory copied while gbrain is');
          console.log('writing may be internally inconsistent. Stop gbrain for the duration of the snapshot when');
          console.log('you can. snapshot warns whenever it sees such a store.');
        } else {
          console.log(`\nDetected a gbrain config at ${gbrainConfigPath} — gbrain's actual data (pages, embeddings,`);
          console.log('timeline, graph) lives in Postgres, not in that directory alone. Requires pg_dump/pg_restore');
          console.log('on PATH — see README "Prerequisites for --pg".');
          if (await askYesNo('Include a Postgres database dump (--pg) for gbrain in this backup?', true)) {
            // Default to the CURRENT machine's OS user — local Postgres setups commonly use
            // peer auth keyed to it (matches README's own --pg examples), so this is a real
            // guess rather than a literal "you" placeholder nobody's account is ever named
            // (Fugu review finding: a bare-Enter accept should not likely fail pg_dump).
            let osUser = 'you';
            try {
              osUser = userInfo().username;
            } catch {
              /* keep the 'you' fallback */
            }
            // percent-encode: a username with '@', ':', '/', or a space would otherwise
            // corrupt the URI's own authority parsing (Fugu review finding).
            const defaultPg = `postgres://${encodeURIComponent(osUser)}@localhost:5432/gbrain`;
            snapshotOpts.pg = await askLine(`Postgres connection string [${defaultPg}]`, defaultPg);
          }
        }
      }

      // ---------- 7. initial snapshot + push ----------
      console.log('\n== 7/7: first snapshot + push ==');
      console.log('Pick where the encrypted snapshot goes — see the hint next to each choice for the tradeoff.');
      // Cast is safe: select() can only return one of the `value`s it was given, and
      // every one of those came from BACKEND_NAMES itself (see askSelect's own doc
      // comment for why the helper cannot be generic over this literal-union type).
      const backend = (await askSelect(
        'Choose a backend',
        BACKEND_NAMES.map((name) => ({ value: name, label: name, hint: BACKEND_HINTS[name] })),
        'file', // the cursor starts on the free/local choice regardless of list order — see BACKEND_NAMES's own doc comment
      )) as (typeof BACKEND_NAMES)[number];
      const paid = backend === 'arweave' || backend === 'turbo' || backend === 'ton-provider';
      // #161: check the backend's OWN prerequisites are present BEFORE the "spends real
      // funds" consent prompt below, not after. Without this, a user who picks a paid
      // backend with its prerequisites unset sails past that consent prompt, then fails
      // deep inside push() — pushSucceeded stays false, and the catch block below rolls
      // back the identity/backup key/recipient pin this same run just spent five steps
      // setting up: the worst possible first-run experience. Neither check can confirm
      // the funds are actually SUFFICIENT (that needs a network call) — only that the
      // prerequisite is set at all; an actual shortfall remains push's own
      // estimate/consent (arweave/turbo, issue #160) or advisory funds-check
      // (ton-provider, backends/ton-provider.ts) job, unchanged here.
      // NOTIFY_BIN is checked here too (multi-model review finding), not just OWNER/
      // MAX_SPEND: put() also requires it before it will push (ton-provider.ts checks
      // both presence AND executability, X_OK, before spending anything) — omitting it
      // from this precheck would let a run with owner+max-spend set but no built
      // scripts/go/storage-v1-client binary sail past this guard and fail deep inside
      // push() anyway, the exact bad UX #161 (and this precheck) exists to avoid. Only
      // evaluated when ton-provider was actually chosen — same lazy, backend-gated shape
      // walletConfigured() already has below, so an unrelated backend's run never pays
      // for an fs.access() call it has no use for.
      let tonProviderReady = false;
      let tonProviderAutoSigns = false;
      if (backend === 'ton-provider') {
        let notifyBinReady = false;
        if (TON_PROVIDER_NOTIFY_BIN) {
          try {
            await access(TON_PROVIDER_NOTIFY_BIN, fsConstants.X_OK);
            notifyBinReady = true;
          } catch {
            notifyBinReady = false;
          }
        }
        // #396 PR2: a configured local TON wallet ALSO satisfies "owner is known" — it
        // derives the owner itself (ton-provider.ts's put()), so CYPHER_BRAIN_TON_PROVIDER_OWNER
        // is no longer the only way to be ready. Checked lazily, same as notifyBinReady
        // above, so an unrelated backend's run never pays for the fs.access() this needs.
        tonProviderAutoSigns = await tonWalletConfigured();
        tonProviderReady =
          (Boolean(TON_PROVIDER_OWNER) || tonProviderAutoSigns) && TON_PROVIDER_MAX_SPEND > 0n && notifyBinReady;
      }
      if (paid && backend === 'ton-provider' && !tonProviderReady) {
        console.log(
          `\n${backend} needs an owner set ONE of two ways: CYPHER_BRAIN_TON_WALLET (a local TON wallet — ` +
            "'wallet create --chain ton' — auto-signs deploys with no human involved) or " +
            'CYPHER_BRAIN_TON_PROVIDER_OWNER (a plain address; deploys need a human to sign a Tonkeeper deeplink ' +
            'instead). Either way, CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (a nanoTON spend cap) is also required — ' +
            'a StorageV1 deploy spends real funds, so there is no safe default amount to let through uncapped.',
        );
        console.log(
          'It also needs a locally built scripts/go/storage-v1-client binary at ' +
            'CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN (checked for presence AND executability) — see ' +
            '"cypher-brain push --help" for the full prerequisite list.',
        );
        console.log(
          `\nEverything this run already set up — primary identity (${IDENTITY})` +
            `${backup ? `, backup identity (${backup.identityPath})` : ''}, and any choices above — is` +
            ' untouched; nothing has been rolled back. Set the env vars above, then drive snapshot + push by hand',
        );
        console.log(
          `(see MANAGEMENT.md) — "cypher-brain init" cannot be re-run, since it refuses whenever an identity` +
            ` already exists at ${IDENTITY}.`,
        );
        return;
      }
      if (paid && backend !== 'ton-provider' && !(await walletConfigured())) {
        console.log(
          `\n${backend} needs a funded wallet to push, and CYPHER_BRAIN_AR_WALLET is not set to an existing wallet file.`,
        );
        console.log('Set one up first:');
        console.log('  cypher-brain wallet create           # writes a JWK wallet (0600, no-clobber)');
        console.log('  cypher-brain wallet address           # prints the address to fund (crypto or a card —');
        console.log('                                         see docs/arweave-upload-runbook.md)');
        console.log(
          `\nEverything this run already set up — primary identity (${IDENTITY})` +
            `${backup ? `, backup identity (${backup.identityPath})` : ''}, and any choices above — is` +
            ' untouched; nothing has been rolled back. Fund the wallet, then drive snapshot + push by hand',
        );
        console.log(
          `(see MANAGEMENT.md) — "cypher-brain init" cannot be re-run, since it refuses whenever an identity` +
            ` already exists at ${IDENTITY}.`,
        );
        return;
      }
      // #172: build the snapshot BEFORE asking for paid-backend consent, not after.
      // The prompt below ("this spends real funds, confirm?") used to fire with no
      // number attached — the actual estimate only appeared later, inside push()
      // (#160/#169), by which point pushOpts.yes was already forced true from this
      // wizard's own consent and push()'s re-check never re-surfaced it. Creating the
      // snapshot first lets us estimate off the REAL ciphertext size and show that
      // estimate in the same prompt the consent decision is made against, exactly
      // like push() now does for direct CLI/MCP callers.
      snapshotOpts.recipients = [RECIPIENT, ...(backup ? [backup.recipientPath] : [])];
      const dateStamp = new Date().toISOString().slice(0, 10);
      const outPath = join(HOME, `brain-${dateStamp}.age`);
      snapshotOpts.out = outPath;
      await snapshot(snapshotOpts);
      snapshotOutPath = outPath; // recorded only now — snapshot() has durably written it

      if (paid) {
        // Same estimateCost()/formatEstimate() math push() uses (src/lib/estimate.ts,
        // #159) — not a second, divergent computation — against the snapshot's actual
        // on-disk size, so the consent prompt right below is never a blind "--yes".
        const { size: sizeBytes } = await stat(outPath);
        const est = await estimateCost(backend, sizeBytes);
        console.log(`\n${backend}: cost estimate for this snapshot:`);
        for (const line of formatEstimate(est)) console.log(`  ${line}`);
        // ton-provider is PAID but NOT permanent the way arweave/turbo are (durability
        // depends on the chosen provider continuing to renew/serve the contract, see
        // docs/durability.md) — the consent wording must not claim a guarantee this
        // backend does not make. Signing itself now depends on tonProviderAutoSigns
        // (#396 PR2, computed above): auto-sign broadcasts immediately, same as
        // arweave/turbo; the Tonkeeper path still blocks on a human signature (up to 20
        // minutes) — said here so that wait itself isn't mistaken for a hang once
        // "Proceed?" is answered.
        const consent = await askYesNo(
          backend === 'ton-provider'
            ? `${backend} is a PAID store — deploying spends real funds and cannot be undone. Unlike arweave/turbo ` +
                'it is availability-based, not permanent: durability depends on the chosen provider continuing to ' +
                'renew/serve the contract (see docs/durability.md). ' +
                (tonProviderAutoSigns
                  ? 'This "Proceed?" IS the consent — the configured local TON wallet then auto-signs and ' +
                    'broadcasts the deploy on its own, with no separate Tonkeeper signature to approve afterward. Proceed?'
                  : 'It also requires a HUMAN to sign a Tonkeeper deeplink once the deploy is built (up to 20 ' +
                    'minutes) — this prompt will not return until that happens. Proceed?')
            : `${backend} is a PAID, PERMANENT store — uploading spends real funds and cannot be undone. Proceed?`,
          false,
        );
        if (!consent) {
          // Declining here throws before push() runs; the catch block below still
          // rolls back this run's identity/backup key/recipient pin AND (per the
          // pushSucceeded/snapshotOutPath contract above) removes the snapshot this
          // step just wrote — correct, since consent was withheld.
          throw new Error(
            `aborted before spending — re-run "cypher-brain init" and choose "file" (free) instead, or run keygen/snapshot/push by hand once you are ready to pay; see MANAGEMENT.md.`,
          );
        }
      } else if (backend === 'file') {
        // issue #85: "file" is the silent Enter-key default, and it is NOT offsite —
        // the recovery kit's own "LOCATOR IS LOCAL-ONLY" block (buildRecoveryKit above)
        // already says so, but until now that warning was invisible unless someone
        // opened the printed kit. Surface it here, interactively, before the push
        // happens, and again in the completion summary below.
        console.log(
          '\n⚠  "file" stores the pushed ciphertext ONLY on this machine (CYPHER_BRAIN_FILE_DIR) — it is NOT\n' +
            '   reachable from any other machine. If this machine is lost, this backup cannot be recovered\n' +
            '   elsewhere. For real offsite recovery, re-run and choose arweave or turbo (paid) instead; see\n' +
            '   MANAGEMENT.md "Key recovery #3".',
        );
      }

      const locatorPath = join(HOME, 'latest-locator.tsv');
      const pushOpts: CliOptions = { dirs: [], tables: [], recipients: [] };
      pushOpts.in = outPath;
      pushOpts.backend = backend;
      pushOpts.save_locator = locatorPath;
      // The wizard's own explicit, just-asked confirmation above IS the human consent
      // push()'s paid-backend gate requires — set the same --yes equivalent a human
      // would pass on the command line. The gate itself is UNCHANGED and still fires
      // for anyone who does not go through this confirmation (push.ts is untouched).
      if (paid) pushOpts.yes = true;
      let savedLocatorLine: string;
      try {
        await push(pushOpts);
        // Push has now durably happened — see the pushSucceeded declaration above for
        // why the catch block's rollback boundary hinges on exactly this line.
        pushSucceeded = true;
        pushedBackend = backend;
        pushedLocatorPath = locatorPath;
        savedLocatorLine = (await readFile(locatorPath, 'utf8')).split('\n').find((l) => l.trim()) ?? '';
      } catch (pushErr) {
        if (pushErr instanceof PushPartialSuccessError) {
          // The ciphertext upload itself (backend.put()) already succeeded — see
          // PushPartialSuccessError's own doc comment in pushpull.ts, covering BOTH the
          // ".minisig" sidecar upload failing (PushSignatureUploadError) and the LOCAL
          // --save-locator bookkeeping failing after everything durably uploaded
          // (PushLocatorWriteError). Either way the remote artifact durably exists
          // (permanently, on arweave/turbo) even though locatorPath was never reached
          // and never written, so this is exactly as unrollbackable as an ordinary
          // successful push: flip pushSucceeded so the outer catch below preserves the
          // identities/snapshot instead of deleting them, but leave pushedLocatorPath
          // null (there genuinely is no locator FILE on disk this time — only the value
          // inside pushErr.locator, which the thrown error below surfaces for the
          // operator to record by hand).
          pushSucceeded = true;
          pushedBackend = backend;
          pushedLocatorPath = null;
          throw new Error(
            `${pushErr.message}\nACTION REQUIRED: the upload already happened and cannot be undone — hand-record ` +
              `this locator now, since --save-locator itself never ran (or failed) for it: locator="${pushErr.locator}" ` +
              `backend="${backend}". Without recording it, this snapshot is unrecoverable even though it durably ` +
              `exists in the backend.`,
          );
        }
        // Any other push() failure (declined paid-backend consent, a network error
        // during backend.put() itself, etc.) means the upload never happened —
        // pushSucceeded stays false and the pre-push rollback path below still fires.
        throw pushErr;
      }

      // ---------- recovery kit ----------
      const primaryRecipient = (await readFile(RECIPIENT, 'utf8')).trim();
      const defaultKitPath = join(homedir(), 'recovery-kit.txt');
      console.log('\n⚠  The recovery kit written below will contain secret key material in plaintext — once it');
      console.log('   is written, move it OFF-BOX (encrypted USB, a second location, a trusted person).');
      const kitPath = expandHome(await askLine(`Path to write the recovery kit [${defaultKitPath}]`, defaultKitPath));
      const kitText = buildRecoveryKit({
        primaryIdentityPath: IDENTITY,
        primaryInline: null, // init never inlines the primary — see recoverykit.ts's design note
        primaryRecipient,
        backup,
        signing,
        pinRecipientsLine,
        savedLocatorLine,
        profile: profileChoice,
        backend,
        pg: snapshotOpts.pg ? { conn: snapshotOpts.pg } : 'none',
        generatedAt: new Date().toISOString(),
      });
      // Secret-bearing write: exclusive-create 0600 temp + atomic rename — shared
      // with the standalone command in recoverykit.ts (one write path, #364).
      await writeRecoveryKitFile(kitPath, kitText, { clobber: true });

      console.log('\n=== cypher-brain init: complete ===');
      console.log(`primary identity:  ${IDENTITY}`);
      if (backup) console.log(`backup identity:   ${backup.identityPath}  (move this OFF this machine)`);
      if (signing) console.log(`signing public key: ${signing.recipientPath}`);
      console.log(`snapshot:          ${outPath}`);
      if (snapshotOpts.pg) console.log('postgres:          included (pg_dump)');
      const backendWarning =
        backend === 'file'
          ? '  ⚠  LOCAL-ONLY — not reachable from another machine, see MANAGEMENT.md "Key recovery #3"'
          : '';
      console.log(`pushed to:         ${backend} (locator saved: ${locatorPath})${backendWarning}`);
      console.log(`recovery kit:      ${kitPath}`);
      console.log('\nNext: print the recovery kit and store it securely, physically away from this machine.');
      if (backup) console.log('Also move the backup identity directory off this machine (encrypted USB, a second');
      if (backup) console.log(`location, a trusted person): ${backup.identityPath.replace(/identity\.age$/, '')}`);
      console.log(
        'Once the kit is secured, you may delete it from disk yourself — cypher-brain does not do this for you.',
      );
      // The happy mood mascot (issue #194) is printed by cli.ts's `init` dispatch
      // case, right after this function returns (immediately followed by the
      // founder's note, issue #195/#199) — not here, so a successful run only
      // ever gets ONE happy mascot instead of one from each layer.
    } catch (err) {
      if (pushSucceeded) {
        // Push already happened — see the pushSucceeded declaration above. The
        // ciphertext is now durably stored (permanently and irreversibly if the
        // backend was arweave/turbo, real funds already spent) and these identities
        // are the ONLY way anyone will ever decrypt it. Deleting them here to "unblock
        // a retry" would be strictly worse than the retry annoyance this rollback
        // exists to fix: it would make an already-paid-for, already-permanent snapshot
        // unrecoverable forever. Preserve everything and tell the user exactly what
        // already succeeded and what remains on disk untouched.
        const permanentNote =
          pushedBackend === 'arweave' || pushedBackend === 'turbo'
            ? ' That backend is PAID and PERMANENT — the upload already happened and cannot be undone or refunded.'
            : '';
        const preserved = [
          `primary identity: ${IDENTITY}`,
          `primary recipient: ${RECIPIENT}`,
          ...(backup ? [`backup identity: ${backup.identityPath}`, `backup recipient: ${backup.recipientPath}`] : []),
          ...(signing
            ? [`signing identity: ${signing.identityPath}`, `signing public key: ${signing.recipientPath}`]
            : []),
          ...(snapshotOutPath ? [`snapshot: ${snapshotOutPath}`] : []),
        ].join('; ');
        // pushedLocatorPath is null exactly when a PushPartialSuccessError fired above:
        // the upload succeeded but --save-locator's own file was never reached/written,
        // so there is no path to print here — printing the literal `null` would read as
        // a bug rather than the "go read the error below" instruction it actually is.
        const locatorNote = pushedLocatorPath
          ? `locator saved: ${pushedLocatorPath}`
          : 'NOT SAVED — see error below for the value to record by hand';
        throw new Error(
          `cypher-brain init: the snapshot was already created and pushed to "${pushedBackend}" successfully ` +
            `(${locatorNote}).${permanentNote} A LATER step then failed: ` +
            `${errMsg(err)}\nNothing was rolled back — these files are PRESERVED and must NOT be deleted: ${preserved}. ` +
            `Fix the cause above, then either construct the recovery kit by hand from those paths (see ` +
            `MANAGEMENT.md), or re-run "cypher-brain init" once you have moved/backed up the above yourself — it ` +
            `will refuse immediately because an identity already exists at ${IDENTITY}; that refusal is expected ` +
            `and correct here, since your snapshot+push already succeeded and these keys must stay exactly where ` +
            `they are.`,
        );
      }
      // Roll back exactly what THIS run wrote — the primary identity/recipient this
      // invocation just generated in step 1, plus the backup identity/recipient if step
      // 2 generated one, plus the snapshot output + its sidecars if step 6's snapshot()
      // call itself succeeded before a LATER step (push, the recovery-kit write) failed
      // — so a subsequent `cypher-brain init` retry finds nothing at IDENTITY (starts
      // genuinely clean instead of hitting the pre-existing-identity refusal above) AND
      // finds no leftover --out at the same dated path (starts genuinely clean instead
      // of hitting snapshot()'s own no-clobber refusal at this step). This branch only
      // runs for failures BEFORE push() succeeded (see pushSucceeded above) — once push
      // has succeeded, the branch above takes over and preserves everything instead.
      await rm(IDENTITY, { force: true });
      await rm(RECIPIENT, { force: true });
      if (backup) {
        await rm(backup.identityPath, { force: true });
        await rm(backup.recipientPath, { force: true });
      }
      if (signing) {
        await rm(signing.identityPath, { force: true });
        await rm(signing.recipientPath, { force: true });
      }
      if (snapshotOutPath) {
        await rm(snapshotOutPath, { force: true });
        await rm(`${snapshotOutPath}.digest`, { force: true });
        await rm(`${snapshotOutPath}.recipients-fingerprint`, { force: true });
      }
      throw err;
    }
  } finally {
    // No persistent readline Interface to close anymore (issue #230 — @clack/prompts
    // tears down its own per-prompt stdin listeners itself; see askLine/askYesNo
    // above). BUT: Node's own readline.emitKeypressEvents(stdin) — which every clack
    // prompt call makes at least once (@clack/core's Prompt.prompt()) to decode raw
    // bytes into keypress events — installs a decoder on stdin's underlying socket
    // that stays registered for the rest of the process; nothing clack does (or that
    // this wizard could do) removes it again. An open stdin socket handle keeps
    // Node's event loop alive on its own, and cli.ts sets `process.exitCode` (rather
    // than calling process.exit() directly) on error, so the process depends on the
    // event loop actually draining to exit — confirmed empirically: after the
    // migration off readline.createInterface (whose own close() DID leave stdin with
    // no handle at all), a run through init() that hits an error here would print it
    // and then just hang forever needing SIGKILL, on EVERY path through init()
    // (success, a thrown error, or InitCancelledError above), not just this one.
    // stdin.pause() alone does not fix it — the handle stays in
    // process._getActiveHandles() even paused, verified directly; unref() is what
    // tells the event loop this handle must not keep the process alive, which was
    // exactly the property the old rl.close() gave us for free.
    //
    // Guard the call itself: unref()/ref() are net.Socket/tty.ReadStream methods, not
    // something every possible stdin implements. CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1
    // (this wizard's own scripted-automation escape hatch, requireTTY above) combined
    // with stdin coming from a HEREDOC or a plain `< file` redirection (rather than a
    // pipe) makes process.stdin a bare fs.ReadStream, which has neither method — calling
    // it unconditionally throws "process.stdin.unref is not a function" from THIS
    // finally block, which then REPLACES whatever error (often InitCancelledError, e.g.
    // stdin hitting EOF mid-wizard) was already propagating out of the try above (Codex
    // review finding: confirmed empirically — a real bug, not a hypothetical, with
    // `cb init < some-file` under the automation env var). A pipe (this repo's own
    // drive-init.mjs, and a real interactive TTY) still gets a net.Socket/tty.ReadStream
    // here and keeps unreffing exactly as before; only the fs.ReadStream case is now a
    // harmless no-op instead of a crash that masks the real failure.
    if (typeof process.stdin.unref === 'function') process.stdin.unref();
  }
}
