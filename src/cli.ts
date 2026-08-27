// cypher-brain — encrypt a gbrain snapshot so only the key holder can read it.
//
// Threat model: the always-on machine (e.g. the Mac mini that runs gbrain) holds
// ONLY the recipient PUBLIC key, so it can produce snapshots but can never read
// them. The private identity — the "key only mine" — lives off the always-on box
// and is the sole thing that can restore. Compromising the snapshotting machine
// therefore leaks no brain content.
//
// Crypto: age (X25519 + ChaCha20-Poly1305) via typage (npm `age-encryption`,
// FiloSottile's official TypeScript implementation), bundled into the CLI — no
// external `age` binary is needed, and the format stays byte-compatible with it.
// Each component (the pg_dump, each directory archive) is staged into a private
// (0700) temp dir, then the bundle is streamed `tar -> age` so the final ciphertext
// never loads into memory. The staged plaintext is erased on a normal failure (the
// snapshot finally-block) AND on Ctrl-C / SIGTERM / SIGHUP (a signal handler that
// rmSync's the active stage dir, since a signal tears the process down without
// unwinding the finally), so it doesn't linger. Staging needs scratch space ~the
// size of the snapshot, so point TMPDIR at a disk with room for large brains.
//
// Backend-agnostic: this produces ONE encrypted artifact (`*.age`). Where those
// bytes get parked (Arweave / anything) is a separate, pluggable concern —
// storage only ever sees ciphertext.
//
// This entry point holds arg parsing + command dispatch; the implementation lives
// in src/lib/ (config, proc, util, signal-guard, identity, snapshot, restore,
// pushpull, backends/).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IDENTITY, CONFIG_FILE_ERROR } from './lib/config.js';
import { keygen } from './lib/keys.js';
import { snapshot } from './lib/snapshot.js';
import { restore, verify } from './lib/restore.js';
import { push, pull } from './lib/pushpull.js';
import { publishLatest } from './lib/ton-dns.js';
import { schedule } from './lib/schedule.js';
import { wallet } from './lib/wallet.js';
import { estimate } from './lib/estimate.js';
import { doctor } from './lib/doctor.js';
import { ledger } from './lib/ledger.js';
import { audit } from './lib/audit.js';
import { withSpan } from './lib/otel.js';
import { init } from './lib/wizard.js';
import { errMsg } from './lib/util.js';
import { annotateErrorMessage, matchErrorCode } from './lib/errors.js';
import { didYouMean, nearestName } from './lib/suggest.js';
import { hasWrittenJson, printMascot, installEpipeGuard } from './lib/ui.js';
import { recoveryKit } from './lib/recoverykit.js';
import { drainWarnings, formatWarningSummary } from './lib/warn.js';
import { printFounderNote, printWisdomQuote } from './lib/wisdom.js';
import type { CliOptions } from './lib/types.js';

const BOOL_FLAGS = new Set([
  'force',
  'passphrase',
  'wrap_in_place',
  'yes',
  'force_vault',
  'skip_unchanged',
  'no_load',
  'no_expand_components',
  'pq',
  'dry_run',
  'json',
  'sign',
  'no_sign',
  'require_signature',
  'inline_identity',
  'csv',
]); // flags that take no value

// Value flags (always a string when passed) — kept in sync with CliOptions
// (src/lib/types.ts), which is the authoritative list of every field a command
// actually reads. `dir`/`pg-table`/`pg-exclude-table-data`/`recipient` are NOT
// listed here: they're repeatable array flags handled by their own branches
// below, before this set is ever consulted.
const VALUE_FLAGS = new Set([
  'out',
  'out_dir',
  'profile',
  'vault',
  'zip',
  'export',
  'pg',
  'pg_filter',
  'in',
  'identity',
  'sha256',
  'backend',
  'remote',
  'digest',
  'save_locator',
  'locator',
  'level',
  'scan_secrets',
  'from_locator_file',
  'sign_identity',
  'sign_recipient',
  'sig_locator',
  'backup_identity',
  'backup_recipient',
  'wait',
  'at',
  'max_spend',
  'index_file',
  'wallet',
  'address',
  'ping_url',
  'ping_url_fail',
  'domain',
  'chain',
  'plan',
]);

// Every flag name an "unknown flag" error can plausibly suggest (#425 — generalizing
// #253's own "would be nice-to-have" mention of a did-you-mean suggestion beyond
// restore's --out/--out-dir special case). Includes the four repeatable array flags
// (--dir/--pg-table/--pg-exclude-table-data/--recipient) parseArgs() handles in their
// own branches BEFORE ever consulting BOOL_FLAGS/VALUE_FLAGS — they are real, valid
// flags and must be suggestable too (#253's own repro used exactly `--recipiant` for
// `--recipient`), even though they never appear in either Set above. Hyphenated (the
// form a user actually types), computed once at module load rather than per rejected
// flag.
const KNOWN_FLAG_NAMES: string[] = [
  'dir',
  'pg-table',
  'pg-exclude-table-data',
  'recipient',
  ...BOOL_FLAGS,
  ...VALUE_FLAGS,
].map((k) => k.replace(/_/g, '-'));

function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { dirs: [], tables: [], recipients: [] };
  const rec = o as unknown as Record<string, string | boolean | undefined>;
  // A value-taking flag whose value is MISSING used to read its value off the end of the
  // array (or off the next flag), i.e. `undefined` — which then looks exactly like "the
  // flag was never passed" to every reader downstream. For a REQUIRED flag that surfaces
  // as a confusing but safe "--x required"; for an OPTIONAL one it is silent, which is the
  // same "asked for a gate, got none" failure #307 is about. Two shapes, both found by
  // multi-model review, both refused here by naming the flag:
  //
  //   snapshot --dir src --out --scan-secrets deny   -> --out swallowed "--scan-secrets",
  //                                                     scan_secrets stayed undefined, and
  //                                                     the snapshot ran UNSCANNED into a
  //                                                     file literally named --scan-secrets
  //   schedule install … --scan-secrets              -> exit 0, runner with no scan at all
  //
  // "Looks like a flag" is ANY token starting with "--", not just a recognized one. An
  // earlier revision only rejected recognized names, and review found the hole that
  // leaves: `--out --scan-secret deny` (note the typo) is not a name this CLI knows, so
  // it was swallowed as --out's value — writing an unscanned snapshot to a file called
  // "--scan-secret" and never reaching the unknown-flag refusal (#253) that exists to
  // catch exactly that typo. A value that genuinely begins with "--" is pathological
  // enough to be worth an explicit "./--name", which the message suggests.
  const valueAt = (i: number, flag: string): string => {
    if (i >= argv.length) throw new Error(`${flag} requires a value (run 'cypher-brain --help' for the expected form)`);
    if (argv[i].startsWith('--'))
      throw new Error(
        `${flag} requires a value, but the next argument looks like another flag (${argv[i]}) — ` +
          `it was NOT consumed as ${flag}'s value. Give ${flag} its value, or write "./${argv[i]}" if you really ` +
          `meant a path by that name.`,
      );
    return argv[i];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dirs.push(valueAt(++i, a));
    else if (a === '--pg-table') o.tables.push(valueAt(++i, a));
    else if (a === '--pg-exclude-table-data') {
      if (!o.pg_exclude_table_data) o.pg_exclude_table_data = [];
      o.pg_exclude_table_data.push(valueAt(++i, a));
    } else if (a === '--recipient')
      o.recipients.push(valueAt(++i, a)); // repeatable: key recovery
    else if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-/g, '_');
      // issue #253: an unrecognized/mistyped --flag used to be silently stored
      // on `o` and then just never read by any command — no error, just quiet
      // wrong behavior (the same bug class as #96/#101/#114). Refuse instead.
      if (!BOOL_FLAGS.has(key) && !VALUE_FLAGS.has(key)) {
        const suggestion = nearestName(a.slice(2), KNOWN_FLAG_NAMES);
        throw new Error(
          `unknown flag: --${a.slice(2)} (${suggestion ? `${didYouMean(`--${suggestion}`)} — ` : ''}run 'cypher-brain --help' or '<command> --help' to see valid flags)`,
        );
      }
      rec[key] = BOOL_FLAGS.has(key) ? true : valueAt(++i, a);
    } else o._ = a;
  }
  return o;
}

const HELP = `cypher-brain — encrypt a gbrain snapshot so only you can read it

  cypher-brain --version
      Print the version this build was packaged with (the "version" field of the
      installed package.json) on stdout and exit 0 — nothing else, so it can be
      captured straight into a variable. "-V" is the same thing.

  cypher-brain <command> --help
      Print just that command's section of this reference (plus the Env/Storage/
      Spend/Consent block below, which applies to every command). Plain
      "cypher-brain --help" prints the whole thing, as it does here.

  cypher-brain init
      Recommended for a FRESH setup: an interactive wizard that walks keygen -> an
      offline backup keypair (optional) -> passphrase-wrap (optional) -> a
      CYPHER_BRAIN_PIN_RECIPIENTS suggestion -> --profile selection -> the first
      snapshot + push, ending in a printable plain-text recovery kit (the backup
      identity + latest locator + exact recovery commands). Refuses if an identity
      already exists (init is for a fresh setup, not overwriting one — use keygen
      --force, or drive the commands below by hand, to redo it) and requires a TTY
      on stdin (it is interactive, not automatable).

  cypher-brain keygen [--passphrase] [--force] [--pq] | keygen --wrap-in-place | keygen --sign
      Create your age keypair: identity (PRIVATE) + recipient (PUBLIC).
      --passphrase wraps the identity at rest with a scrypt passphrase (prompted on the
      TTY); restore/verify then prompt for it. Identity = ${IDENTITY}
      --pq generates a POST-QUANTUM HYBRID keypair (ML-KEM-768 + X25519, via typage's
      generateHybridIdentity()) instead of plain X25519 — mitigates "harvest now,
      decrypt later" against a future quantum computer (see README Threat model), at
      the cost of a MUCH bigger recipient/identity and per-recipient ciphertext
      overhead (recipient ~1.9KB vs ~62 bytes for X25519; negligible next to a real
      snapshot). Combines normally with --recipient (a hybrid primary + an X25519
      backup, or vice versa, both work — pick whichever identity "restore" is called with).
      --wrap-in-place passphrase-protects the EXISTING identity WITHOUT generating a new
      keypair (unlike --force, which always creates a brand-new one and makes every prior
      snapshot unrecoverable) — use this if you skipped the passphrase step during "init"
      or a bare keygen and want to add one later. Refuses if the identity is already
      wrapped, or if none exists yet.
      --sign (#214) generates a SEPARATE minisign-compatible Ed25519 SIGNING keypair
      instead of an age keypair — an independent mode (like --wrap-in-place; the two are
      mutually exclusive), so it can add authenticity to an existing setup without
      touching the age identity at all. age gives confidentiality + tamper detection but
      NOT authenticity (a recipient's public key is not secret — anyone holding it can
      forge ciphertext that decrypts cleanly); signing the *.age ciphertext and verifying
      BEFORE decrypt (see restore/verify below) closes that gap. Writes
      $CYPHER_BRAIN_HOME/sign-identity.key (PRIVATE) and sign-recipient.pub (PUBLIC, in
      the reference minisign CLI's own wire format — verifiable with a real
      "minisign -V -p sign-recipient.pub"). --passphrase/--force apply to it the same way
      they do to the age identity above; --wrap-in-place does not (age-only).

  cypher-brain wallet create [--out <path>] [--force] [--chain arweave|ton]
      Generate a fresh signing credential. --chain arweave (default) generates an
      Arweave JWK for the arweave/turbo storage backends (needs the 'arweave' package —
      a peerDependency, same as those backends). Defaults to $CYPHER_BRAIN_HOME/wallet.json;
      --out picks a different path. Prints the wallet path (PRIVATE) and its derived
      address (PUBLIC — fund THIS one). Refuses to overwrite an existing wallet file
      (same no-clobber posture as keygen); --force to replace it. Written 0600, same
      fail-closed handling as the age identity.
      --chain ton generates a TON wallet (a 24-word BIP39 mnemonic, WalletContractV4 —
      needs the '@ton/ton'/'@ton/crypto' packages, both optionalDependencies) for the
      ton-provider backend's auto-signing mode (issue #396 PR2). Defaults to
      $CYPHER_BRAIN_HOME/ton-wallet.json; same --out/--force/0600 posture as the arweave
      form. Set CYPHER_BRAIN_TON_WALLET to the written path afterward so 'push --backend
      ton-provider' signs and broadcasts deploys itself instead of printing a Tonkeeper
      deeplink for a human to approve — see push's --backend ton-provider section below.

  cypher-brain wallet address [--wallet <path>] [--chain arweave|ton]
      Derive and print the address a wallet spends from, without uploading/deploying
      anything. --wallet defaults to CYPHER_BRAIN_AR_WALLET (--chain arweave, the
      default) or CYPHER_BRAIN_TON_WALLET (--chain ton), then to the matching 'wallet
      create' default path. Use this to confirm you are funding the SAME wallet
      cypher-brain will sign with (for --chain ton, this is also the address that
      becomes the StorageV1 contract's owner — see push's --backend ton-provider
      section).

  cypher-brain wallet balance [--wallet <path>] [--address <addr>] [--json] [--chain arweave|ton]
      --chain arweave (default): print what an address can actually spend on the turbo
      backend: its OWN Turbo Credit balance, its SPENDABLE balance (own + Credit Share
      Approvals delegated to it), and every approval received/given with the winc
      remaining on it and when it expires. Answers the three questions a top-up asks —
      did my purchase land, did the share to this wallet land, how much is left — which
      otherwise need a hand-written @ardrive/turbo-sdk script. A plain unauthenticated
      GET against the payment service keyed on a PUBLIC address: no '@ardrive/turbo-sdk'
      install, no signature. --address queries ANY address without a key or wallet file
      (this is how you check the browser/MetaMask wallet you bought credits on — the one
      whose JWK this machine by definition does not have). Without it, the address is
      derived from the JWK, with the same --wallet / CYPHER_BRAIN_AR_WALLET /
      $CYPHER_BRAIN_HOME/wallet.json fallback 'wallet address' uses. Warns when a
      received approval exists but CYPHER_BRAIN_AR_PAID_BY does not name its payer — a
      push cannot draw on an approval it is not told about, so credits that look
      spendable here would not be. --json prints the same fields as one JSON line on
      stdout instead.
      --chain ton: print the address's on-chain nanoTON balance (tonapi, no key needed
      with --address) plus an approximate USD line (tonUsdRate). --json emits
      {address, balance_nanoton, status} as one JSON line instead — nanoTON only, no USD
      figure (the human-readable form's USD line is a display-time convenience, not a
      persisted field).

  cypher-brain doctor [--json]
      Non-destructive environment health check (#201): inspects the EXISTING setup for the
      permission/config problems several past issues were filed for (the running
      build's provenance — which commit it was built from and how many days old that
      is, WARNing past 90 days; a hand-copied deployment once ran 5+ weeks stale with
      documented features silently absent, #348 — plus: age identity 0600,
      $CYPHER_BRAIN_HOME 0700, an Arweave JWK wallet's permissions, an identity/recipient
      pairing mismatch (including an unexpected EXTRA recipient in recipient.txt that the
      identity does not derive), an empty CYPHER_BRAIN_PIN_RECIPIENTS fail-closing every
      snapshot, any recipient.txt entry missing from that same allowlist (not just the
      primary one), an offline backup keypair sharing a disk with the primary identity at
      its default location, and the last scheduled run's outcome) and reports
      PASS/WARN/FAIL/SKIP per check, each FAIL/WARN paired with the exact command that
      fixes it. Nothing not yet set up (no wallet, no schedule, ...) is treated as a
      failure — it SKIPs instead, EXCEPT a path explicitly configured via an environment
      variable (e.g. CYPHER_BRAIN_AR_WALLET) pointing at nothing, which is a FAIL. A
      permission-denied path, a symlink loop, or an unexpected file type (e.g. a FIFO) is
      its own FAIL rather than folded into the same result an absent path gets.
      Keeps a small bookkeeping file ($CYPHER_BRAIN_HOME/doctor-state.json — check ids and
      timestamps only, never key material) between runs so a WARN/FAIL you have already
      seen is marked "known" rather than re-surprising you every time you run this, while
      a genuinely NEW one is marked with a "new" marker and costs MORE against
      health_score than a known, still-unfixed one — a discount, not a full exclusion (a
      lingering FAIL still pulls the score down, so it can never read a healthy 100/100
      next to VERDICT: FAIL), so the score mostly answers "did anything get WORSE since I
      last looked" rather than "have I fixed literally everything yet" (which would sit
      low forever for a risk you have deliberately accepted). Written only when
      $CYPHER_BRAIN_HOME already exists — doctor never creates it just to leave this file
      behind on a machine with nothing set up yet.
      VERDICT: PASS (exit 0, no WARN/FAIL) / PARTIAL (exit 2, WARN only) / FAIL (exit 1,
      any check FAILs) — same three-way convention as "verify".
      --json prints one JSON object to stdout instead of the human-readable report
      (checks: [{id, status, message, remediation?, marker, since?}], resolved: [...],
      health_score, new_count, carryover_count, verdict, state_path, state_saved) — the
      SAME computation as the human-readable report, never a re-implementation.

  cypher-brain ledger [--json] [--csv]
      Read-only cumulative-cost report (#232): every "push --backend arweave|turbo" that
      actually spent money writes a RECEIPT ($CYPHER_BRAIN_HOME/receipt-ledger.jsonl, or
      CYPHER_BRAIN_RECEIPT_LEDGER — an append-only JSONL file, one object per upload,
      INCLUDING a separate entry for the .minisig signature sidecar upload when a signed
      artifact is pushed — that is its own paid upload too) — the best available
      native-unit cost figure alongside the backend's own response: for the raw arweave
      L1 backend, the authoritative signed transaction reward; for turbo, the pre-flight
      estimate that gated that specific upload (Turbo's SDK response has no separately-
      confirmed charged-amount field to read back — not a confirmed post-hoc debit, the
      best figure available). This is deliberately separate from "estimate"'s pre-flight
      forecast (never conflated) — it answers "what did we actually spend" and "how much
      cumulatively", not "what would this cost". file/rclone/ton/ton-provider pushes never
      write a receipt (nothing paid, or no receipt object to persist) and so never appear
      here. With no receipts yet, prints one line saying so (exit 0 — an empty ledger is
      a normal state, not an error). A ledger line that cannot be read at all (malformed/
      wrong-shape/future-version) is skipped and WARNS on stderr with a count — never
      silently treated as "no receipts" (a genuinely missing/never-created ledger file
      still reports zero receipts with no warning).
      Human report (default): total receipt count, cost summed BY BACKEND, BY MONTH and
      BY DAY (UTC, most recent 14 shown) — each sum kept separate PER NATIVE UNIT
      (winston/winc are different currencies, never added together). A receipt with no
      priceable cost is "unpriced" (excluded from every sum); one with a priced cost but
      an unparseable timestamp is "undated" (still counted in by-backend, excluded only
      from by-day/by-month) — the two are reported as distinct counts, never conflated.
      --json prints one object ({total_receipts, unpriced_receipts, undated_receipts,
      skipped_lines, by_backend, by_day, by_month, receipts: [...every receipt...]}) —
      the same computation as the human report, plus the full receipt array for a script
      to reprocess without a second call.
      --csv prints one row per receipt (timestamp, backend, locator, artifact_sha256,
      size_bytes, payer_address, cost, unit, raw — RFC 4180 minimal quoting) instead of
      an aggregate — wins over --json if both are given (a raw export, not a summary).

  cypher-brain audit [--json]
      Read-only hash-chain verification (#226): every "push"/"restore"/"verify" run
      (success OR failure) appends an entry to $CYPHER_BRAIN_HOME/audit-log.jsonl (or
      CYPHER_BRAIN_AUDIT_LOG — an append-only JSONL file), each entry's hash bound to the
      PREVIOUS entry's hash. This is a local integrity check against accidental or casual
      tampering, not a cryptographically authenticated log — same trust boundary as any
      other file under $CYPHER_BRAIN_HOME (the identity key included): someone who can
      already write there can also rewrite the whole chain consistently. It is a
      different concept from both the MCP idempotency log (replay detection) and "ledger"
      above (cost data, paid backends only) — this one covers every command, records no
      cost, and never mutates or drops a past entry on its own. This command recomputes
      and checks the chain; it never writes to the log itself. With no entries yet,
      prints one line saying so (exit 0 — a fresh machine has an empty, valid,
      trivially-passing chain).
      A log line that cannot be read at all (malformed/wrong-shape/future-version, or a
      field whose type doesn't match what this version writes) is skipped, WARNS on
      stderr with a count, and — unlike "ledger"'s own unreadable-line handling — makes
      the OVERALL verdict FAIL: an unreadable line is exactly what deleting or badly
      corrupting an entry looks like, so it is treated as a possible tamper, never a
      benign gap to silently subtract from the total.
      Human report (default): total entry count, the last entry's timestamp/command/
      exit code, and VERDICT: PASS or FAIL (exit code 1 on FAIL, naming the reason —
      a broken chain link and/or unreadable lines, either one alone is sufficient to fail).
      --json prints one object ({total_entries, chain_valid, broken_at_index,
      skipped_lines, last_entry}) — chain_valid reflects ONLY whether the entries that
      COULD be read form a valid chain among themselves; combine it with skipped_lines
      yourself for the same overall PASS/FAIL the human report and exit code use
      (chain_valid && skipped_lines === 0).

  cypher-brain snapshot --out <file.age> [--profile <name>] [--pg <conn>] [--pg-table <t>]...
                         [--pg-filter <file>] [--pg-exclude-table-data <t>]... [--dir <path>]...
                         [--recipient <pubkey|file>]... [--dry-run] [--scan-secrets warn|deny|off]
                         [--no-sign] [--sign-identity <file>]
      Bundle a pg_dump and/or directories, encrypt to the PUBLIC recipient(s).
      A ".cypherbrainignore" file (gitignore-compatible syntax; the "ignore" npm package
      does the matching, not a hand-rolled glob) at the ROOT of a --dir (or a --profile-
      resolved directory) filters what gets archived from that directory — node_modules,
      caches, credential files etc. never need to be tar'd, encrypted or paid for. No file
      -> unchanged behavior (every path is archived, exactly as before #216). The pre-rename
      name ".cipherbrainignore" is still read when no ".cypherbrainignore" exists. A single-file
      --dir source (a --profile file/zip) is archived as-is; it has no tree to filter.
      --dry-run previews --dir/--profile filtering WITHOUT writing, staging or encrypting
      anything (--out is not required): prints, per --dir, whether a .cypherbrainignore was
      found and the include/exclude file list with an approximate byte total for each side,
      PLUS the largest contributors (up to the top 10 by bytes, aggregated one directory
      level deep, with each one's share of the total; beyond 10 the rest are folded into
      one "other (N more)" remainder line so every byte of the source is accounted for
      across what's shown plus that line — the percentages are rounded to one decimal
      place and are not guaranteed to sum to exactly 100%) — with or without a
      .cypherbrainignore, so you can see what you are about to pay to store permanently
      before you have written a filter for it — the "capacity difference" a
      --recipient/--pg pipeline never touches until you drop --dry-run and
      actually run the snapshot.
      Also records a deterministic PLAINTEXT content digest (mtime-independent) in the
      manifest and in a "<out>.digest" sidecar, PLUS a recipients fingerprint (the
      effective age1… recipient set actually encrypted to) in a
      "<out>.recipients-fingerprint" sidecar — push --skip-unchanged reads BOTH
      sidecars and only skips when neither the content nor the recipient set changed,
      so it never re-pushes unchanged content to a paid store, and never skips past a
      changed --recipient set.
      Pass --recipient more than once (a primary + an offline backup key) for key
      recovery: any one of those identities can restore. The snapshotting machine
      never needs a private key.
      --profile is a one-flag source preset (recorded in the manifest); extra --dir
      flags are appended after the profile's paths:
        claude-code                  ~/.claude/projects/*/memory/ + ~/.claude/CLAUDE.md
                                     (whichever exist; errors if none do)
        obsidian --vault <path>      the vault directory (must contain .obsidian/;
                                     --force-vault to snapshot a vault-less dir anyway)
        chatgpt-export --zip <path>  the official ChatGPT export zip, archived as-is
                                     (never extracted)
        o2b --export <path>          an Open Second Brain bank-export bundle
                                     ("o2b brain bank-export --out <path>.json"), archived
                                     as-is (never extracted; must end in .json)
      --pg-filter <file> and --pg-exclude-table-data <table> are a thin, literal pass-through
      to pg_dump's OWN standard flags (--filter / --exclude-table-data) — cypher-brain does
      no SQL parsing or filtering of its own; pg_dump does exactly what it would if you ran
      it by hand with the same flags. Use them to build a "minimal recovery profile" snapshot
      alongside your normal full one: exclude large/low-value tables (raw conversation logs,
      embedding caches, tool-run logs) while keeping table structure and everything else.
      --pg-filter <file>            pg_dump --filter <file>: a file of one
                                     "{include|exclude} {table|schema} PATTERN" line per
                                     entry (repeatable in --pg-table); requires pg_dump >= 17.
                                     Docs: https://www.postgresql.org/docs/current/app-pgdump.html#PG-DUMP-FILTERING
                                     Example file:
                                       include table conversation_summaries
                                       exclude table conversation_logs
                                       exclude table embedding_cache
      --pg-exclude-table-data <t>   pg_dump --exclude-table-data <t> (repeatable): keep the
                                     table's SCHEMA in the dump but drop its ROWS — e.g. a
                                     large cache table you want restorable-empty rather than
                                     absent entirely.
      Both are additive to --pg-table and to each other; omit them and --pg behaves exactly
      as before (a full pg_dump, no filtering).
      --scan-secrets warn|deny|off (#215) runs gitleaks (install via
      https://github.com/gitleaks/gitleaks) over each --dir/--profile source's staged
      plaintext BEFORE it is archived+encrypted — Arweave/Turbo are write-once,
      un-deletable backends, so an accidentally-committed API key/token/password can
      never be scrubbed after the fact. DEFAULT (#301): warn, whenever there is a
      --dir/--profile source AND gitleaks is resolvable; otherwise nothing scans,
      nothing errors, and no new dependency appears. This is the only path that may
      skip quietly — you did not ask for a gate, so nothing claims one ran. An
      EXPLICIT --scan-secrets that cannot scan always refuses instead.
      warn: log any findings (rule ID + count only — never the matched
      secret, file path, or line) and proceed. deny: refuse the whole snapshot if
      any component has findings. off: do not scan, said out loud — the way to turn
      the default off without uninstalling gitleaks.
      Drop a .gitleaks.toml into a scanned source to
      customize/allowlist rules, same as you would for a git repo. It covers
      --dir/--profile sources only — a --pg dump is not scanned — so a snapshot with
      neither is REFUSED rather than reporting a scan that inspected no component.
      For the same reason it cannot be combined with --dry-run, which stages no
      plaintext for gitleaks to look at.
      KNOWN LIMIT, so you can judge what the gate is worth for your sources: gitleaks
      reads files as they are and does NOT look inside archives, so a zip/tar source
      (notably --profile chatgpt-export, which archives the export zip as-is) is
      scanned only as opaque bytes — a secret inside it will NOT be found, even
      though the run reports the mode. Extract such an export and snapshot the
      directory if you want the gate to actually cover its contents. --profile o2b's
      bundle is plain JSON, not an archive, so gitleaks DOES read its actual text
      content the same as any other file.
      Authenticity (#214): whenever a signing identity exists (default
      $CYPHER_BRAIN_HOME/sign-identity.key, from "keygen --sign"; --sign-identity picks
      a different one), snapshot ALSO writes a detached "<out>.minisig" signature over
      the ciphertext — automatic, no separate flag needed. restore/verify then check it
      BEFORE decrypting. --no-sign skips this even when a signing identity is present.
      No signing identity at all -> unchanged pre-#214 behavior (no *.minisig written).

  cypher-brain restore --in <file.age> --out-dir <dir> [--identity <file>] [--pg <conn>] [--yes] [--no-expand-components]
                        [--sign-recipient <file>] [--require-signature]
      Decrypt with the PRIVATE identity. Extraction never clobbers a file already
      present in --out-dir: an existing file is left untouched, the rest of the
      archive still extracts around it, and the collision itself is not an error.
      That is restore's own behavior, not a flag you pass — it uses tar's own
      --skip-old-files on GNU tar and --keep-old-files on bsdtar, which are those
      two tars' spellings of the same thing.
      Every --dir/--profile component's staged tarball is then auto-expanded into
      "<out-dir>/expanded/<NNN>-<source basename>-<digest>/", keyed to the component's
      ORIGINAL absolute source path (from manifest.json) rather than its on-disk name —
      so components with a colliding basename (e.g. many claude-code project memory/
      dirs) still land in separate directories, even across two SEPARATE restores into
      the same --out-dir. A "expanded/README.txt" (and the same mapping on stdout)
      records which expanded directory came from which FULL source path. Nothing is
      ever written back to that original absolute path — this only ever
      creates NEW directories under --out-dir. Re-running restore into the same
      --out-dir does not clobber a prior expansion (same no-clobber posture as the outer
      extract). --no-expand-components skips this step, leaving only the raw *.tar.gz
      files (the pre-#181 behavior).
      --pg additionally pg_restore's the db.dump into that connection, independently of
      the expand step above (pg_dump's component has no "source" field, so the two never
      touch the same thing). pg_restore --clean --if-exists DROPS and replaces objects
      in the target database — an irreversible operation — so it requires --yes or
      CYPHER_BRAIN_YES=1 to confirm, same as push's paid-backend guard below. Bounded by
      the same pipe timeout as the decrypt/extract step (CYPHER_BRAIN_PIPE_TIMEOUT).
      Authenticity (#214): checked FIRST, before any decryption. If "<in>.minisig"
      exists AND a signing public key is configured (default
      $CYPHER_BRAIN_HOME/sign-recipient.pub; --sign-recipient picks a different one),
      an INVALID signature refuses to restore outright (nothing is decrypted or written).
      An absent signature (unsigned/legacy artifact) or an absent signing public key on
      this box only warn and proceed — this never breaks a pre-#214 backup. --require-
      signature turns that warn into a refusal too: an attacker who simply DELETES the
      .minisig sidecar (rather than forging one) no longer silently succeeds either.

  cypher-brain verify --in <file.age> [--identity <file>] [--sha256 <hex>] [--sign-recipient <file>] [--require-signature] [--json]
                       [--level quick|remote|drill]
      Assert it is real age ciphertext, a wrong key cannot open it, AND (when the
      private identity is on this box) that YOUR key decrypts it into a well-formed
      bundle. --sha256 also pins the artifact to an expected hash. Authenticity (#214):
      if "<in>.minisig" exists and a signing public key is configured (default
      $CYPHER_BRAIN_HOME/sign-recipient.pub; --sign-recipient overrides), verifies it
      too — an INVALID signature is a hard FAIL and skips the positive-control decrypt
      below (an artifact already known to be tampered/forged proves nothing by
      decrypting); no signature or no configured public key just [SKIP]s this check
      by default. --require-signature upgrades that [SKIP] to a hard FAIL too — use it
      once you have run "keygen --sign" and expect every artifact you verify to carry
      a valid signature; without it, an unsigned/legacy artifact still reaches PASS.
      VERDICT: PASS (exit 0) / FAIL (exit 1) / PARTIAL (exit 2 — decryptability not
      proven, e.g. public-key-only box).
      --level (issue #209) picks how deep the check goes, restic/kopia-style — each
      level is a strictly deeper (slower, more expensive) proof than the one before:
        quick  (default, unchanged): everything above, against the LOCAL --in file —
               no network access. Refuses --locator/--backend/--from-locator-file
               (those name something to FETCH; quick never fetches anything).
        remote: pulls the artifact by --locator <id> --backend <name> (or
               --from-locator-file <path>, same contract as "pull") into a scratch temp
               file, then runs the SAME checks above against THAT — proving the object
               is still actually retrievable from storage and unchanged, not merely
               that a local copy still parses. Rejects --in (remote fetches instead).
        drill:  does everything remote does, and — only once those checks reach
               PASS — ALSO decrypts and extracts the pulled artifact into a scratch
               out-dir (the same code path "restore" runs), the full
               pull -> decrypt -> extract rehearsal MANAGEMENT.md's restore runbook
               describes. Refuses --pg (a verification drill must never run
               pg_restore against a live database); the scratch directory is always
               removed afterward, success or failure.
      A failed remote/drill fetch reports VERDICT: FAIL (exit 1) rather than a raw
      error — retrievability itself is what those two levels test.
      --json prints one JSON object to stdout instead of the human-readable report.
      quick: {file, size_bytes, checks: {age_header, sha256_match, signature,
      wrong_key_rejected, positive_control}, verdict, exit_code} — the SAME checks
      computed above, so it never disagrees with the human-readable report or the MCP
      verify_restore tool. remote adds {level, pulled: {backend, locator, sha256_pin,
      fetched}} alongside checks. drill replaces positive_control's role with a
      {full_restore: true|false|"skip", full_restore_error?} pair once the pulled
      checks reach PASS. The exit code is unchanged either way. If the command ERRORS
      instead (#270 — a missing file, an unreadable identity), stdout carries an error
      object ({error, code, exit_code}) rather than nothing, so a --json caller never
      has to fall back to scraping stderr; "code" is the CB-E0xx identifier when the failure
      matches a known one (MANAGEMENT.md#error-codes), null otherwise.

  cypher-brain push --in <file.age> --backend <file|arweave|turbo|rclone|ton|ton-provider> [--remote <name>:<path>] [--yes] [--plan <path.json>] [--save-locator <path>] [--skip-unchanged] [--digest <hex>] [--force]
      Upload ciphertext to storage. Prints ONLY the locator to stdout
      (file: store path; arweave: tx id; turbo: ANS-104 data item id; rclone: the
      --remote value itself; ton: "ton:v1:<bag-id>"; ton-provider: "ton-provider:v1:<bag-id>").
      Storage sees ciphertext only.
      Transfer progress (#283) is printed to stderr on the backends that can actually be
      slow: turbo uploads (from the SDK's own progress events), rclone transfers (rclone's
      periodic stats, translated), an arweave gateway READ during pull, and ton-provider's
      wait for the chosen provider to finish fetching the bag over P2P (bytes downloaded
      so far, from its own self-reported status). file is a local copy and the L1 arweave
      upload is capped at ~10 MiB, so neither reports anything. How OFTEN depends on
      whether stderr is a terminal — roughly every 2s when a human is watching, roughly
      every 30s when it is a nightly log or an MCP tool result, both of which keep
      everything they are given.
      arweave/turbo are paid permanent stores — require --yes or CYPHER_BRAIN_YES=1;
      both print a native-unit cost estimate (winston/winc) before uploading, plus an
      approximate USD line when a USD/AR rate is fetchable — a rate failure drops that
      line only, never the native estimate. Preview the same estimate beforehand
      without pushing anything via "cypher-brain estimate".
      --plan <path.json> (#231): re-validate a plan file written by "estimate --out"
      against the CURRENT state before proceeding — refuses (before any consent prompt)
      if the artifact (sha256), backend, --remote, price (beyond a 10% drift tolerance),
      or the configured payer address no longer match what was reviewed when the plan
      was made, or if the plan has expired (15 minutes after creation, not
      configurable). ADDITIVE to --yes/CYPHER_BRAIN_YES, not a replacement — a validated
      plan still has to clear that consent gate too, and CYPHER_BRAIN_MAX_SPEND (#105),
      enforced separately inside the upload itself, remains the actual cap on spend.
      A plan.json is a plain local file, not cryptographically signed — the same trust
      boundary as the wallet/identity key files already on disk, not a defense against
      someone who already has access to those. Works with any --backend (free backends
      just validate artifact/backend/remote/expiry; there is no price to drift). See
      "estimate" below for how a plan is created.
      --backend rclone --remote <rclone-remote-name>:<path> shells out to the
      rclone binary (rclone copyto <in> <remote>), delegating auth/protocol for
      any of rclone's 70+ supported providers to your own rclone config — cypher-
      brain implements none of them itself. Free (like file); needs rclone on
      PATH and a remote already set up via 'rclone config' (or a config-less
      on-the-fly remote, e.g. --remote ":local:/path"). --remote is required.
      --backend ton stores the ciphertext as a TON Storage bag SEEDED FROM YOUR OWN
      always-on box (the "seeder": a machine running tonutils-storage, reached over
      SSH — CYPHER_BRAIN_TON_SSH_HOST etc., see Settings below). The bag is created
      ON the seeder (the machine that must retain it), the locator is
      "ton:v1:<64-hex-bag-id>", and re-pushing unchanged ciphertext is idempotent
      (same bytes -> the recorded locator, no re-upload). Free per upload (your
      seeder's running cost is the cost) — but NOT permanent storage: a bag is
      retrievable only while at least one reachable seeder retains it. Pull's
      primary path is a real P2P download (no SSH key needed on the restoring
      machine); the seeder is only a loud, explicit fallback.
      --backend ton-provider pays a LIVE THIRD-PARTY provider (self-registered on
      mytonprovider.org, the current Go/StorageV1 scheme) to hold the bag instead of
      seeding it yourself — no always-on box of your own required. Requires
      CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (a nanoTON spend cap; a StorageV1 deploy
      spends real funds, same posture as arweave/turbo's spend cap). The contract's
      owner comes from ONE of two places: if CYPHER_BRAIN_TON_WALLET is configured (a
      local TON wallet — 'wallet create --chain ton', issue #396 PR2), that wallet's own
      address is used and it auto-signs+broadcasts the deploy itself, no human involved
      — the same "runs unattended" shape arweave/turbo's JWK signer already has, which
      is what lets this run under 'schedule install' and MCP too. Otherwise
      CYPHER_BRAIN_TON_PROVIDER_OWNER (a plain address, no local key) is required, and
      push prints a Tonkeeper deeplink for a HUMAN to sign in their own wallet app
      instead. (If BOTH are set and disagree, push REFUSES outright rather than picking
      one silently — auto-signing requires sender==owner on-chain, so there is no safe
      way to guess which address the operator actually meant; unset
      CYPHER_BRAIN_TON_PROVIDER_OWNER, or fix it to match the wallet's own address, and
      re-run.) Before signing/printing the deeplink it runs an advisory pre-deploy
      funds check against the owner address's own on-chain balance (see Spend below) —
      a WARNING only, never a refusal, for either path: whichever one actually spends —
      the human's wallet app, or the auto-sign broadcast itself — already gives its own
      unambiguous refusal on a real shortfall; this just saves the trip through the wait
      below on a spend that was always going to fail. Notifying the chosen provider
      shells out to a locally built scripts/go/storage-v1-client binary
      (CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN) — an ADNL/RLDP query with no mature
      TypeScript implementation — and the wait for it to report a full download is what
      the Transfer progress paragraph above covers. The locator is
      "ton-provider:v1:<64-hex-bag-id>"; pull is the same P2P download ton uses, with
      no seeder-SSH fallback (this backend never operates a seeder of its own).
      --save-locator writes "<locator>\\t<backend>\\t<sha256>[\\t<content_digest>[\\t
      <recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]" to a file (rewritten
      atomically each push, so it always holds the LATEST + an integrity pin; legacy
      3/4/5/6-field files are still accepted everywhere). Back this file up off-box next
      to your identity: it is the durable pointer a fresh machine needs to find the most
      recent snapshot. (For the file backend the locator is a LOCAL store path —
      arweave/turbo locators are
      always portable to another machine; an rclone locator is portable too, PROVIDED
      the same remote name is configured there — a config-less ":local:/path" remote
      is as machine-local as the file backend.)
      Authenticity (#214): if "<in>.minisig" exists (snapshot writes one automatically
      when a signing identity is present — see "snapshot" above), it is ALSO uploaded to
      the SAME backend right after the ciphertext, under the SAME already-granted
      consent — its own locator becomes the 6th --save-locator field above, so pull can
      fetch it back automatically, and the signing key id inside it becomes the 7th
      (#250, see --skip-unchanged below). Unchanged behavior when no sidecar exists.
      --skip-unchanged (requires --save-locator): skips ONLY when ALL THREE of (a) the
      snapshot's PLAINTEXT content digest — read from the "<in>.digest" sidecar
      snapshot writes, or given as --digest <hex> — equals the content_digest recorded
      in the save-locator file for the same backend, (b) the recipients
      fingerprint — read from the "<in>.recipients-fingerprint" sidecar — equals the
      recipients_fingerprint recorded there too, AND (c) the SIGNING state matches:
      an unsigned artifact where the last push was unsigned too, or a "<in>.minisig"
      whose signing key id equals the sign_key_id recorded there. Requiring (b) means a
      re-snapshot of unchanged plaintext under a CHANGED --recipient set (a newly added
      recovery key, a removed/revoked key) is never skipped; requiring (c) means turning
      signing ON ("keygen --sign") or ROTATING the signing key is never skipped either —
      otherwise the store would keep an unsigned, or stale-key-signed, copy of content
      you now expect to be signed with the current key. When all three match: print
      SKIPPED + the previous locator and exit 0 WITHOUT contacting storage or spending.
      Any missing piece on EITHER side (no sidecar, a legacy 3/4-field file, a signed
      push recorded before #250 added the 7th field, a different backend)
      just pushes normally: skip is an optimization, never a gate. --force uploads even
      when unchanged. (The digest is plaintext-side by necessity: age's ephemeral file
      key makes identical content encrypt to different ciphertext bytes every run.)

  cypher-brain estimate --in <file.age> --backend <file|arweave|turbo|rclone|ton|ton-provider> [--json] [--out <path.json>]
      Read-only preview: print what pushing --in to --backend would cost WITHOUT
      uploading anything. turbo/arweave show the native unit (winc/winston) plus
      an approximate USD line when a USD/AR rate is fetchable; ton-provider shows
      the native unit too (nanoTON, a real mytonprovider.org priced query) plus its
      own approximate USD line when a USD/TON rate is fetchable (tonapi's public
      rates endpoint — a rate failure drops that line only, same posture as
      turbo/arweave). file, rclone and ton are always reported as free (rclone's
      actual transfer/storage cost, if any, is whatever the operator's own cloud
      contract for that remote charges — cypher-brain cannot query it; ton's is the
      operator's own seeder box). Sizes --in the same way push does (a real byte count
      off disk). The SAME computation backs the MCP estimate_cost tool, so the two
      never disagree.
      --json prints the same CostEstimate object as one JSON line on stdout
      (backend, size_bytes, cost, unit, approx_ar, usd_estimate, note) instead of
      the human-readable report — field-for-field identical to what estimate_cost
      returns. All seven keys are ALWAYS present (#268): a backend with no native
      unit, or a query that could not run, reports null rather than dropping the key,
      so the object shape does not depend on which backend was asked about. On an
      ERROR, stdout carries {error, code, exit_code} instead (#270 — see verify).
      --out <path.json> (#231): ALSO write a "plan" pinning this exact estimate to the
      artifact (sha256 of --in), --backend, --remote (rclone only, null otherwise), the
      configured payer address (if any wallet is set up for this backend — null
      otherwise), and an expiry 15 minutes from now. Additive to the normal report
      above (stdout/exit code unchanged either way). Feed the path to
      "push --plan <path.json>" to have push refuse instead of proceeding if the
      artifact, backend, remote, price, or payer drifted since the plan was made — the
      Terraform plan/apply pattern, binding what push actually validates before its
      consent gate to what "estimate --out" reviewed (see "push --plan" above for what
      that guarantee does and does not cover).

  cypher-brain pull (--locator <id> --backend <…> | --remote <name>:<path> --backend rclone | --from-locator-file <path>) --out <file.age> [--wait <seconds>] [--sha256 <hex>] [--sig-locator <id>] [--force]
      Fetch ciphertext by locator into --out. --from-locator-file reads the locator, its
      backend AND the saved sha256 from a file written by push --save-locator (the recovery
      path: identity + this file are all a fresh machine needs; the saved sha256 is applied
      as the integrity pin automatically). --wait retries while the item is not yet
      retrievable (a fresh Turbo/Arweave upload takes ~5-8 min to propagate); default 0.
      --sha256 fail-closes the fetch: the bytes must match the expected hash (sourced
      out-of-band from a trusted index) or pull errors, having written nothing to --out.
      No-clobber by default: refuses to overwrite an existing --out (the recovery steps
      above reuse a fixed filename, so a second pull could otherwise destroy the first
      one's result) — pass --force to overwrite it anyway.
      --backend rclone accepts --remote <name>:<path> in place of --locator (the
      rclone backend's locator IS that string — see push's rclone section above);
      an explicit --locator still wins if both are given.
      Authenticity (#214): --sig-locator <id> (or the 6th --from-locator-file field,
      read automatically) ALSO fetches the "<in>.minisig" sidecar push uploaded, into
      "<out>.minisig" — best-effort, never fails the pull itself (restore/verify treat a
      missing sidecar as a warning, not a failure). Omit it and pull behaves exactly as
      before #214 (ciphertext only).

  cypher-brain publish-latest --domain <name>.ton --from-locator-file <path> [--yes] [--wait <seconds>]
      Opt-in: point your OWN .ton DNS domain's "storage" record at the ton backend's
      LATEST bag id (read from --from-locator-file, a file push --save-locator wrote —
      the same recovery pointer pull reads), so a fresh machine can discover the newest
      encrypted-backup bag from a human-memorable name instead of needing that file
      itself. NEVER run automatically by 'schedule install' — a deliberate,
      operator-invoked action, because it also makes your snapshot cadence and current
      bag id PUBLIC (docs/durability.md: DNS is a discovery pointer, never the integrity
      source — the sha256 pin still lives in the locator file, and a pull should still
      verify it).
      --domain must be a lowercase .ton domain (dot-separated [a-z0-9-] labels ending in
      ".ton", e.g. "myname.ton") — anything else is refused up front rather than
      travelling all the way to a confusing tonapi 404.
      Refuses a locator file whose backend is not "ton", or whose locator does not match
      "ton:v1:<64-hex-bag-id>".
      Availability gate (required, before anything is printed): spins an ephemeral local
      TON Storage daemon and probes the bag id on the real P2P network (metadata found
      via DHT AND at least one byte served — a PROBE, not a full download; the whole
      probe, daemon startup included, shares one ~180s budget — under 4 minutes worst
      case). A bag that is not reachable right now is refused with "DNS must never point
      at an unavailable bag", rather than publishing a domain that resolves to nothing.
      Resolves --domain's NFT item address via tonapi (CYPHER_BRAIN_TON_TONAPI_URL,
      default https://tonapi.io) and builds the on-chain change_dns_record message body
      (a dns_storage_address record over the bag id) — but cypher-brain NEVER signs it.
      tonapi is the ONLY source for that NFT address (there is no independent on-chain
      domain -> NFT-address resolver to cross-check against), so the resolved address is
      printed alongside a tonviewer.com link and a warning: confirm the recipient
      Tonkeeper shows equals the printed address before approving anything.
      Prints the domain, the resolved NFT address, the bag id, and (gated behind --yes /
      CYPHER_BRAIN_YES, since acting on it spends ~0.02 TON gas from your wallet) a
      Tonkeeper transfer deeplink (https://app.tonkeeper.com/transfer/...) to stdout:
      open it yourself, review the transaction in your own wallet, and approve it there —
      this command only prepares the link.
      --wait <seconds> (default 0, max 86400/24h, a non-negative whole number — anything
      else is refused): after printing, poll tonapi's DNS resolution until the domain's
      storage record equals the published bag id, then report CONFIRMED or NOT-YET.

  cypher-brain recovery-kit --from-locator-file <path> [--out <file>] [--force]
                            [--inline-identity] [--backup-identity <path>] [--backup-recipient <age1…|file>]
      Regenerate the printable recovery kit "init" prints once — pointed at the CURRENT
      latest push instead of the first one (#364: every push changes the locator/sha the
      kit exists to carry, so a printed kit goes stale each cycle). Renders through the
      SAME builder init uses, from --from-locator-file (a file push --save-locator wrote)
      plus the standard key layout under CYPHER_BRAIN_HOME (deliberately no per-file
      identity override: the kit pairs the identity with recipient.txt, and swapping one
      half per-flag could claim a recipient the embedded key cannot satisfy). Prints to
      stdout by default; --out writes 0600 via an exclusive-create temp and an ATOMIC
      no-clobber promote (same primitive as pull's --out) — --force replaces instead.
      --inline-identity ALSO embeds the primary identity — accepted only when the file
      really is a passphrase wrap (age ciphertext whose first stanza is scrypt; classified
      from the bytes, not a marker sniff). A bare private key in a printable,
      paste-anywhere document is refused outright; a BINARY wrap is re-armored to the
      printable age -p -a encoding. The wrap passphrase is never part of the kit.
      --backup-identity <path> inlines a backup identity the way init's wizard does (the
      kit IS how a backup key goes off-box). An unwrapped one is accepted but warned about
      loudly; a wrapped one is re-armored if binary and needs --backup-recipient
      <age1…-or-path>, since its public recipient cannot be derived without the
      passphrase. PQ hybrid identities (AGE-SECRET-KEY-PQ-1…) classify and derive the
      same as X25519 ones.
      A regenerated kit marks the profile/Postgres columns "unknown" rather than guessing —
      the locator file does not record them.
      CLI-only by design: no MCP tool exposes this (the kit can embed PRIVATE key blocks,
      which must never land in an agent's tool-result context or logs).

  cypher-brain schedule install --backend <file|arweave|turbo|ton-provider> [--at HH:MM] [--max-spend <n>] [--no-load]
                                [--profile <name>] [--pg <conn>] [--pg-table <t>]...
                                [--pg-filter <file>] [--pg-exclude-table-data <t>]... [--dir <path>]...
                                [--recipient <pubkey|file>]... [--vault <path>] [--zip <path>] [--export <path>]
                                [--save-locator <path>] [--index-file <path>]
                                [--ping-url <url>] [--ping-url-fail <url>]
                                [--scan-secrets warn|deny|off]
      Make the nightly snapshot+push unattended. Writes a runner script
      ($CYPHER_BRAIN_HOME/schedule/nightly.sh) composing the snapshot/push pipeline from
      the SAME flags those commands take — dated outputs, --save-locator, an index.tsv
      append — plus the platform trigger (macOS: a launchd plist in ~/Library/LaunchAgents;
      Linux: a crontab entry), and registers it. Default --at 03:30: run well after the
      source re-synthesizes overnight so the DB and files are captured from the same
      settled state (MANAGEMENT.md, "Avoid the write window"). Paid backends
      (arweave/turbo) REQUIRE --max-spend <n>: the runner gets CYPHER_BRAIN_YES=1 for the
      unattended consent, so it must also get a CYPHER_BRAIN_MAX_SPEND cap — an uncapped
      unattended spender is refused. --no-load writes the artifacts without registering.
      Each run logs to $CYPHER_BRAIN_HOME/schedule/logs/nightly-YYYY-MM-DD.log, ending
      "OK rc=0" or "FAILED rc=N".
      --ping-url <url> adds a healthchecks.io-style dead man's switch: the runner curl's
      <url> (best-effort, 10s timeout, never affects the run's own outcome) on every
      successful run, and <url>/fail on every failed run — so a schedule that silently
      stops running (a wedged launchd/cron, a box left off) gets noticed even without
      anyone running 'schedule status'. --ping-url-fail overrides the failure URL
      (default: <url>/fail — a plain string append, not URL-aware: pass --ping-url-fail
      explicitly if your ping URL has a query string or a trailing slash); it requires
      --ping-url to also be set.
      --scan-secrets warn|deny|off bakes snapshot's gitleaks gate (see 'snapshot' above)
      into the generated runner, so the unattended nightly — the run nobody is watching —
      is gated too. The EFFECTIVE mode is always baked, including when you pass nothing:
      install resolves the same default snapshot would (warn if there is a --dir/--profile
      source and gitleaks is resolvable, otherwise off) and writes it in explicitly, so the
      nightly cannot start scanning — or stop — because of what lands on PATH months later.
      Install RESOLVES gitleaks now and PINS the absolute path into the runner
      as CYPHER_BRAIN_GITLEAKS_BIN (launchd/cron do not inherit your PATH, same reason
      --pg bakes CYPHER_BRAIN_PG_BIN; pinning rather than extending PATH so a different
      gitleaks on the scheduler's PATH cannot take its place), and REFUSES to install if
      it cannot be resolved — a schedule that cannot scan is never installed as if it
      could. An explicit CYPHER_BRAIN_GITLEAKS_BIN is resolved and validated the same way,
      not taken on trust: a bare name or a stale path there would be just as unusable to
      the scheduler. Same --dir/--profile requirement as 'snapshot': a
      --pg-only schedule is refused rather than reporting a scan of no component.
      Fail-closed at run time too: if gitleaks later disappears, the nightly FAILS rather
      than silently skipping the scan.

  cypher-brain schedule status [--json]
      Report the configured time + backend, whether a dead man's switch ping-url is
      configured, the trigger load state, the last run log and its final rc line, and the
      next scheduled run.
      --json prints one JSON object to stdout instead of the human-readable report
      (configured, runner, ping, trigger: {type, loaded, legacy, ...}, last_run,
      next_run) — the SAME state read above, so it never disagrees with the
      human-readable report or the MCP schedule_status tool. "not installed" is an
      ordinary state to poll for, not an exception, so it too answers in JSON on
      stdout ({error, code: "CB-E014", exit_code}) instead of prose on stderr (#270).

  cypher-brain schedule uninstall
      Unregister the trigger and remove the generated runner/plist/cron entry (idempotent;
      logs, snapshots and index.tsv are kept — they are your data).

Config file: every setting below can also live in $CYPHER_BRAIN_HOME/config.env (KEY=value
     per line, "#" comments) instead of the environment — the same names, one place, read by
     the CLI and the MCP server alike. An explicit environment variable always WINS over the
     file. CYPHER_BRAIN_HOME is the one exception: this file is found INSIDE it, so it cannot
     set it (a file that tries is warned about, not silently obeyed). An unknown CYPHER_BRAIN_*
     key is an ERROR rather than a no-op — a "CYPHER_BRAIN_MAXSPEND" typo would otherwise
     silently drop your spend cap. ONLY CYPHER_BRAIN_* settings (or their pre-rename
     CIPHER_BRAIN_* spelling — the same setting under both is refused as ambiguous) are
     applied: any other key in the file (TMPDIR, a proxy variable, ...) is read but never
     put into the environment, so
     the file cannot reach through into the processes cypher-brain spawns.
     Secrets are allowed (it warns if the file is group/other-readable — chmod 600 it).
     'schedule install' BAKES the values in effect at install time into the runner AND makes
     that runner skip this file, so editing it never retunes — or breaks — an already-
     installed nightly run; re-run install to pick changes up. 'schedule status' names the
     file it loaded.
Env: CYPHER_BRAIN_HOME (default ~/.cypher-brain; an existing ~/.cipher-brain is used while no
     ~/.cypher-brain exists), CYPHER_BRAIN_PG_BIN (dir of pg_dump/pg_restore). Every variable
     below is also read under its pre-rename CIPHER_BRAIN_* spelling (the CYPHER_BRAIN_* one
     wins when both are set).
     CYPHER_BRAIN_SCHEDULE_DIR (schedule artifacts/logs dir; default $CYPHER_BRAIN_HOME/schedule).
     CYPHER_BRAIN_LAUNCHD_DIR (macOS only: where 'schedule install' writes the launchd plist;
     default ~/Library/LaunchAgents — a REAL system dir, NOT scoped to CYPHER_BRAIN_HOME, written
     even under --no-load; override to sandbox a --no-load preview run).
     CYPHER_BRAIN_PASSPHRASE (non-interactive passphrase for a wrapped identity — automation/CI; otherwise prompted on the TTY).
     CYPHER_BRAIN_PIN_RECIPIENTS (snapshot: allowlist of age1… pubkeys, inline or a file — refuse to encrypt to any other recipient).
     CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1 (init: bypass its TTY requirement — automation/CI only, e.g. this repo's own selftest; a human just runs init directly in a terminal).
Storage: CYPHER_BRAIN_RECEIPT_LEDGER (default $CYPHER_BRAIN_HOME/receipt-ledger.jsonl — every arweave/turbo push's actual-cost receipt, #232; see 'ledger' above).
         CYPHER_BRAIN_AUDIT_LOG (default $CYPHER_BRAIN_HOME/audit-log.jsonl — hash-chained record of every push/restore/verify run, #226; see 'audit' above).
         CYPHER_BRAIN_FILE_DIR (file);
         CYPHER_BRAIN_AR_{HOST,PORT,PROTOCOL,WALLET,GATEWAY,GATEWAYS,HTTP_TIMEOUT,USD_RATE_URL,TURBO_RATES_URL,BALANCE_URL} (arweave; CYPHER_BRAIN_AR_WALLET is a path to a JWK key file — 'cypher-brain wallet create' generates one, 'wallet address' shows what to fund; the 'arweave' npm package is needed only to PUSH or for the rare L1 chunk fallback — a gateway pull needs none; the approximate-USD lines price each backend in its own truthful unit: the raw arweave L1 backend at AR SPOT (CYPHER_BRAIN_AR_USD_RATE_URL — the spend is real AR at market value), the turbo backend and 'wallet balance' at Turbo's own credit rate, fees included (CYPHER_BRAIN_AR_TURBO_RATES_URL — a turbo upload spends credits, and credits sell at Turbo's price, not AR spot; pricing them at spot understated a real push's cost by ~35%), falling back to labeled AR spot only when that price sheet is unavailable or unusable; a dead rate endpoint just omits the USD line, it never blocks a push; CYPHER_BRAIN_AR_BALANCE_URL overrides the payment-service account endpoint 'wallet balance' queries as '<url>?address=<addr>');
         turbo: CYPHER_BRAIN_AR_WALLET (JWK signer) + optional CYPHER_BRAIN_AR_PAID_BY (an address sharing Turbo Credits to that signer); needs '@ardrive/turbo-sdk' to PUSH (a pull reuses the arweave gateway read, no SDK). Funding/credit-share details: docs/arweave-upload-runbook.md.
         rclone: CYPHER_BRAIN_RCLONE_BIN (path to the rclone binary; default 'rclone' on PATH) — the remote itself is whatever --remote <name>:<path> names in your own 'rclone config'.
         ton: CYPHER_BRAIN_TON_SSH_HOST (user@host of your seeder box running tonutils-storage — required to PUSH; also the pull fallback), CYPHER_BRAIN_TON_SSH_KEY (optional ssh -i identity file), CYPHER_BRAIN_TON_REMOTE_DIR (seeder-side layout root; default 'cypher-brain-ton' in the SSH user's home — plain relative or absolute path, a literal ~ is refused), CYPHER_BRAIN_TON_REMOTE_API (the seeder daemon's API address as seen FROM the seeder itself; default '127.0.0.1:9955' — it stays loopback-bound there, reached via ssh, never exposed), CYPHER_BRAIN_TON_BIN (local tonutils-storage binary for the P2P pull; default 'tonutils-storage' on PATH), CYPHER_BRAIN_TON_HTTP_TIMEOUT (ms; default 30000), CYPHER_BRAIN_TON_NO_FALLBACK=1 (strictly '1': forbid the seeder fallback on pull, so a success PROVES P2P availability — use for verify --level remote when you want that proof), CYPHER_BRAIN_TON_NETWORK_CONFIG (path to a TON global config JSON for testnet; default mainnet), CYPHER_BRAIN_TON_TONAPI_URL (tonapi.io base URL 'publish-latest' resolves a .ton domain's NFT address and polls its DNS record against; default 'https://tonapi.io').
         ton-provider: CYPHER_BRAIN_TON_WALLET (path to a local TON wallet mnemonic — 'wallet create --chain ton' — issue #396 PR2; when set, its own address becomes the contract owner and PUSH auto-signs+broadcasts with no human involved, which is also what makes this backend reachable via 'schedule install'/MCP), CYPHER_BRAIN_TON_PROVIDER_OWNER (TON wallet address that will own the deployed StorageV1 contract — required to PUSH only when CYPHER_BRAIN_TON_WALLET is NOT set; PUSH refuses outright, rather than silently overriding it, if both are set and disagree), CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (nanoTON spend cap — required to PUSH either way, a deploy spends real funds), CYPHER_BRAIN_TON_PROVIDER_NOTIFY_BIN (path to a locally built scripts/go/storage-v1-client binary — required to PUSH, notifying a provider needs an ADNL/RLDP query this project has no TypeScript implementation for), CYPHER_BRAIN_TON_PROVIDER_MYTONPROVIDER_URL (provider registry base URL; default 'https://mytonprovider.org'). Also uses CYPHER_BRAIN_TON_BIN/CYPHER_BRAIN_TON_NETWORK_CONFIG (the local ephemeral daemon that hashes and temporarily seeds the bag) and CYPHER_BRAIN_TON_TONAPI_URL (polling the deploy for on-chain confirmation, AND the approximate-USD line's rate source — tonapi's own public rates endpoint, no separate URL setting needed; auto-sign's broadcast and seqno lookup use this same URL too) from the ton settings above.
Tracing: OTEL_EXPORTER_OTLP_ENDPOINT (opt-in, #226 part 3 — a THIRD-PARTY standard env
     var, not a CYPHER_BRAIN_* name, so it is NOT also read under CIPHER_BRAIN_* and has
     no config.env entry, and it is a BASE endpoint — the '/v1/traces' path is appended
     automatically, matching the OTel spec: 'http://localhost:4318', not
     'http://localhost:4318/v1/traces'). When set, every DISPATCHED CLI command and MCP
     tool call becomes an OpenTelemetry span exported there via '@opentelemetry/api' +
     'sdk-trace-node' + 'exporter-trace-otlp-http' — optionalDependencies (like
     '@ardrive/turbo-sdk' above: a normal registry or from-source install already
     carries them; only an install run with --omit=optional skips them). A missing or
     broken package WARNS once on stderr and falls back to a no-op, since tracing must
     never gate a real push/restore/verify the way a missing SDK gates an actual paid
     upload elsewhere. Unset (the default): a pure passthrough — no OTel package is even
     imported, so a machine that has never heard of OTel pays nothing for this feature
     existing.
Spend: arweave/turbo PUSH needs --yes or CYPHER_BRAIN_YES=1 (paid, permanent); CYPHER_BRAIN_MAX_SPEND caps the arweave/turbo cost estimate (winston/winc). ton-provider PUSH needs --yes or CYPHER_BRAIN_YES=1 too, plus CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND (nanoTON) — signed either by a human in Tonkeeper (no CYPHER_BRAIN_TON_WALLET configured) or auto-signed by a local wallet (CYPHER_BRAIN_TON_WALLET set — issue #396 PR2, the same "runs unattended" shape as arweave/turbo's JWK signer, which is what lets it run under 'schedule install'/MCP too). A turbo push also runs a funds check BEFORE signing: when the estimated cost exceeds even the reachable credit (the signer's own balance + the live approvals CYPHER_BRAIN_AR_PAID_BY selects), the spend is headed for a payment-service refusal that would otherwise arrive only after minutes of signing. On a TTY (a human watching) it aborts with the funding steps spelled out, after confirming the shortfall on a second balance read so a top-up landing that same moment is not blocked; without a TTY (a nightly runner, an MCP host) it only WARNS and proceeds — a balance read has no freshness guarantee, and it must never be what blocks an unattended backup. Skipped entirely when the balance cannot be read at all; CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 (strictly '1') bypasses it for one run. A ton-provider push runs the SAME kind of pre-deploy funds check (querying the owner address's own on-chain balance via tonapi), but only ever WARNS, never aborts — whichever mechanism actually spends (the human's Tonkeeper app, or the auto-sign broadcast itself) already gives its own unambiguous refusal on a real shortfall, so this check exists only to save the trip through the up-to-20-minute wait-for-active-contract poll first. Shares CYPHER_BRAIN_SKIP_FUNDS_CHECK=1 with turbo's check above (not a separate ton-provider-specific flag). PUSH also WARNS (never aborts, same reasoning) before signing if the deploy's computed "bounty" looks below the ~0.05 TON floor providers built on tonutils-storage-provider enforce (issue #403) — a real deploy can otherwise succeed and be paid for, then have the provider's own notify refuse to ever fetch the bag, discovered only after the full notify retry window; ESTIMATE shows the same warning ahead of time.
Consent: restore --pg (pg_restore --clean --if-exists, irreversible) needs --yes or CYPHER_BRAIN_YES=1.
Permanence: there is NO delete, at any granularity (#301). cypher-brain has no forget/prune/delete
     command and will not grow one: arweave/turbo are write-once, and destroying your identity does
     not help either — the backup recipient you were told to keep (and the printable recovery kit, if
     it carries one) still decrypts everything. Recoverability was chosen over erasability on purpose.
     What IS parked is ciphertext, so a secret that reaches a snapshot is not published — it is sealed
     to your key, and stays exposed only to whatever might compromise that key later. That is the
     whole reason --scan-secrets now defaults to warn: the only workable answer is to not seal the
     secret in the first place. Before a paid push, assume you are deciding forever.`;

// The version reported by `--version` (issue #261). Read from package.json at
// runtime rather than copied into a constant here, which would be a second place
// to bump and so a place to drift. `../package.json` resolves to the same file
// from BOTH src/cli.ts (repo root, the dev/type-stripping path scripts use) and
// the bundled dist/cli.mjs (the installed package root) — the two are at the
// same depth, so the CLI reports one version no matter which one is running.
// npm always ships package.json in the tarball regardless of the "files" field.
function cliVersion(): string {
  const pkgUrl = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: string };
  if (!pkg.version) throw new Error(`no "version" field in ${fileURLToPath(pkgUrl)}`);
  return pkg.version;
}

// `<command> --help` prints only that command's section of HELP (issue #262).
// #171 made `<command> --help` show help at all; it showed the WHOLE ~300-line
// reference, which is what the unknown-flag error (#253) points people at, so a
// typo'd flag on `push` answers with several screens to scroll back through.
//
// This SLICES the existing HELP string rather than introducing per-command help
// text: `cypher-brain --help`'s output stays byte-identical, which is what
// scripts/check-help-docs.mjs pins README.md's CLI reference against in CI
// (#227). One source of truth for the text, two ways to print it.
//
// Returns null when `cmd` names no section, so the caller can fall back to the
// full HELP (an unknown command with --help is better answered by everything
// than by nothing).
// Every command word HELP documents, in the order it documents them (issue #269).
// Derived from the same section headers helpForCommand() slices on, so the list an
// unknown command is answered with cannot drift from the reference itself.
// The capture is positively shaped like a command word ([a-z][a-z0-9-]*) rather than
// "anything that isn't a flag" — `--version` and `<command> --help` have their own
// sections up top but are a flag and a placeholder, and a future header of some other
// shape (`cypher-brain [options] …`) must not be advertised as a command either
//. `wallet create`, `schedule status` etc. collapse to
// their first word, which is what a user types and what helpForCommand() matches on.
function commandNames(): string[] {
  const names = HELP.split('\n')
    .map((line) => line.match(/^ {2}cypher-brain ([a-z][a-z0-9-]*)/)?.[1])
    .filter((name): name is string => name !== undefined);
  return [...new Set(names)];
}

function helpForCommand(cmd: string): string | null {
  const lines = HELP.split('\n');
  const isSectionStart = (line: string) => /^ {2}cypher-brain \S/.test(line);
  // The trailing Env:/Storage:/Spend:/Consent: block starts at column 0 and is
  // command-agnostic, so every scoped help ends with it.
  const trailerStart = lines.findIndex((line) => line.startsWith('Env:'));
  const sectionsEnd = trailerStart === -1 ? lines.length : trailerStart;

  const matched: string[] = [];
  let inMatch = false;
  for (let i = 1; i < sectionsEnd; i++) {
    const line = lines[i];
    if (isSectionStart(line)) {
      // `wallet create` / `schedule status` etc. are separate sections sharing
      // one command word — matching on the word keeps all of them together.
      inMatch = line.match(/^ {2}cypher-brain (\S+)/)?.[1] === cmd;
    }
    if (inMatch) matched.push(line);
  }
  if (matched.length === 0) return null;

  // Drop the blank line(s) each section ends with, then re-add exactly one.
  while (matched.length > 0 && matched[matched.length - 1].trim() === '') matched.pop();
  const trailer = trailerStart === -1 ? [] : ['', ...lines.slice(trailerStart)];
  return [
    lines[0],
    '',
    ...matched,
    ...trailer,
    '',
    `(one section of "cypher-brain --help", which prints the full reference)`,
  ].join('\n');
}

/**
 * #277 — a flag ANOTHER command accepts, passed to one that never reads it. #253 made an
 * unrecognized `--flag` an error; that check is global, so `restore --out ./x` is still a
 * real flag with a real value, stored and never read, because restore's destination is
 * `--out-dir`.
 *
 * Same shape as #308 took for MCP: each command declares which flags it will NOT read,
 * EMPTY IS A REAL ANSWER, and a command with no declaration fails the build —
 * scripts/cli-smoke.sh compares the dispatch switch's case labels against this table.
 *
 * A deny-list, not an allow-list. An allow-list cannot be derived from HELP (the usage
 * lines are abbreviated), and a hand-written one fails in the direction that matters: a
 * flag missing from it starts REFUSING a valid invocation. A missing deny-list entry only
 * preserves today's behaviour, so the table can grow instead of having to be right at once.
 *
 * Entries record what the command DOES with the flag, not what the flag is called.
 * "Does not read" is the user-facing phrasing; "never honors" is the precise one — restore()
 * touches o.out only to build the #279 hint, a branch now unreachable from the CLI and left
 * for a direct library caller.
 */
interface FlagIrrelevance {
  flag: string;
  because: string;
  /** The flag the user probably meant, when there is an obvious one. */
  instead?: string;
}

const FLAG_IRRELEVANT: Record<string, FlagIrrelevance[]> = {
  // restore's destination is --out-dir; src/lib/restore.ts's restore() never reads o.out.
  // The single highest-traffic instance, since --out means the output on snapshot, pull and
  // wallet create — restore is the one command that spells it differently.
  restore: [{ flag: 'out', because: 'restore extracts into a directory', instead: '--out-dir' }],
  // verify() reads neither: it inspects --in in place and writes nothing.
  verify: [
    { flag: 'out', because: 'verify writes nothing — it inspects --in in place' },
    { flag: 'out_dir', because: 'verify writes nothing — it inspects --in in place' },
  ],
  // src/lib/keys.ts reads neither o.out nor o.backend: keygen writes to the paths under
  // CYPHER_BRAIN_HOME and never touches storage.
  keygen: [
    { flag: 'out', because: 'keygen writes to the identity/recipient paths under CYPHER_BRAIN_HOME' },
    { flag: 'backend', because: 'keygen never touches a storage backend' },
  ],
  // estimate.ts reads o.backend but never o.yes: pricing spends nothing, so there is no
  // consent to give.
  estimate: [
    { flag: 'yes', because: 'estimate only prices an upload — it never spends, so there is nothing to confirm' },
  ],
  // The CLI's snapshot does NOT push (unlike the MCP snapshot_now tool, which takes a
  // backend and pushes): snapshot() reads neither o.backend nor o.locator, so both are
  // accepted and dropped today. Pipe it into `push` to upload.
  snapshot: [
    {
      flag: 'backend',
      because: 'the CLI snapshot does not push — run `push --in <file.age> --backend <name>` after it',
    },
    { flag: 'locator', because: 'a locator names an artifact already in storage; snapshot produces a local file' },
  ],
  // init's implementation is `init(_o)` — it ignores the options bag entirely and asks
  // interactively instead, so every flag is unread. The four here are the ones a user is
  // most likely to reach for; the rest are left undeclared on purpose (see the deny-list
  // reasoning above: a missing entry preserves today's behaviour, a wrong one breaks a
  // valid call).
  init: [
    { flag: 'out', because: 'init is an interactive wizard — it asks for paths rather than taking them as flags' },
    { flag: 'backend', because: 'init is an interactive wizard — it asks which backend to configure' },
    { flag: 'yes', because: 'init is interactive by definition; there is no unattended path to consent to' },
    { flag: 'force', because: 'init never overwrites — it detects what already exists and asks' },
  ],
  // Empty is an answer, not an omission. These were checked and have no flag that another
  // command accepts and they silently ignore.
  push: [],
  pull: [],
  // ton-dns.ts's publishLatest() reads only o.domain/o.from_locator_file/o.yes/o.wait —
  // it never pushes/pulls ciphertext or writes a local file, so the flags a user reaching
  // for push/pull's shape would naturally try are named here rather than silently kept.
  'publish-latest': [
    {
      flag: 'backend',
      because:
        'publish-latest only ever targets the ton backend — its locator file already encodes that; there is nothing to select',
    },
    {
      flag: 'in',
      because: 'publish-latest reads the bag id from --from-locator-file, not from an --in ciphertext path',
    },
    {
      flag: 'out',
      because:
        'publish-latest writes nothing to disk — it only prints a domain, NFT address, bag id and a signing deeplink',
    },
    {
      flag: 'locator',
      because: 'publish-latest reads the locator from --from-locator-file, not a standalone --locator',
      instead: '--from-locator-file',
    },
    { flag: 'save_locator', because: 'publish-latest does not push anything — there is no new locator to save' },
    { flag: 'sha256', because: 'publish-latest does not fetch ciphertext — there is nothing to pin a hash against' },
    {
      flag: 'force',
      because: 'publish-latest never overwrites a local file — it only prints information and a deeplink',
    },
  ],
  'recovery-kit': [
    {
      flag: 'identity',
      because:
        'recovery-kit reads the standard layout under CYPHER_BRAIN_HOME so the identity and recipient.txt cannot be mismatched — relocate with the env var, not per-file flags',
    },
  ],
  schedule: [],
  wallet: [],
  // doctor() reads only o.json — every other flag another command takes (--out, --in,
  // --backend, ...) is meaningless here, but none is likely enough to be typed by
  // mistake to warrant naming individually (unlike restore's --out/--out-dir mix-up).
  doctor: [],
  // ledger() reads only o.json/o.csv — it inspects receipt-ledger.jsonl in place and
  // writes nothing; every other flag another command takes (--in, --backend, --out, ...)
  // is meaningless here, same posture doctor's own entry above takes.
  ledger: [],
  // audit() reads only o.json — it inspects audit-log.jsonl in place and writes
  // nothing; same posture doctor's/ledger's own entries above take.
  audit: [],
  // Reached through the same switch, so the source-level guard in cli-smoke expects an
  // answer from them too. They take no flags and produce no side effects, which is the
  // answer — recorded rather than special-cased, so a future route that DOES take flags
  // cannot slip through by looking like these.
  help: [],
  '--help': [],
  '-h': [],
  '--version': [],
  '-V': [],
};

// A command with no entry has not been considered, and "not considered" must not read as
// "nothing to declare" — that is exactly how #277's cases survived #253. Guarded against
// the SAME derived list the unknown-command reply prints, so adding a command to HELP
// without answering this question fails cli-smoke rather than shipping.
function assertFlagsDeclared(cmd: string | undefined): void {
  if (cmd === undefined) return;
  // Keyed on commandNames() so a TYPO still gets the friendly "unknown command" reply from
  // the switch's default rather than an internal error. That leaves one gap on its own — a
  // switch case never added to HELP is in neither list — which is why cli-smoke reads the
  // case labels out of the source and probes each one.
  if (!commandNames().includes(cmd) && !Object.hasOwn(FLAG_IRRELEVANT, cmd)) return;
  if (!Object.hasOwn(FLAG_IRRELEVANT, cmd)) {
    throw new Error(
      `internal: ${cmd} has no flag-relevance declaration (#277) — add an entry to FLAG_IRRELEVANT in src/cli.ts, using [] if no flag another command accepts is ignored by this one`,
    );
  }
}

function assertFlagsRelevant(cmd: string | undefined, o: CliOptions): void {
  if (cmd === undefined || !Object.hasOwn(FLAG_IRRELEVANT, cmd)) return;
  const rec = o as unknown as Record<string, unknown>;
  const ignored = FLAG_IRRELEVANT[cmd].filter((r) => rec[r.flag] !== undefined);
  if (ignored.length === 0) return;
  // The near-miss suggestion comes from the same helper #305's MCP refusal and restore's own
  // #279 hint use, so a user who typed --out on restore reads the same sentence they did
  // before this check existed — the refusal moved earlier, the help did not get worse.
  const named = ignored
    .map((r) => `--${r.flag.replace(/_/g, '-')} (${r.because}${r.instead ? ` — ${didYouMean(r.instead)}` : ''})`)
    .join('; ');
  throw new Error(
    `${cmd} does not read ${ignored.map((r) => `--${r.flag.replace(/_/g, '-')}`).join(', ')}: ${named}. ` +
      `Refused rather than ignored: a flag that is silently dropped looks exactly like one that was honored.`,
  );
}

async function main(): Promise<void> {
  // #286: the config file refused to load. config.ts records rather than throws (a
  // module-body throw escapes main().catch and prints a raw stack trace), so this is
  // where it re-enters the normal error path — `error: …`, the --json error object, and
  // the CB-E code match. Nothing from the file has been applied, so continuing would run
  // the command with the operator's settings silently absent.
  if (CONFIG_FILE_ERROR) throw CONFIG_FILE_ERROR;
  const [cmd, ...rest] = process.argv.slice(2);
  // `<subcommand> --help` / `-h` must show help instead of running the
  // subcommand (issue #171) — checked on the raw args, BEFORE parseArgs(),
  // so it applies uniformly to every subcommand (not just the bare
  // `cypher-brain --help` handled by the switch below) and keeps working
  // even if parseArgs() is ever changed to validate/throw on bad input
  //.
  if (rest.includes('--help') || rest.includes('-h')) {
    // Deliberately outside tracing's scope (Codex review, #226 part 3): --help/-h never
    // reaches dispatchCommand() and has no side effects to observe, the same reason
    // the audit trail (#419, part 2 of this same issue) also only records
    // push/restore/verify — not every invocation of the binary.
    printMascot('neutral');
    console.log((cmd !== undefined && helpForCommand(cmd)) || HELP);
    return;
  }
  // #226: each dispatched command becomes an OTel span when active (see otel.ts's withSpan() —
  // a pure passthrough when OTEL_EXPORTER_OTLP_ENDPOINT is unset, the default). Wraps
  // arg parsing/validation TOO, not just dispatchCommand() — an invalid-flag refusal is
  // still a real command invocation and observability that only ever sees successful
  // dispatch would miss every rejected one (Codex review, #226 part 3). `cmd` is known
  // before parseArgs() can throw, so the span name doesn't depend on parsing succeeding.
  return withSpan(cmd ?? 'help', async () => {
    const o = parseArgs(rest);
    assertFlagsDeclared(cmd);
    assertFlagsRelevant(cmd, o);
    return dispatchCommand(cmd, o);
  });
}

async function dispatchCommand(cmd: string | undefined, o: CliOptions): Promise<void> {
  switch (cmd) {
    case 'init':
      // A note from the person who built this, right after the wizard's own
      // completion summary above (issue #195) — CLI-only: init has no MCP
      // tool, so this never touches an agent's machine-readable output.
      await init(o);
      printMascot('happy');
      printFounderNote();
      return;
    case 'keygen':
      return keygen(o);
    case 'snapshot':
      return snapshot(o);
    case 'restore':
      return restore(o);
    case 'verify':
      return verify(o);
    case 'push': {
      // push() is shared with the MCP server (src/mcp.ts) and the init wizard
      // (wizard.ts), both of which capture its console.error output as
      // machine-readable data — so the mood mascot (issue #194) is printed HERE,
      // at the CLI-only dispatch site, rather than inside push() itself, where it
      // would otherwise leak the ASCII art into an MCP tool result's `log` field.
      // Decoration only, on stderr (see printMascot in ui.ts).
      let uploaded: boolean;
      try {
        uploaded = await push(o);
      } catch (e) {
        printMascot('sad');
        throw e;
      }
      printMascot('happy');
      // A cited precursor quote after a successful upload to a PAID,
      // permanent backend only (issue #195) — never the free `file` backend,
      // and never a --skip-unchanged run that hit its early SKIPPED return
      // (uploaded === false there — push()'s own doc comment in pushpull.ts).
      // CLI-only: mcp.ts calls push() directly (not through this dispatch),
      // so an MCP push never gets this decoration mixed into its result.
      if (uploaded && (o.backend === 'arweave' || o.backend === 'turbo' || o.backend === 'ton-provider')) {
        printWisdomQuote();
      }
      return;
    }
    case 'pull':
      return pull(o);
    case 'publish-latest':
      return publishLatest(o);
    case 'recovery-kit':
      return recoveryKit(o);
    case 'estimate':
      return estimate(o);
    case 'schedule':
      return schedule(o);
    case 'wallet':
      return wallet(o);
    case 'doctor':
      return doctor(o);
    case 'ledger':
      return ledger(o);
    case 'audit':
      return audit(o);
    // mascot on stderr (decoration only, EPIPE-safe — see printMascot in
    // ui.ts), HELP text stays on stdout so `cypher-brain --help | grep …`
    // still sees only the HELP text on its stdin.
    case 'help':
    case '--help':
    case '-h':
      printMascot('neutral');
      console.log(HELP);
      return;
    // issue #261: `--version` used to fall through to the `default:` arm below —
    // "unknown command: --version" on stderr, the entire HELP on stdout, exit 2.
    // Bare version string on stdout, nothing else, so it can be captured
    // directly; no mascot, for the same reason.
    case '--version':
    case '-V':
      console.log(cliVersion());
      return;
    // issue #427: zero arguments used to be grouped with the `--help`/`-h`/`help` case
    // above — the full ~26 KB reference on stdout, exit 0. That is the same shape #269
    // fixed for a mistyped command, and for the same reason: `--help` is a REQUEST (the
    // user asked for the reference, so printing it with exit 0 is correct), but no
    // arguments at all almost always means the user forgot to type a command, not that
    // they wanted to read ~300 lines. A script relying on "nothing typed" being an error
    // (e.g. a shell-quoting bug that silently drops the argument) used to get a success
    // exit and the whole reference captured instead. Treated as the same usage error as
    // an unknown command below — exit 2, short reply, stdout empty — just with its own
    // first line, since there is no offending token to name.
    case undefined: {
      const names = commandNames();
      console.error('error: no command given');
      if (names.length > 0) console.error(`valid commands: ${names.join(', ')}`);
      console.error(
        `run 'cypher-brain --help' for the full reference, or 'cypher-brain <command> --help' for one command`,
      );
      process.exitCode = 2;
      return;
    }
    // issue #269: this is an ERROR path, so all of it goes to stderr and stdout stays
    // empty — the HELP-on-stdout rule two cases up exists so `cypher-brain --help |
    // grep …` works, which is a REQUEST for the help, not a failure to parse a
    // command. Dumping ~26 KB of help on stdout here meant `LOC=$(cypher-brain psh …)`
    // captured the whole reference into the variable instead of nothing.
    // And it is now a short answer rather than the whole reference: since #262,
    // `<command> --help` prints one section, so the useful reply to a typo is the
    // list of real commands plus where to read more — not 300 lines to scroll back
    // through with no indication of which one was meant.
    default: {
      // Guard the derived list: if a future HELP edit ever changed the section-header
      // shape enough that nothing matches, "valid commands: " with nothing after it
      // would be worse than not printing the line at all.
      // cli-smoke also asserts the list matches the real command set on every run.
      const names = commandNames();
      // #425: generalizes #253's own "would be nice-to-have" mention of a did-you-mean
      // suggestion beyond restore's --out/--out-dir special case. `cmd` is only ever
      // undefined via the earlier `case undefined:` arm (mapped to its own usage-error
      // reply, #427), so it is always a real (if unrecognized) string here — the
      // `cmd ? ... : undefined` guard exists for the type checker, not because this
      // path can actually see undefined.
      const suggestion = cmd ? nearestName(cmd, names) : undefined;
      console.error(`error: unknown command: ${cmd}${suggestion ? ` (${didYouMean(suggestion)})` : ''}`);
      if (names.length > 0) console.error(`valid commands: ${names.join(', ')}`);
      console.error(
        `run 'cypher-brain --help' for the full reference, or 'cypher-brain <command> --help' for one command`,
      );
      process.exitCode = 2;
      return;
    }
  }
}

// The end-of-run warning summary (#347). Every ⚠-class warning a run recorded (via
// warn.ts's chokepoint) is repeated ONCE, together, at the very end — on stderr, after
// everything else. Why: an agent driving this CLI relays fragments; warnings that
// scrolled by mid-run (a single-recipient snapshot, a spend-blocking shortfall, a
// loose-permissioned key) were measured to vanish into a background log on a real
// agent-driven push. One block at the tail, explicitly addressed to agents, is a
// relayable contract — and a human scrolling a long unattended log gets the recap for
// free. stderr only (stdout stays machine-readable), printed on success AND failure
// (warnings recorded before an error still matter), skipped when nothing was recorded.
function printWarningSummary(): void {
  const lines = formatWarningSummary(drainWarnings());
  if (lines.length === 0) return;
  installEpipeGuard();
  for (const l of lines) console.error(l);
}

main()
  .catch((e: unknown) => {
    // issue #212: a stable "[CB-E0xx] see MANAGEMENT.md#error-codes" suffix is appended
    // HERE (the one place every command's error funnels through) when the message matches
    // a known failure pattern — never at the individual throw site, so no existing message
    // body changes; an unmatched error prints exactly as before.
    const message = errMsg(e);
    console.error(`error: ${annotateErrorMessage(message)}`);
    // issue #270: --json (#211) only ever produced JSON on the SUCCESS path, so a caller
    // that asked for machine-readable output had to parse stdout on success and scrape
    // English off stderr on failure. The stable error identity #212 computes is already
    // right here — surface it as a field instead of leaving it embedded in a sentence.
    //
    // Read off argv rather than the parsed options because parseArgs() itself can throw
    // (an unknown flag, #253) before any options exist — that failure must answer in the
    // format the caller asked for too.
    //
    // `error` carries the RAW message; the "[CB-E0xx] see …" suffix is stderr's rendering
    // of the same two facts, and duplicating it inside a field that sits next to `code`
    // would just make the JSON harder to consume. Additive: stdout on this path used to
    // be empty, stderr is byte-for-byte what it was, and the exit code stays the sole
    // authority on success/failure.
    //
    // hasWrittenJson(): never append a SECOND JSON value to a stdout that already holds
    // a command's own document — two values on one stream is not parseable as one. No
    // --json command can currently throw after printing (each prints last and returns),
    // so this is a structural guarantee for future ones rather than a live fix
    //.
    if (process.argv.slice(2).includes('--json') && !hasWrittenJson()) {
      console.log(JSON.stringify({ error: message, code: matchErrorCode(message)?.code ?? null, exit_code: 1 }));
    }
    process.exitCode = 1;
  })
  // The summary is genuinely LAST — after the error line and the --json error object
  // (multi-model review: printing it before the error handler made "end-of-run" a
  // misnomer). .finally covers success and failure with one call site.
  .finally(() => printWarningSummary());
