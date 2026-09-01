// src/mcp-tool-schemas.ts — the MCP tool descriptors (JSON Schemas advertised via
// tools/list) for cypher-brain-mcp, split out of src/mcp.ts (#507).
//
// src/mcp.ts mixed two concerns in one 2300+ line file: these ten `Tool` consts
// (~630 lines, 27% of the file) are pure declarative data — long prose
// `description` strings and JSON Schema shapes, no logic — glued in the same
// file as the handler implementations that dispatch on them. Splitting them out
// makes it faster to find handler logic vs. tool-description prose when editing
// either. The #507 move itself was a pure extraction — verified via a live MCP
// round-trip that `tools/list` came back byte-identical to src/mcp.ts's in-place
// version before any further edit landed. `snapshot_now`'s `recipients` description
// below has since gained a #478 note (a deliberate, separately-reviewed content
// change, not part of the extraction) — everything else here is still exactly what
// src/mcp.ts used to define in place: same tool names, same schemas, same
// annotations. Imported by src/mcp.ts, whose handlers also need BACKENDS/
// PAID_BACKENDS and (for the #220 idempotency-key lock) SNAPSHOT_NOW_TOOL.name.

import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { SCAN_SECRETS_MODES } from './lib/secrets-scan.js';
import { tonWalletConfigured } from './lib/wallet.js';

// rclone (#204) and the self-hosted `ton` backend stay CLI-only: each needs
// operator-side setup (--remote / a configured seeder box) an MCP host cannot collect,
// so a caller offering either would sail past this list into a "missing config" error
// deep inside push() with no way to have supplied what was missing. `ton-provider`
// used to be excluded for a THIRD, different reason — no local TON wallet existed at
// all, so every deploy needed a HUMAN to sign a Tonkeeper deeplink mid-push, which an
// MCP tool call has no way to pause for. PR2 (issue #396) added that wallet
// (src/lib/wallet.ts's `wallet create --chain ton`), so `ton-provider` is now listed
// HERE precisely when one is configured (tonWalletConfigured(), the same presence-check
// arweave/turbo's own wallet already uses) — an MCP host that never got one configured
// still never sees it offered, so it can't get stuck waiting on a signature nobody is
// there to give. Computed once at module load (top-level await), same as every other
// env-derived constant in this file — matches how AR_WALLET etc. are already frozen for
// the process's lifetime; creating a wallet mid-session needs an MCP server restart to
// be picked up here, same as changing any other env-backed setting would.
export const BACKENDS = ['file', 'arweave', 'turbo', ...((await tonWalletConfigured()) ? ['ton-provider'] : [])];
export const PAID_BACKENDS = new Set(['arweave', 'turbo', 'ton-provider']); // ton-provider always spends real funds when reachable at all (#396 PR2) — safe to list unconditionally even when BACKENDS above omits it (an unreachable value can never trigger this check)

// ─────────────────────────────────────────────────────────────────────────────
// Tool descriptors (JSON Schemas advertised via tools/list)
// ─────────────────────────────────────────────────────────────────────────────

export const SNAPSHOT_NOW_TOOL: Tool = {
  name: 'snapshot_now',
  description:
    '⚠ CAN SPEND MONEY (only tool in this server that can). Take an encrypted age snapshot of ' +
    'directories and/or a Postgres database, and optionally push the ciphertext to a storage ' +
    'backend. Backend "file" is free; "arweave" and "turbo" are PAID, PERMANENT stores; ' +
    '"ton-provider" is also PAID, but weaker-durability than arweave/turbo (depends on a live ' +
    "provider continuing to renew/serve the contract), and only appears in this tool's backend " +
    "enum when a local TON wallet is already configured (see wallet_create's description for how " +
    'to set one up — this MCP server has no tool that creates it). Pushing to any of ' +
    'arweave/turbo/ton-provider REQUIRES confirm_paid=true (the MCP equivalent of the CLI --yes ' +
    'guard; the CYPHER_BRAIN_YES env escape hatch is NOT honored here, so nothing can be spent ' +
    'without an explicit confirm_paid in the call). Snapshotting itself needs only the PUBLIC ' +
    'recipient key(s); storage only ever sees ciphertext. Pass idempotency_key to make a RETRY ' +
    'safe (issue #220, the Stripe idempotency-key pattern): a repeat call with the SAME key ' +
    "returns the FIRST call's result (no new snapshot, no new spend) instead of re-executing — " +
    "the fix for an agent's own retry logic (a network blip after the upload already succeeded, " +
    "say) double-spending on arweave/turbo. The key is scoped to THIS call's dirs/pg/recipients/" +
    'out/backend/scan_secrets: reusing it for a call that differs in any of those is refused ' +
    'rather than silently answered with the wrong result. Cached results expire after ' +
    'CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS (default 24h) — a repeat past that is a fresh call.',
  inputSchema: {
    type: 'object',
    properties: {
      dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directories to include (tar.gz each). At least one of dirs/pg is required.',
      },
      pg: { type: 'string', description: 'Postgres connection string to pg_dump into the snapshot.' },
      recipients: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description:
          'age recipients (age1… pubkey or a recipients file path). Pass 2+ (primary + offline backup) for key ' +
          'recovery. REQUIRED here with NO default (#478): unlike the CLI `snapshot`, which defaults to ' +
          '<CYPHER_BRAIN_HOME>/recipient.txt when --recipient is omitted, this MCP tool refuses a call with no ' +
          'recipients rather than silently reaching for that file — pass the home recipient explicitly ' +
          "(<CYPHER_BRAIN_HOME>/recipient.txt's contents) to get the same effect.",
      },
      out: {
        type: 'string',
        description: 'Output path for the .age ciphertext (must not already exist — no-clobber).',
      },
      backend: {
        type: 'string',
        enum: BACKENDS,
        description:
          'When given, push the snapshot: file (free) or arweave|turbo|ton-provider (PAID — needs confirm_paid; ' +
          "ton-provider only appears when a local TON wallet is configured — see wallet_create's description " +
          'for how to set one up).',
      },
      locator_file: {
        type: 'string',
        description:
          'Path for push --save-locator: writes "<locator>\\t<backend>\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]" (the durable recovery pointer; back it up off-box).',
      },
      confirm_paid: {
        type: 'boolean',
        description:
          'REQUIRED true to push to a PAID backend (arweave/turbo/ton-provider). Confirms you accept an irreversible, real-money upload.',
      },
      scan_secrets: {
        type: 'string',
        enum: [...SCAN_SECRETS_MODES],
        description:
          'Run gitleaks over each dirs source\'s staged plaintext BEFORE it is archived+encrypted (the CLI --scan-secrets, #215): "warn" logs findings (rule ID + count only, never the secret) and proceeds, "deny" refuses the whole snapshot if any source has findings. Omitted = no scan (same default as the CLI). Requires the gitleaks binary on PATH: when set and gitleaks cannot be resolved, the call FAILS rather than silently skipping the scan.',
      },
      idempotency_key: {
        type: 'string',
        description:
          "Caller-chosen key making a RETRY safe (issue #220, Stripe's idempotency-key pattern): a repeat " +
          'call with the SAME key AND the same dirs/pg/recipients/out/backend/scan_secrets returns the ' +
          "FIRST call's result — no new snapshot, no new spend — instead of re-executing. The same key " +
          'with DIFFERENT values in any of those fields is refused rather than answered with the wrong ' +
          'result. Cached results expire after CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS (default 24h).',
      },
    },
    required: ['recipients', 'out'],
    additionalProperties: false,
  },
  annotations: {
    // Creates a new snapshot file (and, with backend, pushes it) — never
    // overwrites (out is no-clobber), so it adds state rather than destroying
    // existing state. Each call produces a distinct snapshot/spend, so it is
    // not idempotent BY DEFAULT. #220's idempotency_key is an opt-in exception to
    // that (a repeat call with the same key replays rather than re-executes), but
    // this hint describes the tool's default posture — a caller that omits the
    // key gets exactly the non-idempotent behavior this says.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const LAST_SNAPSHOT_STATUS_TOOL: Tool = {
  name: 'last_snapshot_status',
  description:
    'Read-only, spends nothing. Report the most recent snapshot push: locator, backend, sha256, ' +
    'timestamp and age, read from the save-locator file (written by snapshot_now/push ' +
    'locator_file — "<locator>\\t<backend>\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]", ' +
    'legacy 3/4/5/6-field lines accepted, timestamped by file mtime) and/or an ' +
    'append-only index.tsv ("<timestamp>\\t<locator>\\t<sha256>" per line, newest last). With no ' +
    'arguments it tries the default save-locator path $CYPHER_BRAIN_HOME/latest-locator.tsv.',
  inputSchema: {
    type: 'object',
    properties: {
      locator_file: {
        type: 'string',
        description: 'Path to a push --save-locator file. Default: <CYPHER_BRAIN_HOME>/latest-locator.tsv',
      },
      index_file: {
        type: 'string',
        description: 'Path to an append-only index.tsv (timestamp<TAB>locator<TAB>sha256 lines).',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    // Reads a local locator/index file only — no writes, no network calls.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const VERIFY_RESTORE_TOOL: Tool = {
  name: 'verify_restore',
  description:
    'Read-only for your wallet (downloads only, never uploads or spends). Prove a snapshot is ' +
    'restorable: pull the ciphertext by locator, or verify a local file, or pass locator_file ' +
    '(a push --save-locator file) which supplies the locator, its backend AND the sha256 ' +
    'integrity pin in one — the same fail-closed recovery path as the CLI --from-locator-file. ' +
    'Then run the verify checks (age header, wrong-key rejection, and — when a private ' +
    'identity is available — a full decrypt proof). IMPORTANT: arweave/turbo locators are NOT ' +
    'content hashes, so verifying a bare locator without a sha256 pin cannot detect a gateway ' +
    'rollback/substitution that still decrypts with your key — pass sha256 (or use ' +
    'locator_file) to pin the fetched bytes; an unpinned arweave/turbo pull returns a warning ' +
    'field. Returns the HONEST verdict mirroring the CLI exit codes: PASS (exit 0, restorable ' +
    'by you), FAIL (exit 1), or PARTIAL (exit 2 — decryptability NOT proven, e.g. no private ' +
    'identity on this box; PARTIAL is never inflated to PASS).',
  inputSchema: {
    type: 'object',
    properties: {
      locator: {
        type: 'string',
        description: 'Storage locator to pull first (requires backend). Exactly one of locator/file/locator_file.',
      },
      file: {
        type: 'string',
        description: 'Local .age file to verify directly. Exactly one of locator/file/locator_file.',
      },
      locator_file: {
        type: 'string',
        description:
          'Path to a push --save-locator file ("<locator>\\t<backend>\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]"; legacy 3/4/5/6-field lines accepted): pull using its recorded locator + backend, with its saved sha256 applied as the integrity pin (the CLI --from-locator-file recovery path). Exactly one of locator/file/locator_file; do not also pass backend.',
      },
      backend: {
        type: 'string',
        enum: BACKENDS,
        description:
          'Backend to pull the locator from (required with locator; not allowed with locator_file — the file records it).',
      },
      sha256: {
        type: 'string',
        description:
          'Optional integrity pin: 64-hex sha256 of the expected ciphertext, sourced from a TRUSTED off-box record (index.tsv / a backed-up save-locator file). A pulled artifact that does not match is deleted and the call fails closed (no verdict); with file the mismatch is a hard FAIL verdict. Overrides the pin recorded in locator_file.',
      },
      identity: {
        type: 'string',
        description: 'Private identity file for the decrypt proof. Default: <CYPHER_BRAIN_HOME>/identity.age',
      },
      require_signature: {
        type: 'boolean',
        description:
          'REQUIRED true to turn an ABSENT .minisig from a [SKIP] check into a FAIL verdict ' +
          "(#214's --require-signature). Deleting a sidecar — rather than forging one — is the downgrade this " +
          'closes; an INVALID signature already fails without it.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    // Never uploads or spends (per description); a pulled artifact only lands
    // in a temp dir that this handler removes before returning. Pulling from
    // arweave/turbo/a gateway is a network call to an external store.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const RESTORE_NOW_TOOL: Tool = {
  name: 'restore_now',
  description:
    '⚠ WRITES decrypted files to disk, and can irreversibly clobber a database. The actual disaster-' +
    'recovery step verify_restore stops short of (issue #183): verify_restore only PROVES a snapshot is ' +
    'restorable, this tool actually restores it. Pull the ciphertext by locator, or restore a local file, ' +
    'or pass locator_file (a push --save-locator file) which supplies the locator, its backend AND the ' +
    'sha256 integrity pin in one — the SAME dual-mode input as verify_restore (exactly one of ' +
    'locator/file/locator_file). Decrypts with the PRIVATE identity and extracts into out_dir; extraction ' +
    'never clobbers a file already present there (tar --keep-old-files/--skip-old-files, same as the CLI) — ' +
    'EXCEPT a component archive (<name>.tar.gz) whose pre-existing content does not match what this restore ' +
    'just decrypted: that refuses the WHOLE restore instead of silently auto-expanding stale/unrelated data ' +
    'and reporting it as the manifest-recorded source (#527). ' +
    'REQUIRES confirm_write=true before ANY work happens (pull/decrypt/extract): confirms writing decrypted ' +
    'files into out_dir, and — when pg is given — that pg_restore --clean --if-exists will ALSO DROP and ' +
    'replace objects in that database, an irreversible operation (the MCP equivalent of the CLI --yes/' +
    'CYPHER_BRAIN_YES guard on restore --pg; the CYPHER_BRAIN_YES env escape hatch is NOT honored here, so ' +
    'nothing can be restored/clobbered without an explicit confirm_write in the call). IMPORTANT: arweave/' +
    'turbo locators are NOT content hashes, so restoring — and, when pg is given, pg_restoring — a bare ' +
    'locator without a sha256 pin cannot detect a gateway rollback/substitution that still decrypts with ' +
    'your key: this tool will proceed and DROP/replace live database objects over unverified bytes — pass ' +
    'sha256 (or use locator_file) to pin the fetched bytes; an unpinned arweave/turbo pull returns a warning ' +
    'field in the result instead of refusing.',
  inputSchema: {
    type: 'object',
    properties: {
      locator: {
        type: 'string',
        description: 'Storage locator to pull first (requires backend). Exactly one of locator/file/locator_file.',
      },
      file: {
        type: 'string',
        description: 'Local .age file to restore directly. Exactly one of locator/file/locator_file.',
      },
      locator_file: {
        type: 'string',
        description:
          'Path to a push --save-locator file ("<locator>\\t<backend>\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]"; legacy 3/4/5/6-field lines accepted): pull using its recorded locator + backend, with its saved sha256 applied as the integrity pin (the CLI --from-locator-file recovery path). Exactly one of locator/file/locator_file; do not also pass backend.',
      },
      backend: {
        type: 'string',
        enum: BACKENDS,
        description:
          'Backend to pull the locator from (required with locator; not allowed with locator_file — the file records it).',
      },
      sha256: {
        type: 'string',
        description:
          'Optional integrity pin: 64-hex sha256 of the expected ciphertext, sourced from a TRUSTED off-box record (index.tsv / a backed-up save-locator file). A pulled artifact that does not match is deleted and the call fails closed (no restore happens); with file the mismatch refuses before any decrypt/extract work. Overrides the pin recorded in locator_file.',
      },
      out_dir: {
        type: 'string',
        description:
          'Directory to extract the decrypted snapshot into (created if missing). Existing files already there are never clobbered.',
      },
      identity: {
        type: 'string',
        description: 'Private identity file to decrypt with. Default: <CYPHER_BRAIN_HOME>/identity.age',
      },
      require_signature: {
        type: 'boolean',
        description:
          'REQUIRED true to refuse an artifact whose .minisig is ABSENT, rather than warning and continuing ' +
          "(#214's --require-signature). Deleting a sidecar — rather than forging one — is the downgrade this " +
          'closes; an INVALID signature is always refused regardless. Checked before anything is decrypted or ' +
          'written, so it gates pg_restore rather than reporting on it afterwards.',
      },
      pg: {
        type: 'string',
        description:
          "Postgres connection string to pg_restore the snapshot's db.dump into. pg_restore --clean --if-exists " +
          'DROPS and replaces objects in that database — irreversible — so this ALSO requires confirm_write=true ' +
          '(the MCP equivalent of the CLI --yes/CYPHER_BRAIN_YES guard on restore --pg).',
      },
      confirm_write: {
        type: 'boolean',
        description:
          'REQUIRED true to execute the restore. Confirms you accept decrypted files being written into out_dir, ' +
          'and — when pg is given — objects in that database being DROPPED and replaced via pg_restore --clean --if-exists.',
      },
    },
    required: ['out_dir'],
    additionalProperties: false,
  },
  annotations: {
    // The file extraction itself is no-clobber (like snapshot_now's --out), but
    // when pg is given, pg_restore --clean --if-exists DROPS and replaces
    // existing objects in that database — genuinely destructive, unlike
    // snapshot_now which never destroys existing state. Pulls from a storage
    // backend over the network.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const ESTIMATE_COST_TOOL: Tool = {
  name: 'estimate_cost',
  description:
    'Read-only, spends nothing (price queries only). Estimate what pushing a payload of the ' +
    'given size to a backend would cost: turbo → Turbo upload cost in winc via @ardrive/turbo-sdk ' +
    '(<100KB is free; a clear note is returned when that optional dependency is not installed); ' +
    'arweave → network price in winston from the gateway /price endpoint; ton-provider → nanoTON ' +
    'cost from a real priced query against the live mytonprovider.org registry (only listed when a ' +
    'local TON wallet is configured — the estimate itself never spends, but the underlying push ' +
    "would; see wallet_create's description for how to set one up); file → free (local disk), " +
    'returned with a zero-cost note. All seven fields (backend, size_bytes, cost, ' +
    'unit, approx_ar, usd_estimate, note) are ALWAYS present — null, never absent, where they do ' +
    'not apply (#268), so do not test for a key to decide whether a value exists. For ' +
    'turbo/arweave, usd_estimate carries an approximate USD figure when a USD/AR rate is ' +
    'fetchable — a direct HTTP call to the public Turbo rate endpoint, so it works with or ' +
    'without @ardrive/turbo-sdk installed — and is null on any rate failure; the native estimate ' +
    'in cost/unit never fails because of it.',
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path of the payload to size (exactly one of file/size_bytes).' },
      size_bytes: {
        type: 'number',
        minimum: 0,
        description: 'Payload size in bytes (exactly one of file/size_bytes).',
      },
      backend: { type: 'string', enum: BACKENDS, description: 'Backend to estimate for.' },
    },
    required: ['backend'],
    additionalProperties: false,
  },
  annotations: {
    // Price queries only (per description) — reads a local file's size at
    // most, then calls the gateway/turbo rate endpoints for pricing.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

export const SCHEDULE_INSTALL_TOOL: Tool = {
  name: 'schedule_install',
  description:
    '⚠ WRITES a REAL, PERSISTENT system file (a launchd plist under ~/Library/LaunchAgents on ' +
    'macOS, or a crontab entry on Linux) and, unless no_load is set, REGISTERS it so the nightly ' +
    'snapshot+push runs unattended from now on (issue #174 follow-up — the MCP equivalent of the ' +
    "CLI's `schedule install`). A PAID backend (arweave/turbo) gets CYPHER_BRAIN_YES=1 baked into " +
    'the generated runner for unattended consent, so it ALSO REQUIRES max_spend (a positive integer ' +
    'cap in native units — winston for arweave, winc for turbo): an uncapped unattended spender is ' +
    'refused, same as the CLI. backend=ton-provider (only listed when a local TON wallet is ' +
    "configured — see wallet_create's description for how to set one up) is ALSO paid and " +
    'unattended-capable, but its spend cap is a SEPARATE, env-only ' +
    'mechanism (CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND, in nanoTON — must already be set in the ' +
    "environment before this call; this tool's own max_spend argument does not apply to it and is " +
    'refused if passed for it, matching the CLI). Requires confirm_install=true before ANY work happens — the MCP ' +
    'equivalent of consenting to both the real-system-file write and (for a paid backend) the ' +
    'ongoing capped spend risk every future unattended run carries; there is no environment escape ' +
    'hatch honored here. Only ONE schedule can be installed at a time; re-calling replaces the prior ' +
    'configuration (same as re-running the CLI command). Uses `cypher-brain schedule status` to ' +
    'read this back, and `schedule uninstall` — not exposed as a tool — to remove it by hand.',
  inputSchema: {
    type: 'object',
    properties: {
      backend: {
        type: 'string',
        enum: BACKENDS,
        description:
          'Where the nightly push goes: file (free), arweave|turbo (PAID — requires max_spend), or ' +
          'ton-provider (PAID — requires CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND set in the environment ' +
          'instead, not the max_spend argument; only listed when a local TON wallet is configured — ' +
          "see wallet_create's description for how to set one up).",
      },
      dirs: {
        type: 'array',
        items: { type: 'string' },
        description: 'Directories to include in every nightly snapshot. At least one of dirs/pg is required.',
      },
      pg: { type: 'string', description: 'Postgres connection string to pg_dump into every nightly snapshot.' },
      recipients: {
        type: 'array',
        items: { type: 'string' },
        description:
          'age recipients (age1… pubkey or a recipients file path) to encrypt every nightly snapshot to. ' +
          "Defaults to the keypair's own recipient when omitted (same as the CLI's snapshot/schedule install).",
      },
      at: {
        type: 'string',
        description: 'Local time "HH:MM" to run nightly. Default 03:30 (after the source re-settles overnight).',
      },
      max_spend: {
        type: 'string',
        description:
          'REQUIRED for backend arweave|turbo: a positive integer cap (native units — winston/winc) on ' +
          "EVERY unattended run's spend. Not allowed for backend file (nothing to cap) or backend " +
          'ton-provider (its own env-only CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND applies instead — see the tool description).',
      },
      no_load: {
        type: 'boolean',
        description:
          'Write the runner + plist/cron entry WITHOUT registering the trigger (launchctl/crontab left ' +
          'untouched) — a preview. The written file(s) still persist on disk; see the tool description.',
      },
      ping_url: {
        type: 'string',
        description:
          "Optional healthchecks.io-style dead man's switch: the runner curl's this URL (best-effort, " +
          "never affects the run's own outcome) on every successful run.",
      },
      ping_url_fail: {
        type: 'string',
        description: 'Failure-ping URL override (default: ping_url + "/fail"). Requires ping_url to also be set.',
      },
      scan_secrets: {
        type: 'string',
        enum: [...SCAN_SECRETS_MODES],
        description:
          'Bake the gitleaks gate into the generated nightly runner (the CLI --scan-secrets, #215/#307): ' +
          '"warn" logs findings and proceeds, "deny" refuses the whole snapshot on a finding. Omitted = the ' +
          'nightly does not scan (same default as the CLI). Requires at least one dirs entry — the scan covers ' +
          'staged directory plaintext, not the pg dump. Install RESOLVES gitleaks now and PINS the absolute ' +
          'path into the runner as CYPHER_BRAIN_GITLEAKS_BIN (launchd/cron do not inherit a useful PATH, and a ' +
          'different gitleaks on theirs must not take its place), and FAILS if it cannot be resolved, rather ' +
          'than installing a schedule that cannot scan.',
      },
      confirm_install: {
        type: 'boolean',
        description:
          'REQUIRED true to install. Confirms accepting a real, persistent system-file write and — for a ' +
          'paid backend — the ongoing capped spend risk every future unattended run carries.',
      },
    },
    required: ['backend'],
    additionalProperties: false,
  },
  annotations: {
    // Writes a real system file (plist/crontab) OUTSIDE CYPHER_BRAIN_HOME and,
    // unless no_load, registers it with launchd/cron — genuinely destructive in
    // the sense that re-installing replaces the prior configuration, and for a
    // paid backend it commits to an ongoing (capped) unattended spend. Not
    // idempotent: re-calling with different args produces a different runner/
    // trigger. Talks to launchctl/crontab (and, at run time, storage backends),
    // not just the local filesystem.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
};

export const SCHEDULE_STATUS_TOOL: Tool = {
  name: 'schedule_status',
  description:
    'Read-only, spends nothing, mutates nothing. Report the state of the nightly schedule set up ' +
    'by `cypher-brain schedule install`: the configured time + backend, whether the launchd/cron ' +
    'trigger is actually registered, the last run\'s log filename and its final "OK rc=0"/"FAILED ' +
    'rc=N" line, and the next scheduled run — the SAME report `cypher-brain schedule status` prints ' +
    'on the CLI, verbatim (one string per line). No arguments. Fails with ERR_NOT_CONFIGURED if no ' +
    'schedule is installed yet — call schedule_install first.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  annotations: {
    // Reads the launchd/cron registration + the last run's log file — spends
    // and mutates nothing (per description).
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const KEYGEN_TOOL: Tool = {
  name: 'keygen',
  description:
    '⚠ WRITES a new identity/recipient keypair — the FIRST-RUN setup step a shell-less agent otherwise ' +
    'cannot do (issue #174): snapshot_now/verify_restore need this keypair to already exist, and there ' +
    'was no MCP tool that could create one. Spends no money, but is destructive the same way a ' +
    'money-gated call is: it refuses if an identity/recipient already exists at ' +
    '<CYPHER_BRAIN_HOME>/{identity.age,recipient.txt} UNLESS force=true, and force=true DISCARDS the old ' +
    'keypair — every snapshot already encrypted to it becomes permanently unrecoverable. ' +
    'passphrase=true additionally wraps the new identity at rest; since MCP has no interactive TTY this ' +
    'REQUIRES CYPHER_BRAIN_PASSPHRASE to be set in the server environment (fails closed with a clear ' +
    'error otherwise — never prompts blindly). NOTE (#690): this server serializes every captured tool ' +
    'call through one internal queue, so this call can sit WAITING (not failing, not hung) behind an ' +
    'unrelated in-flight snapshot_now/restore_now/verify_restore call that happens to still be running — ' +
    'a slow response here does not by itself mean anything is wrong.',
  inputSchema: {
    type: 'object',
    properties: {
      force: {
        type: 'boolean',
        description:
          'Delete and overwrite an existing identity/recipient. DESTRUCTIVE — the old identity is ' +
          'discarded, so every snapshot already encrypted to it becomes unrecoverable.',
      },
      passphrase: {
        type: 'boolean',
        description:
          'Wrap the new identity with a passphrase (scrypt). Requires CYPHER_BRAIN_PASSPHRASE set in ' +
          'the server environment (no TTY is available over MCP to prompt for one).',
      },
      pq: {
        type: 'boolean',
        description:
          'Generate a POST-QUANTUM HYBRID keypair (ML-KEM-768 + X25519, #205) instead of plain X25519 ' +
          '— mitigates "harvest now, decrypt later" (see README Threat model), at the cost of a much ' +
          'bigger recipient/identity and per-recipient ciphertext overhead.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    // force=true discards the existing identity/recipient — every snapshot
    // already encrypted to it becomes permanently unrecoverable — so this is
    // destructive the same way keygen's description frames it. Each call
    // generates a fresh random keypair, so repeat calls are not idempotent.
    // Purely local key generation, no network calls.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const WALLET_CREATE_TOOL: Tool = {
  name: 'wallet_create',
  description:
    '⚠ WRITES a new Arweave JWK wallet — the funding half of first-run setup (issue #174): ' +
    'arweave/turbo pushes need CYPHER_BRAIN_AR_WALLET to point at a JWK file, and there was no MCP tool ' +
    'that could create one. Spends no money by itself, but is destructive the same way keygen is: it ' +
    'refuses if a wallet already exists at the target path UNLESS force=true, and force=true DISCARDS ' +
    'the old JWK — the only credential able to spend any AR/Turbo Credits already sent to its address. ' +
    'Writes to <CYPHER_BRAIN_HOME>/wallet.json by default (out overrides the path). ARWEAVE ONLY (issue ' +
    '#439): this tool has no chain parameter and cannot create a TON wallet. To use snapshot_now/' +
    'schedule_install\'s backend="ton-provider", instead run `cypher-brain wallet create --chain ton` ' +
    "from a shell, set CYPHER_BRAIN_TON_WALLET to the printed path in this MCP server's own environment, " +
    'and restart the server — only then does "ton-provider" appear in those tools\' backend enum. ' +
    'NOTE (#690): this server serializes every captured tool call through one internal queue, so this ' +
    'call can sit WAITING (not failing, not hung) behind an unrelated in-flight snapshot_now/restore_now/' +
    'verify_restore call that happens to still be running — a slow response here does not by itself mean ' +
    'anything is wrong.',
  inputSchema: {
    type: 'object',
    properties: {
      out: {
        type: 'string',
        description:
          'Output path for the wallet JWK file — must be inside CYPHER_BRAIN_HOME. Default: ' +
          '<CYPHER_BRAIN_HOME>/wallet.json',
      },
      force: {
        type: 'boolean',
        description:
          'Delete and overwrite an existing wallet file at the target path. DESTRUCTIVE — discards spend ' +
          'authority over any AR/Turbo Credits already sent to its address.',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    // force=true discards the existing wallet — the only credential able to
    // spend any AR/Turbo Credits already sent to its address — so this is
    // destructive the same way keygen's force is. Each call generates a fresh
    // random JWK, so repeat calls are not idempotent. Purely local
    // key/file generation, no network calls.
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

export const WALLET_ADDRESS_TOOL: Tool = {
  name: 'wallet_address',
  description:
    'Read-only, spends nothing — derives and shows the Arweave address for a JWK wallet file (the ' +
    'address to FUND, e.g. via app.ardrive.io / turbo.ar.io, before pushing to arweave/turbo). Defaults ' +
    'to $CYPHER_BRAIN_AR_WALLET, then <CYPHER_BRAIN_HOME>/wallet.json (the same default wallet_create ' +
    'writes to) when wallet is omitted. ARWEAVE ONLY (issue #439): there is no TON equivalent of this ' +
    "tool over MCP — a TON wallet's address is printed once by `cypher-brain wallet create --chain ton` " +
    "at creation time (see wallet_create's description for the full CLI-bootstrap-then-restart steps " +
    'needed to reach backend="ton-provider"). NOTE (#690): despite being read-only and fast on its own, ' +
    'this server serializes every captured tool call through one internal queue, so this call can sit ' +
    'WAITING (not failing, not hung) behind an unrelated in-flight snapshot_now/restore_now/verify_restore ' +
    'call that happens to still be running — do not mistake a queued call for a hang.',
  inputSchema: {
    type: 'object',
    properties: {
      wallet: {
        type: 'string',
        description:
          'Path to the JWK wallet file. Default: $CYPHER_BRAIN_AR_WALLET, then <CYPHER_BRAIN_HOME>/wallet.json',
      },
    },
    additionalProperties: false,
  },
  annotations: {
    // Read-only, spends nothing (per description) — derives the address from
    // a local JWK file with no side effects; the same wallet always yields
    // the same address, and there is no network call.
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

// #477: `cypher-brain ledger`, `cypher-brain audit`, and `cypher-brain wallet balance` have
// no MCP tool below — deliberately CLI-only (see README's "## MCP server" section), same as
// `schedule uninstall` (see SCHEDULE_INSTALL_TOOL's own description above) and the recovery
// kit. Noted here, next to the list every tool has to appear in, so the gap for these three
// stays visible to whoever next edits this array rather than only living in README.
export const ALL_TOOLS: Tool[] = [
  SNAPSHOT_NOW_TOOL,
  LAST_SNAPSHOT_STATUS_TOOL,
  VERIFY_RESTORE_TOOL,
  RESTORE_NOW_TOOL,
  ESTIMATE_COST_TOOL,
  SCHEDULE_INSTALL_TOOL,
  SCHEDULE_STATUS_TOOL,
  KEYGEN_TOOL,
  WALLET_CREATE_TOOL,
  WALLET_ADDRESS_TOOL,
];
