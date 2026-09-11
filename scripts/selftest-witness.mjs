#!/usr/bin/env node
// Offline integration + isolated security controls. Run `node ... signature` or
// `node ... fork` to prove each check independently under a temporary source mutation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const self = fileURLToPath(import.meta.url);
const root = join(dirname(self), '..');
const scenarios = [
  'chain',
  'signature',
  'fork',
  'fork-with-poisoned-hint',
  'fork-replay-substitution',
  'gap',
  'freshness',
  'unavailable',
  'hash-link',
  'wrong-key',
  'hint-forgery',
  'missing-identity',
  'exit-codes',
  'integration',
  'doctor',
  'kit',
  'caps-green',
  'caps-run',
  'caps-signature',
  'caps-uncertain',
  'caps-daily',
  'caps-monthly',
  'mcp',
];
if (!process.env.CB_WITNESS_SCENARIO) {
  const selected = process.argv[2] ? [process.argv[2]] : scenarios;
  assert.ok(selected.every((s) => scenarios.includes(s)));
  const scratch = await mkdtemp(join(tmpdir(), 'cb-witness-test-'));
  let passed = 0;
  let failed = 0;
  try {
    for (const scenario of selected) {
      const home = join(scratch, scenario);
      await mkdir(home);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !/^(CYPHER_BRAIN_|CIPHER_BRAIN_|OTEL_)/.test(k)),
      );
      Object.assign(env, {
        CB_WITNESS_SCENARIO: scenario,
        CYPHER_BRAIN_HOME: home,
        CYPHER_BRAIN_FILE_DIR: join(home, 'store'),
        CYPHER_BRAIN_NO_CONFIG_FILE: '1',
        CYPHER_BRAIN_NO_MASCOT: '1',
        GBRAIN_HOME: join(home, 'gbrain'),
        CYPHER_BRAIN_SCHEDULE_DIR: join(home, 'schedule'),
      });
      if (scenario.startsWith('caps-'))
        Object.assign(env, {
          CYPHER_BRAIN_MAX_SPEND: scenario === 'caps-run' ? '25' : scenario === 'caps-signature' ? '35' : '100',
          CYPHER_BRAIN_MAX_SPEND_DAILY: scenario === 'caps-daily' ? '105' : '1000',
          CYPHER_BRAIN_MAX_SPEND_MONTHLY: scenario === 'caps-monthly' ? '105' : '1000',
        });
      const r = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--experimental-test-module-mocks',
          '--import',
          join(root, 'scripts/dev-cli-loader.mjs'),
          self,
        ],
        { env, encoding: 'utf8', timeout: 60000 },
      );
      if (r.status === 0) {
        passed++;
        console.log(`[PASS] ${scenario}`);
      } else {
        failed++;
        console.log(`[FAIL] ${scenario}\n${r.stdout}${r.stderr}\n${r.error ?? ''}`);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  console.log(`WITNESS SELFTEST: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
} else {
  const scenario = process.env.CB_WITNESS_SCENARIO;
  const home = process.env.CYPHER_BRAIN_HOME;
  // Any accidentally introduced fetch fails the test, rather than contacting a service.
  globalThis.fetch = () => {
    throw new Error('selftest forbids network');
  };
  const w = await import('../src/lib/witness.ts');
  const mini = await import('../src/lib/minisign.ts');
  const { fileBackend } = await import('../src/lib/backends/file.ts');
  const store = fileBackend();
  const key = mini.generateSignKeypair();
  const trusted = { keyId: key.keyId, publicKey: key.publicKey };
  const options = { trustedKey: trusted, trustedFingerprint: key.keyId.toString('hex'), toSequence: 0 };
  const fields = {
    backend: 'file',
    locator: 'snapshot-locator',
    sig_locator: null,
    snapshot_sha256: 'a'.repeat(64),
    signing_key_fingerprint: key.keyId.toString('hex'),
  };
  const cli = (args, env = {}) => {
    const r = spawnSync(process.execPath, [join(root, 'dist/cli.mjs'), ...args], {
      env: { ...process.env, ...env },
      encoding: 'utf8',
      timeout: 20000,
    });
    assert.ifError(r.error);
    return { ...r, output: r.stdout + r.stderr };
  };
  const ok = (r) => {
    assert.equal(r.status, 0, r.output);
    return r;
  };
  const input = join(home, 'input.age');
  await writeFile(input, 'age-encryption.org/v1\nfixture ciphertext\n');
  const makeSigningIdentity = async () => {
    await mini.keygenSignAt({
      home,
      identityPath: join(home, 'sign-identity.key'),
      recipientPath: join(home, 'sign-recipient.pub'),
    });
    return mini.loadSignIdentity(join(home, 'sign-identity.key'));
  };
  const chain = async () => {
    const entries = [],
      hints = [];
    for (let i = 0; i < 3; i++) {
      const entry = await w.buildWitnessEntry({ ...fields, locator: `snapshot-${i}` });
      entries.push(entry);
      hints.push(await w.publishWitnessEntry(entry, key, store));
    }
    assert.equal(
      (await w.verifyWitnessChain(store, { ...options, locator: hints[2].entry_locator })).outcome,
      'confirmed',
      'positive control: intact 3-entry chain',
    );
    return { entries, hints };
  };
  if (
    [
      'chain',
      'signature',
      'fork',
      'fork-with-poisoned-hint',
      'fork-replay-substitution',
      'gap',
      'freshness',
      'unavailable',
      'hash-link',
      'wrong-key',
      'hint-forgery',
    ].includes(scenario)
  ) {
    const { entries, hints } = await chain();
    let locator = hints[2].entry_locator;
    if (scenario === 'chain') {
      assert.deepEqual(
        hints.map((h) => h.sequence),
        [0, 1, 2],
      );
      assert.equal(entries[2].prev_entry_hash, w.witnessEntryHash(entries[1]));
      assert.equal(
        w.canonicalWitnessJson(Object.fromEntries(Object.entries(entries[2]).reverse())),
        w.canonicalWitnessJson(entries[2]),
      );
      assert.equal((await w.verifyWitnessChain(store, { ...options, locator })).checked, 3);
    } else if (scenario === 'signature') {
      // Re-address the tampered newest entry through the REAL file backend. Its own
      // content-hash gate then passes: only the witness signature can reject this.
      const tampered = { ...entries[2], locator: 'attacker-replacement' };
      const path = join(home, 'tampered.json');
      await writeFile(path, w.canonicalWitnessJson(tampered));
      locator = await store.put(path);
      const replacements = [
        ...hints.slice(0, 2),
        { ...hints[2], entry_locator: locator, entry_hash: w.witnessEntryHash(tampered) },
      ];
      await writeFile(w.WITNESS_HINT_FILE, `${replacements.map((h) => JSON.stringify(h)).join('\n')}\n`);
      await assert.rejects(
        async () => {
          const result = await w.verifyWitnessChain(store, { ...options, locator });
          console.error(`Tampered chain unexpectedly returned: ${result.outcome}`);
        },
        /signature verification failed/,
        'tampered chain must not report confirmed',
      );
    } else if (scenario === 'fork') {
      const fork = { ...entries[2], locator: 'different-snapshot-same-sequence' };
      await w.publishWitnessEntry(fork, key, store);
      const r = await w.verifyWitnessChain(store, { ...options, locator });
      assert.equal(r.outcome, 'conflicting', 'forked chain must not report confirmed');
      assert.equal(r.conflicts.sequence, 2);
      assert.equal(r.conflicts.locators.length, 2);
      assert.equal((await w.readWitnessHints()).bySequence.get(2).length, 2);
    } else if (scenario === 'fork-with-poisoned-hint') {
      // Codex review regression: one hint that fails signature verification must
      // not abort the whole walk before the OTHER, genuinely forked entries are
      // grouped and reported. Mixes a real fork with an unrelated poisoned hint
      // (content exists, but its signature does not match it) in the same run.
      const fork = { ...entries[2], locator: 'different-snapshot-same-sequence' };
      await w.publishWitnessEntry(fork, key, store);
      const poisonPath = join(home, 'poison.json');
      await writeFile(poisonPath, w.canonicalWitnessJson({ ...entries[0], sequence: 5 }));
      const poisonLocator = await store.put(poisonPath);
      // Sign a DIFFERENT file's bytes so verifyDetached rejects this pairing —
      // the poisoned entry object exists (not `unavailable`), only its
      // signature is wrong (`invalid`).
      const wrongSigPath = join(home, 'poison-wrongsig.minisig');
      await writeFile(wrongSigPath, await mini.signDetached(key.privateKey, key.keyId, input));
      const poisonSigLocator = await store.put(wrongSigPath);
      await w.appendWitnessHint({
        sequence: 5,
        entry_hash: 'c'.repeat(64),
        entry_locator: poisonLocator,
        sig_locator: poisonSigLocator,
      });
      const r = await w.verifyWitnessChain(store, { ...options, locator });
      assert.equal(r.outcome, 'conflicting', 'a poisoned hint must not suppress detection of a genuine fork');
      assert.equal(r.conflicts.sequence, 2);
      assert.equal(r.conflicts.locators.length, 2);
    } else if (scenario === 'fork-replay-substitution') {
      // #941: the actual reported vulnerability — a malicious/compromised backend never
      // forges a signature. It answers a request for a COMPETING fork's (F2) locator/
      // signature by instead returning a genuinely-signed, genuinely-valid EARLIER
      // entry's (E2) own bytes. Both entries are real and both signatures are real; only
      // the substitution — serving E2's bytes for a request that named F2's locator — is
      // malicious. Before the #941 fix, fetchEntry() authenticated whatever came back
      // with no check that it corresponded to the LOCATOR that was actually requested,
      // so the replayed E2 bytes were folded together with the honestly-fetched E2 entry
      // (same hash -> deduped, not grouped as a second candidate at sequence 2) and
      // verifyWitnessChain reported `confirmed` instead of surfacing the fork.
      const fork = { ...entries[2], locator: 'different-snapshot-same-sequence' };
      const forkHint = await w.publishWitnessEntry(fork, key, store);
      // Sanity check on the HONEST backend first (same shape as the plain `fork`
      // scenario above): isolates every assertion below to the REPLAYING backend's
      // substitution, not to some unrelated mistake in this scenario's own setup.
      const honest = await w.verifyWitnessChain(store, { ...options, locator });
      assert.equal(honest.outcome, 'conflicting', 'sanity: an honest backend must still report the real fork');
      // A backend that behaves honestly for every OTHER locator, but answers a request
      // for the fork's own entry/signature locator by serving entry 2's genuine
      // locator/signature bytes instead — exactly the issue's reported attack.
      const replayingBackend = {
        put: store.put,
        get: (loc, out, expect) => {
          if (loc === forkHint.entry_locator) return store.get(hints[2].entry_locator, out, expect);
          if (loc === forkHint.sig_locator) return store.get(hints[2].sig_locator, out, expect);
          return store.get(loc, out, expect);
        },
      };
      const r = await w.verifyWitnessChain(replayingBackend, { ...options, locator });
      assert.notEqual(
        r.outcome,
        'confirmed',
        `a backend that replays entry 2's bytes for the fork's locator must never be confirmed (got: ${JSON.stringify(r)})`,
      );
      // The substitution is caught per-candidate inside fetchEntry() (see witness.ts's
      // hashLocators comment), which forces the shared `incomplete` flag rather than
      // surfacing its own specific message through the generic freshness-unknown path —
      // same "an unverifiable candidate must never be silently dropped as if it had
      // simply been absent" contract fork-with-poisoned-hint already relies on for a
      // different invalid reason. `outcome` (asserted above) is the load-bearing check;
      // this just confirms it took the expected refusal path, not some other one.
      assert.equal(r.outcome, 'freshness-unknown');
      assert.match(r.reason, /could not be checked/, r.reason);
    } else if (scenario === 'gap') {
      await writeFile(w.WITNESS_HINT_FILE, `${JSON.stringify(hints[2])}\n`);
      assert.equal((await w.verifyWitnessChain(store, { ...options, locator })).outcome, 'freshness-unknown');
    } else if (scenario === 'freshness') {
      assert.equal(
        (await w.verifyWitnessChain(store, { ...options, toSequence: undefined, locator })).outcome,
        'freshness-unknown',
      );
      await rm(w.WITNESS_HINT_FILE);
      assert.equal(
        (await w.verifyWitnessChain(store, { ...options, locator, sigLocator: hints[2].sig_locator })).outcome,
        'freshness-unknown',
      );
      assert.equal(
        (
          await w.verifyWitnessChain(store, {
            ...options,
            toSequence: undefined,
            locator: hints[0].entry_locator,
            sigLocator: hints[0].sig_locator,
          })
        ).outcome,
        'freshness-unknown',
      );
    } else if (scenario === 'unavailable') {
      await rm(hints[1].sig_locator);
      assert.equal((await w.verifyWitnessChain(store, { ...options, locator })).outcome, 'freshness-unknown');
    } else if (scenario === 'hash-link') {
      await rm(w.WITNESS_HINT_FILE);
      for (const h of hints.slice(0, 2)) await w.appendWitnessHint(h);
      const bad = await w.publishWitnessEntry({ ...entries[2], prev_entry_hash: 'b'.repeat(64) }, key, store);
      await assert.rejects(
        w.verifyWitnessChain(store, { ...options, locator: bad.entry_locator }),
        /hash link mismatch/,
      );
    } else if (scenario === 'wrong-key') {
      const other = mini.generateSignKeypair();
      await assert.rejects(
        w.verifyWitnessChain(store, {
          ...options,
          locator,
          trustedKey: other,
          trustedFingerprint: other.keyId.toString('hex'),
        }),
        /signature verification failed/,
      );
    } else {
      // Fake cache hash/sequence metadata cannot itself constitute a signed fork.
      await w.appendWitnessHint({ ...hints[1], sequence: 2, entry_hash: 'f'.repeat(64) });
      assert.equal((await w.verifyWitnessChain(store, { ...options, locator })).outcome, 'confirmed');
    }
  } else if (scenario === 'missing-identity') {
    // #932: loadWitnessIdentity()'s two adjacent preconditions are both pure usage
    // mistakes ("you invoked this wrong", decidable from local flags/state alone,
    // no I/O needed to know it) and must produce the SAME exit-code class (2).
    const r = cli(['push', '--in', input, '--backend', 'file', '--witness']);
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /--witness requires a signing identity/);
    assert.deepEqual(await readdir(process.env.CYPHER_BRAIN_FILE_DIR).catch(() => []), []);
    const identity = await makeSigningIdentity();
    // The sibling precondition (unsupported --backend for --witness) — now signing
    // identity exists, so this exercises ONLY the second check.
    const badBackend = cli(['push', '--in', input, '--backend', 'rclone', '--remote', ':local:/never', '--witness']);
    assert.equal(badBackend.status, 2, badBackend.output);
    assert.match(badBackend.output, /--witness requires --backend arweave or turbo/);
    await writeFile(`${input}.minisig`, await mini.signDetached(identity.privateKey, identity.keyId, input));
    ok(cli(['push', '--in', input, '--backend', 'file', '--witness']));
  } else if (scenario === 'exit-codes') {
    // #930: a GENUINE authenticity/integrity failure (mismatched --sig-locator or
    // --pubkey) must exit with a distinct code from the benign freshness-unknown
    // OUTCOME — both used to exit 1, indistinguishable to a script gating on $?
    // alone. Mirrors the issue's own repro (a)/(b)/(c) at the CLI layer, since the
    // exit code is only assigned in cli.ts's dispatch (exitCodeFor()), not by the
    // library call verifyWitnessChain() itself.
    const identity = await makeSigningIdentity();
    await writeFile(`${input}.minisig`, await mini.signDetached(identity.privateKey, identity.keyId, input));
    ok(cli(['push', '--in', input, '--backend', 'file', '--witness']));
    const first = await w.latestWitnessHint();
    await writeFile(input, 'age-encryption.org/v1\nsecond snapshot\n');
    await writeFile(`${input}.minisig`, await mini.signDetached(identity.privateKey, identity.keyId, input));
    ok(cli(['push', '--in', input, '--backend', 'file', '--witness']));
    const second = await w.latestWitnessHint();
    assert.notEqual(first.entry_locator, second.entry_locator);

    // (a) repro (a): healthy chain, no --to-sequence -> freshness-unknown, a
    // benign OUTCOME (not a thrown error) that still exits 1, unchanged by #930.
    const benign = cli(['witness', 'verify', '--backend', 'file', '--locator', second.entry_locator, '--json']);
    assert.equal(benign.status, 1, benign.output);
    assert.equal(JSON.parse(benign.stdout).outcome, 'freshness-unknown');

    // (b) repro (b): mismatched --sig-locator (entry 2's JSON paired with entry 1's
    // signature) -> a genuine authenticity failure, now exit 3, not 1.
    const mismatchedSig = cli([
      'witness',
      'verify',
      '--backend',
      'file',
      '--locator',
      second.entry_locator,
      '--sig-locator',
      first.sig_locator,
    ]);
    assert.equal(mismatchedSig.status, 3, mismatchedSig.output);
    assert.match(mismatchedSig.output, /signature verification failed/);

    // (c) repro (c): mismatched --pubkey (verifying against the wrong signer's
    // key) -> also a genuine authenticity failure, exit 3.
    const otherHome = join(home, 'other-signer');
    await mkdir(otherHome);
    await mini.keygenSignAt({
      home: otherHome,
      identityPath: join(otherHome, 'sign-identity.key'),
      recipientPath: join(otherHome, 'sign-recipient.pub'),
    });
    const mismatchedKey = cli([
      'witness',
      'verify',
      '--backend',
      'file',
      '--locator',
      second.entry_locator,
      '--pubkey',
      join(otherHome, 'sign-recipient.pub'),
    ]);
    assert.equal(mismatchedKey.status, 3, mismatchedKey.output);
    assert.match(mismatchedKey.output, /signature key id does not match|signature verification failed/);
  } else if (scenario === 'integration') {
    const identity = await makeSigningIdentity();
    await writeFile(`${input}.minisig`, await mini.signDetached(identity.privateKey, identity.keyId, input));
    ok(cli(['push', '--in', input, '--backend', 'file']));
    assert.equal(await w.latestWitnessHint(), undefined, 'opt-in only');
    const r = ok(
      cli(['push', '--in', input, '--backend', 'file', '--witness', '--save-locator', join(home, 'locator.tsv')]),
    );
    const h = await w.latestWitnessHint();
    const e = JSON.parse(await readFile(h.entry_locator, 'utf8'));
    assert.equal(e.locator, r.stdout.trim());
    assert.ok(e.sig_locator);
    const { sha256 } = await import('../src/lib/util.ts');
    assert.equal(e.snapshot_sha256, await sha256(input));
    const v = ok(
      cli(['witness', 'verify', '--backend', 'file', '--locator', h.entry_locator, '--to-sequence', '0', '--json']),
    );
    assert.equal(JSON.parse(v.stdout).outcome, 'confirmed');
    assert.equal(JSON.parse(v.stdout).latest_known, false);
    const latest = cli(['witness', 'verify', '--backend', 'file', '--locator', h.entry_locator, '--json']);
    assert.equal(latest.status, 1);
    assert.equal(JSON.parse(latest.stdout).outcome, 'freshness-unknown');
    assert.notEqual(
      cli(['push', '--in', input, '--backend', 'rclone', '--remote', ':local:/never', '--witness']).status,
      0,
    );
  } else if (scenario === 'doctor') {
    const { checkWitnessCoverage } = await import('../src/lib/doctor.ts');
    assert.equal((await checkWitnessCoverage()).status, 'skip');
    await makeSigningIdentity();
    ok(cli(['push', '--in', input, '--backend', 'file', '--witness']));
    assert.equal((await checkWitnessCoverage()).status, 'pass');
    await writeFile(input, 'age-encryption.org/v1\nnew snapshot\n');
    ok(cli(['push', '--in', input, '--backend', 'file']));
    assert.equal((await checkWitnessCoverage()).status, 'warn');
    assert.match((await checkWitnessCoverage()).message, /no matching witness/);
    ok(cli(['push', '--in', input, '--backend', 'file', '--witness']));
    assert.equal((await checkWitnessCoverage()).status, 'pass');
    const h = await w.latestWitnessHint();
    await writeFile(w.WITNESS_HINT_FILE, `${JSON.stringify({ ...h, sequence: 4 })}\n`);
    assert.match((await checkWitnessCoverage()).message, /sequence gap/);
  } else if (scenario === 'kit') {
    ok(cli(['keygen']));
    await makeSigningIdentity();
    const saved = join(home, 'locator.tsv');
    ok(cli(['push', '--in', input, '--backend', 'file', '--save-locator', saved]));
    assert.doesNotMatch(ok(cli(['recovery-kit', '--from-locator-file', saved])).stdout, /WITNESS CATALOG/);
    ok(cli(['push', '--in', input, '--backend', 'file', '--save-locator', saved, '--witness']));
    const h = await w.latestWitnessHint();
    const printed = ok(cli(['recovery-kit', '--from-locator-file', saved])).stdout;
    assert.match(printed, /WITNESS CATALOG ANCHOR/);
    assert.ok(printed.includes(h.entry_locator));
    assert.ok(printed.includes(h.sig_locator));
    assert.match(printed, /Sequence: 0/);
  } else if (scenario.startsWith('caps-')) {
    const { mock } = await import('node:test');
    const tracker = await import('../src/lib/spend-tracker.ts');
    const { AR_MAX_SPEND } = await import('../src/lib/config.ts');
    let uploads = 0;
    let lastLocator;
    let shared;
    mock.module('../src/lib/backends/index.ts', {
      namedExports: {
        backendFor: async () => ({
          put: async (path, opts) => {
            if (shared) assert.equal(opts.spendTracker, shared);
            else shared = opts.spendTracker;
            if (uploads === 3 && scenario === 'caps-uncertain') {
              const { PushUncertainSpendError } = await import('../src/lib/push-uncertain-spend.ts');
              throw new PushUncertainSpendError({
                backend: 'arweave',
                checkKind: 'arweave_tx_id',
                checkIdentifier: 'uncertain-witness-signature',
                detail: 'mock response lost',
              });
            }
            if (tracker.remainingSpendBudget(AR_MAX_SPEND, opts.spendTracker) < 10n)
              throw new Error('mock exceeds CYPHER_BRAIN_MAX_SPEND');
            tracker.chargeSpendTracker(opts.spendTracker, 10n);
            uploads++;
            const locator = await store.put(path);
            lastLocator = locator;
            await opts.onReceipt({ locator, raw: {}, cost: { amount: '10', unit: 'winston' } });
            if (uploads === 2 && ['caps-daily', 'caps-monthly'].includes(scenario)) {
              // Another process spends after primary+sidecar admission. The witness's
              // OWN budget reservation must observe it before uploading anything else.
              const { appendReceipt } = await import('../src/lib/receipt.ts');
              await appendReceipt({
                timestamp: new Date().toISOString(),
                backend: 'arweave',
                locator: 'concurrent-spend',
                artifact_sha256: 'a'.repeat(64),
                size_bytes: 1,
                payer_address: null,
                cost: '80',
                unit: 'winston',
                raw: {},
              });
            }
            return locator;
          },
          get: store.get,
        }),
      },
    });
    mock.module('../src/lib/estimate.ts', {
      namedExports: { estimateCost: async () => ({ cost: '10', unit: 'winston' }), formatEstimate: () => [] },
    });
    mock.module('../src/lib/wallet.ts', {
      namedExports: { payerAddressFor: async () => 'test-payer', tonWalletConfigured: async () => false },
    });
    const { push } = await import('../src/lib/pushpull.ts');
    const identity = await makeSigningIdentity();
    await writeFile(`${input}.minisig`, await mini.signDetached(identity.privateKey, identity.keyId, input));
    const opts = { in: input, backend: 'arweave', yes: true, witness: true, dirs: [], tables: [], recipients: [] };
    if (scenario === 'caps-green') {
      assert.equal(await push(opts), true);
      assert.equal(uploads, 4, 'ciphertext, sidecar, witness, witness sidecar');
      assert.equal(shared.spent, 40n);
      assert.ok(await w.latestWitnessHint());
    } else if (['caps-signature', 'caps-uncertain'].includes(scenario)) {
      await assert.rejects(push(opts), (e) => {
        assert.ok(e.message.includes(lastLocator), 'already-paid witness entry locator survives the error');
        if (scenario === 'caps-signature') {
          assert.equal(e.name, 'PushWitnessUploadError');
          assert.equal(e.witnessEntryLocator, lastLocator);
          assert.ok(e.locator);
          assert.ok(e.sigLocator);
        } else {
          assert.equal(e.name, 'PushUncertainSpendError');
          assert.equal(e.checkIdentifier, 'uncertain-witness-signature');
          assert.ok(e.confirmedCiphertextLocator);
          assert.match(e.message, /Witness publication/);
        }
        return true;
      });
      assert.equal(uploads, 3);
      assert.equal(await w.latestWitnessHint(), undefined);
    } else {
      await assert.rejects(
        push(opts),
        (e) => e.name === 'PushWitnessUploadError' && /MAX_SPEND|spend.*budget|daily|monthly/i.test(e.message),
      );
      assert.equal(uploads, 2);
      assert.equal(await w.latestWitnessHint(), undefined);
    }
    const { readReceipts } = await import('../src/lib/receipt.ts');
    assert.equal(
      (await readReceipts()).receipts.length,
      uploads + (['caps-daily', 'caps-monthly'].includes(scenario) ? 1 : 0),
    );
  } else if (scenario === 'mcp') {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    ok(cli(['keygen']));
    await makeSigningIdentity();
    const recipient = (await readFile(join(home, 'recipient.txt'), 'utf8'))
      .split('\n')
      .find((l) => l.startsWith('age1'));
    const source = join(home, 'source');
    await mkdir(source);
    await writeFile(join(source, 'proof'), 'mcp witness proof');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(root, 'dist/mcp.mjs')],
      env: {
        ...process.env,
        CYPHER_BRAIN_PIN_RECIPIENTS: recipient,
        CYPHER_BRAIN_MCP_SOURCE_ROOTS: JSON.stringify([source]),
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'witness-selftest', version: '1' });
    try {
      await client.connect(transport);
      assert.ok((await client.listTools()).tools.find((t) => t.name === 'snapshot_now').inputSchema.properties.witness);
      const args = {
        dirs: [source],
        recipients: [recipient],
        out: join(home, 'mcp.age'),
        backend: 'file',
        witness: true,
        scan_secrets: 'off',
        idempotency_key: 'witness-test',
      };
      const result = await client.callTool({ name: 'snapshot_now', arguments: args });
      assert.ok(!result.isError, JSON.stringify(result));
      assert.ok(await w.latestWitnessHint());
      const replay = await client.callTool({ name: 'snapshot_now', arguments: args });
      assert.ok(!replay.isError, JSON.stringify(replay));
      const mismatch = await client.callTool({ name: 'snapshot_now', arguments: { ...args, witness: false } });
      assert.ok(mismatch.isError, 'witness opt-in must participate in idempotency identity');
    } finally {
      await client.close();
    }
  }
}
