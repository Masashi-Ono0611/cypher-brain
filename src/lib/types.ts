// Shared shapes that don't belong to any single module: the parsed CLI/MCP options
// bag every command function takes, and the storage-backend contract every
// src/lib/backends/*.ts implements. Kept in one place so cli.ts, mcp.ts and every
// lib/*.ts consumer import the SAME type instead of each hand-rolling its own.

// The flags every "cypher-brain <cmd>" (and its schedule-runner-generating twin)
// can see. `parseArgs` (src/cli.ts) turns `--foo-bar val` into `foo_bar: val` for
// any flag not in BOOL_FLAGS (which get `true`) — genuinely dynamic (any command
// only reads the handful of fields it cares about), so every field beyond the
// three always-initialized arrays is optional rather than a big union of exact
// per-command shapes the parser can't actually guarantee.
export interface CliOptions {
  _?: string; // the schedule/wallet subcommand (install|status|uninstall|create|address) or the top-level positional arg
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

// A StorageBackend is { put(file) -> locator, get(locator, outFile) }. Storage
// only ever sees the *.age ciphertext. The locator is whatever the backend
// assigns: a content hash for file (known before upload), or a tx id for
// arweave (assigned AFTER upload) — the interface assumes neither.
export interface PutOpts {
  yes?: boolean;
  remote?: string; // rclone backend only: the "<remote>:<path>" destination (put() throws without it)
  // #232: paid backends (arweave, turbo) call this, right after a successful upload,
  // with a response object and the best available native-unit cost that upload paid,
  // if the backend can name one — turbo's is its SDK response verbatim (its own
  // official receipt-persistence recommendation); arweave's raw L1 backend has no
  // analogous receipt object, so it passes a small normalized summary instead (see
  // backends/arweave.ts's onReceipt call, and src/lib/receipt.ts's header comment for
  // the full per-backend honesty note on both `raw` and `cost`). pushpull.ts's push()
  // uses it to persist a receipt (src/lib/receipt.ts) SEPARATE from estimate.ts's
  // pre-flight forecast — never conflated. Backends with no concept of a paid receipt
  // (file/rclone/ton) never call it, so no entry, cost, or unit field here is ever
  // optional-but-lying: absence means "this backend has nothing to report", not
  // "reporting failed".
  onReceipt?: (raw: unknown, cost: { amount: string; unit: 'winston' | 'winc' } | null) => void;
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
