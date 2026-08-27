// recovery-kit — the printable recovery kit, as ONE canonical builder plus the
// standalone `cypher-brain recovery-kit` command (#364).
//
// The builder (buildRecoveryKit) moved here from wizard.ts VERBATIM in spirit:
// `init` renders its end-of-wizard kit through this exact function, and the
// standalone command renders through it too, so the two outputs cannot drift
// (#364's acceptance). What changed in the move: `pg` grew an 'unknown' state
// (a regenerated kit has no memory of the original run's flags) and the
// primary identity can now be inlined on explicit request (--inline-identity,
// wrapped-armored only — see the guard in recoveryKit() below).
//
// Why a standalone command exists (#364): `init` prints the kit exactly once,
// but every subsequent `push` changes what the kit points at (locator, sha256)
// — a printed kit references the FIRST snapshot forever unless regenerated.
// The real-world evidence was a maintainer operator script hand-reimplementing
// the entire kit, mojibake lessons and all.
//
// DELIBERATELY CLI-ONLY — no MCP tool exposes this. The kit can embed PRIVATE
// identity material (the backup identity, or the wrapped primary on request);
// an MCP tool would hand that block to any connected agent's context and logs.
// Same "decoration stays off MCP paths" reasoning as ui.ts's mascot, with real
// stakes.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { identityToRecipient } from 'age-encryption';
import { IDENTITY, PIN_RECIPIENTS, RECIPIENT, SIGN_IDENTITY, SIGN_RECIPIENT } from './config.js';
import { armorCiphertext, classifyIdentityFileAtRest } from './crypt.js';
import { promoteNoClobber, readSavedLocatorLine } from './pushpull.js';
import type { CliOptions } from './types.js';
import { exists, redactPgConn } from './util.js';
import { warn } from './warn.js';

export interface BackupKey {
  identityPath: string;
  recipientPath: string;
  recipient: string;
  identityText: string; // the raw file contents (unwrapped) — inlined into the kit
}

// The recovery kit: one printable plain-text page, after 1Password's Emergency Kit
// (https://support.1password.com/emergency-kit/ — a single printable sheet carrying
// what you need to get back in, kept physically). This used to say
// "Bitwarden-emergency-kit style", which credited the wrong project: Bitwarden's
// Emergency Access is a different mechanism entirely — an approval-or-time-delayed
// grant to a trusted contact, not a document (docs/prior-art.md carries both).
// Plain text was chosen over HTML->PDF deliberately (see issue #68 / cli.ts's file-header comment on
// the INLINE-vs-external Bun.build split) — zero new dependencies, greppable, and
// printable from any editor. Content mirrors MANAGEMENT.md's "Key recovery" section:
// the backup identity (if any) is INLINED here since printing this page IS how it
// leaves the machine to go offline; the primary identity is only referenced by
// location (it is already durably on this machine and duplicating a live secret into
// a file whose whole purpose is to also leave the building would only multiply risk)
// — unless the operator explicitly opts in with --inline-identity, which the command
// below only honors for a passphrase-wrapped, ASCII-armored identity.
export interface SigningKey {
  identityPath: string;
  recipientPath: string;
  pubkeyText: string; // the minisign-wire-format public key file's content — PUBLIC, safe to inline verbatim (unlike the backup identity above, this is never secret)
}

export interface KitInputs {
  primaryIdentityPath: string;
  /** Non-null only for the standalone command's --inline-identity (wrapped+armored, enforced by the caller). init never inlines the primary. */
  primaryInline: { text: string } | null;
  primaryRecipient: string;
  backup: BackupKey | null;
  signing: SigningKey | null; // #214: authenticity signing keypair, if known
  pinRecipientsLine: string | null;
  savedLocatorLine: string;
  profile: string;
  backend: string;
  /** 'none' = the run is known to have had no pg dump; 'unknown' = a regenerated kit that cannot know (#364). */
  pg: { conn: string } | 'none' | 'unknown';
  generatedAt: string;
}

// The two marker blocks (PRIMARY/BACKUP IDENTITY, SAVE-LOCATOR) plus the fixed
// install/pull/restore command sequence are what an operator ACTUALLY types to
// recover — shared between the QUICK RECOVERY block (top of the file, #428) and
// the detailed "RECOVERY STEPS" section further down, so the two can never state
// different commands. Only the wording of where the referenced blocks live
// ("above" the detail section, "below" the quick block) differs by caller.
function recoverySteps(which: 'BACKUP' | 'PRIMARY', blockLocation: 'above' | 'below'): string[] {
  return [
    '1) npm install -g cypher-brain          (or: npx cypher-brain@latest <command>)',
    `2) Copy the ${which} IDENTITY block ${blockLocation} (the lines between its BEGIN and END markers,`,
    '   not including the marker lines themselves) into its own file, e.g.: ~/restore-identity.age',
    `3) Copy the SAVE-LOCATOR line ${blockLocation} (between its BEGIN and END markers) into its own`,
    '   file, e.g.: ~/restore-locator.tsv',
    '4) cypher-brain pull --from-locator-file ~/restore-locator.tsv --out ~/restored.age',
    '5) cypher-brain restore --in ~/restored.age --out-dir ~/restored --identity ~/restore-identity.age',
    '   (if the identity is passphrase-wrapped, this step prompts for that passphrase)',
  ];
}

export function buildRecoveryKit(k: KitInputs): string {
  // Which identity block a self-contained recovery copies from — null when NEITHER
  // a backup identity nor an inlined primary is in this kit (the "kit-only recovery
  // is not possible" case below). Hoisted so the QUICK RECOVERY block (top) and the
  // detailed RECOVERY STEPS section (further down) agree on it by construction.
  const which: 'BACKUP' | 'PRIMARY' | null = k.backup ? 'BACKUP' : k.primaryInline ? 'PRIMARY' : null;
  const lines: string[] = [];
  lines.push('='.repeat(72));
  lines.push('CYPHER-BRAIN RECOVERY KIT — KEEP THIS OFFLINE / PHYSICALLY SECURE');
  lines.push('This file contains SECRET key material. Anyone holding it can decrypt');
  lines.push('every cypher-brain snapshot encrypted to the key(s) below. Print it,');
  lines.push('store it somewhere physically secure (a safe, a password manager secure');
  lines.push('note, a trusted person) AWAY from this machine, then treat it like cash.');
  lines.push('='.repeat(72));
  lines.push('');
  // --- QUICK RECOVERY (#428): "what do I type, right now" first, full detail below.
  // Purely additive resequencing — nothing below this block changes or is removed.
  lines.push('--- QUICK RECOVERY (read this first — full detail and caveats are further below) ---');
  if (which) {
    if (k.backend === 'file') {
      lines.push('!!! Locator is LOCAL-ONLY (file backend) — step 4 below only works on THIS machine unless the');
      lines.push('    file-backend store is also copied elsewhere. See the "LOCATOR IS LOCAL-ONLY" caveat below.');
      lines.push('');
    }
    lines.push('If you need to recover RIGHT NOW (the identity + locator blocks referenced below are further down):');
    for (const step of recoverySteps(which, 'below')) lines.push(`  ${step}`);
    if (k.pg !== 'none') {
      lines.push('');
      lines.push('If a Postgres dump is included: do NOT pg_restore it into a live database once restored — see the');
      lines.push('Postgres caveat further below before running pg_restore.');
    }
  } else {
    lines.push('!!! NO BACKUP IDENTITY IS IN THIS KIT: kit-only recovery — on a fresh machine with ZERO other prior');
    lines.push('    knowledge — is NOT possible right now. Recovery IS possible if you still have the PRIMARY');
    lines.push(`    identity itself, originally at: ${k.primaryIdentityPath}`);
    lines.push('    See "Your actual options" in the RECOVERY STEPS section further below for the exact commands.');
  }
  lines.push('');
  lines.push(`Kit generated: ${k.generatedAt}`);
  lines.push(`Profile used:  ${k.profile}`);
  lines.push(`Backend used:  ${k.backend}`);
  lines.push(
    `Postgres dump: ${
      k.pg === 'unknown'
        ? 'unknown (not recorded in the locator file — after a restore, check --out-dir for db.dump)'
        : k.pg === 'none'
          ? 'not included'
          : `included (connection: ${redactPgConn(k.pg.conn)})`
    }`,
  );
  lines.push('');
  if (k.primaryInline) {
    lines.push('--- PRIMARY IDENTITY (passphrase-wrapped copy inlined below at your request) ---');
    lines.push(`Location on the original machine: ${k.primaryIdentityPath}`);
    lines.push(`Recipient (public, safe to share): ${k.primaryRecipient}`);
    lines.push('');
    lines.push('BEGIN PRIMARY IDENTITY FILE (passphrase-wrapped — useless without the passphrase)');
    lines.push(k.primaryInline.text.replace(/\n+$/, ''));
    lines.push('END PRIMARY IDENTITY FILE');
    lines.push('(Inlined via --inline-identity. The wrap passphrase is NOT in this kit — keep it');
    lines.push(' memorized or stored separately, never written next to this block.)');
    lines.push('');
  } else {
    lines.push('--- PRIMARY IDENTITY (already on this machine — not duplicated here) ---');
    lines.push(`Location:  ${k.primaryIdentityPath}`);
    lines.push(`Recipient (public, safe to share): ${k.primaryRecipient}`);
    lines.push('');
  }
  if (k.backup) {
    lines.push('--- BACKUP IDENTITY (SECRET — this is what lets a fresh machine restore) ---');
    lines.push(`Location on THIS machine (move it off-box): ${k.backup.identityPath}`);
    lines.push(`Recipient (public, safe to share): ${k.backup.recipient}`);
    lines.push('');
    lines.push('BEGIN BACKUP IDENTITY FILE');
    lines.push(k.backup.identityText.replace(/\n+$/, ''));
    lines.push('END BACKUP IDENTITY FILE');
    lines.push('');
  } else {
    lines.push('--- BACKUP IDENTITY ---');
    lines.push('None was generated during init. The PRIMARY identity above is the only key');
    lines.push('that can restore — losing it loses the brain. MANAGEMENT.md "Key recovery #1"');
    lines.push('recommends adding an offline backup key: CYPHER_BRAIN_HOME=<path> cypher-brain keygen');
    lines.push('');
  }
  if (k.signing) {
    lines.push('--- SIGNING PUBLIC KEY (authenticity, #214 — PUBLIC, safe to keep with this kit or share) ---');
    lines.push('age proves confidentiality but not authenticity: anyone holding a recipient public key can');
    lines.push('forge decryptable ciphertext. This signing key closes that gap — snapshot signs each *.age it');
    lines.push('writes, and restore/verify check the signature BEFORE decrypting. Keep this public key alongside');
    lines.push(`the recovery locator so restore on ANY machine can verify: ${k.signing.recipientPath}`);
    lines.push('');
    lines.push('BEGIN SIGNING PUBLIC KEY');
    lines.push(k.signing.pubkeyText.replace(/\n+$/, ''));
    lines.push('END SIGNING PUBLIC KEY');
    lines.push('(The matching PRIVATE signing key stays on this machine only — see MANAGEMENT.md "Key recovery" —');
    lines.push(
      ' it is not needed to VERIFY a signature, only to CREATE new ones, so it is deliberately not inlined here.)',
    );
    lines.push('');
  } else {
    lines.push('--- SIGNING PUBLIC KEY (authenticity, #214) ---');
    lines.push('None was generated during init. Snapshots restore exactly as before (age confidentiality +');
    lines.push('tamper detection), just without the extra authenticity check. Add one later at any time:');
    lines.push('cypher-brain keygen --sign');
    lines.push('');
  }
  lines.push('--- LATEST SAVE-LOCATOR (back this up off-box, next to the backup identity) ---');
  lines.push('BEGIN SAVE-LOCATOR LINE');
  lines.push(k.savedLocatorLine);
  lines.push('END SAVE-LOCATOR LINE');
  lines.push('');
  // The kit is a sheet of paper someone acts on later, possibly on a different machine —
  // so it names the config file the way README/MANAGEMENT.md do ($CYPHER_BRAIN_HOME-
  // relative), not this machine's resolved path, which would not be the right one there.
  lines.push('--- CYPHER_BRAIN_PIN_RECIPIENTS (add to $CYPHER_BRAIN_HOME/config.env; shell rc: prefix "export ") ---');
  lines.push(
    k.pinRecipientsLine ?? '(skipped during init — see MANAGEMENT.md / "cypher-brain help" for what this does)',
  );
  lines.push('');
  lines.push('--- RECOVERY STEPS (run these on ANY machine with Node >=22.6 and this npm package installed) ---');
  // Deliberately do NOT auto-append --pg (with the SOURCE connection string) to the
  // restore commands below: pg_restore --clean --if-exists DROPS/replaces objects in
  // whatever database --pg names, so blindly reusing the dump's SOURCE as the restore
  // TARGET on a verbatim copy-paste risks clobbering a live database. MANAGEMENT.md's
  // own restore runbook is explicit about this ("rebuild into a SCRATCH database, never
  // straight over a live one") — the Postgres block below points there instead of
  // encouraging a single dangerous copy-paste command (Fugu review finding).
  if (k.backend === 'file') {
    lines.push('!!! LOCATOR IS LOCAL-ONLY: this backup used the "file" backend, so the save-locator line above');
    lines.push('    points at a path inside a local object store (CYPHER_BRAIN_FILE_DIR) on THIS machine — it');
    lines.push('    is NOT reachable from a different machine unless that whole store directory is also copied');
    lines.push('    there. Step 4 below (pull --from-locator-file) will fail on another machine as written. For');
    lines.push('    genuine cross-machine recovery, re-run push with a network backend (arweave/turbo), or');
    lines.push('    manually copy the file-backend store alongside this kit. See MANAGEMENT.md "Key recovery #3".');
    lines.push('');
  }
  if (which) {
    lines.push('An operator with ZERO prior knowledge of this repo can follow these verbatim. The two marker');
    lines.push('blocks above (each a single BEGIN/END pair, unique in this file) are the two things you copy:');
    for (const step of recoverySteps(which, 'above')) lines.push(`  ${step}`);
  } else {
    lines.push('!!! NO BACKUP IDENTITY IS IN THIS KIT: true kit-only recovery — restoring on a fresh machine');
    lines.push('    with ZERO other prior knowledge — is NOT possible right now. The only thing that can');
    lines.push('    decrypt any snapshot encrypted so far is the PRIMARY identity above, and it was');
    lines.push('    deliberately NOT copied into this kit (it already lives durably on THIS machine — printing');
    lines.push('    a backup identity into the kit is how a SECOND key leaves the machine; there is no second');
    lines.push('    key here). See MANAGEMENT.md "Key recovery #1".');
    lines.push('');
    lines.push('Your actual options:');
    lines.push('  * Restore using the PRIMARY identity itself, wherever it currently lives (this machine, or');
    lines.push(`    a copy of it you separately made outside of this kit): ${k.primaryIdentityPath}`);
    lines.push('    (possibly passphrase-protected, per step 3 of the wizard — restore then prompts for it).');
    lines.push('    Copy the SAVE-LOCATOR line above into its own file, e.g. ~/restore-locator.tsv, then:');
    lines.push('      cypher-brain pull --from-locator-file ~/restore-locator.tsv --out ~/restored.age');
    lines.push(
      `      cypher-brain restore --in ~/restored.age --out-dir ~/restored --identity ${k.primaryIdentityPath}`,
    );
    lines.push('  * For real kit-based portable recovery (any machine, zero prior knowledge), a backup');
    lines.push('    identity has to exist and be inlined in the kit. To get there: generate one —');
    lines.push('    "CYPHER_BRAIN_HOME=<path> cypher-brain keygen" — then re-snapshot encrypting to BOTH the');
    lines.push('    primary recipient.txt (next to the primary identity above) and the new backup');
    lines.push('    recipient.txt (see MANAGEMENT.md "Key recovery #1"), then generate a fresh kit so it');
    lines.push('    inlines the new backup identity.');
    lines.push('  * The SAVE-LOCATOR and CYPHER_BRAIN_PIN_RECIPIENTS sections above are still valid, useful');
    lines.push('    information regardless of the above — only "restore using just this kit alone" carries');
    lines.push('    this caveat.');
  }
  if (k.pg !== 'none') {
    lines.push('');
    if (k.pg === 'unknown') {
      lines.push('!!! IF THE RESTORED OUTPUT CONTAINS A POSTGRES DUMP (db.dump in --out-dir): do NOT pg_restore');
      lines.push('    it into a live database — "pg_restore --clean --if-exists" DROPS/replaces objects in');
      lines.push('    whatever database --pg names. Add --pg pointing at a SCRATCH database; see MANAGEMENT.md');
      lines.push('    "Restore runbook" step 4 for the exact pattern.');
    } else {
      lines.push('!!! THIS BACKUP ALSO INCLUDES A POSTGRES DUMP: the restore command(s) above extract db.dump into');
      lines.push('    --out-dir but deliberately do NOT pg_restore it (no --pg is included above).');
      lines.push(`    Its SOURCE connection was: ${redactPgConn(k.pg.conn)}`);
      lines.push('    Do NOT pg_restore into that same database — "pg_restore --clean --if-exists" DROPS/replaces');
      lines.push('    objects in whatever database --pg names. Add --pg pointing at a SCRATCH database (never the');
      lines.push('    source above) to the restore command; see MANAGEMENT.md "Restore runbook" step 4 for the');
      lines.push('    exact pattern.');
    }
  }
  lines.push('');
  lines.push('--- WHAT TO DO WITH THIS FILE ---');
  lines.push('Print this page and store it securely, physically away from this machine. Once it');
  lines.push('is secured, you MAY delete this file from disk — that is a manual step; cypher-brain');
  lines.push('does not delete it for you.');
  lines.push('');
  return lines.join('\n');
}

// Write-then-chmod has a real exposure window: if path already exists at a looser
// mode, writeFile() replaces its CONTENT first — the secret briefly sits in a
// world/group-readable file — and only chmod() afterward narrows it. Create a
// distinctly-named temp sibling with `wx` (exclusive create) and `mode: 0o600`
// from the instant of creation, then atomically rename() over path — the same
// temp-then-rename convention pushpull.ts's save-locator write and snapshot.ts's
// promote step use. (Moved verbatim from wizard.ts so init and `recovery-kit`
// share one secret-bearing write path.)
export async function writeRecoveryKitFile(path: string, text: string, opts: { clobber: boolean }): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, text, { flag: 'wx', mode: 0o600 });
    if (opts.clobber) {
      await rename(tmp, path);
    } else {
      // Atomic no-clobber: link()/wx-gated promote, NOT exists()-then-rename —
      // a check-then-act pair leaves a window where a concurrent create at
      // `path` gets silently replaced (Codex review). Same primitive pull's
      // --out write uses.
      await promoteNoClobber(tmp, path, 'a recovery kit');
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** `cypher-brain recovery-kit` (#364) — regenerate the kit for the CURRENT latest
 *  push, from a save-locator file + on-disk key material. CLI-only (see file header). */
export async function recoveryKit(o: CliOptions): Promise<void> {
  if (!o.from_locator_file) {
    throw new Error(
      '--from-locator-file <path> required — the kit points a future restore at ONE specific push; name the ' +
        'save-locator file that push wrote (push --save-locator <file>)',
    );
  }
  if (o.backup_recipient && !o.backup_identity) {
    throw new Error('--backup-recipient only makes sense WITH --backup-identity — pass both, or neither');
  }
  const saved = await readSavedLocatorLine(o.from_locator_file);
  if (!saved) {
    throw new Error(
      `${o.from_locator_file} has no locator line — run a push with --save-locator first, and point ` +
        '--from-locator-file at the file it wrote',
    );
  }
  // Same truncated-file guard pull's --from-locator-file applies: a kit whose
  // "Backend used" column reads undefined is a broken recovery document.
  if (!saved.locator || !saved.backend) {
    throw new Error(
      `locator file ${o.from_locator_file} must contain "<locator>\t<backend>[\t<sha256>…]" — its first ` +
        'locator line is missing the locator and/or backend column',
    );
  }
  const savedLocatorLine =
    (await readFile(o.from_locator_file, 'utf8'))
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? '';

  // Deliberately the standard layout only — no per-file --identity override: the kit
  // pairs the identity with $CYPHER_BRAIN_HOME/recipient.txt, and letting one half be
  // swapped per-flag lets the kit claim a recipient the embedded/referenced private
  // key cannot satisfy (Codex review). Relocation is CYPHER_BRAIN_HOME's job, which
  // moves both halves coherently.
  if (!(await exists(IDENTITY))) {
    throw new Error(`no identity at ${IDENTITY} — run "cypher-brain keygen" first (relocate with CYPHER_BRAIN_HOME)`);
  }
  if (!(await exists(RECIPIENT))) {
    throw new Error(
      `no recipient at ${RECIPIENT} — the kit records the public recipient; run "cypher-brain keygen" (or put ` +
        'recipient.txt back) first',
    );
  }
  const primaryRecipient = (await readFile(RECIPIENT, 'utf8')).trim();

  // --inline-identity: opt-in, and ONLY for a genuinely passphrase-wrapped identity
  // (classified from the file's bytes: age ciphertext whose first stanza is scrypt —
  // NOT a marker-string sniff, which malformed armor or an armored SNAPSHOT would
  // pass; Codex review). Refusing the unwrapped case is the point of the flag
  // existing at all: a bare private key in a paste-anywhere document is exactly the
  // accident this tool would otherwise industrialize (#364). A binary wrap is
  // re-armored here (pure re-encoding, `age -p -a` compatible) so it can survive
  // the print/copy-paste the kit exists for.
  let primaryInline: { text: string } | null = null;
  if (o.inline_identity) {
    const at = await classifyIdentityFileAtRest(IDENTITY);
    if (at.kind === 'plaintext') {
      throw new Error(
        `${IDENTITY} is NOT passphrase-wrapped — refusing to inline a bare private key into a printable ` +
          'document. Wrap it first ("cypher-brain keygen --wrap-in-place", or age -p -a), then rerun.',
      );
    }
    if (at.kind !== 'wrapped') {
      throw new Error(
        `${IDENTITY} is not a passphrase-wrapped identity (${
          at.kind === 'ciphertext-not-passphrase'
            ? 'it is age ciphertext, but to a recipient — no scrypt stanza, so no passphrase can unwrap it'
            : 'unrecognized contents'
        }) — refusing to inline it as the primary identity.`,
      );
    }
    primaryInline = { text: at.armored ? at.text : armorCiphertext(new Uint8Array(at.bytes)) };
  }

  // --backup-identity: same shape init's wizard inlines (the kit IS the off-box
  // store for a backup key, so inlining an unwrapped one is a supported choice —
  // but a LOUD one, via the #347 warning chokepoint, unlike the primary above).
  let backup: BackupKey | null = null;
  if (o.backup_identity) {
    if (!(await exists(o.backup_identity))) throw new Error(`no backup identity at ${o.backup_identity}`);
    const at = await classifyIdentityFileAtRest(o.backup_identity);
    if (at.kind !== 'plaintext' && at.kind !== 'wrapped') {
      throw new Error(
        `${o.backup_identity} is not an identity file (${
          at.kind === 'ciphertext-not-passphrase'
            ? 'age ciphertext to a recipient — no scrypt stanza'
            : 'unrecognized contents'
        }) — refusing to inline it as a backup identity.`,
      );
    }
    let recipient: string;
    if (o.backup_recipient) {
      recipient = o.backup_recipient.startsWith('age1')
        ? o.backup_recipient
        : (await readFile(o.backup_recipient, 'utf8')).trim();
    } else if (at.kind === 'plaintext') {
      // Generic AGE-SECRET-KEY- prefix, not the X25519-only …-1: PQ hybrid
      // identities (AGE-SECRET-KEY-PQ-1…) must derive identically (Codex review).
      const secret = at.text
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('AGE-SECRET-KEY-'));
      if (!secret) throw new Error(`${o.backup_identity} has no AGE-SECRET-KEY-… line to derive a recipient from`);
      recipient = await identityToRecipient(secret);
    } else {
      throw new Error(
        `${o.backup_identity} is passphrase-wrapped, so its public recipient cannot be derived without the ` +
          'passphrase — pass --backup-recipient <age1…-or-path> alongside it',
      );
    }
    if (at.kind === 'plaintext') {
      warn(
        `the backup identity being inlined (${o.backup_identity}) is NOT passphrase-wrapped — anyone holding ` +
          'the printed kit can decrypt every snapshot encrypted to it. Store the kit accordingly, or wrap the ' +
          'identity first (age -p -a) and pass --backup-recipient.',
      );
    }
    // A binary wrap is re-armored (bytes, not the utf8-mangled text — reading a
    // binary file as utf8 replaces invalid sequences and would print an
    // UNRECOVERABLE identity into the kit; Codex review P1).
    const identityText = at.kind === 'wrapped' && !at.armored ? armorCiphertext(new Uint8Array(at.bytes)) : at.text;
    backup = { identityPath: o.backup_identity, recipientPath: o.backup_recipient ?? '', recipient, identityText };
  }

  let signing: SigningKey | null = null;
  if (await exists(SIGN_RECIPIENT)) {
    signing = {
      identityPath: SIGN_IDENTITY,
      recipientPath: SIGN_RECIPIENT,
      pubkeyText: await readFile(SIGN_RECIPIENT, 'utf8'),
    };
  }

  const kitText = buildRecoveryKit({
    primaryIdentityPath: IDENTITY,
    primaryInline,
    primaryRecipient,
    backup,
    signing,
    pinRecipientsLine: PIN_RECIPIENTS !== undefined ? `CYPHER_BRAIN_PIN_RECIPIENTS=${PIN_RECIPIENTS}` : null,
    savedLocatorLine,
    profile: '(not recorded — kit regenerated by "cypher-brain recovery-kit")',
    backend: saved.backend,
    pg: 'unknown',
    generatedAt: new Date().toISOString(),
  });

  if (o.out) {
    await writeRecoveryKitFile(o.out, kitText, { clobber: o.force === true });
    console.log(`recovery kit written: ${o.out} (mode 0600)`);
  } else {
    console.log(kitText);
  }
}
