// cypher-brain-mcp — MCP server so an AI agent can snapshot/verify/restore its own brain.
//
// Second entry point next to src/cli.ts (a CLI + MCP two-face design). Every
// tool is a thin wrapper over the SAME src/lib functions the CLI dispatches
// to — no re-implemented logic, no shelling out.
//
// Transport: stdio only. Stdout is MCP JSON-RPC framing; the lib functions
// print progress via console.log/console.error, so tool handlers run inside
// captureCall() which redirects both into per-call buffers (stdout lines are
// data — e.g. push() prints the locator there — stderr lines are progress) and
// snapshots process.exitCode (verify() reports its verdict through it).
//
// Uses the LOW-LEVEL `Server` + `setRequestHandler` API (not the high-level
// McpServer helper) so validation lives in our handlers and errors come back
// as one structured {code, message} payload instead of SDK plain-text errors.
//
// Spend safety: snapshot_now is the ONLY tool that can spend money (push to
// arweave/turbo — paid, permanent). It requires an explicit confirm_paid=true
// for those backends, checked BEFORE any work happens; the CYPHER_BRAIN_YES
// env escape hatch the CLI honors is deliberately NOT honored here, so an
// agent can never spend without saying so in the call itself.

import { stat, readFile, rm, copyFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  type Tool,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';

import {
  HOME,
  IDENTITY,
  RECIPIENT,
  CONFIG_FILE_ERROR,
  IDEMPOTENCY_LOG,
  IDEMPOTENCY_TTL_SECONDS,
  IDEMPOTENCY_TTL_ERROR,
  NON_CONTENT_ADDRESSED_BACKENDS,
} from './lib/config.js';
import { restoreRunbook } from './lib/runbook.js';
import { drainWarnings } from './lib/warn.js';
import { snapshot } from './lib/snapshot.js';
import { restore, verify } from './lib/restore.js';
import { withSpan } from './lib/otel.js';
import {
  push,
  pull,
  signatureGap,
  redactUserinfo,
  PushPartialSuccessError,
  writeReplayedSavedLocator,
} from './lib/pushpull.js';
import { lookupIdempotencyResult, recordIdempotencyResult, IdempotencyStoreError } from './lib/idempotency.js';
import { schedule, scheduleStatusReport } from './lib/schedule.js';
import { estimateCost } from './lib/estimate.js';
import { keygenAt } from './lib/keys.js';
import { wallet, tonWalletConfigured } from './lib/wallet.js';
import { SCAN_SECRETS_MODES, isScanSecretsMode } from './lib/secrets-scan.js';
import { exists, requireFile, MissingPathError, sha256, errMsg } from './lib/util.js';
import { annotateErrorMessage, matchErrorCode } from './lib/errors.js';
import { installStageSignalGuard, addActiveMcpFetchDir, removeActiveMcpFetchDir } from './lib/signal-guard.js';
import { didYouMean, nearestName } from './lib/suggest.js';
import type { CliOptions } from './lib/types.js';

const SERVER_NAME = 'cypher-brain-mcp';
const SERVER_VERSION = '0.0.1'; // keep in sync with package.json "version"

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
const BACKENDS = ['file', 'arweave', 'turbo', ...((await tonWalletConfigured()) ? ['ton-provider'] : [])];
const PAID_BACKENDS = new Set(['arweave', 'turbo', 'ton-provider']); // ton-provider always spends real funds when reachable at all (#396 PR2) — safe to list unconditionally even when BACKENDS above omits it (an unreachable value can never trigger this check)
// NON_CONTENT_ADDRESSED_BACKENDS: arweave/turbo locators are post-assigned tx/upload ids
// and rclone's is an operator-chosen remote path — none of the three are content hashes,
// so pulling by bare locator cannot detect a rolled-back/substituted (yet still
// age-decryptable) ciphertext unless a sha256 pin binds the fetched bytes. `file`'s own
// locator IS a content hash (its get() verifies the fetched bytes against it, #209
// review), which is why it is NOT in this set. Shared with verify --level remote/drill
// (src/lib/restore.ts, #209) — defined once in config.ts so the two call sites (rclone
// is unreachable from here per BACKENDS above, but the constant is still one definition)
// can't drift apart on which backends this applies to.
const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

// Untyped JSON-RPC tool-call arguments (an MCP client can send anything) — every
// handler below validates its own shape at runtime (isStr/isStrArray etc), so
// `unknown` per-field is the honest type until a check narrows it.
type ToolArgs = Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────
// stdout hygiene + per-call output capture
// ─────────────────────────────────────────────────────────────────────────────

// Safety net: nothing outside a captured call may write to stdout (it would
// corrupt the JSON-RPC framing). Rebind console.log at module load; the capture
// below swaps in per-call buffers on top of this.
const rawStderrLine = (s: string) => process.stderr.write(`${s}\n`);
console.log = (...a: unknown[]) => rawStderrLine(a.map(String).join(' '));
console.error = (...a: unknown[]) => rawStderrLine(a.map(String).join(' '));

interface CaptureResult<T> {
  value: T;
  out: string[];
  err: string[];
  /** ⚠-class warnings the call recorded via warn.ts (#347) — the load-bearing subset
   *  of `err`, surfaced as its own field so an agent can relay them without parsing
   *  logs. Drained per call (the mutex serializes calls, so no cross-call bleed). */
  warnings: string[];
  exitCode: number;
}

// Run one lib call with console.log/console.error captured and process.exitCode
// snapshotted. Calls are serialized through a promise-chain mutex because the
// capture mutates process-global state (console + exitCode).
let callChain: Promise<void> = Promise.resolve();
function captureCall<T>(fn: () => Promise<T>): Promise<CaptureResult<T>> {
  const run = callChain.then(async (): Promise<CaptureResult<T>> => {
    const out: string[] = [];
    const err: string[] = [];
    const prevLog = console.log;
    const prevErr = console.error;
    const prevExit = process.exitCode;
    process.exitCode = undefined;
    console.log = (...a: unknown[]) => {
      out.push(a.map(String).join(' '));
    };
    console.error = (...a: unknown[]) => {
      const s = a.map(String).join(' ');
      err.push(s);
      rawStderrLine(s); // progress stays visible on the server's stderr too
    };
    try {
      const value = await fn();
      return { value, out, err, warnings: drainWarnings(), exitCode: process.exitCode ?? 0 };
    } catch (e) {
      // A warning recorded BEFORE the failure matters no less for having been
      // followed by one — losing it here would re-open the exact relay hole #347
      // closes (review round 1, Critical). Bound to the ERROR OBJECT itself, not to
      // shared state: structuredErr() runs outside the callChain mutex, so a
      // module-level stash could be consumed or overwritten by an interleaved failing
      // call (review round 2, Critical). Residual, accepted: a handler that throws
      // AFTER a successful capture (interpreting its output, say) abandons that
      // capture's warnings — they still reached the server's stderr live.
      if (e instanceof Error) (e as Error & { cbWarnings?: string[] }).cbWarnings = drainWarnings();
      throw e;
    } finally {
      console.log = prevLog;
      console.error = prevErr;
      process.exitCode = prevExit;
      // No-op after either path above; kept as a backstop so a future edit cannot
      // leak one call's warnings into the next call's drain.
      drainWarnings();
    }
  });
  callChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

// ─────────────────────────────────────────────────────────────────────────────
// Result + validation helpers (structured {code, message} error contract)
// ─────────────────────────────────────────────────────────────────────────────

class ToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// #347: module-load warnings, preserved by main()'s startup drain — attached to every
// structured result below (session-scoped facts like a deprecated env var).
let startupWarnings: string[] = [];

function structuredOk(payload: Record<string, unknown>): CallToolResult {
  const full = {
    ...payload,
    ...(startupWarnings.length ? { startup_warnings: startupWarnings } : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(full, null, 2) }],
    structuredContent: full,
  };
}

// #293: a caller-supplied path that is not there is bad INPUT, not a server fault —
// left unchecked it reaches the library, whose plain Error structuredErr() can only
// report as ERR_INTERNAL, telling an agent the server broke and inviting a retry that
// can only fail the same way. requireFile() (not exists()) does the check, because
// exists() swallows EVERY access() failure: EACCES/ELOOP would be relabelled "no such
// file", which is the same misdiagnosis one level down that #267 fixed for the CLI.
// Those propagate untouched and stay ERR_INTERNAL, which is the honest answer for them.
async function requireCallerFile(file: string): Promise<void> {
  try {
    await requireFile(file);
  } catch (e) {
    if (e instanceof MissingPathError) throw new ToolError('ERR_INVALID_INPUT', e.message);
    throw e;
  }
}

// verify_restore and restore_now each stage bytes in a private temp dir: an artifact
// pulled by locator (`pulled.age`), or a caller-given `file` copied in (`given.age`) so
// the sha256 pin applies to a path nothing else can swap underneath it. Both erase it in
// a finally-block — which a signal skips, and unlike the CLI's one-shot runs this server
// is LONG-LIVED: a launchd/shutdown SIGTERM or an operator Ctrl-C is how it ordinarily
// ends, not an exceptional event. Ciphertext rather than plaintext, so this is a smaller
// leak than the snapshot stage dir, but the same class of one.
//
// These two helpers are the ONLY way those dirs are created and removed, so the ordering
// the signal guard depends on cannot drift from one call site to the next:
//   - mkdtempSync, then register, with no await between them. An `await mkdtemp()` leaves
//     the directory on disk but untracked for as long as its continuation sits queued.
//   - rm FIRST, deregister only once it is gone. Deregistering first leaves a window
//     where a signal finds nothing to erase and the finally never finishes. If the rm
//     itself fails (EACCES under the dir, say) the entry deliberately STAYS registered:
//     the handler's forceRmSync chmods and retries, so a signal is the one path left
//     that can still clear it.
// installStageSignalGuard() is idempotent. The lib calls that follow (pull/verify/restore)
// install it themselves too, but only once they are REACHED — by then the dir has already
// existed for the whole fetch.
function makeFetchDir(): string {
  installStageSignalGuard();
  const dir = mkdtempSync(join(tmpdir(), 'cypher-brain-mcp-'));
  addActiveMcpFetchDir(dir);
  return dir;
}

async function discardFetchDir(dir: string | null): Promise<void> {
  if (!dir) return;
  await rm(dir, { recursive: true, force: true });
  removeActiveMcpFetchDir(dir);
}

function structuredErr(errObj: unknown): CallToolResult {
  const rawMessage = errObj instanceof Error ? errObj.message : String(errObj);
  // issue #212: same stable "[CB-E0xx] see MANAGEMENT.md#error-codes" suffix the CLI
  // appends (cli.ts's main().catch) — applied HERE, the one place every tool call's
  // error funnels through, never at an individual throw site (no existing message body
  // changes). `cb_code` additionally surfaces the bare code as its own field — an AI
  // agent driving these tools can branch on it directly instead of regexing `message`.
  const cbCode = matchErrorCode(rawMessage)?.code;
  // Additive (#347): warnings the failing call recorded before it failed ride the
  // error result too — {code, message} consumers are unaffected by an extra field.
  // Read off the error object (captureCall's catch bound them there), never off
  // shared state — this function runs outside the call mutex.
  const warnings = (errObj as (Error & { cbWarnings?: string[] }) | null)?.cbWarnings ?? [];
  const payload = {
    code: errObj instanceof ToolError ? errObj.code : 'ERR_INTERNAL',
    message: annotateErrorMessage(rawMessage),
    ...(cbCode ? { cb_code: cbCode } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(startupWarnings.length ? { startup_warnings: startupWarnings } : {}),
  };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
function isStrArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}
function isBool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

// wallet_create's `out` lets an MCP caller pick where the new JWK is written, and
// `force: true` overwrites whatever is already there — same as the CLI's own
// `wallet create --out --force`, but MCP's threat model is different: a shell-less
// caller (an AI agent acting on tool descriptions, possibly steered by adversarial
// input) has no OTHER path to an arbitrary-file-overwrite primitive the way a human
// with a shell already does. Scope `out` to CYPHER_BRAIN_HOME so this tool can only
// ever clobber cypher-brain's own key material, never an arbitrary server-writable
// file (multi-model review finding, PR #180 / issue #174).
function assertWithinHome(p: string): void {
  const resolved = resolve(p);
  const homeResolved = resolve(HOME);
  if (resolved !== homeResolved && !resolved.startsWith(homeResolved + sep)) {
    throw new ToolError('ERR_INVALID_INPUT', `out must be inside CYPHER_BRAIN_HOME (${HOME}), got: ${p}`);
  }
}

// The PRESENCE half of the backend rule — the part no schema keyword states and the
// dispatcher's central enum check (#308) therefore cannot enforce. Four of its five call
// sites need a backend to be THERE: estimate_cost and schedule_install declare it
// `required` (a keyword nothing enforces at runtime), and verify_restore/restore_now need
// one only when a `locator` is given, which is a conditional no schema can express.
//
// Its membership test is deliberately NOT the duplication #305 removed: the schemas'
// `enum:` and this function read the SAME `BACKENDS` constant, so there is no second list
// to drift. On snapshot_now — the one site where the value is optional, and so the one
// the central check now fully covers at runtime — it stays because it is also the
// assertion that narrows `backend` to a string for the rest of that handler.
function requireBackend(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !BACKENDS.includes(value)) {
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `${what} must be one of ${BACKENDS.join('|')} — got ${JSON.stringify(value)}`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool descriptors (JSON Schemas advertised via tools/list)
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_NOW_TOOL: Tool = {
  name: 'snapshot_now',
  description:
    '⚠ CAN SPEND MONEY (only tool in this server that can). Take an encrypted age snapshot of ' +
    'directories and/or a Postgres database, and optionally push the ciphertext to a storage ' +
    'backend. Backend "file" is free; "arweave" and "turbo" are PAID, PERMANENT stores; ' +
    '"ton-provider" (only listed when a local TON wallet is configured — see BACKENDS above) is ' +
    'also PAID, but weaker-durability than arweave/turbo (depends on a live provider continuing ' +
    'to renew/serve the contract) — pushing to any of these REQUIRES confirm_paid=true (the MCP equivalent of the CLI --yes ' +
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
          'age recipients (age1… pubkey or a recipients file path). Pass 2+ (primary + offline backup) for key recovery.',
      },
      out: {
        type: 'string',
        description: 'Output path for the .age ciphertext (must not already exist — no-clobber).',
      },
      backend: {
        type: 'string',
        enum: BACKENDS,
        description:
          'When given, push the snapshot: file (free) or arweave|turbo|ton-provider (PAID — needs confirm_paid; ton-provider only appears when a local TON wallet is configured).',
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

const LAST_SNAPSHOT_STATUS_TOOL: Tool = {
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

const VERIFY_RESTORE_TOOL: Tool = {
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

const RESTORE_NOW_TOOL: Tool = {
  name: 'restore_now',
  description:
    '⚠ WRITES decrypted files to disk, and can irreversibly clobber a database. The actual disaster-' +
    'recovery step verify_restore stops short of (issue #183): verify_restore only PROVES a snapshot is ' +
    'restorable, this tool actually restores it. Pull the ciphertext by locator, or restore a local file, ' +
    'or pass locator_file (a push --save-locator file) which supplies the locator, its backend AND the ' +
    'sha256 integrity pin in one — the SAME dual-mode input as verify_restore (exactly one of ' +
    'locator/file/locator_file). Decrypts with the PRIVATE identity and extracts into out_dir; extraction ' +
    'never clobbers a file already present there (tar --keep-old-files/--skip-old-files, same as the CLI). ' +
    'REQUIRES confirm_write=true before ANY work happens (pull/decrypt/extract): confirms writing decrypted ' +
    'files into out_dir, and — when pg is given — that pg_restore --clean --if-exists will ALSO DROP and ' +
    'replace objects in that database, an irreversible operation (the MCP equivalent of the CLI --yes/' +
    'CYPHER_BRAIN_YES guard on restore --pg; the CYPHER_BRAIN_YES env escape hatch is NOT honored here, so ' +
    'nothing can be restored/clobbered without an explicit confirm_write in the call).',
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

const ESTIMATE_COST_TOOL: Tool = {
  name: 'estimate_cost',
  description:
    'Read-only, spends nothing (price queries only). Estimate what pushing a payload of the ' +
    'given size to a backend would cost: turbo → Turbo upload cost in winc via @ardrive/turbo-sdk ' +
    '(<100KB is free; a clear note is returned when that optional dependency is not installed); ' +
    'arweave → network price in winston from the gateway /price endpoint; ton-provider → nanoTON ' +
    'cost from a real priced query against the live mytonprovider.org registry (only listed when a ' +
    'local TON wallet is configured — the estimate itself never spends, but the underlying push ' +
    'would); file → free (local disk), returned with a zero-cost note. All seven fields (backend, size_bytes, cost, ' +
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

const SCHEDULE_INSTALL_TOOL: Tool = {
  name: 'schedule_install',
  description:
    '⚠ WRITES a REAL, PERSISTENT system file (a launchd plist under ~/Library/LaunchAgents on ' +
    'macOS, or a crontab entry on Linux) and, unless no_load is set, REGISTERS it so the nightly ' +
    'snapshot+push runs unattended from now on (issue #174 follow-up — the MCP equivalent of the ' +
    "CLI's `schedule install`). A PAID backend (arweave/turbo) gets CYPHER_BRAIN_YES=1 baked into " +
    'the generated runner for unattended consent, so it ALSO REQUIRES max_spend (a positive integer ' +
    'cap in native units — winston for arweave, winc for turbo): an uncapped unattended spender is ' +
    'refused, same as the CLI. backend=ton-provider (only listed when a local TON wallet is ' +
    'configured) is ALSO paid and unattended-capable, but its spend cap is a SEPARATE, env-only ' +
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
          'instead, not the max_spend argument; only listed when a local TON wallet is configured).',
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

const SCHEDULE_STATUS_TOOL: Tool = {
  name: 'schedule_status',
  description:
    'Read-only, spends nothing, mutates nothing. Report the state of the nightly schedule set up ' +
    'by `cypher-brain schedule install`: the configured time + backend, whether the launchd/cron ' +
    'trigger is actually registered, the last run\'s log filename and its final "OK rc=0"/"FAILED ' +
    'rc=N" line, and the next scheduled run — the SAME report `cypher-brain schedule status` prints ' +
    'on the CLI, verbatim (one string per line). No arguments. Fails with ERR_INTERNAL if no ' +
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

const KEYGEN_TOOL: Tool = {
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
    'error otherwise — never prompts blindly).',
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

const WALLET_CREATE_TOOL: Tool = {
  name: 'wallet_create',
  description:
    '⚠ WRITES a new Arweave JWK wallet — the funding half of first-run setup (issue #174): ' +
    'arweave/turbo pushes need CYPHER_BRAIN_AR_WALLET to point at a JWK file, and there was no MCP tool ' +
    'that could create one. Spends no money by itself, but is destructive the same way keygen is: it ' +
    'refuses if a wallet already exists at the target path UNLESS force=true, and force=true DISCARDS ' +
    'the old JWK — the only credential able to spend any AR/Turbo Credits already sent to its address. ' +
    'Writes to <CYPHER_BRAIN_HOME>/wallet.json by default (out overrides the path).',
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

const WALLET_ADDRESS_TOOL: Tool = {
  name: 'wallet_address',
  description:
    'Read-only, spends nothing — derives and shows the Arweave address for a JWK wallet file (the ' +
    'address to FUND, e.g. via app.ardrive.io / turbo.ar.io, before pushing to arweave/turbo). Defaults ' +
    'to $CYPHER_BRAIN_AR_WALLET, then <CYPHER_BRAIN_HOME>/wallet.json (the same default wallet_create ' +
    'writes to) when wallet is omitted.',
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

const ALL_TOOLS: Tool[] = [
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

const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

// #300: every schema above advertises `additionalProperties: false`, but the
// low-level Server does not enforce the advertised inputSchema at runtime — so a
// field a handler does not destructure was simply DISCARDED, and the call went ahead
// as if it had never been asked for. That fails OPEN precisely where it hurts: a
// misspelled REQUIRED field errors by accident (the real name is then missing), while
// a misspelled OPTIONAL one — which here is where the safety and scoping arguments
// live (confirm_paid, sha256, identity, no_load, pg) — silently changed nothing. A
// `no_laod: true` on schedule_install registered a REAL trigger where the caller
// meant a preview; a stray field on schedule_status would have reported the server's
// own schedule as if it were the one asked about; a snapshot_now that named a
// safety gate it misspelled reported plain success.
//
// Checked HERE, once, against each tool's own declared `properties` — the contract it
// already publishes — rather than in ten handlers. Two of them used to carry a
// hand-written copy of this check and eight did not, which is the same enumeration
// drift #276/#290/#293 removed elsewhere; a per-handler rule is one every future tool
// has to remember, and the eleventh would forget it again.
//
// Case-SENSITIVE, deliberately: JSON object keys are, `properties` is, and an agent
// sending `Out` for `out` has a bug worth hearing about rather than a spelling the
// server should quietly accept. The near-miss suggestion below is case-insensitive,
// so such a call is still told exactly what it got wrong.
//
// Absent `arguments` and `{}` are the same thing (the dispatcher defaults one to the
// other): both name no fields at all, so neither can be naming a wrong one.
//
// `additionalProperties` itself is deliberately NOT consulted: all ten schemas set it
// false, and reading it would mean a tool added later without that line — the easiest
// line to forget — silently opted out of the check. A tool that genuinely wants
// open-ended arguments has to change this function, which is a decision someone makes
// on purpose rather than one they can omit by accident.
//
// One key still never gets here, and cannot: the SDK parses `arguments` through a zod
// record, which strips a literal `__proto__` before any handler runs (verified against
// the built server — `constructor`/`toString` DO reach this check and are refused).
// Left as it is on purpose. Stripping that key is the SDK defending against prototype
// pollution, and unlike the fields this issue is about, `__proto__` cannot be a request
// anyone meant to make — nothing is silently not-honored by dropping it.
function assertDeclaredArgs(tool: Tool, args: ToolArgs): void {
  const declared = Object.keys(tool.inputSchema.properties ?? {});
  const unknown = Object.keys(args).filter((k) => !declared.includes(k));
  if (unknown.length === 0) return;
  const named = unknown.map((k) => {
    const near = nearestName(k, declared);
    return near ? `${k} (${didYouMean(near)})` : k;
  });
  throw new ToolError(
    'ERR_INVALID_INPUT',
    `${tool.name} got unrecognized argument(s): ${named.join(', ')} — ` +
      (declared.length > 0 ? `it accepts only: ${declared.join(', ')}. ` : 'it takes no arguments. ') +
      'Refused rather than ignored: a discarded field would look to the caller like it was honored.',
  );
}

// #308: the same sentence one level in. #300 closed the case where a field a tool does
// not DECLARE was accepted and discarded; a declared one could still be, whenever the
// branch the handler takes never consults it. `backend` declares
// enum: ["file","arweave","turbo"] on five tools, but whether a value outside that set
// was refused depended on which branch the REST of the arguments selected:
//
//   estimate_cost  {file, backend: "nonsense"} -> refused (its handler consults backend)
//   verify_restore {file, backend: "nonsense"} -> PASS, verdict returned, value ignored
//
// Same field, same declared enum, opposite answers — because verify_restore's local-file
// branch never needs a backend, so the handler's own check never ran. The caller asked to
// verify through a backend they named and was told PASS by a code path that never touched
// it.
//
// Checked HERE for the same reason assertDeclaredArgs is: the constraint is already
// published in the tool's own schema, so enforcing it once against that schema covers
// every tool and every branch — instead of a branch-relevance rule that each future
// handler has to remember (direction 2 of the issue, and the one it calls the worst of
// the three). It costs no dependency: an enum is a literal array already sitting in the
// schema and membership is `includes`.
//
// Deliberately enum ONLY. Validating a declared `type` centrally is the part that would
// need a real JSON Schema validator — a fourth runtime dependency for a tool that has
// three — so the per-handler isStr/isBool checks stay exactly where they are; #305 was
// right to decline that half, and it is untouched here.
//
// Being no validator, it reads exactly ONE shape, which is the shape all ten schemas use:
// a top-level property's own `enum`, of primitive literals. It does NOT descend into
// `items`, a nested object's properties, or allOf/anyOf/oneOf, and it compares by value —
// so an object/array literal, which JSON Schema compares STRUCTURALLY and `includes`
// would compare by reference, is out of scope too. Neither
// gap can arrive unnoticed: scripts/mcp-smoke.mjs walks every advertised schema and FAILS
// on an enum in either shape, so adding one is a deliberate step that says "extend this
// function first" rather than a field the server quietly stops enforcing — which is the
// bug this issue is about.
//
// What this does NOT do, on purpose: a value the enum PERMITS but the chosen branch
// cannot use is still accepted and ignored. verify_restore {file, backend: "file"} names
// a legal backend on a branch that fetches nothing, and still returns PASS. That is
// branch relevance, a different question from the one the schema answers, and it is left
// open rather than half-closed.
//
// An ABSENT field is skipped, not defaulted: `required` is a separate keyword this does
// not read, and the handlers that need a backend enforce their own presence rule — some
// conditionally ("required with locator"), which no schema keyword states. A field with
// no `enum` is untouched. The near-miss suggestion is offered only when the value and the
// candidates are strings, since that is the only case where "did you mean" can mean
// anything; both it and the phrasing come from src/lib/suggest.ts, the same helper the
// unknown-argument refusal above uses.
/**
 * #308 direction 2 — a DECLARED field whose value is legal but whose branch never reads it.
 * `assertDeclaredArgs` catches undeclared names and `assertDeclaredEnums` catches
 * out-of-enum values; neither can catch `verify_restore {file, backend}`, which returns
 * PASS from a path that fetched nothing.
 *
 * Not a new discipline — three cases of it were already refused by hand where someone
 * noticed (`locator_file` with `backend`, `ping_url_fail` without `ping_url`, `max_spend`
 * on a free backend). What was missing is anything that made the question get ASKED. Hence
 * a declaration per tool, EMPTY BEING A REAL ANSWER, and a dispatcher that refuses a tool
 * with no entry (assertBranchDeclared) so adding one forces the decision.
 *
 * Cases already handled in a handler or in lib/ stay there: schedule.ts's three are shared
 * with the CLI, which needs them just as much.
 */
interface BranchIrrelevance {
  /** The declared field that this branch will not read. */
  field: string;
  /** Why the branch cannot use it — surfaced verbatim to the caller. */
  because: string;
}

// verify_restore and restore_now take EXACTLY ONE of locator / file / locator_file, and
// their handlers say so. A call naming two of them has no valid branch at all, so answering
// it with "backend is irrelevant on this branch" would name the smaller problem and hide the
// real one. Claim irrelevance only when the local-file branch
// is the unambiguous choice; otherwise stay quiet and let the handler's own
// exactly-one-source refusal answer.
function localFileBranch(a: ToolArgs, verb: string): BranchIrrelevance[] {
  const unambiguous = a.file !== undefined && a.locator === undefined && a.locator_file === undefined;
  return unambiguous
    ? [{ field: 'backend', because: `a local file is ${verb} in place, with no fetch for a backend to serve` }]
    : [];
}

const BRANCH_IRRELEVANT: Record<string, (args: ToolArgs) => BranchIrrelevance[]> = {
  // No backend means no push, and both of these only ever reach the push step.
  // `locator_file` is the durable recovery pointer, so dropping it silently costs the
  // caller the one artifact that makes the snapshot findable later (measured on main: the
  // file is simply never written, and the result does not mention it).
  snapshot_now: (a) => [
    ...(a.backend === undefined
      ? [
          {
            field: 'locator_file',
            because: 'nothing is pushed without a backend, and the locator is only written by the push',
          },
        ]
      : []),
    // Keyed on "is there a PAID upload", not merely "is there a backend" — `file` is free,
    // so its push never consults the consent flag either. The
    // CLI already applies the same rule to --max-spend, which it refuses on a free backend.
    ...(!(typeof a.backend === 'string' && PAID_BACKENDS.has(a.backend))
      ? [
          {
            field: 'confirm_paid',
            because: 'nothing is spent on this call — confirm_paid only gates a push to arweave or turbo',
          },
        ]
      : []),
  ],
  // The local-file branch verifies bytes already on this machine; it fetches nothing, so a
  // backend cannot participate in the verdict it returns.
  verify_restore: (a) => localFileBranch(a, 'verified'),
  restore_now: (a) => localFileBranch(a, 'restored'),
  // Both sources are read when both are given, and either alone is a complete request.
  last_snapshot_status: () => [],
  // `backend` prices both the file and the size_bytes branch.
  estimate_cost: () => [],
  // Its three cases (ping_url_fail without ping_url, max_spend on a free backend, and the
  // paid-backend cap requirement) live in src/lib/schedule.ts, shared with the CLI.
  schedule_install: () => [],
  schedule_status: () => [],
  keygen: () => [],
  wallet_create: () => [],
  wallet_address: () => [],
};

// A tool with no entry above has not been considered, and "not considered" must not read as
// "nothing to declare" — that is precisely how this issue's case survived #305 and #310.
// ERR_INTERNAL rather than ERR_INVALID_INPUT: the caller did nothing wrong.
function assertBranchDeclared(name: string): void {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so a tool named `constructor`
  // or `toString` would report a declaration it does not have — and TOOLS_BY_NAME is a Map,
  // which happily holds such a name.
  if (!Object.hasOwn(BRANCH_IRRELEVANT, name)) {
    throw new ToolError(
      'ERR_INTERNAL',
      `${name} has no branch-relevance declaration (#308) — add an entry to BRANCH_IRRELEVANT in src/mcp.ts, using an empty array if no declared field is branch-dependent`,
    );
  }
}

function assertBranchRelevance(name: string, args: ToolArgs): void {
  const declare = Object.hasOwn(BRANCH_IRRELEVANT, name) ? BRANCH_IRRELEVANT[name] : () => [];
  const ignored = declare(args).filter((r) => args[r.field] !== undefined);
  if (ignored.length === 0) return;
  const list = ignored.map((r) => `${r.field} (${r.because})`).join('; ');
  throw new ToolError(
    'ERR_INVALID_INPUT',
    `${name} cannot use ${ignored.map((r) => r.field).join(', ')} on this call: ${list}. Refused rather than ignored: ` +
      `a field that is silently dropped looks to the caller exactly like one that was honored.`,
  );
}

function assertDeclaredEnums(tool: Tool, args: ToolArgs): void {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, { enum?: unknown[] } | undefined>;
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) continue;
    const allowed = properties[key]?.enum;
    if (!Array.isArray(allowed) || allowed.length === 0) continue;
    if (allowed.includes(value)) continue;
    const near =
      typeof value === 'string'
        ? nearestName(
            value,
            allowed.filter((v): v is string => typeof v === 'string'),
          )
        : undefined;
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `${tool.name} got an unrecognized value for ${key}: ${JSON.stringify(value)}` +
        `${near ? ` (${didYouMean(near)})` : ''} — it accepts only: ` +
        `${allowed.map((v) => JSON.stringify(v)).join(', ')}. ` +
        'Refused rather than ignored: the tool publishes that set for every call, so a value outside it is ' +
        'refused whichever branch this call would have taken — being ignored on one of them is exactly what ' +
        'used to make an unusable value look honored.',
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// #220: an in-process, per-(tool, key) lock — belt-and-suspenders alongside the
// idempotency log itself. The log alone closes the SEQUENTIAL case (a retry that arrives
// after this call has already returned and recorded); it does nothing about two calls
// carrying the SAME key arriving before either has finished (a client that fires a retry
// without waiting for a timeout) — both would read a cache MISS from the log and both
// would go on to spend. Keyed on tool+key together, encoded via JSON.stringify([tool,
// key]) rather than a hand-picked separator — unambiguous regardless of what characters an
// arbitrary caller-chosen key contains — so a key reused across two different tools can
// never be treated as the same in-flight call. Checked and inserted synchronously with no
// `await` in between (see the call site below) — that is what makes the check-then-add
// atomic under Node's single-threaded, cooperative concurrency, with no separate mutex
// needed.
const idempotencyInFlight = new Set<string>();

// The fields that define "the same snapshot_now call" for #220's idempotency-key replay —
// deliberately NOT confirm_paid (a consent flag, not part of the operation's identity) and
// NOT locator_file (where the recovery pointer is written, not what is snapshotted/
// pushed). A caller reusing a key for a call that differs in one of THESE fields is
// refused rather than silently answered with an unrelated result — the same rule Stripe's
// own idempotency keys follow ("Keys can only be reused for the exact same operation").
function snapshotNowFingerprint(args: ToolArgs): string {
  const relevant = {
    dirs: args.dirs,
    pg: args.pg,
    recipients: args.recipients,
    out: args.out,
    backend: args.backend,
    scan_secrets: args.scan_secrets,
  };
  return createHash('sha256').update(JSON.stringify(relevant)).digest('hex');
}

async function handleSnapshotNow(args: ToolArgs): Promise<CallToolResult> {
  const {
    dirs = [],
    pg,
    recipients,
    out,
    backend,
    locator_file: locatorFile,
    confirm_paid: confirmPaid,
    scan_secrets: scanSecrets,
    idempotency_key: idempotencyKeyRaw,
  } = args;
  if (!isStrArray(recipients) || recipients.length === 0)
    throw new ToolError(
      'ERR_INVALID_INPUT',
      'recipients must be a non-empty array of strings (age1… pubkeys or recipient file paths)',
    );
  if (!isStr(out)) throw new ToolError('ERR_INVALID_INPUT', 'out (string path for the .age ciphertext) is required');
  if (!isStrArray(dirs)) throw new ToolError('ERR_INVALID_INPUT', 'dirs must be an array of strings');
  if (backend !== undefined) requireBackend(backend, 'backend');
  if (pg !== undefined && !isStr(pg)) throw new ToolError('ERR_INVALID_INPUT', 'pg must be a string connection URI');
  if (locatorFile !== undefined && !isStr(locatorFile))
    throw new ToolError('ERR_INVALID_INPUT', 'locator_file must be a string path');
  // #308's assertDeclaredEnums now refuses a bad mode before dispatch, reading the same
  // SCAN_SECRETS_MODES this schema advertises — so this is not the check that stops one.
  // It stays for the reason requireBackend stays on this same handler: it is the assertion
  // that narrows `scan_secrets` from ToolArgs' unknown to a mode for the CliOptions handoff
  // below. Both read one constant, so neither can drift from the schema or each other.
  if (scanSecrets !== undefined && !isScanSecretsMode(scanSecrets))
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `scan_secrets must be one of ${SCAN_SECRETS_MODES.join('|')} — got ${JSON.stringify(scanSecrets)}`,
    );
  if (idempotencyKeyRaw !== undefined && !isStr(idempotencyKeyRaw))
    throw new ToolError('ERR_INVALID_INPUT', 'idempotency_key must be a non-empty string');
  const idempotencyKey = isStr(idempotencyKeyRaw) ? idempotencyKeyRaw : undefined;

  // #220: idempotency-key replay, checked BEFORE the spend gate below — a replay of an
  // already-completed call must not need confirm_paid supplied again (nothing NEW is being
  // spent; this only returns what already happened) and must do no work at all. A
  // fingerprint mismatch means the same key named two DIFFERENT calls, refused rather than
  // silently answered with the wrong one's result (see snapshotNowFingerprint above).
  let fingerprint: string | undefined;
  const lockId = idempotencyKey ? JSON.stringify([SNAPSHOT_NOW_TOOL.name, idempotencyKey]) : undefined;
  if (idempotencyKey && lockId) {
    fingerprint = snapshotNowFingerprint(args);
    let cached: Awaited<ReturnType<typeof lookupIdempotencyResult>>;
    try {
      cached = await lookupIdempotencyResult(
        IDEMPOTENCY_LOG,
        SNAPSHOT_NOW_TOOL.name,
        idempotencyKey,
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (e) {
      if (!(e instanceof IdempotencyStoreError)) throw e; // an unexpected bug, not the fail-closed case below — stays ERR_INTERNAL
      // Fail-closed (multi-model review, P1): the log could not rule out a prior call
      // under this exact key — see IdempotencyStoreError's own doc comment in
      // idempotency.ts. Refusing here means no paid work happens on an uncertain read,
      // rather than silently treating "could not check" the same as "definitely unused".
      throw new ToolError(
        'ERR_IDEMPOTENCY_STORE_UNREADABLE',
        `could not verify whether idempotency_key ${JSON.stringify(idempotencyKey)} was already used: ${errMsg(e)} ` +
          '— refused rather than risk re-running a paid operation that may already have completed under this key ' +
          '(fail-closed). Repair or remove the corrupted line(s) in the idempotency log, or retry once the ' +
          'underlying I/O issue clears.',
      );
    }
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw new ToolError(
          'ERR_IDEMPOTENCY_KEY_REUSED',
          `idempotency_key ${JSON.stringify(idempotencyKey)} was already used for a snapshot_now call with ` +
            `different dirs/pg/recipients/out/backend/scan_secrets within the last ${IDEMPOTENCY_TTL_SECONDS}s ` +
            '— reuse a key only to retry the exact same call; use a new key for a different one.',
        );
      }
      // #220 P2 (multi-model review): locator_file is deliberately excluded from the
      // fingerprint (see snapshotNowFingerprint's own comment above) — but a replay must
      // still honor a locator_file THIS call asked for, even though nothing is
      // re-uploaded. Without this, a caller reusing a key with a NEW/different
      // locator_file (e.g. it moved where it keeps its recovery pointer) would get a
      // reported success while the requested pointer is silently never written anywhere.
      // Deliberately minimal (locator/backend/sha256 ONLY, no re-derived sidecar
      // fields) — see writeReplayedSavedLocator's own doc comment in pushpull.ts for why.
      let replayedResult = cached.result;
      if (
        isStr(locatorFile) &&
        cached.result.pushed === true &&
        isStr(cached.result.locator) &&
        isStr(cached.result.backend) &&
        isStr(cached.result.sha256)
      ) {
        await writeReplayedSavedLocator(locatorFile, {
          locator: cached.result.locator,
          backend: cached.result.backend,
          sha256: cached.result.sha256,
        });
        replayedResult = { ...replayedResult, locator_file: locatorFile };
      }
      return structuredOk({ ...replayedResult, idempotent_replay: true });
    }
    // No `await` between this check and the `.add()` below — see idempotencyInFlight's own
    // comment for why that is what makes it safe against a concurrent duplicate.
    if (idempotencyInFlight.has(lockId)) {
      throw new ToolError(
        'ERR_IDEMPOTENCY_IN_FLIGHT',
        `a snapshot_now call with idempotency_key ${JSON.stringify(idempotencyKey)} is already running — ` +
          'wait for it to finish rather than sending a concurrent duplicate with the same key.',
      );
    }
    idempotencyInFlight.add(lockId);
  }

  try {
    // Spend gate FIRST — before any snapshot work — so a refused paid push does no
    // work and leaves no artifact behind. Never silently spend: the CLI accepts
    // CYPHER_BRAIN_YES=1 for unattended cadence loops, but via MCP the consent
    // must be in the call itself.
    if (backend && PAID_BACKENDS.has(backend) && confirmPaid !== true) {
      throw new ToolError(
        'ERR_CONFIRM_REQUIRED',
        `backend "${backend}" is a PAID, PERMANENT Arweave store — pushing spends real funds ` +
          `irreversibly. Re-call snapshot_now with confirm_paid=true to consent (the MCP equivalent ` +
          `of the CLI --yes guard). The CYPHER_BRAIN_YES environment escape hatch is not honored ` +
          `over MCP, so no call can spend without this flag.`,
      );
    }

    const snapOpts: CliOptions = { out, pg, dirs, tables: [], recipients, scan_secrets: scanSecrets };
    const snap = await captureCall(() => snapshot(snapOpts));
    const size = (await stat(out)).size;
    const digest = await sha256(out);

    const result: Record<string, unknown> = {
      out,
      size_bytes: size,
      sha256: digest,
      pushed: false,
      // The EFFECTIVE mode, read back off the options object snapshot() resolved it onto —
      // not `scanSecrets`, which is only what the CALLER passed. Since #301 an omitted
      // scan_secrets means "warn ran" as often as it means "nothing ran", so echoing the
      // input would report null for both and leave an agent unable to tell a scanned
      // snapshot from an unscanned one. Reaching this line
      // means snapshot() returned, so a mode here means the scan really ran in that mode.
      scan_secrets: snapOpts.scan_secrets ?? null,
      log: [...snap.out, ...snap.err],
      ...(snap.warnings.length ? { warnings: snap.warnings } : {}),
      idempotency_key: idempotencyKey ?? null,
      idempotent_replay: false,
    };

    if (backend) {
      const pushOpts: CliOptions = {
        in: out,
        backend,
        yes: confirmPaid === true,
        save_locator: locatorFile,
        dirs: [],
        tables: [],
        recipients: [],
      };
      let pushRes: CaptureResult<boolean>;
      try {
        pushRes = await captureCall(() => push(pushOpts));
      } catch (e) {
        // #220 (multi-model review, P1): a PushPartialSuccessError means the ciphertext
        // upload — the actual paid, permanent spend — already happened even though THIS
        // call is about to report an error. That covers BOTH the ".minisig" signature
        // sidecar upload failing (PushSignatureUploadError, e.sigLocator undefined —
        // see its own doc comment in pushpull.ts) and the LOCAL --save-locator
        // bookkeeping failing after everything durably uploaded (PushLocatorWriteError,
        // e.sigLocator set when a signed push's sidecar landed first). Either way, a
        // retry carrying the same idempotency_key must be told the spend already
        // happened, not sent to spend again for an AFTERMATH failure that has nothing
        // to do with whether the paid upload itself landed — this is precisely the
        // "partial success" scenario #220 exists to make retry-safe.
        if (idempotencyKey && fingerprint && e instanceof PushPartialSuccessError) {
          const partialResult: Record<string, unknown> = {
            ...result,
            pushed: true,
            backend,
            locator: e.locator,
            ...(e.sigLocator ? { sig_locator: e.sigLocator } : {}),
            ...(e.name === 'PushSignatureUploadError'
              ? { signature_upload_failed: true }
              : { locator_file_write_failed: true }),
          };
          try {
            await recordIdempotencyResult(
              IDEMPOTENCY_LOG,
              SNAPSHOT_NOW_TOOL.name,
              idempotencyKey,
              fingerprint,
              partialResult,
              IDEMPOTENCY_TTL_SECONDS,
            );
          } catch (recordErr) {
            // A record-write failure here must NEVER mask `e` (multi-model review, P1):
            // e.locator is recovery-critical, and swallowing it behind a DIFFERENT,
            // unrelated fs error (the ORIGINAL bug this fixes) would hide the one piece
            // of information the operator needs to hand-record the already-paid-for
            // upload. Best-effort only — log a warning and fall through to `throw e`
            // below unconditionally.
            console.error(
              `warning: could not record the idempotency-key result for a partially-succeeded snapshot_now call ` +
                `(idempotency_key=${JSON.stringify(idempotencyKey)}, locator=${JSON.stringify(e.locator)}): ` +
                `${errMsg(recordErr)} — the error below (not this warning) is the one to act on.`,
            );
          }
        }
        throw e;
      }
      const locator = pushRes.out.join('\n').trim(); // push() prints ONLY the locator to stdout
      result.pushed = true;
      result.backend = backend;
      result.locator = locator;
      if (locatorFile) result.locator_file = locatorFile;
      (result.log as string[]).push(...pushRes.err);
    }

    if (idempotencyKey && fingerprint) {
      try {
        await recordIdempotencyResult(
          IDEMPOTENCY_LOG,
          SNAPSHOT_NOW_TOOL.name,
          idempotencyKey,
          fingerprint,
          result,
          IDEMPOTENCY_TTL_SECONDS,
        );
      } catch (recordErr) {
        // The snapshot (and any push) already fully succeeded — `result` is complete and
        // correct. Only the FUTURE-replay safety net failed to get written; that must
        // not turn an actually-successful, already-paid-for call into a reported
        // failure, which would all but guarantee a double-spend retry AND hide that the
        // work genuinely succeeded (multi-model review, P1: the same "never let
        // idempotency-log bookkeeping outrank the real result" principle as above).
        console.error(
          `warning: snapshot_now succeeded but recording its idempotency-key result failed ` +
            `(idempotency_key=${JSON.stringify(idempotencyKey)}): ${errMsg(recordErr)} — a retry with the SAME key ` +
            'will not replay this result and may re-execute.',
        );
      }
    }
    return structuredOk(result);
  } finally {
    if (lockId) idempotencyInFlight.delete(lockId);
  }
}

interface LocatorSource {
  source: 'locator_file' | 'index_file';
  path: string;
  locator: string;
  backend: string | null;
  sha256: string | null;
  content_digest?: string | null;
  timestamp: string;
  entries?: number;
  age_seconds?: number | null;
}

// Parse one save-locator file ("<locator>\t<backend>\t<sha256>[\t<content_digest>[\t
// <recipients_fingerprint>[\t<sig_locator>[\t<sign_key_id>]]]]", latest only; timestamp
// = file mtime since push does not record one in it). Legacy 3-field lines (pre-#70, no
// content_digest) and 4-field lines (no recipients_fingerprint) parse identically —
// never break the recovery of an existing file. Only the first four fields are read
// here; the later ones are push-side bookkeeping for --skip-unchanged (#214/#250) and
// are ignored on this path, which is why a longer line needs no change here.
async function readLocatorFile(path: string): Promise<LocatorSource> {
  const text = await readFile(path, 'utf8');
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) throw new ToolError('ERR_INVALID_INPUT', `locator file ${path} has no locator line`);
  const [locator, backend, digest, contentDigest] = line.split('\t');
  if (!locator || !backend)
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `locator file ${path} must contain "<locator>\\t<backend>[\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]]" — got: ${JSON.stringify(line)}`,
    );
  const { mtime } = await stat(path);
  return {
    source: 'locator_file',
    path,
    locator,
    backend,
    sha256: digest || null,
    content_digest: contentDigest || null,
    timestamp: mtime.toISOString(),
  };
}

// Parse an append-only index.tsv ("<timestamp>\t<locator>\t<sha256>", newest LAST).
async function readIndexFile(path: string): Promise<LocatorSource> {
  const text = await readFile(path, 'utf8');
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) throw new ToolError('ERR_INVALID_INPUT', `index file ${path} has no entries`);
  const last = lines[lines.length - 1];
  const [timestamp, locator, digest] = last.split('\t');
  if (!timestamp || !locator)
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `index file ${path} lines must be "<timestamp>\\t<locator>[\\t<sha256>]" — got: ${JSON.stringify(last)}`,
    );
  // The index records timestamp+locator+sha256 but not the backend — that lives
  // in the save-locator file / the push command itself.
  return {
    source: 'index_file',
    path,
    locator,
    backend: null,
    sha256: digest || null,
    timestamp,
    entries: lines.length,
  };
}

const ageSeconds = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 1000));
};

async function handleLastSnapshotStatus(args: ToolArgs): Promise<CallToolResult> {
  if (args.locator_file !== undefined && !isStr(args.locator_file))
    throw new ToolError('ERR_INVALID_INPUT', 'locator_file must be a string path');
  if (args.index_file !== undefined && !isStr(args.index_file))
    throw new ToolError('ERR_INVALID_INPUT', 'index_file must be a string path');
  let locatorFile: string | undefined = isStr(args.locator_file) ? args.locator_file : undefined;
  const indexFile: string | undefined = isStr(args.index_file) ? args.index_file : undefined;
  let defaulted = false;
  if (!locatorFile && !indexFile) {
    locatorFile = join(HOME, 'latest-locator.tsv'); // the MANAGEMENT.md cadence default
    defaulted = true;
    if (!(await exists(locatorFile))) {
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `no locator_file/index_file given and the default save-locator file does not exist: ${locatorFile}. Pass locator_file (a push --save-locator file) or index_file (an append-only index.tsv).`,
      );
    }
  }
  const sources: LocatorSource[] = [];
  if (locatorFile) {
    if (!(await exists(locatorFile))) throw new ToolError('ERR_INVALID_INPUT', `no such locator file: ${locatorFile}`);
    sources.push(await readLocatorFile(locatorFile));
  }
  if (indexFile) {
    if (!(await exists(indexFile))) throw new ToolError('ERR_INVALID_INPUT', `no such index file: ${indexFile}`);
    sources.push(await readIndexFile(indexFile));
  }
  for (const s of sources) s.age_seconds = ageSeconds(s.timestamp);
  // latest = the newest-timestamped entry across whichever sources were readable
  const latest = sources.slice().sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
  return structuredOk({ latest, sources, defaulted_to: defaulted ? locatorFile : undefined });
}

// SIG_FETCH_FAILED / redactUserinfo / signatureGap now live in src/lib/pushpull.ts
// (imported above) — shared with the CLI's `verify --level remote/drill` (src/lib/
// restore.ts, #209), which used to have no equivalent structured report at all.

async function handleVerifyRestore(args: ToolArgs): Promise<CallToolResult> {
  const {
    locator,
    file,
    backend,
    identity,
    sha256: pin,
    locator_file: locatorFile,
    require_signature: requireSignature,
  } = args;
  // Validated rather than coerced: `requireSignature === true` alone would read
  // require_signature: "true" — a plausible thing for a client to send — as FALSE, silently
  // handing back the permissive posture to a caller who asked for the strict one (multi-model
  // review finding). Every neighbouring typed field is checked the same way.
  if (requireSignature !== undefined && !isBool(requireSignature))
    throw new ToolError('ERR_INVALID_INPUT', 'require_signature must be a boolean');
  const given = [locator, file, locatorFile].filter((v) => v !== undefined).length;
  if (given !== 1) {
    throw new ToolError(
      'ERR_INVALID_INPUT',
      'pass exactly one of locator (pull first), file (verify a local .age), or locator_file (a push --save-locator file: locator + backend + sha256 pin in one)',
    );
  }
  if (locatorFile !== undefined) {
    if (!isStr(locatorFile)) throw new ToolError('ERR_INVALID_INPUT', 'locator_file must be a string path');
    if (backend !== undefined)
      throw new ToolError(
        'ERR_INVALID_INPUT',
        'backend cannot be combined with locator_file — the file records the backend itself',
      );
  }
  if (pin !== undefined && !(isStr(pin) && SHA256_HEX.test(pin))) {
    throw new ToolError(
      'ERR_INVALID_INPUT',
      'sha256 must be a 64-char hex string (the expected ciphertext digest, from a trusted off-box record)',
    );
  }
  if (identity !== undefined && !isStr(identity))
    throw new ToolError('ERR_INVALID_INPUT', 'identity must be a string path');
  let target: string | undefined = isStr(file) ? file : undefined;
  let effectivePin: string | undefined = isStr(pin) ? pin : undefined;
  let tdir: string | null = null;
  let pulled: Record<string, unknown> | undefined;
  let signature: Record<string, unknown> | undefined;
  let warning: string | undefined;
  try {
    if (file === undefined) {
      if (locator !== undefined) {
        if (!isStr(locator)) throw new ToolError('ERR_INVALID_INPUT', 'locator must be a string');
        requireBackend(backend, 'backend (required with locator)');
      }
      tdir = makeFetchDir();
      target = join(tdir, 'pulled.age');
      // pull() natively understands from_locator_file — the SAME parsing + pin
      // application as the CLI recovery path (src/lib/pushpull.ts) — and fills
      // the resolved locator/backend/sha256 back into this options object. A
      // sha256 mismatch deletes the artifact and throws: fail closed, no verdict.
      const pullOpts: CliOptions = {
        locator: isStr(locator) ? locator : undefined,
        backend: isStr(backend) ? backend : undefined,
        out: target,
        sha256: effectivePin,
        from_locator_file: isStr(locatorFile) ? locatorFile : undefined,
        dirs: [],
        tables: [],
        recipients: [],
      };
      const pullRes = await captureCall(() => pull(pullOpts));
      // err before out: pull's narrative (retries, progress, warnings) goes to stderr, and the
      // single stdout line is the resolved locator it prints last — concatenating out first
      // would put the end of the story at the top.
      const pullLog = [...pullRes.err, ...pullRes.out].map(redactUserinfo);
      effectivePin = pullOpts.sha256;
      signature = signatureGap(pullLog, pullOpts.sig_locator);
      pulled = {
        backend: pullOpts.backend,
        locator: pullOpts.locator,
        sha256_pin: effectivePin ?? null,
        // Everything pull() said, which used to be collected and dropped (#312): the retry
        // lines behind `wait`, the `sha256 OK: <hash>` confirmation, the transfer progress
        // added in #283, and — the reason this is a bug rather than a nicety — the warning
        // naming WHY an authenticity signature could not be fetched.
        log: pullLog,
        ...(locatorFile !== undefined ? { locator_file: locatorFile } : {}),
      };
      if (!effectivePin && pullOpts.backend && NON_CONTENT_ADDRESSED_BACKENDS.has(pullOpts.backend)) {
        warning =
          `integrity pin NOT applied: ${pullOpts.backend} locators are not content hashes (post-assigned ids for ` +
          'arweave/turbo, an operator-chosen remote path for rclone), so a gateway rollback/substitution that ' +
          'still decrypts with your key would go undetected by this ' +
          'verdict. Pass sha256 (the expected ciphertext digest from a trusted off-box record, e.g. index.tsv) ' +
          'or use locator_file (a push --save-locator file, which carries the pin) to fail closed like the CLI recovery path.';
      }
    } else if (!isStr(file)) {
      throw new ToolError('ERR_INVALID_INPUT', 'file must be a string path');
    } else {
      await requireCallerFile(file);
    }
    if (!target) throw new ToolError('ERR_INTERNAL', 'no target file resolved for verify');
    // The pin (explicit or read from locator_file) is ALSO handed to verify() so
    // the checks record "[PASS] sha256 matches the expected hash" like the CLI;
    // for a local file this is where the pin is enforced (mismatch = FAIL).
    const verifyOpts: CliOptions = {
      in: target,
      identity: isStr(identity) ? identity : undefined,
      sha256: effectivePin,
      // #319: passed through rather than reinterpreted. verify() already turns an ABSENT
      // signature from a [SKIP] into a FAIL under this flag (#214), so the MCP surface gets
      // the CLI's exact semantics instead of a second implementation of them.
      require_signature: requireSignature === true,
      dirs: [],
      tables: [],
      recipients: [],
    };
    const res = await captureCall(() => verify(verifyOpts));
    // verify() reports through process.exitCode: 0 PASS, 1 FAIL, 2 PARTIAL.
    const verdict = res.exitCode === 0 ? 'PASS' : res.exitCode === 2 ? 'PARTIAL' : 'FAIL';
    return structuredOk({
      verdict,
      exit_code: res.exitCode,
      restorable_proven: verdict === 'PASS', // PARTIAL ≠ PASS: decryptability was not proven
      checks: res.out,
      ...(pulled ? { pulled } : {}),
      // Named separately rather than folded into `warning` (which is about integrity pins,
      // a different question) so a caller can branch on it without parsing prose.
      ...(signature ? { signature } : {}),
      ...(warning ? { warning } : {}),
      ...(verdict === 'PARTIAL'
        ? {
            note: 'header + wrong-key checks passed but no private identity could prove decryptability on this box — run verify_restore where the identity lives for a full PASS.',
          }
        : {}),
    });
  } finally {
    await discardFetchDir(tdir);
  }
}

// restore_now shares its dual-mode locator/file/locator_file input resolution with
// verify_restore above (pull into a scratch tmpdir, or use a local file directly),
// then hands the resolved .age path to restore() (src/lib/restore.ts) — the SAME
// function the CLI's `restore` subcommand dispatches to — instead of re-implementing
// the decrypt+extract(+pg_restore) logic here.
async function handleRestoreNow(args: ToolArgs): Promise<CallToolResult> {
  const {
    locator,
    file,
    locator_file: locatorFile,
    backend,
    sha256: pin,
    out_dir: outDir,
    identity,
    pg,
    confirm_write: confirmWrite,
    require_signature: requireSignature,
  } = args;

  // Validated rather than coerced: `requireSignature === true` alone would read
  // require_signature: "true" — a plausible thing for a client to send — as FALSE, silently
  // handing back the permissive posture to a caller who asked for the strict one (multi-model
  // review finding). Every neighbouring typed field is checked the same way.
  if (requireSignature !== undefined && !isBool(requireSignature))
    throw new ToolError('ERR_INVALID_INPUT', 'require_signature must be a boolean');
  const given = [locator, file, locatorFile].filter((v) => v !== undefined).length;
  if (given !== 1) {
    throw new ToolError(
      'ERR_INVALID_INPUT',
      'pass exactly one of locator (pull first), file (restore a local .age), or locator_file (a push --save-locator file: locator + backend + sha256 pin in one)',
    );
  }
  if (locatorFile !== undefined) {
    if (!isStr(locatorFile)) throw new ToolError('ERR_INVALID_INPUT', 'locator_file must be a string path');
    if (backend !== undefined)
      throw new ToolError(
        'ERR_INVALID_INPUT',
        'backend cannot be combined with locator_file — the file records the backend itself',
      );
  }
  if (pin !== undefined && !(isStr(pin) && SHA256_HEX.test(pin))) {
    throw new ToolError(
      'ERR_INVALID_INPUT',
      'sha256 must be a 64-char hex string (the expected ciphertext digest, from a trusted off-box record)',
    );
  }
  if (!isStr(outDir)) throw new ToolError('ERR_INVALID_INPUT', 'out_dir (string path) is required');
  if (identity !== undefined && !isStr(identity))
    throw new ToolError('ERR_INVALID_INPUT', 'identity must be a string path');
  if (pg !== undefined && !isStr(pg)) throw new ToolError('ERR_INVALID_INPUT', 'pg must be a string connection URI');
  if (confirmWrite !== undefined && !isBool(confirmWrite))
    throw new ToolError('ERR_INVALID_INPUT', 'confirm_write must be a boolean');

  // Consequential-action gate FIRST — before any pull/decrypt/extract work happens,
  // same "check before work" discipline as snapshot_now's confirm_paid gate above.
  // Restoring writes decrypted files into out_dir, and when pg is given ALSO runs
  // pg_restore --clean --if-exists (DROPS and replaces objects in that database).
  // The CLI accepts CYPHER_BRAIN_YES=1 for unattended runs, but via MCP the consent
  // must be in the call itself — the env escape hatch is deliberately NOT honored here.
  if (confirmWrite !== true) {
    throw new ToolError(
      'ERR_CONFIRM_REQUIRED',
      'restore_now writes decrypted files into out_dir' +
        (pg
          ? ', and pg is given so pg_restore --clean --if-exists will DROP and replace objects in that database'
          : '') +
        ' — re-call restore_now with confirm_write=true to consent (the MCP equivalent of the CLI --yes guard). ' +
        'The CYPHER_BRAIN_YES environment escape hatch is not honored over MCP, so no call can restore/clobber ' +
        'without this flag.',
    );
  }

  let target: string | undefined = isStr(file) ? file : undefined;
  // #293: validate a caller-given `file` BEFORE any branch below, so a path that is
  // not there is reported as bad input rather than failing later inside the pin copy
  // or the decrypt. Skipped entirely for locator / locator_file input, where `file`
  // is undefined and the artifact is fetched rather than given.
  if (isStr(file)) await requireCallerFile(file);
  let effectivePin: string | undefined = isStr(pin) ? pin : undefined;
  let tdir: string | null = null;
  let pulled: Record<string, unknown> | undefined;
  let signature: Record<string, unknown> | undefined;
  try {
    if (file === undefined) {
      if (locator !== undefined) {
        if (!isStr(locator)) throw new ToolError('ERR_INVALID_INPUT', 'locator must be a string');
        requireBackend(backend, 'backend (required with locator)');
      }
      tdir = makeFetchDir();
      target = join(tdir, 'pulled.age');
      // pull() natively understands from_locator_file and applies the sha256 pin
      // (explicit or read from the locator file) BEFORE the fetched bytes are
      // promoted to `target` — a mismatch deletes the temp fetch and throws, so
      // nothing here is ever decrypted/extracted from an unpinned/substituted artifact.
      const pullOpts: CliOptions = {
        locator: isStr(locator) ? locator : undefined,
        backend: isStr(backend) ? backend : undefined,
        out: target,
        sha256: effectivePin,
        from_locator_file: isStr(locatorFile) ? locatorFile : undefined,
        dirs: [],
        tables: [],
        recipients: [],
      };
      const pullRes = await captureCall(() => pull(pullOpts));
      // err before out: pull's narrative (retries, progress, warnings) goes to stderr, and the
      // single stdout line is the resolved locator it prints last — concatenating out first
      // would put the end of the story at the top.
      const pullLog = [...pullRes.err, ...pullRes.out].map(redactUserinfo);
      effectivePin = pullOpts.sha256;
      signature = signatureGap(pullLog, pullOpts.sig_locator);
      pulled = {
        backend: pullOpts.backend,
        locator: pullOpts.locator,
        sha256_pin: effectivePin ?? null,
        // Everything pull() said, which used to be collected and dropped (#312): the retry
        // lines behind `wait`, the `sha256 OK: <hash>` confirmation, the transfer progress
        // added in #283, and — the reason this is a bug rather than a nicety — the warning
        // naming WHY an authenticity signature could not be fetched.
        log: pullLog,
        ...(locatorFile !== undefined ? { locator_file: locatorFile } : {}),
      };
    } else if (!isStr(file)) {
      throw new ToolError('ERR_INVALID_INPUT', 'file must be a string path');
    } else if (effectivePin) {
      // Unlike a pulled artifact (pinned above by pull() itself), a directly-given
      // `file` never passes through that check — apply the SAME pin here so file
      // and locator/locator_file inputs get identical integrity guarantees before
      // any decrypt/extract work runs (restore(), unlike verify(), does not check
      // sha256 itself). Copy `file` into our own private tmpdir FIRST, then hash
      // and restore that copy — never re-open the caller-given path a second time
      // (a hash-then-reopen would leave a window where the file at that path
      // could change between the two operations; copying once removes it).
      tdir = makeFetchDir();
      const pinnedCopy = join(tdir, 'given.age');
      await copyFile(file, pinnedCopy);
      // The authenticity sidecar has to come WITH it. restore() looks for "<in>.minisig"
      // beside whatever it is handed, so copying only the ciphertext left the artifact
      // looking UNSIGNED to the very next step — and an absent signature warns and
      // continues, while an INVALID one refuses (#214). Passing sha256 therefore turned a
      // tampered signature into a silent success: adding an integrity pin, the more careful
      // thing to do, disabled the authenticity check. Measured on the pre-fix build — the
      // CLI refused the same tampered artifact and this path restored it (multi-model
      // review finding). Best-effort by the same #214 logic: an artifact with no sidecar
      // beside it is unsigned, which is a state restore() already handles.
      if (await exists(`${file}.minisig`)) await copyFile(`${file}.minisig`, `${pinnedCopy}.minisig`);
      target = pinnedCopy;
      const got = await sha256(target);
      if (got.toLowerCase() !== effectivePin.toLowerCase()) {
        throw new ToolError(
          'ERR_INVALID_INPUT',
          `sha256 mismatch: ${file} has ${got}, expected ${effectivePin} — refusing to restore an unverified artifact`,
        );
      }
    }

    const restoreOpts: CliOptions = {
      in: target,
      out_dir: outDir,
      identity: isStr(identity) ? identity : undefined,
      pg: isStr(pg) ? pg : undefined,
      // #319: restore() checks authenticity FIRST — before the identity is loaded, before
      // out_dir is touched, and before pg_restore --clean --if-exists can drop anything.
      // Passing the flag through therefore puts the refusal ahead of the consequential
      // action, which is what a gate has to do. The `signature` field added in #312 reports
      // the same situation but only after the restore has run: detection, not a gate.
      require_signature: requireSignature === true,
      yes: true, // already gated above by confirm_write; restore()'s own --pg guard needs this to proceed
      dirs: [],
      tables: [],
      recipients: [],
    };
    let res: CaptureResult<void>;
    try {
      res = await captureCall(() => restore(restoreOpts));
    } catch (e) {
      // A refusal under require_signature throws, so the structured result below — and with
      // it the `signature` object #312 added — never gets built. The caller would then read
      // restore()'s generic "no signature found" wording for a case where this server KNOWS
      // a recorded sidecar failed to fetch, and knows why.
      // Carry that diagnosis onto the error rather than losing it.
      if (!signature) throw e;
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `${errMsg(e)} — note: ${String(signature.note ?? '')} (${String(signature.reason ?? 'no reason recorded')})`,
      );
    }
    return structuredOk({
      out_dir: outDir,
      ...(pulled ? { pulled } : {}),
      ...(signature ? { signature } : {}),
      pg_restored: Boolean(pg),
      log: [...res.out, ...res.err],
      ...(res.warnings.length ? { warnings: res.warnings } : {}),
    });
  } finally {
    await discardFetchDir(tdir);
  }
}

async function handleEstimateCost(args: ToolArgs): Promise<CallToolResult> {
  const { file, size_bytes: sizeBytes, backend } = args;
  requireBackend(backend, 'backend');
  if ((file === undefined) === (sizeBytes === undefined)) {
    throw new ToolError('ERR_INVALID_INPUT', 'pass exactly one of file (a path to size) or size_bytes');
  }
  let size: number;
  if (file !== undefined) {
    if (!isStr(file)) throw new ToolError('ERR_INVALID_INPUT', 'file must be a string path');
    await requireCallerFile(file); // #293: shared with verify_restore/restore_now
    size = (await stat(file)).size;
  } else {
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes < 0)
      throw new ToolError('ERR_INVALID_INPUT', 'size_bytes must be a non-negative number');
    size = Math.ceil(sizeBytes);
  }
  // The actual price computation (file/turbo/arweave, incl. the nullable usd_estimate)
  // lives in src/lib/estimate.ts — the SAME function the CLI `estimate` command calls,
  // so this math is never re-implemented per surface (#159).
  return structuredOk({ ...(await estimateCost(backend, size)) });
}

// schedule({_: 'install', ...}) is the SAME function + dispatch branch the CLI's
// `schedule install` subcommand uses — install() itself returns void (progress
// only via console.error, no console.log data lines), so this returns the
// captured log verbatim plus an echo of the args that were actually consented
// to, rather than re-parsing/re-deriving the written config (same "no
// re-implemented logic" approach as handleScheduleStatus below).
//
// This tool's key set used to be enumerated here a SECOND time, to reject a stray
// `no_laod` before it could register a real trigger where a preview was meant. The
// dispatcher now derives that check from the advertised schema for every tool
// (assertDeclaredArgs, #300), so the duplicate list is gone rather than left to drift
// from the schema it copied.
async function handleScheduleInstall(args: ToolArgs): Promise<CallToolResult> {
  const {
    backend,
    dirs = [],
    pg,
    recipients = [],
    at,
    max_spend: maxSpend,
    no_load: noLoad,
    ping_url: pingUrl,
    ping_url_fail: pingUrlFail,
    scan_secrets: scanSecrets,
    confirm_install: confirmInstall,
  } = args;
  requireBackend(backend, 'backend');
  if (!isStrArray(dirs)) throw new ToolError('ERR_INVALID_INPUT', 'dirs must be an array of strings');
  if (pg !== undefined && !isStr(pg)) throw new ToolError('ERR_INVALID_INPUT', 'pg must be a string connection URI');
  if (!isStrArray(recipients)) throw new ToolError('ERR_INVALID_INPUT', 'recipients must be an array of strings');
  if (at !== undefined && !isStr(at)) throw new ToolError('ERR_INVALID_INPUT', 'at must be a string "HH:MM"');
  if (maxSpend !== undefined && !isStr(maxSpend))
    throw new ToolError('ERR_INVALID_INPUT', 'max_spend must be a string (a positive integer in native units)');
  if (noLoad !== undefined && !isBool(noLoad)) throw new ToolError('ERR_INVALID_INPUT', 'no_load must be a boolean');
  if (pingUrl !== undefined && !isStr(pingUrl)) throw new ToolError('ERR_INVALID_INPUT', 'ping_url must be a string');
  if (pingUrlFail !== undefined && !isStr(pingUrlFail))
    throw new ToolError('ERR_INVALID_INPUT', 'ping_url_fail must be a string');
  // Same as snapshot_now's: assertDeclaredEnums (#308) is what refuses a bad mode; this is
  // the narrowing assertion for the CliOptions handoff below.
  if (scanSecrets !== undefined && !isScanSecretsMode(scanSecrets))
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `scan_secrets must be one of ${SCAN_SECRETS_MODES.join('|')} — got ${JSON.stringify(scanSecrets)}`,
    );

  // Consequential-action gate FIRST — before any file write happens, same
  // discipline as every other mutating tool in this server. Covers BOTH the
  // real-system-file write and, for a paid backend, the ongoing capped spend
  // every future unattended run carries — there is no env escape hatch here.
  if (confirmInstall !== true) {
    throw new ToolError(
      'ERR_CONFIRM_REQUIRED',
      'schedule_install writes a real, persistent system file (a launchd plist or crontab entry)' +
        (PAID_BACKENDS.has(backend)
          ? ` and, since backend "${backend}" is paid, commits to an ongoing spend capped at max_spend on every future unattended run`
          : '') +
        ' — re-call schedule_install with confirm_install=true to consent. There is no environment escape hatch honored over MCP.',
    );
  }

  const installOpts: CliOptions = {
    _: 'install',
    backend,
    dirs,
    pg,
    recipients,
    at,
    max_spend: maxSpend,
    no_load: noLoad,
    ping_url: pingUrl,
    ping_url_fail: pingUrlFail,
    scan_secrets: scanSecrets,
    tables: [],
  };
  const res = await captureCall(() => schedule(installOpts));
  return structuredOk({
    backend,
    at: at || '03:30',
    no_load: Boolean(noLoad),
    ...(maxSpend ? { max_spend: maxSpend } : {}),
    // The EFFECTIVE mode install() resolved and baked, read back off the options object —
    // not the caller's input, which install() now fills in when it was omitted (#301).
    // Reaching this line means install() succeeded, so this reports what the installed
    // nightly will really do.
    scan_secrets: installOpts.scan_secrets ?? null,
    log: [...res.out, ...res.err],
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
  });
}

// scheduleStatusReport() (src/lib/schedule.ts) is the SAME function the CLI's
// `schedule status --json` prints and the cypher-brain://schedule/status resource
// serves (#285). This used to capture schedule()'s console output and return it as
// `{ report: [lines] }`, because that function had no return value — so the tool
// handed back prose an agent had to parse. One object now, three surfaces, no
// re-implementation and no text round-trip.
//
// This handler used to reject stray arguments itself, because a field like a
// schedule_dir override a client imagined would otherwise be discarded and this would
// answer about the server's OWN configured schedule as if that were the one asked
// about. That reasoning was always true of every tool here, not just this one — it is
// now stated once and enforced for all of them in assertDeclaredArgs (#300), which is
// why this takes no `args` at all.
async function handleScheduleStatus(): Promise<CallToolResult> {
  return structuredOk(await scheduleStatusReport());
}

// keygenAt() (src/lib/keys.ts) is the SAME generation logic `cypher-brain keygen`
// calls (keygen() is a thin wrapper over it for the module's global HOME/IDENTITY/
// RECIPIENT paths) — used directly here (rather than keygen()) because it RETURNS
// { recipient, wrapped } instead of only printing them, so this handler returns
// structured fields instead of re-parsing console.log lines.
async function handleKeygen(args: ToolArgs): Promise<CallToolResult> {
  const { force, passphrase, pq } = args;
  if (force !== undefined && !isBool(force)) throw new ToolError('ERR_INVALID_INPUT', 'force must be a boolean');
  if (passphrase !== undefined && !isBool(passphrase))
    throw new ToolError('ERR_INVALID_INPUT', 'passphrase must be a boolean');
  if (pq !== undefined && !isBool(pq)) throw new ToolError('ERR_INVALID_INPUT', 'pq must be a boolean');
  const res = await captureCall(() =>
    keygenAt({ home: HOME, identityPath: IDENTITY, recipientPath: RECIPIENT, passphrase, force, pq }),
  );
  return structuredOk({
    identity_path: IDENTITY,
    recipient_path: RECIPIENT,
    recipient: res.value.recipient,
    passphrase_wrapped: res.value.wrapped,
    post_quantum: !!pq,
    log: [...res.out, ...res.err],
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
  });
}

// wallet({_: 'create'|'address'}) (src/lib/wallet.ts) is the SAME dispatch the CLI's
// `wallet create`/`wallet address` subcommands use — it has no structured return (void,
// console.log only), so unlike keygen above these two just capture + return its output
// lines, mirroring handleScheduleStatus's "no re-implemented logic" approach. Each
// printed line has exactly one trailing token that IS the field of interest (a path or
// an address, neither of which can contain whitespace), so pulling the last
// whitespace-separated token is a stable read of a fixed, first-party console.log
// format — not a parse of arbitrary text.
const lastToken = (line: string | undefined): string | undefined => line?.trim().split(/\s+/).pop();

async function handleWalletCreate(args: ToolArgs): Promise<CallToolResult> {
  const { out, force } = args;
  if (out !== undefined && !isStr(out)) throw new ToolError('ERR_INVALID_INPUT', 'out must be a string path');
  if (force !== undefined && !isBool(force)) throw new ToolError('ERR_INVALID_INPUT', 'force must be a boolean');
  if (isStr(out)) assertWithinHome(out);
  const walletOpts: CliOptions = {
    _: 'create',
    dirs: [],
    tables: [],
    recipients: [],
    out: isStr(out) ? out : undefined,
    force,
  };
  const res = await captureCall(() => wallet(walletOpts));
  return structuredOk({
    wallet_path: lastToken(res.out[0]),
    address: lastToken(res.out[1]),
    log: [...res.out, ...res.err],
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
  });
}

async function handleWalletAddress(args: ToolArgs): Promise<CallToolResult> {
  const { wallet: walletPath } = args;
  if (walletPath !== undefined && !isStr(walletPath))
    throw new ToolError('ERR_INVALID_INPUT', 'wallet must be a string path');
  const walletOpts: CliOptions = {
    _: 'address',
    dirs: [],
    tables: [],
    recipients: [],
    wallet: isStr(walletPath) ? walletPath : undefined,
  };
  const res = await captureCall(() => wallet(walletOpts));
  return structuredOk({
    address: lastToken(res.out[0]),
    log: [...res.out, ...res.err],
    ...(res.warnings.length ? { warnings: res.warnings } : {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Server bootstrap
// ─────────────────────────────────────────────────────────────────────────────

// #285: tools are MODEL-controlled (the LLM decides to invoke one); resources are
// APPLICATION-controlled (the client attaches them). The schedule's state is a document
// a user may want pinned rather than something the model should have to think to fetch,
// and the restore runbook is a procedure agents keep reconstructing from prose — so both
// of those primitives are declared, alongside the ten tools.
const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {}, resources: {}, prompts: {} } },
);

// ─── resources (#285) ──────────────────────────────────────────────────────────
// One resource, and only one on purpose. `schedule_status` is the single status tool
// that takes NO arguments, so it maps to a fixed URI; `last_snapshot_status` takes
// optional locator_file/index_file paths and would need a URI template, which is a
// separate decision rather than a detail of this one.
//
// It serves the SAME object scheduleStatusReport() returns to the tool and to the CLI's
// `schedule status --json`. That is the whole reason this was safe to add: a resource
// that built its own view would be a third description of one contract, which is the
// bug class this repo has spent the week removing (#276, #280, #290, #293). The two are
// not byte-identical — this side is pretty-printed JSON text, and next_run is derived
// from the clock at call time — but neither can describe the state differently.
const SCHEDULE_STATUS_URI = 'cypher-brain://schedule/status';

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: SCHEDULE_STATUS_URI,
      name: 'Schedule status',
      description:
        'The installed nightly schedule: when it runs, which backend, which config file supplied ' +
        'settings, whether the launchd/cron trigger is actually registered, the last run’s result ' +
        'and the next run time. Read-only. Identical to the schedule_status tool’s result — this is ' +
        'the same state offered as something a client can attach rather than something the model has ' +
        'to think to ask for. Errors if no schedule is installed.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri !== SCHEDULE_STATUS_URI) throw new ToolError('ERR_INVALID_INPUT', `no such resource: ${uri}`);
  return {
    contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await scheduleStatusReport(), null, 2) }],
  };
});

// ─── prompts (#285) ────────────────────────────────────────────────────────────
// The restore procedure, which an agent would otherwise reconstruct from prose every
// time. Its text is MANAGEMENT.md's "## Restore runbook" section — inlined at build
// time for a shipped build, read from the repo in dev (src/lib/runbook.ts). No copy of
// it lives in the source tree.
const RESTORE_PROMPT = 'restore-runbook';

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: RESTORE_PROMPT,
      title: 'Restore a cypher-brain snapshot',
      description:
        'The documented procedure for getting a snapshot back on a machine that holds an identity: ' +
        'pull the ciphertext, verify it before trusting it, then decrypt into a SCRATCH target. ' +
        'Verbatim from MANAGEMENT.md so it cannot drift from the documentation.',
      arguments: [],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;
  if (name !== RESTORE_PROMPT) throw new ToolError('ERR_INVALID_INPUT', `no such prompt: ${name}`);
  return {
    description: 'cypher-brain restore runbook (from MANAGEMENT.md)',
    messages: [{ role: 'user' as const, content: { type: 'text' as const, text: restoreRunbook() } }],
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ALL_TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const name = request.params.name;
  const args: ToolArgs = request.params.arguments ?? {};
  try {
    // #226: each MCP tool call becomes an OTel span when active (see otel.ts's
    // withSpan() — a pure passthrough when OTEL_EXPORTER_OTLP_ENDPOINT is unset, the
    // default). Wraps the validation checks below TOO, not just the switch — a call
    // refused for an unknown tool name, an undeclared/out-of-enum arg, or a branch-
    // irrelevant field is still a real invocation, and this is exactly the kind of
    // thing #226's own "what actually happened" motivation cares about seeing (Codex
    // review, #226 part 3). `name` is known before any of these checks can throw, so
    // the span name doesn't depend on validation succeeding.
    return await withSpan(name, async (): Promise<CallToolResult> => {
      // #300: one check, derived from the tool's own advertised inputSchema, applying to
      // every tool including any added later — so `additionalProperties: false` means at
      // runtime what tools/list says it means. Runs BEFORE dispatch, so no handler can
      // start work on a call carrying a field it will not read.
      //
      // A name that is not in ALL_TOOLS is answered HERE and never reaches the switch —
      // otherwise a future case added to the switch but forgotten in ALL_TOOLS would be
      // both invisible in tools/list and reachable with entirely unvalidated arguments,
      // which is the hole this whole change is about, one level up (multi-model review
      // finding). Being unlisted therefore means uncallable, not unchecked.
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return structuredErr(new ToolError('ERR_INVALID_INPUT', `Unknown tool: ${name}`));
      // Before anything else, and deliberately before the argument checks: a tool nobody has
      // answered the branch-relevance question for must not serve a call at all (#308). Put
      // last it would be unreachable for exactly the calls the every-tool CI pass makes,
      // which is what turns a forgotten declaration into a red build rather than a quiet gap.
      assertBranchDeclared(name);
      assertDeclaredArgs(tool, args);
      // #308: names first, then the VALUES those names carry — a declared field whose
      // schema pins an `enum` is checked against it here, for every tool, before dispatch,
      // so a bad value is refused whether or not the branch taken would have read it.
      assertDeclaredEnums(tool, args);
      // #308 direction 2: names, then values, then whether the branch this call selects will
      // actually READ the fields it carries. Last of the three because a field that is
      // undeclared or out-of-enum is wrong on its own terms, and should be reported that way
      // rather than as irrelevant.
      assertBranchRelevance(name, args);
      switch (name) {
        case 'snapshot_now':
          return await handleSnapshotNow(args);
        case 'last_snapshot_status':
          return await handleLastSnapshotStatus(args);
        case 'verify_restore':
          return await handleVerifyRestore(args);
        case 'restore_now':
          return await handleRestoreNow(args);
        case 'estimate_cost':
          return await handleEstimateCost(args);
        case 'schedule_install':
          return await handleScheduleInstall(args);
        case 'schedule_status':
          return await handleScheduleStatus();
        case 'keygen':
          return await handleKeygen(args);
        case 'wallet_create':
          return await handleWalletCreate(args);
        case 'wallet_address':
          return await handleWalletAddress(args);
        // Unreachable via the guard above for any name outside ALL_TOOLS; what lands
        // here is a tool this server ADVERTISES and cannot dispatch, which is a wiring
        // bug on our side rather than a caller mistake — and ERR_INTERNAL is the
        // honest way to say so. scripts/mcp-smoke.mjs calls every advertised tool, so
        // it fires in CI.
        default:
          return structuredErr(new ToolError('ERR_INTERNAL', `${name} is advertised in tools/list but not dispatched`));
      }
    });
  } catch (err) {
    return structuredErr(err);
  }
});

async function main(): Promise<void> {
  // #286: same guard as the CLI — refuse to serve with a config file we could not
  // accept, rather than silently running as if the operator had configured nothing.
  if (CONFIG_FILE_ERROR) throw CONFIG_FILE_ERROR;
  // #220 (multi-model review P2): same posture — refuse to serve with an idempotency-key
  // TTL override that would silently defeat the feature (see config.ts's own doc comment
  // on IDEMPOTENCY_TTL_ERROR). The CLI never reads or writes the idempotency log, so this
  // check lives only here, not in cli.ts's equivalent guard.
  if (IDEMPOTENCY_TTL_ERROR) throw IDEMPOTENCY_TTL_ERROR;
  // Module-load warnings (a deprecated env var, a loose-permissioned config file)
  // already printed to the server's stderr live; drain them here so they are not
  // misattributed to whichever tool call happens to run first — but PRESERVED, not
  // discarded: they ride every structured result as `startup_warnings` (review
  // round 2 — silently dropping them from the structured channel would be the same
  // relay hole one level up). They concern the server session as a whole, which is
  // why every result carries them rather than only the first.
  startupWarnings = drainWarnings();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  process.stderr.write(`cypher-brain-mcp: fatal startup error: ${errMsg(err)}\n`);
  process.exit(1);
});
