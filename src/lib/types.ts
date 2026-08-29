// Shared shapes that don't belong to any single module: the parsed CLI/MCP options
// bag every command function takes, and the storage-backend contract every
// src/lib/backends/*.ts implements. Kept in one place so cli.ts, mcp.ts and every
// lib/*.ts consumer import the SAME type instead of each hand-rolling its own.

// The full canonical set of storage backend names, shared by backends/index.ts (its
// BACKEND_FACTORIES key set, and the "unknown backend" usage text) and estimate.ts
// (its own "unknown backend"/"did you mean" suggestion and --backend usage text) —
// one list so the two can never drift apart the way #435 already let them once
// (backends/index.ts's own header comment documents that history; #501 is the
// estimate.ts side of the same fix). Lives HERE, not in backends/index.ts, because
// estimate.ts must NOT import backends/index.ts directly — that would pull every
// backend's own SDK dependency graph into estimate.ts just to get a name list — and
// this file has no such imports for either side to worry about.
export const STORAGE_BACKEND_NAMES = ['file', 'arweave', 'turbo', 'rclone', 'ton', 'ton-provider'] as const;

// The flags every "cypher-brain <cmd>" (and its schedule-runner-generating twin)
// can see. `parseArgs` (src/cli.ts) turns `--foo-bar val` into `foo_bar: val` for
// any flag not in BOOL_FLAGS (which get `true`) — genuinely dynamic (any command
// only reads the handful of fields it cares about), so every field beyond the
// three always-initialized arrays is optional rather than a big union of exact
// per-command shapes the parser can't actually guarantee.
export interface CliOptions {
  _?: string; // the schedule/wallet sub-verb (install|status|uninstall|create|address|balance) — cli.ts's
  // parseArgs() (#637) refuses a bare argument outright for every OTHER command, so this is
  // never set for them; an unrecognized top-level command word is a separate `cmd` string in
  // cli.ts, not carried here at all
  dirs: string[];
  tables: string[];
  recipients: string[];
  pg_exclude_table_data?: string[]; // repeatable --pg-exclude-table-data <table>: passed through verbatim to pg_dump

  // boolean flags (BOOL_FLAGS in cli.ts) — absent when not passed
  force?: boolean;
  passphrase?: boolean;
  wrap_in_place?: boolean;
  pq?: boolean; // keygen --pq: post-quantum HYBRID keypair (ML-KEM-768 + X25519, #205)
  yes?: boolean;
  force_vault?: boolean;
  skip_unchanged?: boolean;
  no_load?: boolean;
  no_expand_components?: boolean;
  dry_run?: boolean; // snapshot --dry-run: preview .cypherbrainignore include/exclude without writing anything (#216)
  json?: boolean; // verify/estimate/schedule status: machine-readable JSON on stdout instead of the human-readable report (issue #211)
  verbose?: boolean; // restore/verify --level drill: also print the raw manifest.json dump restoreImpl() reads (name, source, digests, host, created_at, …) — off by default (issue #436), since --json already means something else for these two commands (a whole alternate machine-readable report, not "show me the manifest too")
  csv?: boolean; // ledger --csv: one row per receipt on stdout instead of the aggregate report (#232)
  level?: string; // verify --level quick|remote|drill (issue #209) — validated in restore.ts (parseArgs can't know the enum), default 'quick' when absent
  sign?: boolean; // keygen --sign: generate a minisign-compatible Ed25519 signing keypair instead of an age identity (#214)
  no_sign?: boolean; // snapshot --no-sign: skip writing a <out>.minisig sidecar even when a signing identity is present (#214)
  require_signature?: boolean; // restore/verify: an absent/unverifiable signature is a hard failure, not just a warning (#214)
  skip_signature_check?: boolean; // INTERNAL ONLY, never a CLI/MCP flag (not in cli.ts's BOOL_FLAGS/VALUE_FLAGS): verify --level drill sets this on the restoreImpl() call it makes from src/lib/restore.ts, after its own runFileChecks() already ran (and printed) this exact signature check against this exact fetched artifact — restoreImpl skips re-running (and re-printing) it rather than reporting the same check twice (#530)

  // value flags — always a string when passed (argv is untyped text)
  out?: string;
  out_dir?: string;
  profile?: string;
  vault?: string;
  zip?: string;
  export?: string; // profile o2b: the "o2b brain bank-export --out <file>" bundle path (issue #206)
  pg?: string;
  pg_filter?: string; // --pg-filter <file>: passed through verbatim as pg_dump's --filter <file> (issue #235)
  in?: string;
  identity?: string;
  sha256?: string;
  backend?: string;
  remote?: string; // rclone backend: "<rclone-remote-name>:<path>" (also usable as pull's --locator, since that IS the rclone backend's locator)
  digest?: string;
  save_locator?: string;
  locator?: string;
  scan_secrets?: string; // snapshot --scan-secrets warn|deny|off (gitleaks, #215/#301) — validated in snapshot.ts, not here (parseArgs can't know the enum)
  from_locator_file?: string;
  inline_identity?: boolean; // recovery-kit: inline the (wrapped+armored ONLY) primary identity into the kit (#364)
  backup_identity?: string; // recovery-kit: path to a backup identity to inline, wizard-style (#364)
  backup_recipient?: string; // recovery-kit: the backup identity's public recipient (age1… literal or a file path) — required when the backup identity is wrapped (#364)
  sign_identity?: string; // keygen/snapshot: signing PRIVATE key path override (default $CYPHER_BRAIN_HOME/sign-identity.key, #214)
  sign_recipient?: string; // snapshot/restore/verify: signing PUBLIC key path override (default $CYPHER_BRAIN_HOME/sign-recipient.pub, #214)
  sig_locator?: string; // pull: explicit locator for the <out>.minisig sidecar (mirrors --locator; usually read from --from-locator-file's 6th field instead, #214)
  wait?: string;
  at?: string;
  max_spend?: string;
  index_file?: string;
  wallet?: string; // wallet address/balance --wallet <path> (defaults to CYPHER_BRAIN_AR_WALLET)
  address?: string; // wallet balance --address <addr>: query any address, no JWK needed (#345)
  ping_url?: string; // schedule install: dead man's switch success ping (healthchecks.io-style)
  ping_url_fail?: string; // schedule install: failure ping override (defaults to `${ping_url}/fail`)
  domain?: string; // publish-latest --domain <name>.ton: the operator's .ton domain to point at the latest ton bag
  chain?: string; // wallet create/address/balance --chain arweave|ton (default arweave, #396 PR2): which credential type wallet.ts operates on
  plan?: string; // push --plan <path.json>: re-validate a plan file written by "estimate --out" before proceeding (#231)
}

/**
 * What a get() is fetching. `age` is the ciphertext; `minisig` is the detached authenticity
 * signature push parks beside it (#214). They are different file formats, and a backend
 * that validates the shape it received must be told which one to expect — hard-coding
 * "always age ciphertext" is what made a signed artifact's sidecar unfetchable from
 * arweave/turbo (#318).
 */
export type FetchShape = 'age' | 'minisig';

// The event a paid backend hands to onReceipt (below) — issue #654 made this
// locator-aware and async so pushpull.ts can persist the receipt SYNCHRONOUSLY inside
// the callback, before put() does anything else. `locator` is whatever put() would
// otherwise return: known before upload for a content-addressed backend, or assigned
// by the remote (arweave's tx id, turbo's data item id) — always computable by the
// backend itself at the point it calls onReceipt, never derived from put()'s own
// return value (a backend that raises a PushFundingConfirmedButIncompleteError-style
// partial-success error never gets to return one). `raw`/`cost` carry the same
// per-backend honesty contract PutOpts.onReceipt's own doc comment below describes.
export interface ReceiptEvent {
  locator: string;
  raw: unknown;
  cost: { amount: string; unit: 'winston' | 'winc' | 'nanoton' } | null;
}

// A StorageBackend is { put(file) -> locator, get(locator, outFile) }. Storage
// only ever sees the *.age ciphertext. The locator is whatever the backend
// assigns: a content hash for file (known before upload), or a tx id for
// arweave (assigned AFTER upload) — the interface assumes neither.
export interface PutOpts {
  yes?: boolean;
  remote?: string; // rclone backend only: the "<remote>:<path>" destination (put() throws without it)
  // rclone backend only (#533): opts out of that backend's own refuse-by-default
  // overwrite check (an object already sitting at the exact --remote path). This is
  // the SAME CliOptions.force push already threads through for --skip-unchanged's
  // digest override (pushpull.ts) — deliberately reused rather than a second flag,
  // since both mean "push anyway despite a safety net", not two unrelated behaviors.
  // Every other backend's put() ignores it, same as `remote` above.
  force?: boolean;
  // #232 (arweave/turbo), #484 (ton-provider): paid backends call this, at the moment
  // the spend becomes IRREVERSIBLE (not merely "the whole upload/deploy finished" — see
  // issue #654), with a ReceiptEvent naming a response object and the best available
  // native-unit cost that spend paid, if the backend can name one — turbo's is its SDK
  // response verbatim (its own official receipt-persistence recommendation); arweave's
  // raw L1 backend has no analogous receipt object, so it passes a small normalized
  // summary instead (see backends/arweave.ts's onReceipt call, and src/lib/receipt.ts's
  // header comment for the full per-backend honesty note on both `raw` and `cost`);
  // ton-provider passes the deploy amount actually locked into the confirmed on-chain
  // transfer, called right after waitForContractActive() confirms — BEFORE
  // notifyProviderWithRetry() runs, not after (see backends/ton-provider.ts's own
  // onReceipt call and its issue #654 comment for why the ordering matters: a notify
  // failure must never make an already-irreversible spend vanish from the ledger).
  // pushpull.ts's push() awaits this call and persists a receipt (src/lib/receipt.ts)
  // from inside it, SEPARATE from estimate.ts's pre-flight forecast — never conflated.
  // Backends with no concept of a paid receipt (file/rclone/ton) never call it, so no
  // entry, cost, or unit field here is ever optional-but-lying: absence means "this
  // backend has nothing to report", not "reporting failed". Async (returns a Promise)
  // specifically so pushpull.ts's caller can `await` the durable disk write before
  // the backend moves on to whatever might still fail (e.g. ton-provider's notify) —
  // a synchronous callback would let the receipt live only in memory across that gap.
  onReceipt?: (event: ReceiptEvent) => Promise<void>;
  // #639: ton-provider only. A signed push calls put() TWICE — once for the ciphertext,
  // once for its ".minisig" sidecar — and each deploys its OWN StorageV1 contract.
  // pushpull.ts's push() creates ONE mutable box and passes the SAME reference to both
  // calls; ton-provider.ts's put() checks the REMAINING CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND
  // budget (the cap minus spentNano so far) before building each deploy, then adds that
  // deploy's own amountNano to spentNano once it is known to be within budget — so the
  // cap bounds what the WHOLE push spends, not what either deploy spends in isolation.
  // Every other backend ignores this field entirely, same as `remote`/`force` above.
  // CONTRACT: the check-then-charge against this box is not atomic — callers must
  // never run two put() calls against the SAME spendTracker concurrently (await each
  // to completion before starting the next), or the cap can be bypassed. pushpull.ts's
  // push() already does this correctly.
  spendTracker?: { spentNano: bigint };
}

export interface StorageBackend {
  put(file: string, opts?: PutOpts): Promise<string>;
  /**
   * `expect` names the SHAPE of the object being fetched, because a backend that has to
   * decide whether a gateway's HTTP 200 is the real artifact or a soft-404 page can only do
   * that if it knows what the real artifact looks like (#318). It defaults to the
   * ciphertext, which is what every caller but the authenticity-sidecar fetch wants.
   * Backends without such a check (file, rclone — a local path or an rclone remote either
   * has the object or errors) accept it and ignore it.
   */
  get(locator: string, out: string, expect?: FetchShape): Promise<void>;
}
