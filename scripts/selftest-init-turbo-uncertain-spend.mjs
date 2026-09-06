#!/usr/bin/env node
// Regression proof for a Codex whole-session accumulated-diff review (elevated-caution
// key-handling cluster; relates to PRs #846/#869): `init`'s own push()-catch (src/lib/
// wizard.ts, the `try { await push(pushOpts) } catch (pushErr)` block near step 7/7)
// recognized ONLY `PushPartialSuccessError` as "the ciphertext upload itself already
// durably succeeded — preserve keys/snapshot, do not roll back". `src/lib/backends/
// turbo.ts` (PR #869, "distinguish receipt-callback failure from upload failure") can
// now throw `PushUncertainSpendError` instead, for a signed init whose ".minisig"
// SIDECAR upload comes back ambiguous AFTER the ciphertext's own upload already
// succeeded — `src/lib/pushpull.ts`'s own ".minisig" catch re-throws exactly that shape
// via `e.withConfirmedCiphertextLocator(locator)` (see push-uncertain-spend.ts's own doc
// comment on that field). Since `PushUncertainSpendError` is deliberately NOT a
// `PushPartialSuccessError` subclass (same doc comment — it also covers the genuinely-
// unconfirmed case, which carries no locator at all), the pre-fix catch missed the
// CONFIRMED-locator shape entirely and fell through to the unconditional rollback,
// deleting IDENTITY/RECIPIENT/the signing keypair even though the remote ciphertext is
// durably uploaded, paid for, and now unrecoverable without them.
//
// Reaching this exact shape through the REAL wizard.ts `init()` needs: (a) a signing
// keypair (so a ".minisig" sidecar exists for push() to even attempt), (b) a PAID
// backend (turbo), and (c) the backend's own network-dependent sidecar upload actually
// landing in the ambiguous state turbo.ts's own `uncertainTurboSpend()` produces — none
// of which is reachable offline/deterministically without a live, funded Turbo wallet.
// Same lever as scripts/selftest-init-keygen-force-race.mjs: Node's `node:test` module
// mocking intercepts (1) `@clack/prompts`' `text`/`confirm`/`select` with a canned
// answer queue (mirrors the QA-JSON-driven scripts/drive-init.mjs scenarios in
// scripts/selftest-init.sh, but in-process — no pty, no real prompt timing to race) and
// (2) `./pushpull.js` (as wizard.ts imports it) so its `push` throws a REAL, hand-built
// `PushUncertainSpendError` — constructed via ITS OWN real `withConfirmedCiphertextLocator()`
// method (push-uncertain-spend.ts), the exact same call pushpull.ts's own ".minisig" catch
// makes — while `PushPartialSuccessError`/`PushUncertainSpendError` themselves stay the
// REAL classes (re-exported unchanged), so wizard.ts's `instanceof` checks are exercised
// genuinely, not against a stand-in. Only the network transport is faked; every byte of
// classification/rollback logic under test is the real, unmodified `wizard.ts`.
//
// Three scenarios, all against the REAL `wizard.ts` `init()`:
//   (confirmed)   PushUncertainSpendError WITH confirmedCiphertextLocator (the ciphertext
//                 durably uploaded; only the .minisig sidecar's own spend is ambiguous) —
//                 must PRESERVE identity/recipient/signing keypair/snapshot, and the
//                 thrown error must carry ACTION REQUIRED + the confirmed locator.
//   (unconfirmed) PushUncertainSpendError with NO confirmedCiphertextLocator (the
//                 ciphertext's own upload — not just the sidecar's — is what went
//                 ambiguous). A second-round Codex regression review of the FIRST version
//                 of this fix (which treated this shape identically to any other ordinary
//                 push() failure, i.e. rolled back) flagged that as still unsafe:
//                 PushUncertainSpendError's own doc comment (push-uncertain-spend.ts) is
//                 explicit that "absence of an observation is NOT proof of absence" — an
//                 UNCONFIRMED "maybe uploaded and paid for" is not a confirmed "definitely
//                 did not happen", and deleting the only keys able to ever decrypt an
//                 upload that DID land would be strictly worse than leaving an identity
//                 behind pending manual verification. So this ALSO now preserves
//                 everything — but with an honestly-worded message that never claims
//                 success (no "ACTION REQUIRED: record this locator", since there is no
//                 confirmed locator to record) and instead tells the operator to verify
//                 the outcome via PushUncertainSpendError's own checkIdentifier before
//                 deciding whether to retry or build a recovery kit by hand.
//   (unconfirmed-reused-signing) same shape as (unconfirmed), but the signing keypair
//                 pre-exists (a previous `keygen --sign` run, or an earlier `init`) and
//                 this run only REUSED it (`signingGeneratedThisRun` stays false) rather
//                 than generating it. The SAME 2nd-round review flagged that the
//                 "unconfirmed" branch's own "if nothing happened, remove these
//                 yourself" advice must NEVER list a reused signing keypair — other
//                 backups may still depend on it — the same protection the ordinary
//                 rollback path already gives it. Asserts the advice list omits it, an
//                 explicit "intentionally NOT included" note explains why, and the file
//                 itself is untouched regardless (nothing in this run's own flow ever
//                 had a reason to delete a keypair it did not create).
//
// Red/green for each shape against the pre-fix source is verified separately (git stash
// the wizard.ts fix, observe this file FAIL, git stash pop, observe it PASS) rather than
// embedded here as a second reimplementation.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SELF), '..');
const CONFIRMED_LOCATOR = 'turbo-data-item-id-0123456789abcdef0123456789abcdef01234567';

if (!process.env.CB_UNCERTAIN_SCENARIO) {
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

  const ROOT_TMP = await mkdtemp(join(tmpdir(), 'cb-init-uncertain-'));

  async function runScenario(scenario, label) {
    console.log(`== ${label} ==`);
    const cbHome = join(ROOT_TMP, `cb-home-${scenario}`);
    const osHome = join(ROOT_TMP, `os-home-${scenario}`);
    const src = join(ROOT_TMP, `src-${scenario}`);
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'note.txt'), 'push-uncertain-rollback-selftest\n');
    const walletPath = join(ROOT_TMP, `wallet-${scenario}.json`);
    // Contents never actually read — push() itself is mocked below, so nothing ever
    // loads this JWK — walletConfigured() (wallet.ts) only checks the path EXISTS.
    await writeFile(walletPath, JSON.stringify({ kty: 'RSA', n: 'fake', e: 'AQAB' }));

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
        env: {
          ...process.env,
          CB_UNCERTAIN_SCENARIO: scenario,
          CB_UNCERTAIN_CB_HOME: cbHome,
          CB_UNCERTAIN_OS_HOME: osHome,
          CB_UNCERTAIN_SRC: src,
          CB_UNCERTAIN_WALLET: walletPath,
        },
        encoding: 'utf8',
      },
    );
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    check(`${label}: child process exits 0 (every check inside it passed)`, r.status === 0, `exit=${r.status}`);
    return cbHome;
  }

  await runScenario(
    'confirmed',
    '(confirmed) turbo .minisig sidecar throws PushUncertainSpendError WITH confirmedCiphertextLocator — must PRESERVE keys/snapshot',
  );
  await runScenario(
    'unconfirmed',
    "(unconfirmed) turbo's own ciphertext upload throws PushUncertainSpendError with NO confirmedCiphertextLocator — must ALSO preserve keys/snapshot (an unconfirmed maybe is not a confirmed no)",
  );
  await runScenario(
    'unconfirmed-reused-signing',
    "(unconfirmed-reused-signing) same as (unconfirmed), but the signing keypair pre-existed and was only REUSED — the 'remove these yourself' advice must exclude it (other backups may depend on it)",
  );

  await rm(ROOT_TMP, { recursive: true, force: true }).catch(() => {});

  console.log();
  if (failed > 0) {
    console.log(`INIT TURBO UNCERTAIN-SPEND SELFTEST: ${failed} check(s) FAILED`);
    process.exit(1);
  }
  console.log('INIT TURBO UNCERTAIN-SPEND SELFTEST PASS');
} else {
  // ── Child: run exactly ONE scenario in this fresh process/module graph ────────────
  const { mock } = await import('node:test');

  const scenario = process.env.CB_UNCERTAIN_SCENARIO;
  const cbHome = process.env.CB_UNCERTAIN_CB_HOME;
  const osHome = process.env.CB_UNCERTAIN_OS_HOME;
  const src = process.env.CB_UNCERTAIN_SRC;
  const wallet = process.env.CB_UNCERTAIN_WALLET;
  await mkdir(osHome, { recursive: true });

  process.env.CYPHER_BRAIN_HOME = cbHome;
  process.env.HOME = osHome; // keep resolveGbrainConfigPath() off this machine's REAL ~/.gbrain
  process.env.CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE = '1';
  process.env.CYPHER_BRAIN_AR_WALLET = wallet;
  process.env.CYPHER_BRAIN_AR_HTTP_TIMEOUT = '200'; // bound estimateCost()'s (unauthenticated, offline-tolerant) Turbo pricing query

  const reusedSigning = scenario === 'unconfirmed-reused-signing';
  if (reusedSigning) {
    // Pre-create a REAL, matching signing keypair BEFORE init() ever runs — step 3
    // (wizard.ts) auto-detects both files present, verifies they match
    // (signingKeypairMatches), and REUSES them silently (no confirm() prompt at all —
    // see wizard.ts's own "if ((await exists(SIGN_IDENTITY)) && (await
    // exists(SIGN_RECIPIENT)))" branch), leaving `signingGeneratedThisRun` false.
    const minisignMod = await import(new URL('../src/lib/minisign.ts', import.meta.url).href);
    await minisignMod.keygenSignAt({
      home: cbHome,
      identityPath: join(cbHome, 'sign-identity.key'),
      recipientPath: join(cbHome, 'sign-recipient.pub'),
    });
  }

  // ---- mock 1: @clack/prompts — a sequential, per-function answer queue -------------
  const clackReal = await import('@clack/prompts');
  const confirmAnswers = reusedSigning
    ? [
        false, // 'Generate an offline backup keypair now?'
        // no signing-keypair confirm() at all — the pre-created pair is auto-reused
        false, // 'Protect the primary identity with a passphrase now?'
        false, // 'Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line for config.env?'
        true, // the paid-backend "... spends real funds and cannot be undone. Proceed?" consent
      ]
    : [
        false, // 'Generate an offline backup keypair now?'
        true, // 'Generate a signing keypair now?' — REQUIRED: this is what produces the ".minisig" sidecar push()'s catch classifies
        false, // 'Protect the primary identity with a passphrase now?'
        false, // 'Show a suggested CYPHER_BRAIN_PIN_RECIPIENTS line for config.env?'
        true, // the paid-backend "... spends real funds and cannot be undone. Proceed?" consent
      ];
  const selectAnswers = [
    'none', // 'Profile (what to back up)'
    'turbo', // 'Choose a backend'
  ];
  const textAnswers = [
    src, // 'Directory path(s) to back up, comma-separated (at least one, required)'
  ];
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
        if (selectAnswers.length === 0) throw new Error('test setup: select() called more times than scripted');
        return selectAnswers.shift();
      },
      text: async () => {
        if (textAnswers.length === 0) throw new Error('test setup: text() called more times than scripted');
        return textAnswers.shift();
      },
    },
  });

  // ---- mock 2: ./pushpull.js (as wizard.ts AND recoverykit.ts import it) — push()
  //      throws a REAL, hand-built PushUncertainSpendError. Every OTHER real export
  //      (PushPartialSuccessError/PushUncertainSpendError themselves — so wizard.ts's
  //      `instanceof` checks are genuine — plus promoteNoClobber/pull/etc., which
  //      recoverykit.ts also imports from this same module) is re-exported UNCHANGED,
  //      spread from the real module first, so only `push` itself is actually replaced.
  const realPushpull = await import(new URL('../src/lib/pushpull.ts', import.meta.url).href);
  const { PushUncertainSpendError } = realPushpull;
  mock.module(new URL('../src/lib/pushpull.ts', import.meta.url).href, {
    namedExports: {
      ...realPushpull,
      push: async () => {
        const uncertain = new PushUncertainSpendError({
          backend: 'turbo',
          checkKind: 'turbo_wallet_address',
          checkIdentifier: '0xfaketurbowalletaddress',
          detail: 'the ".minisig" sidecar upload response was lost',
          verifyHint: 'cypher-brain wallet balance --address 0xfaketurbowalletaddress',
        });
        // (confirmed): the SAME real method pushpull.ts's own ".minisig" catch calls
        // (pushpull.ts: `if (e instanceof PushUncertainSpendError) throw
        // e.withConfirmedCiphertextLocator(locator);`) — proves this test's crafted
        // error is shaped exactly like the real one, not merely instanceof-compatible.
        if (scenario === 'confirmed') throw uncertain.withConfirmedCiphertextLocator(CONFIRMED_LOCATOR);
        throw uncertain; // (unconfirmed): no confirmedCiphertextLocator at all
      },
    },
  });

  let failed = 0;
  const check = (name, cond, detail) => {
    if (cond) {
      console.log(`[PASS] ${name}`);
    } else {
      failed++;
      console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
    }
  };

  const wizard = await import(new URL('../src/lib/wizard.ts', import.meta.url).href);
  let thrown = null;
  try {
    await wizard.init({ dirs: [], tables: [], recipients: [] });
  } catch (e) {
    thrown = e;
  }

  check(`(${scenario}): init() throws (a PushUncertainSpendError is never a silent success)`, thrown !== null);

  const identityPath = join(cbHome, 'identity.age');
  const recipientPath = join(cbHome, 'recipient.txt');
  const signIdentityPath = join(cbHome, 'sign-identity.key');
  const signRecipientPath = join(cbHome, 'sign-recipient.pub');
  const real = await import('node:fs/promises');
  const identityBytes = await real.readFile(identityPath).catch(() => null);
  const recipientBytes = await real.readFile(recipientPath).catch(() => null);
  const signIdentityBytes = await real.readFile(signIdentityPath).catch(() => null);
  const signRecipientBytes = await real.readFile(signRecipientPath).catch(() => null);

  // Suggestion (2nd-round Codex regression review): the preserve branches claim the
  // SNAPSHOT survives too, not just the keys — assert that explicitly, for every
  // scenario, instead of only checking the key files. Same local-calendar-day
  // computation wizard.ts's own localDateStamp() uses (step 7's dated --out).
  const now = new Date();
  const dateStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const snapshotPath = join(cbHome, `brain-${dateStamp}.age`);
  const snapshotBytes = await real.readFile(snapshotPath).catch(() => null);
  const snapshotDigestBytes = await real.readFile(`${snapshotPath}.digest`).catch(() => null);
  const snapshotFingerprintBytes = await real.readFile(`${snapshotPath}.recipients-fingerprint`).catch(() => null);
  const snapshotMinisigBytes = await real.readFile(`${snapshotPath}.minisig`).catch(() => null);
  check(
    `(${scenario}): the SNAPSHOT ciphertext survives — not rolled back`,
    !!snapshotBytes && snapshotBytes.length > 0,
  );
  check(
    `(${scenario}): the snapshot's .digest sidecar survives`,
    !!snapshotDigestBytes && snapshotDigestBytes.length > 0,
  );
  check(
    `(${scenario}): the snapshot's .recipients-fingerprint sidecar survives`,
    !!snapshotFingerprintBytes && snapshotFingerprintBytes.length > 0,
  );
  check(
    `(${scenario}): the snapshot's .minisig sidecar survives (this is a SIGNED push)`,
    !!snapshotMinisigBytes && snapshotMinisigBytes.length > 0,
  );

  if (scenario === 'confirmed') {
    check(
      `(${scenario}): the thrown error says the upload already happened and must be hand-recorded (ACTION REQUIRED)`,
      thrown !== null && /ACTION REQUIRED/.test(String(thrown.message)),
      thrown ? String(thrown.message) : '(no error)',
    );
    check(
      `(${scenario}): the thrown error names the CONFIRMED ciphertext locator`,
      thrown !== null && String(thrown.message).includes(CONFIRMED_LOCATOR),
      thrown ? String(thrown.message) : '(no error)',
    );
    check(`(${scenario}): PRIMARY IDENTITY survives — not rolled back`, identityBytes !== null);
    check(`(${scenario}): PRIMARY RECIPIENT survives — not rolled back`, recipientBytes !== null);
    check(`(${scenario}): SIGNING IDENTITY survives — not rolled back`, signIdentityBytes !== null);
    check(`(${scenario}): SIGNING RECIPIENT (public key) survives — not rolled back`, signRecipientBytes !== null);
  } else {
    check(
      `(${scenario}): the thrown error says the outcome is UNCERTAIN and preserves files (never claims success)`,
      thrown !== null &&
        /UNCERTAIN/.test(String(thrown.message)) &&
        /PRESERVED/.test(String(thrown.message)) &&
        !/already happened and cannot be undone/.test(String(thrown.message)),
      thrown ? String(thrown.message) : '(no error)',
    );
    check(
      `(${scenario}): the thrown error does NOT claim a confirmed locator to hand-record (nothing is actually confirmed)`,
      thrown !== null && !/ACTION REQUIRED: the upload already happened/.test(String(thrown.message)),
      thrown ? String(thrown.message) : '(no error)',
    );
    check(
      `(${scenario}): PRIMARY IDENTITY survives — an unconfirmed spend must NOT be treated as a confirmed failure`,
      identityBytes !== null,
    );
    check(`(${scenario}): PRIMARY RECIPIENT survives`, recipientBytes !== null);
    check(`(${scenario}): SIGNING IDENTITY survives`, signIdentityBytes !== null);
    check(`(${scenario}): SIGNING RECIPIENT survives`, signRecipientBytes !== null);

    // 3rd-round Codex regression review, Warning: the "remove these yourself" advice
    // must name the snapshot's OWN sidecars too, not just the main ciphertext file —
    // omitting them left a stale .digest/.recipients-fingerprint/.minisig behind after
    // following the advice literally (rm the listed files, then re-run), which
    // snapshot()'s own no-clobber check on those leftover sidecars would then refuse
    // on a same-day retry.
    const msgForSidecars = thrown ? String(thrown.message) : '';
    check(
      `(${scenario}): the "remove these yourself" advice also names the snapshot's .digest sidecar`,
      msgForSidecars.includes(`${snapshotPath}.digest`),
      msgForSidecars,
    );
    check(
      `(${scenario}): the "remove these yourself" advice also names the snapshot's .recipients-fingerprint sidecar`,
      msgForSidecars.includes(`${snapshotPath}.recipients-fingerprint`),
      msgForSidecars,
    );
    check(
      `(${scenario}): the "remove these yourself" advice also names the snapshot's .minisig sidecar`,
      msgForSidecars.includes(`${snapshotPath}.minisig`),
      msgForSidecars,
    );

    if (reusedSigning) {
      // Warning (2nd-round Codex regression review): a signing keypair this run only
      // REUSED must never be suggested for removal in the "if nothing happened, remove
      // these yourself" advice — other backups may still depend on it. The file itself
      // is untouched regardless (nothing in this run's flow had a reason to delete a
      // keypair it did not create), but the ADVICE TEXT is what the earlier version of
      // this fix got wrong (it listed everything in `preservedList()`, signing keypair
      // included, with no distinction for reuse).
      const msg = thrown ? String(thrown.message) : '';
      // The actual REMOVAL list sits between "yourself<note>: " and " — then re-run" —
      // NOT simply "anywhere after the word 'remove'": the note explaining the
      // exclusion (which correctly NAMES the excluded path so the operator knows what
      // was left out and why) sits in that same sentence, so a bare "remove...path"
      // substring search would wrongly flag the correct, explanatory mention as if it
      // were a removal instruction.
      const removalListMatch = msg.match(/yourself[\s\S]*?:\s*([\s\S]*?)\s+—\s+then re-run/);
      check(
        `(${scenario}): the "remove these yourself" sentence has the expected shape (test setup sanity)`,
        !!removalListMatch,
        msg,
      );
      const removalList = removalListMatch ? removalListMatch[1] : '';
      check(
        `(${scenario}): the actual "remove these yourself" LIST does NOT include the reused signing keypair`,
        !removalList.includes(signIdentityPath) && !removalList.includes(signRecipientPath),
        removalList,
      );
      check(
        `(${scenario}): the message explicitly explains why the reused signing keypair is excluded`,
        /intentionally NOT included/.test(msg) && /other backups may still depend on it/.test(msg),
        msg,
      );
      check(
        `(${scenario}): the reused signing keypair is still named in the PRESERVED list (it must not be deleted either)`,
        msg.includes('PRESERVED') && msg.includes(signIdentityPath),
        msg,
      );
    }
  }

  process.exit(failed > 0 ? 1 : 0);
}
