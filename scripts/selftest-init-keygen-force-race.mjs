#!/usr/bin/env node
// Regression proof for a Codex whole-session accumulated-diff review (elevated-caution
// key-handling cluster; relates to PRs #846/#869): `init`'s own `keygen()` call race
// guard (src/lib/wizard.ts, near the `raced` check inside the `try { await keygen(...) }
// catch` block) recognized an EEXIST race ONLY when it landed on RECIPIENT — the shape
// two concurrent PLAIN `keygen`/`init` calls produce, since keygenAt() (keys.ts, #786)
// writes RECIPIENT (exclusive create) strictly before IDENTITY (also exclusive create).
//
// `keygen --force` is a SEPARATE code path (keygenAt's force branch, keys.ts) that does
// NOT follow that same "exclusive create, RECIPIENT then IDENTITY" contract: it writes
// each target via write-new-then-RENAME, which succeeds unconditionally regardless of
// what already sits at the final path. So a DIFFERENT race shape is possible: this run's
// own (non-force) keygen() call wins its own RECIPIENT write (nothing there yet), then —
// before this run's own IDENTITY write executes — a concurrent `keygen --force` completes
// BOTH of its own writes (overwriting RECIPIENT, then creating IDENTITY). This run's own
// IDENTITY write then also fails EEXIST — but on IDENTITY, not RECIPIENT. Checking only
// RECIPIENT missed this shape: it fell through to the unconditional rollback, deleting the
// concurrent `keygen --force`'s just-written (and already-current) identity/recipient pair
// out from under it, with no backup to recover it from if that forced keygen started
// against an empty CYPHER_BRAIN_HOME.
//
// Five scenarios, all exercised against the REAL `wizard.ts` `init()`:
//   (A) grounding / regression guard for the ORIGINAL #720/#849 shape: two concurrent
//       PLAIN keygen() calls race on RECIPIENT — this run's OWN RECIPIENT write itself
//       fails EEXIST. Must still back off untouched (proves this fix did not regress the
//       case it already handled).
//   (B) the NEW shape this pass fixes: this run's own RECIPIENT write succeeds, then a
//       concurrent `keygen --force` completes fully before this run's own IDENTITY write
//       runs. Must ALSO back off untouched — pre-fix, this deleted the concurrent
//       `keygen --force`'s freshly-written identity/recipient pair.
//   (C) sibling-symmetry check (found via CLAUDE.md's own "check the twin location"
//       reflex, not part of the original two findings): step 3's SIGNING keypair race
//       guard (wizard.ts, "Generate a signing keypair now?" branch) has the EXACT same
//       code shape as the primary identity's own pre-fix check — it too only recognized
//       EEXIST on SIGN_RECIPIENT, not SIGN_IDENTITY, so `keygen --sign --force` racing
//       it hit the identical bug. Also checks that THIS run's own primary identity
//       (already written in step 1, before step 3 ever runs) is correctly ROLLED BACK by
//       the outer catch once the signing-keygen race backs off further down — nothing
//       was ever pushed in this run, so unlike the winner's SIGN_IDENTITY/SIGN_RECIPIENT
//       (which must survive), this run's OWN artifacts must NOT survive.
//   (D) a second-round Codex regression review of scenarios A/B's own fix flagged that an
//       EEXIST from an exclusive-create open() proves ONLY that something already sits at
//       that path — a symlink (dangling or not) throws the IDENTICAL EEXIST for any
//       O_CREAT|O_EXCL open, per POSIX, with no real winning process at all. A pre-
//       existing symlink at IDENTITY must not be misreported as "another process just won
//       a race" (which would tell the operator to simply re-run and wait — no amount of
//       waiting fixes a stray symlink) — it must fall through to the ordinary cleanup +
//       honest raw-error path instead.
//   (E) a SECOND sibling-symmetry gap the SAME 2nd-round review found: step 2's own
//       BACKUP keypair race guard (wizard.ts, "Generate an offline backup keypair now?"
//       branch) was STILL on the original, narrower shape (EEXIST on the backup
//       recipient path only) — never updated when (C)'s signing-keypair sibling was
//       fixed. A concurrent `keygen --force` pointed at the same backup home wins this
//       run's own identity write the same way it can for the primary/signing keypairs.
//

// Genuinely racing two OS processes against the microsecond-scale window between
// keygenAt()'s two exclusive-create writes is not a reliable, deterministic CI signal (the
// window is far too narrow for a freshly-spawned second process — module load + keypair
// generation — to reliably land inside it). Instead, scenarios A/B/C/E use Node's
// `node:test` module-mocking (`--experimental-test-module-mocks`) to intercept exactly ONE
// `fs.promises.open(path, 'wx', ...)` call for a specific path, and — at that exact
// moment, using the REAL, unmodified `keygenAt()`/`keygenSignAt()` — runs the "concurrent"
// writer to completion before letting the real `open()` proceed. Every byte on disk, and
// every thrown error, comes from the actual production code; only the TIMING is
// choreographed (the same "faithful reproduction of the real code, sequenced
// deterministically instead of via true concurrency" spirit as
// scripts/selftest-file-toctou.mjs's own Part 2). Scenario D needs no such choreography —
// the symlink is simply pre-created before `init()` ever runs.
//
// Each scenario runs in its OWN freshly-spawned `node` child process (like
// scripts/selftest-receipt.mjs's own multi-CYPHER_BRAIN_HOME scenarios do): config.ts's
// top-level HOME/IDENTITY/RECIPIENT consts are read from CYPHER_BRAIN_HOME once, at
// module-load time — re-using one process across scenarios would silently keep serving
// the FIRST scenario's HOME to every subsequent dynamic import of the same module graph.
//
// Red/green for each fix against the pre-fix source is verified separately (git stash the
// wizard.ts fix, observe this file FAIL on the affected scenario, git stash pop, observe
// it PASS) rather than embedded here as a second reimplementation — this file always
// exercises the CURRENT, real code, in only ONE (fixed-or-not) shape at a time.
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');

if (!process.env.CB_RACE_SCENARIO) {
  // ── Orchestrator: spawn one fresh child process per scenario ──────────────────────
  let failed = 0;
  const check = (name, cond, detail) => {
    if (cond) {
      console.log(`[PASS] ${name}`);
    } else {
      failed++;
      console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  const ROOT_TMP = await mkdtemp(join(tmpdir(), 'cb-init-race-'));

  async function runScenario(scenario, label) {
    console.log(`== ${label} ==`);
    const home = join(ROOT_TMP, `home-${scenario.toLowerCase()}`);
    const r = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        '--experimental-test-module-mocks',
        '--import',
        join(ROOT, 'scripts', 'dev-cli-loader.mjs'),
        SELF,
      ],
      {
        env: { ...process.env, CB_RACE_SCENARIO: scenario, CB_RACE_HOME: home },
        encoding: 'utf8',
      },
    );
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    check(`${label}: child process exits 0 (every check inside it passed)`, r.status === 0, `exit=${r.status}`);
    return home;
  }

  await runScenario(
    'A',
    '(A) two concurrent plain `keygen` calls race on RECIPIENT — must back off untouched (regression guard)',
  );
  const homeB = await runScenario(
    'B',
    "(B) this run's own RECIPIENT write succeeds, then a concurrent `keygen --force` finishes fully before this run's own IDENTITY write — must back off untouched, not delete the forced run's fresh identity/recipient",
  );
  const homeC = await runScenario(
    'C',
    "(C) sibling-symmetry: the SAME race, but for the SIGNING keypair (`keygen --sign --force`) — must back off from the winner's sign-identity/sign-recipient, while still correctly rolling back THIS run's own primary identity (step 1, nothing pushed yet)",
  );
  await runScenario(
    'D',
    '(D) a pre-existing symlink (dangling or not) at IDENTITY must NOT be misreported as a winning concurrent process',
  );
  const homeE = await runScenario(
    'E',
    "(E) second sibling-symmetry gap: the SAME race, but for the BACKUP keypair (`keygen --force` at the backup home) — must back off from the winner's backup identity/recipient, while still correctly rolling back THIS run's own primary identity",
  );

  // Sanity-check what survived scenarios B/C/E from the OUTSIDE too — the concurrent
  // writer's output is what MUST survive, so this must look like real key material, not
  // empty/corrupt bytes a bug elsewhere could produce and still pass the child's own bare
  // "file exists" check.
  const identityBytes = await readFile(join(homeB, 'identity.age')).catch(() => null);
  const recipientBytes = await readFile(join(homeB, 'recipient.txt')).catch(() => null);
  check(
    '(B) the surviving IDENTITY is non-empty age identity material',
    !!identityBytes && identityBytes.length > 0 && identityBytes.toString('utf8').includes('AGE-SECRET-KEY'),
  );
  check(
    '(B) the surviving RECIPIENT is non-empty and looks like an age recipient',
    !!recipientBytes && recipientBytes.toString('utf8').trim().startsWith('age1'),
  );
  const signIdentityBytes = await readFile(join(homeC, 'sign-identity.key')).catch(() => null);
  const signRecipientBytes = await readFile(join(homeC, 'sign-recipient.pub')).catch(() => null);
  check('(C) the surviving SIGNING IDENTITY is non-empty', !!signIdentityBytes && signIdentityBytes.length > 0);
  check('(C) the surviving SIGNING RECIPIENT is non-empty', !!signRecipientBytes && signRecipientBytes.length > 0);
  const backupIdentityBytes = await readFile(join(`${homeE}-backup`, 'identity.age')).catch(() => null);
  const backupRecipientBytes = await readFile(join(`${homeE}-backup`, 'recipient.txt')).catch(() => null);
  check(
    '(E) the surviving BACKUP IDENTITY is non-empty age identity material',
    !!backupIdentityBytes &&
      backupIdentityBytes.length > 0 &&
      backupIdentityBytes.toString('utf8').includes('AGE-SECRET-KEY'),
  );
  check(
    '(E) the surviving BACKUP RECIPIENT is non-empty and looks like an age recipient',
    !!backupRecipientBytes && backupRecipientBytes.toString('utf8').trim().startsWith('age1'),
  );

  await rm(ROOT_TMP, { recursive: true, force: true }).catch(() => {});

  console.log();
  if (failed > 0) {
    console.log(`INIT KEYGEN --FORCE RACE SELFTEST: ${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log('INIT KEYGEN --FORCE RACE SELFTEST PASS');
} else {
  // ── Child: run exactly ONE scenario in this fresh process/module graph ────────────
  const { mock } = await import('node:test');
  const real = await import('node:fs/promises');

  const scenario = process.env.CB_RACE_SCENARIO;
  const home = process.env.CB_RACE_HOME;
  process.env.CYPHER_BRAIN_HOME = home;
  process.env.CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE = '1';

  let failed = 0;
  const check = (name, cond, detail) => {
    if (cond) {
      console.log(`[PASS] ${name}`);
    } else {
      failed++;
      console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  if (scenario === 'D') {
    // ── Scenario D: a stray/dangling symlink at IDENTITY, no race choreography needed ──
    const identityPath = join(home, 'identity.age');
    const recipientPath = join(home, 'recipient.txt');
    await real.mkdir(home, { recursive: true });
    // Dangling on purpose (target never created) — exists()/access() FOLLOWS a symlink
    // and reports a dangling one as absent, which is exactly what lets this run's own
    // top-of-init() `exists(IDENTITY)` refusal pass through without seeing it.
    await real.symlink('/nonexistent-dangling-symlink-target-for-selftest', identityPath);

    const wizard = await import(new URL('../src/lib/wizard.ts', import.meta.url).href);
    let thrown = null;
    try {
      await wizard.init({ dirs: [], tables: [], recipients: [] });
    } catch (e) {
      thrown = e;
    }

    check('(D): init() throws', thrown !== null);
    check(
      '(D): does NOT misreport a stray symlink as a winning concurrent process',
      thrown !== null && !/just won a race/i.test(String(thrown?.message)),
      thrown ? String(thrown.message) : '(no error thrown)',
    );
    check(
      '(D): the thrown error still surfaces the colliding path honestly (a real EEXIST, not a fabricated race story)',
      thrown !== null && String(thrown?.message).includes(identityPath),
      thrown ? String(thrown.message) : '(no error thrown)',
    );
    const identityLstat = await real.lstat(identityPath).catch(() => null);
    check(
      '(D): the stray symlink at IDENTITY is cleaned up — does not permanently block every future init',
      identityLstat === null,
    );
    const recipientBytes = await real.readFile(recipientPath).catch(() => null);
    check(
      "(D): RECIPIENT (this run's own, orphaned once the symlink collision failed) is cleaned up too",
      recipientBytes === null,
    );
    process.exit(failed > 0 ? 1 : 0);
  }

  // ── Scenarios A/B/C/E: an EEXIST race, choreographed via a single intercepted open() ──
  const variant = scenario === 'C' ? 'signing' : scenario === 'E' ? 'backup' : 'primary';
  const backupHome = `${home}-backup`; // wizard.ts's own default: `${HOME}-backup`
  const identityPath = join(
    variant === 'signing' ? home : variant === 'backup' ? backupHome : home,
    variant === 'signing' ? 'sign-identity.key' : 'identity.age',
  );
  const recipientPath = join(
    variant === 'signing' ? home : variant === 'backup' ? backupHome : home,
    variant === 'signing' ? 'sign-recipient.pub' : 'recipient.txt',
  );
  // Scenario A arms on THIS run's own RECIPIENT write (the original #720/#849 shape —
  // the concurrent writer is a PLAIN keygen(), force:false). Scenarios B/C/E arm on THIS
  // run's own IDENTITY-equivalent write (the NEW shape — the concurrent writer is
  // `keygen --force` / `keygen --sign --force`, or another `keygen --force` pointed at
  // the same backup home).
  const armPath = scenario === 'A' ? recipientPath : identityPath;
  const concurrentForce = scenario !== 'A';

  let fired = false;
  const opensSeen = [];
  mock.module('node:fs/promises', {
    namedExports: {
      ...real,
      open: async (path, flags, mode) => {
        const p = String(path);
        opensSeen.push({ path: p, flags });
        if (!fired && p === armPath && flags === 'wx') {
          fired = true;
          // The "concurrent" writer — the REAL keygenAt()/keygenSignAt() (keys.ts/
          // minisign.ts), run to completion right here, in the gap between this run's
          // own prior write and this exact write, using the REAL production code for
          // every byte it writes. The backup variant uses keygenAt() too — a backup
          // keypair is just a primary-shaped keypair generated at a different home.
          if (variant === 'signing') {
            const minisignMod = await import(new URL('../src/lib/minisign.ts', import.meta.url).href);
            await minisignMod.keygenSignAt({ home, identityPath, recipientPath, force: concurrentForce });
          } else {
            const keysMod = await import(new URL('../src/lib/keys.ts', import.meta.url).href);
            const keygenHome = variant === 'backup' ? backupHome : home;
            await keysMod.keygenAt({ home: keygenHome, identityPath, recipientPath, force: concurrentForce });
          }
        }
        return real.open(path, flags, mode);
      },
    },
  });

  if (variant === 'signing' || variant === 'backup') {
    // Scenario C needs to answer TWO prompts (no signing keygen without them): "Generate
    // an offline backup keypair now?" -> no, then "Generate a signing keypair now?" ->
    // yes — the race fires during that immediately-following keygenSignAt() call, before
    // any select()/text() prompt is ever reached. Scenario E needs ONE confirm
    // ("Generate an offline backup keypair now?" -> yes) plus ONE text answer (the
    // backup path prompt) — an empty string accepts askLine's own default
    // (`${HOME}-backup`, matching backupHome above), so this test never has to
    // hand-compute the wizard's own default-path formula a second time.
    const clackReal = await import('@clack/prompts');
    const confirmAnswers = variant === 'signing' ? [false, true] : [true];
    const textAnswers = variant === 'backup' ? [''] : [];
    mock.module('@clack/prompts', {
      namedExports: {
        isCancel: clackReal.isCancel,
        settings: clackReal.settings,
        updateSettings: clackReal.updateSettings,
        confirm: async () => {
          if (confirmAnswers.length === 0) throw new Error('test setup: confirm() called more times than scripted');
          return confirmAnswers.shift();
        },
        select: async () => {
          throw new Error('test setup: select() should never be reached before the keygen race fires');
        },
        text: async () => {
          if (textAnswers.length === 0) throw new Error('test setup: text() called more times than scripted');
          return textAnswers.shift();
        },
      },
    });
  }

  const wizard = await import(new URL('../src/lib/wizard.ts', import.meta.url).href);
  let thrown = null;
  try {
    await wizard.init({ dirs: [], tables: [], recipients: [] });
  } catch (e) {
    thrown = e;
  }

  const raceMessage =
    variant === 'signing'
      ? /just won a race to create the signing identity/i
      : variant === 'backup'
        ? /just won a race to create the backup identity/i
        : /just won a race to create the identity/i;
  const label = variant === 'signing' ? 'SIGNING' : variant === 'backup' ? 'BACKUP' : '';
  check(`(${scenario}): this run's own init() throws`, thrown !== null);
  check(
    `(${scenario}): the thrown error says another process won the race (backs off, does not misreport an ordinary failure)`,
    thrown !== null && raceMessage.test(String(thrown?.message)),
    thrown ? String(thrown.message) : '(no error thrown)',
  );
  check(`(${scenario}): the concurrent writer actually ran (race fired)`, fired, JSON.stringify(opensSeen));

  const identityBytes = await real.readFile(identityPath).catch(() => null);
  const recipientBytes = await real.readFile(recipientPath).catch(() => null);
  check(
    `(${scenario}): ${label ? `${label} IDENTITY` : 'IDENTITY'} (the concurrent winner's) survives — not deleted by this run's rollback`,
    identityBytes !== null,
  );
  check(
    `(${scenario}): ${label ? `${label} RECIPIENT` : 'RECIPIENT'} (the concurrent winner's) survives — not deleted by this run's rollback`,
    recipientBytes !== null,
  );

  if (variant === 'signing' || variant === 'backup') {
    // Distinguishes "back off from touching the WINNER's files" (checked above) from
    // "still correctly roll back what THIS run itself created" — this run's own step-1
    // primary identity/recipient must NOT survive: nothing was ever pushed, so the outer
    // catch's ordinary rollback for "this run's own artifacts" still applies in full.
    const primaryIdentityBytes = await real.readFile(join(home, 'identity.age')).catch(() => null);
    const primaryRecipientBytes = await real.readFile(join(home, 'recipient.txt')).catch(() => null);
    check(
      `(${scenario}): this run's OWN primary identity (step 1) is correctly rolled back — nothing was ever pushed`,
      primaryIdentityBytes === null,
    );
    check(
      `(${scenario}): this run's OWN primary recipient (step 1) is correctly rolled back`,
      primaryRecipientBytes === null,
    );
  }

  process.exit(failed > 0 ? 1 : 0);
}
