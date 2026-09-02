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

import { stat, lstat, rm, copyFile, realpath, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname, basename } from 'node:path';
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
  McpError,
  ErrorCode,
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
  AR_MAX_SPEND_ERROR,
  TON_PROVIDER_MAX_SPEND_ERROR,
  NON_CONTENT_ADDRESSED_BACKENDS,
  PIN_RECIPIENTS,
  MCP_SOURCE_ROOTS,
  MCP_SOURCE_ROOTS_ERROR,
} from './lib/config.js';
import { restoreRunbook } from './lib/runbook.js';
import { drainWarnings, warn } from './lib/warn.js';
import { snapshot } from './lib/snapshot.js';
import { restore, verify } from './lib/restore.js';
import { withSpan } from './lib/otel.js';
import {
  push,
  pull,
  signatureGap,
  redactUserinfo,
  PushPartialSuccessError,
  PushFundingConfirmedButIncompleteError,
  PushUncertainSpendError,
  writeReplayedSavedLocator,
} from './lib/pushpull.js';
import {
  lookupIdempotencyResult,
  recordIdempotencyResult,
  claimIdempotencyKey,
  idempotencyClaimLockPath,
  IdempotencyStoreError,
  IdempotencyClaimHeldError,
} from './lib/idempotency.js';
import { schedule, scheduleStatusReport, ScheduleNotInstalledError } from './lib/schedule.js';
import { estimateCost } from './lib/estimate.js';
import { keygenAt, recipientEntries, resolvePinnedRecipients } from './lib/keys.js';
// #800: the exact-or-separator-bounded containment predicate, already written (and
// already reviewed twice) for `--dir` coverage. Reused rather than re-derived so the
// "/roots/a does not cover /roots/ab" rule has ONE implementation in this codebase.
import { pathCoveredBy } from './lib/gbrain.js';
import { wallet } from './lib/wallet.js';
import { SCAN_SECRETS_MODES, isScanSecretsMode } from './lib/secrets-scan.js';
import { exists, requireFile, MissingPathError, sha256, errMsg } from './lib/util.js';
import { annotateErrorMessage, matchErrorCode } from './lib/errors.js';
import { installStageSignalGuard, addActiveMcpFetchDir, removeActiveMcpFetchDir } from './lib/signal-guard.js';
import { didYouMean, nearestName } from './lib/suggest.js';
import type { CliOptions } from './lib/types.js';
// #789: the full set of backend names a `push --save-locator` line can record — wider than
// this server's own BACKENDS enum, because the file may have been written by a CLI push to
// rclone/ton. Used to authorize OVERWRITING an existing locator file, never to read one.
import { STORAGE_BACKEND_NAMES } from './lib/types.js';
// #507: the ten `Tool` schema constants + the derived BACKENDS/PAID_BACKENDS enums they
// advertise now live in src/mcp-tool-schemas.ts (pure declarative data, split out of this
// file's handler implementation). BACKENDS/PAID_BACKENDS are re-exported from there because
// the handlers below need them too (requireBackend, the spend gates); SNAPSHOT_NOW_TOOL is
// needed for its `.name` in the #220 idempotency-key lock.
import {
  ALL_TOOLS,
  BACKENDS,
  PAID_BACKENDS,
  SNAPSHOT_NOW_TOOL,
  paidBackendConsentDescription,
} from './mcp-tool-schemas.js';

const SERVER_NAME = 'cypher-brain-mcp';
const SERVER_VERSION = '0.0.1'; // keep in sync with package.json "version"

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

// #560: three lib-level messages reclassified from ERR_INTERNAL to ERR_INVALID_INPUT at
// their MCP call sites (handleWalletAddress / handleSnapshotNow / handleRestoreNow) —
// same "caller gave a bad path/value" class requireCallerFile() already turns into
// ERR_INVALID_INPUT for `file`/`identity` args, extended to the three inputs #560 found
// still falling through to the generic, unclassified fallback. Matched by substring
// against the already-formatted message, the SAME approach src/lib/errors.ts's own
// registry uses and documents the tradeoff of (rewording the throw site silently stops
// the match) — kept here rather than in errors.ts because these three also need their
// `code` field changed from ERR_INTERNAL to ERR_INVALID_INPUT, which errors.ts's
// annotateErrorMessage()/matchErrorCode() deliberately never do (they only ever add a
// `[CB-E0xx]` suffix and `cb_code`, additive to whatever `code` the error already
// carries). CB-E019/CB-E020/CB-E021 in src/lib/errors.ts give the reclassified
// ToolError the same stable cb_code CB-E015 already gives a missing identity file.
const NO_WALLET_AT_PATTERN = /no wallet at /;
const NO_RECIPIENT_AT_PATTERN = /no recipient at /;
const OUT_DIR_NOT_A_DIRECTORY_PATTERN = /exists and is not a directory/;

// #726: three more lib-level messages reclassified the SAME way as the four above, but
// with their TEXT also rewritten — snapshot()/schedule() are the CLI's own validation
// functions, shared verbatim with the MCP handlers below, so their "pass --profile/--pg/
// --dir" and "--max-spend"/"--ping-url-fail" guidance is phrased for a shell. An MCP
// caller has no flags to pass at all, only this tool's own JSON fields (dirs/pg,
// max_spend, ping_url/ping_url_fail — --profile has no MCP-side equivalent to offer, so
// it is dropped rather than translated), so a --flag-shaped refusal names something the
// caller literally cannot supply. Detected here by the same substring-match convention;
// the replacement text is built at each call site below (it needs the caller's own
// `backend` value interpolated, which a module-level constant cannot carry).
//
// NOTHING_TO_SNAPSHOT_PATTERN matches TWO throw sites with byte-identical text —
// snapshot.ts's (reclassified in handleSnapshotNow) and schedule.ts's OWN copy in
// validateInstallInputs (reclassified in handleScheduleInstall): schedule_install's
// dirs/pg are exactly as optional-but-one-required as snapshot_now's, and its schema
// has no `profile` field either, so the same sibling defect and the same fix apply.
const NOTHING_TO_SNAPSHOT_PATTERN = /^nothing to snapshot: pass --profile/;
const MAX_SPEND_REQUIRED_PATTERN = /--max-spend <n> is required for an unattended schedule/;
const PING_URL_FAIL_REQUIRES_PATTERN = /^--ping-url-fail requires --ping-url/;

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

// #560 (multi-model review finding): a catch block that reclassifies a caught error into
// a NEW ToolError — e.g. "this ERR_INTERNAL is actually bad input" — otherwise drops
// whatever captureCall() had already bound onto the ORIGINAL error's `cbWarnings`
// (line ~175 above): a warning the failed call recorded before it failed would silently
// vanish from the structured error result instead of riding it (the exact relay hole
// #347 exists to close). Copying it onto the replacement preserves that regardless of
// which ToolError the caller ends up seeing.
function reclassify(code: string, message: string, original: Error): ToolError {
  const replacement = new ToolError(code, message);
  const cbWarnings = (original as Error & { cbWarnings?: string[] }).cbWarnings;
  if (cbWarnings) (replacement as ToolError & { cbWarnings?: string[] }).cbWarnings = cbWarnings;
  return replacement;
}

// #347: module-load warnings, preserved by main()'s startup drain — attached to every
// structured result below (session-scoped facts like a deprecated env var).
let startupWarnings: string[] = [];

// #810/#818: one builder for a structured tool result, with `isError` as an explicit
// parameter rather than an implicit consequence of which function was called. Two
// outcomes have to come back error-shaped while still carrying a full structured payload
// that structuredErr()'s {code, message} shape cannot hold: an uncertain spend (#818) and
// a REPLAY of any error-disposition record (#810) — the bug there was precisely that
// replaying a recorded partial failure through the success-shaped builder dropped
// `isError`, so the same outcome read as an error on the first call and as a clean
// success on the retry.
//
// A non-error result is byte-for-byte what structuredOk() always returned: no `isError`
// key at all, rather than `isError: false`.
function structuredOutcome(payload: Record<string, unknown>, opts: { isError?: boolean } = {}): CallToolResult {
  const full = {
    ...payload,
    ...(startupWarnings.length ? { startup_warnings: startupWarnings } : {}),
  };
  const base: CallToolResult = {
    content: [{ type: 'text', text: JSON.stringify(full, null, 2) }],
    structuredContent: full,
  };
  return opts.isError ? { ...base, isError: true } : base;
}

function structuredOk(payload: Record<string, unknown>): CallToolResult {
  return structuredOutcome(payload);
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

// #793: cleaning up the fetch dir must never REPLACE the outcome it is cleaning up
// after. A bare `finally { await discardFetchDir(tdir); }` does exactly that — a throw
// from a finally block discards whatever the try was doing, both a pending `return`
// (a completed verdict) and a pending `throw` (the verification's OWN error, which is
// the finding the caller actually needs). handleRestoreNow got this right in #650; the
// other two call sites did not, so the correct shape is extracted here rather than
// written a third time. Same argument makeFetchDir()/discardFetchDir() themselves make
// for routing every create and remove through one pair: three call sites, one behavior,
// no room for it to drift.
//
// Success and failure need genuinely different handling, not one shared branch:
//
//   - after success there IS a result to attach to, so the cleanup failure becomes a
//     warning ON it (`warnings`, the #347 relay array a human is guaranteed to see);
//   - after a failure the original error must come back UNCHANGED, so the message rides
//     on `e.cbWarnings` — the convention captureCall()'s own catch and reclassify()
//     already use — which buildErrorPayload() folds into the structured error's
//     `warnings`. Without that it would reach the server's stderr and nowhere an agent
//     branching on the structured result could see it.
//
// Both branches also log to stderr, matching what #650 shipped.
//
// This function must not throw, under any circumstance (multi-model review, #793): it
// runs inside the catch that exists to PRESERVE `e`, so a throw from here would replace
// the very error it was called to protect — the identical masking bug, moved one frame
// in. Two ways it could: `e` may be frozen or non-extensible (assigning `cbWarnings`
// then throws in strict mode, which module code always is), and an existing
// `cbWarnings` may be something other than an array (a caller-shaped object, a string)
// whose spread throws. Hence the isArray check and the blanket try/catch — the stderr
// line above has already run either way, so the warning is never lost entirely, only
// its structured copy. A non-Error thrown value has nowhere to carry it and keeps the
// stderr line alone; it is not normalized into an Error here because doing so would mean
// replacing the thrown value, which is the thing this must not do.
function noteCleanupWarningOnError(e: unknown, warnMsg: string): void {
  console.error(`warning: ${warnMsg}`);
  if (!(e instanceof Error)) return;
  try {
    const carrier = e as Error & { cbWarnings?: unknown };
    const existing = Array.isArray(carrier.cbWarnings) ? (carrier.cbWarnings as string[]) : [];
    carrier.cbWarnings = [...existing, warnMsg];
  } catch {
    /* frozen/non-extensible error, or an exotic cbWarnings setter — the stderr line above
       is then the only record, which is strictly better than losing `e` itself. */
  }
}

// Cleanup on the FAILURE path: never masks `e`, which the caller must still receive.
async function discardFetchDirPreservingError(dir: string | null, e: unknown, context: string): Promise<void> {
  try {
    await discardFetchDir(dir);
  } catch (cleanupErr) {
    noteCleanupWarningOnError(
      e,
      `failed to clean up ${context} fetch/scratch dir ${dir} after a failed call: ${errMsg(cleanupErr)} ` +
        '(it may remain on disk until server restart) — the error below is the one to act on.',
    );
  }
}

// Cleanup on the SUCCESS path: the work already completed, so a cleanup failure is a
// warning on the result, never an ERR_INTERNAL that throws the result away.
async function discardFetchDirWarningOnResult(
  dir: string | null,
  payload: Record<string, unknown>,
  context: string,
): Promise<void> {
  try {
    await discardFetchDir(dir);
  } catch (cleanupErr) {
    const warnMsg =
      `failed to clean up ${context} fetch/scratch dir ${dir} after a successful ${context}: ` +
      `${errMsg(cleanupErr)} — it may remain on disk until server restart.`;
    console.error(`warning: ${warnMsg}`);
    const existing = Array.isArray(payload.warnings) ? (payload.warnings as string[]) : [];
    payload.warnings = [...existing, warnMsg];
  }
}

// The structured {code, message[, cb_code][, warnings][, startup_warnings]} shape every
// tools/call error carries in structuredContent (#212, #347) — factored out of
// structuredErr() (#558) so resources/read and prompts/get can put the SAME payload in
// their JSON-RPC error's `data` field instead of falling through to the SDK's generic,
// unclassified -32603. Those two protocols have no isError/structuredContent slot of
// their own to carry it in, but the underlying contract (a stable `code`, an
// already-`[CB-E0xx]`-annotated `message`, and `cb_code` for an agent to branch on
// without regexing text) is the same one, so it should not depend on which JSON-RPC
// method the caller happened to use.
function buildErrorPayload(errObj: unknown): {
  code: string;
  message: string;
  cb_code?: string;
  warnings?: string[];
  startup_warnings?: string[];
} {
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
  return {
    code: errObj instanceof ToolError ? errObj.code : 'ERR_INTERNAL',
    message: annotateErrorMessage(rawMessage),
    ...(cbCode ? { cb_code: cbCode } : {}),
    ...(warnings.length ? { warnings } : {}),
    ...(startupWarnings.length ? { startup_warnings: startupWarnings } : {}),
  };
}

function structuredErr(errObj: unknown): CallToolResult {
  const payload = buildErrorPayload(errObj);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

// #653: passed as withSpan()'s `onFlushWarning` below — splices a LATE OTel flush
// warning (see otel.ts's header comment: boundedFlush() only resolves after `fn()`,
// i.e. after the dispatched handler, has already built and returned its own
// CallToolResult) into THIS call's own already-built result, rather than the shared
// warn()/recorded buffer a differently-timed, unrelated tool call could otherwise
// drain first (the exact cross-request misattribution #653 is about). Re-derives
// `content[0].text` from the merged structuredContent the same way structuredOk()
// itself does, so the two views of the result never disagree with each other.
function attachLateFlushWarning(message: string, result: CallToolResult): CallToolResult {
  const structured: Record<string, unknown> = { ...(result.structuredContent as Record<string, unknown>) };
  const existing = Array.isArray(structured.warnings) ? (structured.warnings as string[]) : [];
  structured.warnings = [...existing, message];
  return {
    ...result,
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

// #558: resources/read and prompts/get handlers throw directly rather than returning a
// CallToolResult, so — unlike every tools/call error, which structuredErr() above wraps
// — a thrown ToolError (or anything else) used to reach the SDK's own top-level catch
// unwrapped and come back as a bare `{code: -32603, message}` JSON-RPC error: no `code`
// field, no `cb_code`, no `[CB-E0xx]` suffix. The JSON-RPC spec's `data` slot on an
// error response is exactly where a server is meant to put extra structured detail, so
// this puts buildErrorPayload()'s SAME {code, message, cb_code, ...} object there —
// an agent branching on `error.data.cb_code` gets the identical signal a tools/call
// error gives it in `structuredContent.cb_code`. The outer numeric `code` only needs to
// be A json-rpc code (clients that don't look past it just see "an error happened");
// InvalidParams for a caller-input mistake and InternalError otherwise is the closest
// existing category, picked for readability, not because any spec requires that split.
function throwStructuredResourceError(errObj: unknown): never {
  if (errObj instanceof McpError) throw errObj; // already the right shape — do not double-wrap
  const payload = buildErrorPayload(errObj);
  const jsonRpcCode = payload.code === 'ERR_INVALID_INPUT' ? ErrorCode.InvalidParams : ErrorCode.InternalError;
  throw new McpError(jsonRpcCode, payload.message, payload);
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
function isOutsideHome(p: string): boolean {
  const resolved = resolve(p);
  const homeResolved = resolve(HOME);
  return resolved !== homeResolved && !resolved.startsWith(homeResolved + sep);
}

function assertWithinHome(p: string): void {
  if (isOutsideHome(p)) {
    throw new ToolError('ERR_INVALID_INPUT', `out must be inside CYPHER_BRAIN_HOME (${HOME}), got: ${p}`);
  }
}

// #648: isOutsideHome()'s resolve() above is purely LEXICAL — it normalizes `.`/`..`
// segments and makes the path absolute, but never follows an actual symlink that
// exists on disk. If some ancestor directory under CYPHER_BRAIN_HOME is (or later
// becomes) a symlink pointing elsewhere — e.g. $CYPHER_BRAIN_HOME/escape ->
// $HOME/.ssh — a caller-supplied `out` like `$CYPHER_BRAIN_HOME/escape/authorized_keys`
// passes assertWithinHome()'s lexical prefix check while wallet.ts's write-temp-then-
// rename (createKeyFile()/writeKeyFile(), which mkdir's `dirname(outPath)` and then
// writes/renames INTO it) actually follows that symlink and lands outside
// CYPHER_BRAIN_HOME entirely — restoring the exact arbitrary-file-clobber capability
// this containment check exists to prevent (issue #174 / PR #180's own threat model).
//
// `out`'s FINAL path component (and possibly more of its ancestry, e.g. a not-yet-
// created subdirectory) does not need to exist yet — wallet_create may be creating it
// — so this cannot simply call realpath() on the whole path unconditionally (it throws
// ENOENT when the target itself is missing). It tries the full path FIRST (multi-model
// review, #648: an earlier version always skipped straight to the ancestor walk below,
// which never resolves `p`'s OWN final component even when `p` already exists — a
// symlinked CYPHER_BRAIN_HOME itself, not just a symlinked ancestor under it, produced
// a false-positive rejection of a legitimately-scoped `out`, since HOME's own realpath
// and `out`'s realpath then disagreed on whether HOME's symlink had been followed).
// Only on "this path is not there as written" does it fall back to walking UP to the
// nearest ancestor that already exists, resolving THAT (following any symlinks), and
// re-attaching the still-nonexistent tail lexically — the tail cannot itself be a symlink
// escape because nothing is there yet for a write to follow.
//
// ENOTDIR counts as "not there" alongside ENOENT (#789): it means some component of the
// path is a regular file rather than a directory, so nothing exists at `p` either, and
// walking up is exactly the right response — the walk terminates at that file, whose own
// realpath resolves fine. Treating it as a hard error instead surfaced a raw
// `ENOTDIR: ... realpath '<path>'` as ERR_INTERNAL, telling the caller the server broke
// when in fact their path was simply unwritable; the honest failure comes one step later,
// from the write that actually tries to mkdir the parent (for --save-locator, that is
// PushLocatorWriteError, which the #220 partial-success handling depends on being able to
// see). Both catch sites take it, since either realpath call can raise it.
const PATH_ABSENT_CODES = new Set(['ENOENT', 'ENOTDIR']);

async function realpathOfNearestAncestor(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    return await realpath(abs);
  } catch (e) {
    if (!PATH_ABSENT_CODES.has((e as NodeJS.ErrnoException)?.code ?? '')) throw e;
  }
  let dir = dirname(abs);
  const tail: string[] = [basename(abs)];
  for (;;) {
    try {
      const real = await realpath(dir);
      return join(real, ...tail);
    } catch (e) {
      if (!PATH_ABSENT_CODES.has((e as NodeJS.ErrnoException)?.code ?? '')) throw e;
      const parent = dirname(dir);
      if (parent === dir) throw e; // reached the filesystem root and even that failed
      tail.unshift(basename(dir));
      dir = parent;
    }
  }
}

// The actual security boundary for wallet_create's `out` (assertWithinHome() above is
// kept, unchanged, as the cheap lexical pre-check every caller still gets first) —
// resolves symlinks on BOTH sides before comparing, so a symlinked ancestor anywhere
// under CYPHER_BRAIN_HOME (or CYPHER_BRAIN_HOME itself being a symlink) cannot smuggle
// the write outside the scoped directory. Returns the RESOLVED path rather than just
// validating it (multi-model review, #648: a Critical finding on an earlier version
// that only checked and let the caller re-resolve the ORIGINAL, possibly-symlinked
// path a second time at write time) — an ancestor symlink swapped in the gap between
// this check and the actual write would otherwise still be followed a SECOND time by
// that later resolution (a classic check-then-use TOCTOU). Callers must use the
// returned path for the actual write, not the original `p`, so the write only ever
// touches the path this check already vetted, closing that gap for the ancestor
// portion of the path (the same residual risk any other fixed-path write in this
// codebase already carries — e.g. a symlink planted at the resolved path itself
// after this check returns — is unavoidable without an O_NOFOLLOW-based openat
// rewrite of every write primitive, which is out of scope for this check).
//
// `field` names the tool argument being checked, so a refusal says which one it was
// (#789 gave this the same job for snapshot_now's locator_file, which is a different
// argument on a different tool but the same containment question). It defaults to
// 'out', leaving wallet_create's own message byte-identical to what #648 shipped.
async function resolveRealpathWithinHome(p: string, field = 'out'): Promise<string> {
  const resolved = await realpathOfNearestAncestor(p);
  const homeResolved = await realpathOfNearestAncestor(HOME);
  if (resolved !== homeResolved && !resolved.startsWith(homeResolved + sep)) {
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `${field} must be inside CYPHER_BRAIN_HOME (${HOME}), got: ${p} (resolves to ${resolved} after following symlinks)`,
    );
  }
  return resolved;
}

// #787: last_snapshot_status reads a caller-named path and reports on its contents, so
// it needs the containment resolveRealpathWithinHome() gives every OTHER caller-named
// path on this server PLUS two checks a write-side check has no reason to make.
//
// Containment first, for the reason assertWithinHome()'s own comment gives: over MCP a
// shell-less caller has no other route to an arbitrary local file, and unlike
// restore_now's out_dir (#559, which only warns because restoring outside home is its
// entire normal use case) there is no legitimate reason to read a save-locator file from
// outside the directory this server manages — the tool's own default lives in HOME. So
// this REFUSES rather than warning.
//
// Then: a regular file, below a size bound. A locator file is one short line and an
// index.tsv is a few thousand at most; a FIFO would block the read forever and a
// multi-gigabyte file would be buffered whole into memory by readFile().
//
// All of that happens through ONE open file handle (multi-model review, #787). An earlier
// version did realpath → stat(path) → readFile(path) → stat(path), which checks one file
// and can then read another: three independent path lookups, each re-traversing the same
// symlinks, so anything swapped in between is what actually gets read and reported. Every
// property is now read off the handle instead — `isFile()`, the size, the CONTENT, and the
// mtime a locator file's timestamp comes from all describe the same open inode, whatever
// happens to the name afterwards.
//
// O_NONBLOCK matters as much as the single handle: opening a FIFO for reading BLOCKS until
// a writer appears, and src/mcp.ts serializes every tool call through one mutex, so a FIFO
// planted in CYPHER_BRAIN_HOME would wedge the whole server rather than be rejected by the
// isFile() check further down. With O_NONBLOCK the open returns immediately and the FIFO is
// refused like any other non-regular file. It is a no-op for regular files, and absent on
// platforms that have no such flag (hence the `?? 0`).
//
// What this does NOT close: an ancestor directory swapped between the realpath above and
// the open below. Node exposes no openat/RESOLVE_BENEATH, so binding the open to a verified
// directory descriptor is not available here — the same documented residual #648 records
// for wallet_create's `out`, narrowed to a single syscall pair rather than removed.
const LOCATOR_FILE_MAX_BYTES = 1024 * 1024;

interface ContainedFileRead {
  resolved: string;
  text: string;
  mtime: Date;
}

async function readContainedFileWithinHome(p: string, field: string): Promise<ContainedFileRead> {
  const resolved = await resolveRealpathWithinHome(p, field);
  let handle: FileHandle;
  try {
    handle = await open(resolved, (constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)) as number);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new ToolError('ERR_INVALID_INPUT', `no such ${field}: ${p}`);
    // Linux lets open(O_RDONLY) succeed on a directory and fails at read time; other
    // platforms refuse at open. Either way this is the not-a-regular-file refusal, not a
    // server fault — the isFile() check below covers the platforms that get that far.
    if (code === 'EISDIR')
      throw new ToolError('ERR_INVALID_INPUT', `${field} (${p}) is not a regular file — refusing to read it`);
    throw e;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile())
      throw new ToolError('ERR_INVALID_INPUT', `${field} (${p}) is not a regular file — refusing to read it`);
    if (st.size > LOCATOR_FILE_MAX_BYTES)
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `${field} (${p}) is ${st.size} bytes, above the ${LOCATOR_FILE_MAX_BYTES}-byte limit for a locator/index file — refusing to read it`,
      );
    return { resolved, text: await handle.readFile('utf8'), mtime: st.mtime };
  } finally {
    await handle.close();
  }
}

// #789: the write-side counterpart of resolveReadableFileWithinHome() above, for
// snapshot_now's `locator_file` (push --save-locator's destination). Containment is the
// main event, for the reason spelled out at the call site; the second check below is the
// part worth explaining.
//
// Containment alone still permits replacing an unrelated file that happens to live under
// CYPHER_BRAIN_HOME — recipient.txt, the identity, idempotency-log.jsonl. So an EXISTING
// target must also parse as a save-locator file, using readLocatorFile()'s own format
// check rather than a second copy of it. A path with nothing at it is fine and normal:
// this is how the first push in a cadence creates the file.
//
// ENOENT means nothing is there, which is fine and normal — that is how the first push in
// a cadence creates the file. ENOTDIR is NOT the same thing (multi-model review, #789): it
// means a component of the path is a regular file, so the write is ALREADY KNOWN to be
// impossible. Letting it through would run the whole snapshot and, on a paid backend with
// confirm_paid, actually SPEND before push()'s --save-locator mkdir failed on something
// this preflight could see from the start. It is refused here instead. (#220's
// partial-success coverage in scripts/mcp-smoke.mjs induces PushLocatorWriteError with an
// unwritable PARENT rather than this pre-detectable shape, so the aftermath path it tests
// is a genuine post-upload failure.)
//
// readLocatorFile()'s parse is necessary but NOT sufficient for authorizing an overwrite
// (multi-model review, #789): it accepts any two non-empty tab-separated fields, which an
// unrelated in-home TSV — an index.tsv, notably — satisfies. So authorization additionally
// requires the second field to be a REAL backend name and any third field to be a sha256,
// which is a shape nothing but a save-locator file has. The split is deliberate: READING
// stays liberal, so a legacy or hand-repaired locator file still works everywhere it used
// to; only AUTHORIZING ITS DESTRUCTION is strict.
const SAVE_LOCATOR_BACKENDS: ReadonlySet<string> = new Set(STORAGE_BACKEND_NAMES);

function assertIsSaveLocatorFile(text: string, p: string, field: string): void {
  // Returns the refusal rather than throwing it, so every rejection below reads as an
  // explicit `throw` at the point it happens.
  const refusal = (why: string): ToolError =>
    new ToolError(
      'ERR_INVALID_INPUT',
      `${field} (${p}) already exists but is not a cypher-brain save-locator file — refusing to overwrite it ` +
        `(push --save-locator REPLACES this path outright). Pick a path that is either empty or a previous ` +
        `--save-locator file. ${why}`,
    );
  let parsed: LocatorSource;
  try {
    // The mtime is irrelevant to this check (only the fields are inspected), so a
    // placeholder is passed rather than another stat of a path that could have changed.
    parsed = parseLocatorFile(p, text, new Date(0));
  } catch (e) {
    throw refusal(`Reason it did not parse: ${e instanceof ToolError ? e.message : errMsg(e)}`);
  }
  if (!parsed.backend || !SAVE_LOCATOR_BACKENDS.has(parsed.backend))
    throw refusal(
      `Its second field is ${JSON.stringify(parsed.backend)}, which is not one of the backends a ` +
        `--save-locator line records (${[...SAVE_LOCATOR_BACKENDS].join(', ')}).`,
    );
  if (parsed.sha256 && !SHA256_HEX.test(parsed.sha256))
    throw refusal('Its third field is present but is not a 64-hex sha256, which every --save-locator line writes.');
}

async function resolveWritableLocatorFile(p: string, field: string): Promise<string> {
  const resolved = await resolveRealpathWithinHome(p, field);
  // Inspected through one open handle, for the reasons readContainedFileWithinHome()
  // spells out — the existing file's type, size and content must all describe the SAME
  // inode, or the overwrite gate is checking one file and authorizing the destruction of
  // another.
  let handle: FileHandle;
  try {
    handle = await open(resolved, (constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)) as number);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return resolved; // nothing there — the normal first-push case
    if (code === 'ENOTDIR')
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `${field} (${p}) cannot be written: a component of that path is a regular file, not a directory. ` +
          'Refusing before doing any snapshot or upload work, since saving the recovery pointer there could ' +
          'only fail afterwards (on a paid backend, after the money was already spent).',
      );
    if (code === 'EISDIR')
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `${field} (${p}) already exists and is a directory — refusing to replace it with a save-locator file`,
      );
    throw e;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile())
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `${field} (${p}) already exists and is not a regular file — refusing to replace it with a save-locator file`,
      );
    if (st.size > LOCATOR_FILE_MAX_BYTES)
      throw new ToolError(
        'ERR_INVALID_INPUT',
        `${field} (${p}) already exists, is ${st.size} bytes, and is far larger than any save-locator file — refusing to replace it`,
      );
    assertIsSaveLocatorFile(await handle.readFile('utf8'), p, field);
  } finally {
    await handle.close();
  }
  return resolved;
}

// #559: restore_now writes DECRYPTED PLAINTEXT into out_dir — a materially higher-risk
// write than wallet_create's `out` (a small generated JWK) or snapshot_now's `out`
// (ciphertext only) — yet unlike wallet_create's `out` above, it was not scoped to
// CYPHER_BRAIN_HOME at all. assertWithinHome()'s own reasoning applies here too: MCP's
// threat model gives a shell-less caller no OTHER path to an arbitrary-file-write
// primitive the way a human with a shell already has.
//
// But restoring a backup INTO an arbitrary location outside this server's own config
// directory is restore_now's ENTIRE normal use case — a fresh disk, a specific recovery
// target that has nothing to do with where cypher-brain keeps its own state.
// scripts/mcp-smoke.mjs's own real restore round-trip (#183) restores outside
// CYPHER_BRAIN_HOME as a matter of course, and the CLI's `restore --out-dir` has never
// been scoped either. Hard-refusing here the way wallet_create's `out` is refused would
// break that legitimate, intended workflow, not just an adversarial one — so this only
// WARNS (surfaced in the result's `warnings` array, which #347's warn()/relay
// convention already guarantees reaches a human) instead of refusing outright: visibility
// without breaking the tool's own purpose. confirm_write=true is still required before
// ANY write happens either way — the actual consequential-action gate is unchanged.
function outsideHomeWarning(outDir: string): string | undefined {
  if (!isOutsideHome(outDir)) return undefined;
  return (
    `out_dir (${outDir}) is outside CYPHER_BRAIN_HOME (${HOME}) — restore_now writes DECRYPTED plaintext ` +
    "there, to a path this server does not otherwise scope or manage (unlike wallet_create's out, which " +
    'refuses outside CYPHER_BRAIN_HOME). Confirm this destination is what you intended (#559).'
  );
}

// #792: outsideHomeWarning() above is built on isOutsideHome(), whose resolve() is
// LEXICAL — the same gap #648 closed for wallet_create's `out`, still open one tool
// over. src/lib/restore.ts reaches the destination with stat(), which FOLLOWS symlinks,
// so `$CYPHER_BRAIN_HOME/out -> /var/www/html` reads as "inside home" to the warning
// while the plaintext lands in /var/www/html — no warning, and the result reports the
// in-home path the caller passed rather than where the bytes actually went.
//
// Two things fix that, and they are deliberately different in strength:
//
//   1. Resolve the path the way restore.ts will, and warn/report on THAT. Ancestor
//      symlinks are ordinary (a home under /var -> /private/var on macOS is one), so
//      following them is not itself suspicious — reporting the wrong destination is.
//   2. REFUSE when out_dir's own final component is a symlink. This is fail-closed
//      where rule 1 is fail-open, and the asymmetry is the point: #559 chose to warn
//      rather than refuse for a path outside home because restoring outside home is
//      restore_now's entire normal use case, so refusing would break the legitimate
//      workflow along with the adversarial one. A final-component symlink has no such
//      workflow behind it — a caller who wants to restore into /var/www/html can name
//      it — and it is the exact shape that makes the #559 warning silently
//      inapplicable. Nothing legitimate is lost by refusing it, so refusing is free.
//
// lstat() (not stat()) is what rule 2 needs: the question is whether the final component
// IS a link, not what it points at. ENOENT is fine and common — restore_now routinely
// creates out_dir — and means there is no link there to follow.
//
// RESIDUAL, stated rather than papered over (multi-model review, #792): this is a
// path-based check, so a symlink swapped into out_dir AFTER it returns is followed by
// restore() all the same. Closing that needs the write itself bound to an already-open,
// verified directory descriptor (openat/RESOLVE_BENEATH + friends), which Node does not
// expose and which would mean rewriting every write primitive in src/lib/restore.ts —
// out of scope here, and the SAME residual #648 already records for wallet_create's `out`.
// What is done instead is to shrink the window: handleRestoreNow calls this twice, once
// up front so an obviously-bad destination costs no pull, and again immediately before
// restore() runs, so the gap is a few statements rather than the whole fetch+verify. That
// narrows, it does not eliminate — an attacker who can write inside out_dir's parent
// directory in that instant still wins, and a deployment where that is part of the threat
// model needs the descriptor-bound rewrite, not this.
async function resolveRestoreOutDir(outDir: string): Promise<string> {
  const abs = resolve(outDir);
  let linkSt: Awaited<ReturnType<typeof lstat>> | undefined;
  try {
    linkSt = await lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
  }
  if (linkSt?.isSymbolicLink()) {
    const target = await realpathOfNearestAncestor(abs);
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `out_dir (${outDir}) is a symlink (to ${target}) — refusing to restore DECRYPTED plaintext through it, ` +
        'because the destination it reports and the destination it writes to are not the same path (#792). ' +
        'Pass the real directory instead.',
    );
  }
  return await realpathOfNearestAncestor(abs);
}

// ─────────────────────────────────────────────────────────────────────────────
// #800: the MCP snapshot policy — fail-closed, operator-configured, CLI unchanged.
// ─────────────────────────────────────────────────────────────────────────────
//
// Every other containment check on this server scopes a path the caller named for a
// WRITE (wallet_create's `out`, snapshot_now's `locator_file`, restore_now's `out_dir`).
// `dirs` is the opposite direction and the one this server had left open: it names the
// PLAINTEXT, and `recipients` names the key it is encrypted to. An untrusted caller —
// which is exactly what this server's own threat model says an MCP caller is — could
// therefore pick both halves and walk away with a readable copy of any directory the
// server process can read, using nothing but the free `file` backend, which needs no
// confirm_paid and so passes no consent gate at all. The disclosure is irreversible
// once the ciphertext leaves, which is why this refuses rather than warns: an agent can
// ignore a warning, and there is no undo behind it (issue #800's decision comment).
//
// Two independent conditions, both of which the OPERATOR sets in the server's own
// environment and no caller can supply in the call:
//
//   1. CYPHER_BRAIN_PIN_RECIPIENTS must resolve to at least one key. That is what takes
//      the KEY half away from the caller: with a pin in force, snapshot.ts refuses any
//      recipient that is not on the allowlist, so a caller-chosen `recipients` can no
//      longer name an attacker's own public key. This check deliberately only asks
//      whether a usable pin EXISTS — snapshot.ts's own check stays authoritative for the
//      expanded recipient set (files, multiple entries, non-age1 lines), and duplicating
//      that logic here would create a second allowlist implementation to drift.
//   2. For a call that names `dirs`, every entry must realpath-resolve inside one
//      CYPHER_BRAIN_MCP_SOURCE_ROOTS root. That is the PLAINTEXT half. Unset, empty or
//      malformed roots refuse every `dirs` call — the fail-closed default, since an
//      operator who has not said which directories are snapshottable has not authorized
//      any of them. A pinned pg-only call still works with no roots configured at all:
//      `pg` is a connection URI the operator's own environment governs, not a filesystem
//      path this policy can scope, and refusing it would break a legitimate setup for no
//      gain.
//
// WHAT THIS IS NOT: an authorization check on the caller's intent. confirm_paid is
// deliberately not treated as consent for the disclosure — it is attacker-supplied, and
// it says "spend money", not "read this directory".
//
// RESIDUAL, stated rather than papered over: this is a path-based check, so a directory
// swapped for a symlink AFTER it returns is followed by the snapshot all the same — the
// same TOCTOU residual #648/#789/#792 already record for every other path check here,
// and closing it needs openat/RESOLVE_BENEATH-bound reads Node does not expose. What it
// does close is the case where the CALLER names the escape, which is the one an
// untrusted caller controls.
function snapshotPolicyDenied(reason: string, remedy: string): ToolError {
  // One contiguous sentence, on purpose: src/lib/errors.ts's CB-E025 pattern greps the
  // literal out of this file's text (scripts/selftest-error-codes.mjs), so splitting
  // "refusing to snapshot over MCP" across a `+` join would make that entry unassertable.
  return new ToolError('ERR_POLICY_DENIED', `${reason} — refusing to snapshot over MCP (#800). ${remedy}`);
}

const POLICY_DOC_REF = 'See MANAGEMENT.md ("MCP snapshot policy") for how to configure this.';

// Anything this gate does on the filesystem — reading the pin file, resolving a root or
// a source — can fail for reasons that are neither "allowed" nor "denied": an unreadable
// pin, a permission error partway up a root. Those must not escape as ERR_INTERNAL
// (multi-model review, #800): the caller is told the SERVER broke and invited to retry,
// when in fact the policy could not be evaluated — which is a denial, because a check
// that could not run has not passed. Every filesystem call in this gate goes through
// here, so the fail-closed answer cannot be forgotten at one of them.
//
// `what` describes the step rather than echoing the raw error path for the PIN: that path
// is operator-set and an untrusted caller has no business learning the server's local
// layout from a refusal. A caller-supplied source path is different — the caller already
// knows it, and the refusals below echo resolved source paths anyway.
async function underPolicy<T>(what: string, remedy: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError) throw e; // already a policy refusal — do not re-wrap it
    const code = (e as NodeJS.ErrnoException)?.code;
    throw snapshotPolicyDenied(`${what} (${code ?? errMsg(e)}), so the snapshot policy could not be evaluated`, remedy);
  }
}

// #838: a CYPHER_BRAIN_MCP_SOURCE_ROOTS entry is an OPERATOR-set boundary, not a caller
// argument — realpathOfNearestAncestor()'s "walk up to the nearest EXISTING ancestor"
// fallback is the right behavior for a `dirs` entry (a typo there is refused later by
// snapshot()'s own "no such directory" error, not by this gate — see the comment at this
// function's call site), but reusing it HERE meant a typo'd root
// (CYPHER_BRAIN_MCP_SOURCE_ROOTS=["/Users/me/brian"]) never refused at all: it silently
// "resolved" to /Users/me instead, and every `dirs` call under /Users/me was authorized —
// broader than what the operator named, for a caller this server's own threat model
// treats as untrusted. A root must therefore exist ON DISK, as a directory, or this
// throws — fully realpath'd first (a root that is itself a symlink is accepted, same as
// every other path this gate compares: its RESOLVED target is what gets checked and
// compared against, consistent with how a `dirs` entry that is a symlink is already
// treated a few lines below), then confirmed to be a directory rather than a file. Either
// failure throws a ToolError, which underPolicy() at the call site re-throws as-is
// (`if (e instanceof ToolError) throw e`) — so ONE bad root fails the WHOLE policy closed
// for this call (every `dirs` call refused, naming the offending root), rather than
// silently dropping just that root while the rest keep authorizing sources.
async function resolveConfiguredRoot(root: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(resolve(root));
  } catch (e) {
    if (!PATH_ABSENT_CODES.has((e as NodeJS.ErrnoException)?.code ?? '')) throw e; // handled by underPolicy()
    throw snapshotPolicyDenied(
      `CYPHER_BRAIN_MCP_SOURCE_ROOTS names a root that does not exist on disk: ${JSON.stringify(root)}`,
      'Create the directory, or fix the path, in CYPHER_BRAIN_MCP_SOURCE_ROOTS, and restart this server. ' +
        POLICY_DOC_REF,
    );
  }
  const st = await stat(resolved);
  if (!st.isDirectory()) {
    throw snapshotPolicyDenied(
      `CYPHER_BRAIN_MCP_SOURCE_ROOTS names a root that is not a directory: ${JSON.stringify(root)}`,
      `Fix CYPHER_BRAIN_MCP_SOURCE_ROOTS to name a directory, and restart this server. ${POLICY_DOC_REF}`,
    );
  }
  return resolved;
}

async function assertSnapshotPolicy(dirs: readonly string[], recipients: readonly string[]): Promise<void> {
  // ── 1. the key half ────────────────────────────────────────────────────────
  // `undefined` (unset) and `''` are both "no pin", and are refused identically here.
  // config.ts keeps them distinguishable for snapshot.ts, which must fail closed on the
  // explicitly-empty case specifically; this gate refuses both anyway, so it does not
  // need the distinction — only that a usable allowlist is present.
  if (PIN_RECIPIENTS === undefined || PIN_RECIPIENTS.trim() === '') {
    throw snapshotPolicyDenied(
      'CYPHER_BRAIN_PIN_RECIPIENTS is not set in this MCP server environment, so an untrusted caller could ' +
        'name any recipient key it likes and receive a readable copy of the brain',
      'Set CYPHER_BRAIN_PIN_RECIPIENTS to the age1… key(s) allowed to decrypt (the `cypher-brain init` wizard ' +
        'offers to write it, and `<CYPHER_BRAIN_HOME>/recipient.txt` is the usual value), then restart this ' +
        `server. ${POLICY_DOC_REF}`,
    );
  }
  // Bound to a local so the narrowing above survives into the closure below.
  const pinValue: string = PIN_RECIPIENTS;
  const pinned = await underPolicy(
    'CYPHER_BRAIN_PIN_RECIPIENTS could not be read',
    `Check that the path it names exists and is readable by this server. ${POLICY_DOC_REF}`,
    () => resolvePinnedRecipients(pinValue),
  );
  if (pinned.size === 0) {
    throw snapshotPolicyDenied(
      'CYPHER_BRAIN_PIN_RECIPIENTS is set but resolves to no age1… pubkeys, which leaves the recipient ' +
        'allowlist empty and hands the key choice back to an untrusted caller',
      `Point it at a recipient file that contains at least one age1… key, or list the keys inline. ${POLICY_DOC_REF}`,
    );
  }

  // A usable pin EXISTING is not the same as THIS call's recipients being on it, and the
  // gap between the two is a replay (multi-model review, #800 — Critical). snapshot.ts's
  // check is the authoritative one and stays exactly where it is, but it only runs when a
  // snapshot actually runs: an idempotency replay returns a stored result without going
  // near it. So a result recorded while recipient A was pinned could be replayed — and
  // its locator re-written — after the operator narrowed the pin to B, which is precisely
  // the "replays are not grandfathered" rule this gate exists to keep. Membership is
  // therefore checked HERE too, over the same recipientEntries() expansion snapshot.ts
  // uses, so the two cannot disagree about what a recipient argument means.
  //
  // A recipient argument that expands to NOTHING is refused here as well as in
  // snapshot.ts (multi-model review round 2, #800). The membership loop below would
  // otherwise pass it vacuously — no entries, nothing to reject — which on a REPLAY (the
  // one path snapshot.ts never sees) turns an emptied recipient file into a way through
  // this gate.
  //
  // RESIDUAL, stated rather than papered over (multi-model review round 2): this
  // authorizes the recipients the call names AS THEY RESOLVE NOW. A replay whose
  // recipient FILE was rewritten between the two calls — old key A out, currently-pinned
  // key B in — passes, and returns the cached result for ciphertext that was encrypted to
  // A. Nothing new is disclosed to A by that (the ciphertext was created and pushed while
  // A was pinned, and the replay only re-reports its locator), and the window is bounded
  // by CYPHER_BRAIN_IDEMPOTENCY_TTL_SECONDS plus an exact fingerprint match on the same
  // key. The SAME residual exists on the `dirs` side (multi-model review round 3): a
  // replay authorizes each source as it resolves NOW, so a symlink retargeted between the
  // two calls can be authorized under the new roots while the cached result belongs to the
  // old ones. Both are stale-RESULT problems rather than new-disclosure ones — a replay
  // reads no source and encrypts nothing; it re-reports a locator for ciphertext that was
  // produced and pushed while the then-current policy allowed it, and can rewrite the
  // caller's locator_file to point at it.
  //
  // Closing either properly means recording each call's EFFECTIVE recipients and resolved
  // sources in the idempotency log and rejecting every record written before those fields
  // existed — a store-schema change with a legacy-record migration that #800's decision
  // did not scope, and that needs its own design pass rather than being smuggled in here.
  for (const rec of recipients) {
    const entries = await underPolicy(
      `recipient ${JSON.stringify(rec)} could not be read`,
      'Pass an age1… pubkey, or a readable recipients file.',
      () => recipientEntries(rec),
    );
    if (entries.length === 0) {
      throw snapshotPolicyDenied(
        `recipient ${JSON.stringify(rec)} resolves to no recipients at all (an empty or fully commented-out ` +
          'recipients file), so there is nothing to check against the allowlist',
        `Pass a recipients file that contains at least one age1… key. ${POLICY_DOC_REF}`,
      );
    }
    for (const entry of entries) {
      if (!pinned.has(entry)) {
        throw snapshotPolicyDenied(
          `recipient ${JSON.stringify(entry)} (via ${JSON.stringify(rec)}) is not on the ` +
            'CYPHER_BRAIN_PIN_RECIPIENTS allowlist this server enforces',
          'Pass a recipient the operator has pinned. If this key SHOULD be able to decrypt, the operator adds ' +
            `it to CYPHER_BRAIN_PIN_RECIPIENTS and restarts this server. ${POLICY_DOC_REF}`,
        );
      }
    }
  }

  // ── 2. the plaintext half ─────────────────────────────────────────────────
  // Only a call that actually names directories is governed by the roots.
  //
  // A `pg`-only call is therefore NOT scoped by anything here, and that is a limitation
  // to state rather than imply away (multi-model review, #800): `pg` is a caller-supplied
  // connection URI, so a caller can still name any database the server's ambient
  // credentials (a Unix socket, ~/.pgpass, PG* environment variables) already reach.
  // Scoping it needs its own allowlist mechanism, which #800's decision deliberately did
  // not take on — the roots are a filesystem concept and a connection URI is not a path.
  // The pin above still applies to such a call, so whatever is dumped is readable only by
  // a key the operator allowlisted; what is missing is source authorization, and it is
  // tracked as a follow-up rather than fixed here.
  if (dirs.length === 0) return;

  if (MCP_SOURCE_ROOTS_ERROR) {
    // The parse detail names the operator's own value, so it goes to the server's stderr
    // (outside captureCall, so it is NOT relayed to the caller) rather than into the
    // refusal — see the containment refusal below for the same reasoning.
    console.error(`snapshot policy: ${MCP_SOURCE_ROOTS_ERROR.message}`);
    throw snapshotPolicyDenied(
      'CYPHER_BRAIN_MCP_SOURCE_ROOTS is set but is not a usable list of roots, so no directory can be checked ' +
        'against it (this server logged the specific reason to its own stderr)',
      'Fix the variable — a JSON array of absolute paths, e.g. ["/srv/brain","/home/me/notes"] — and restart ' +
        'this server. ' +
        POLICY_DOC_REF,
    );
  }
  if (MCP_SOURCE_ROOTS.length === 0) {
    throw snapshotPolicyDenied(
      'CYPHER_BRAIN_MCP_SOURCE_ROOTS is not set in this MCP server environment, so no directory is authorized ' +
        'as a snapshot source over MCP',
      'Set it to a JSON array of the absolute directories this server may snapshot, e.g. ' +
        '["/srv/brain","/home/me/notes"], and restart this server. A call that snapshots only `pg` needs no ' +
        'roots. ' +
        POLICY_DOC_REF,
    );
  }

  // Both sides resolved to their real locations before comparing, but NOT the same way
  // (#838): a `dirs` entry that does not exist resolves to its nearest existing ancestor
  // plus the literal tail (realpathOfNearestAncestor(), below), which keeps the
  // containment answer honest while leaving "no such directory" to snapshot()'s own
  // error — this gate must not change how a plain typo in a CALL is reported. A
  // CYPHER_BRAIN_MCP_SOURCE_ROOTS root is the opposite: it is the OPERATOR's boundary,
  // not a call argument, so resolveConfiguredRoot() (above) requires it to actually exist
  // as a directory and throws — refusing the WHOLE call — rather than silently falling
  // back to authorizing an ancestor the operator did not name.
  const roots = await underPolicy(
    'a CYPHER_BRAIN_MCP_SOURCE_ROOTS root could not be resolved',
    `Check that every configured root exists and is reachable by this server. ${POLICY_DOC_REF}`,
    () => Promise.all(MCP_SOURCE_ROOTS.map((r) => resolveConfiguredRoot(r))),
  );
  // Resolved CONCURRENTLY, not one after another (multi-model review round 3). Sequential
  // resolution makes the post-check window for the FIRST entry as long as the resolution
  // of every later one, which a caller can pad at will by passing many directories. This
  // does not eliminate the window — see the second call site's comment for what remains
  // and why the real fix (revalidating each source immediately before it is archived)
  // lives in snapshot.ts's own loop rather than here — it removes the part of it the
  // caller controls the size of.
  const resolvedDirs = await Promise.all(
    dirs.map((dir) =>
      underPolicy(`dirs entry ${JSON.stringify(dir)} could not be resolved`, 'Pass a path this server can reach.', () =>
        realpathOfNearestAncestor(dir),
      ),
    ),
  );
  for (const [i, dir] of dirs.entries()) {
    const resolved = resolvedDirs[i];
    if (!pathCoveredBy(resolved, roots)) {
      // The refusal names the caller's OWN path and nothing else (multi-model review
      // round 2, #800). Echoing the resolved path would turn this gate into a symlink
      // oracle — submit paths, read back where they really point — and echoing the root
      // list would hand an untrusted caller the server's configured directory layout.
      // Neither is needed to act on the refusal: the caller knows what it passed, and the
      // operator, who is the only one who can change the roots, has the full detail on
      // this server's stderr (logged outside captureCall, so it is not relayed back).
      console.error(
        `snapshot policy: refused dirs entry ${JSON.stringify(dir)} — resolves to ${resolved}, outside every ` +
          `CYPHER_BRAIN_MCP_SOURCE_ROOTS root (${MCP_SOURCE_ROOTS.join(', ')})`,
      );
      throw snapshotPolicyDenied(
        `dirs entry ${JSON.stringify(dir)} is not inside any directory this server is configured to snapshot ` +
          '(CYPHER_BRAIN_MCP_SOURCE_ROOTS)',
        'Pass a directory the operator has authorized, or have them add this location to ' +
          'CYPHER_BRAIN_MCP_SOURCE_ROOTS and restart the server. ' +
          POLICY_DOC_REF,
      );
    }
  }
}

// #753: shared quoted, comma-joined rendering of an allowed-value list — used by both
// requireBackend and assertDeclaredEnums below, so a caller sees the SAME list shape
// whichever of the two "value must be one of a fixed set" checks refused it.
function formatAllowedValues(values: readonly unknown[]): string {
  return values.map((v) => JSON.stringify(v)).join(', ');
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
//
// #753: the SAME list formatting (and did-you-mean handling, for a present string that
// misses) as assertDeclaredEnums' "unrecognized value" refusal below — via the shared
// formatAllowedValues() helper — so "backend must be from this fixed set" reads the same
// way whichever of the two violations (missing entirely, caught here since `required` is
// a schema keyword nothing enforces at runtime; present but wrong, caught by
// assertDeclaredEnums before this handler even runs) triggered it. Before this, a missing
// backend got a bare pipe-joined list here while a present-but-wrong one got
// assertDeclaredEnums' quoted list plus a did-you-mean — an agent that had only ever
// pattern-matched one shape would not recognize the other as the same refusal.
function requireBackend(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || !BACKENDS.includes(value)) {
    const near = typeof value === 'string' ? nearestName(value, BACKENDS) : undefined;
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `${what} must be one of: ${formatAllowedValues(BACKENDS)}` +
        ` — got ${JSON.stringify(value)}${near ? ` (${didYouMean(near)})` : ''}.`,
    );
  }
}

// ALL_TOOLS itself is imported from mcp-tool-schemas.ts (#507); this index over it is a
// dispatcher-side concern (the switch below reads it), not a schema declaration, so it
// stays here rather than moving with the schemas.
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
        `${near ? ` (${didYouMean(near)})` : ''} — refused rather than ignored. Accepts only: ` +
        `${formatAllowedValues(allowed)}.`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

// #220/#636: an in-process, per-(tool, key) lock — belt-and-suspenders alongside the
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
//
// #636 (Codex agentic audit, P1): that check-then-add must run BEFORE this call's own
// (async) idempotency-log lookup, not after it — the original #220 ordering. With the
// check after the lookup, call A's lookup misses and A starts working; call B's OWN
// lookup — already in flight, reading a log snapshot from before A ever wrote to it — can
// resolve to a miss AFTER A finishes, records its result, and removes itself from this
// Set, at which point B observes both a cache miss and an empty in-flight set and spends
// again. Checking (and claiming) first closes this: B's check now happens before B's own
// lookup even starts, so it observes A's claim regardless of how long either call's log
// read takes. The call site below also claims the file-based, cross-process counterpart
// of this same-process Set (idempotency.ts's claimIdempotencyKey) before its own lookup,
// for the identical reason across two separate cypher-brain-mcp server processes sharing
// one CYPHER_BRAIN_HOME.
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
  // #800: the snapshot policy runs HERE — after the cheap type checks that make `dirs`
  // a string[], and before ANYTHING with a side effect. Everything below this line
  // creates something: resolveWritableLocatorFile reads a caller-named file, the
  // idempotency claim writes a lock, the replay branch writes a locator file, and the
  // snapshot itself stages plaintext, scans it and uploads the ciphertext. Placing the
  // gate above all of it is what makes "a denied call leaves nothing behind" true rather
  // than merely likely.
  //
  // It is also above the idempotency LOOKUP on purpose, so a replay is not
  // grandfathered: a key recorded while the policy was looser (or before it existed)
  // must not become a way to re-run a call the current policy would deny. The replay
  // returns a stored result AND can write a locator file, so "nothing new is disclosed"
  // is not a reason to let it through a policy the operator has since tightened.
  await assertSnapshotPolicy(dirs, recipients);
  // #789: `locator_file` reaches push() as --save-locator, which mkdir's the parent and
  // RENAMES a temp sibling over the exact path named (src/lib/pushpull.ts) — an atomic,
  // unconditional replacement of whatever is there. Unscoped, that is an arbitrary-file-
  // replacement primitive reachable with NO consent gate at all, because the free `file`
  // backend needs no confirm_paid. Same asymmetry assertWithinHome() was written for: the
  // CLI's --save-locator is a human with a shell writing where they asked to; an MCP
  // caller has no other route to this.
  //
  // Scoped to CYPHER_BRAIN_HOME, which is where MANAGEMENT.md's own cadence already puts
  // it (`--save-locator ~/.cypher-brain/latest-locator.tsv`), and resolved through the
  // #648 helper so a symlinked ancestor cannot smuggle the rename out. The RESOLVED path
  // is what gets used from here on — carrying the caller's original through to the write
  // would re-follow the symlink a second time, which is the Critical #648 already fixed
  // once for wallet_create's `out`.
  //
  // RESIDUAL, stated rather than papered over (multi-model review, #789): the actual
  // rename happens at the END of push(), potentially after a long upload, and a canonical
  // pathname does not bind that rename to the object checked here — an ancestor swapped
  // for a symlink in between is still followed. Removing that needs the write bound to an
  // already-open, verified directory descriptor (openat/RESOLVE_BENEATH + renameat), which
  // Node does not expose and which lives in src/lib/pushpull.ts, not here. This is the
  // SAME residual #648 records for wallet_create's `out` — an attacker who can already
  // create symlinks inside CYPHER_BRAIN_HOME at will. Re-checking just before the rename
  // would narrow it without closing it, and cannot be done from this file at all.
  const savedLocatorFile = isStr(locatorFile)
    ? await resolveWritableLocatorFile(locatorFile, 'locator_file')
    : undefined;
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

  // #636: claim (tool, key) — the in-process Set AND its cross-process file-lock
  // counterpart — BEFORE this call's own (async) idempotency-log lookup below, not after
  // it (the original #220 ordering); see idempotencyInFlight's own comment above for why
  // that ordering is what closes the race, not merely having a lock. Held through the
  // lookup, the spend gate, the actual paid work, and recordIdempotencyResult — released
  // only in the `finally` below, on every path out of this function including a
  // cache-hit replay.
  let fingerprint: string | undefined;
  const lockId = idempotencyKey ? JSON.stringify([SNAPSHOT_NOW_TOOL.name, idempotencyKey]) : undefined;
  let releaseClaim: (() => Promise<void>) | undefined;
  // #809: set when the result of a call that MAY HAVE SPENT could not be recorded. The
  // `finally` below then leaves BOTH claims in place instead of releasing them, so the
  // key stays blocked and a retry carrying it is refused — rather than finding no record
  // and no claim, and running the whole paid path a second time. Fail closed, the same
  // posture ERR_IDEMPOTENCY_STORE_UNREADABLE already takes when the log cannot be READ.
  let retainClaim = false;
  // Only a paid backend can have spent, so only a paid backend is worth wedging a key
  // for: on `file` (free) a re-executed retry costs nothing but a no-clobber refusal,
  // which is a much better outcome than a key an operator has to unblock by hand.
  const paidSpend = typeof backend === 'string' && PAID_BACKENDS.has(backend);
  // #809: the exact file an operator removes to unblock a retained key. Derived from the
  // same helper IdempotencyClaimHeldError's own message uses, so the two cannot drift.
  const claimLockPathForKey = (): string =>
    idempotencyKey ? idempotencyClaimLockPath(IDEMPOTENCY_LOG, SNAPSHOT_NOW_TOOL.name, idempotencyKey) : '';
  // #809: a record-write failure after a possible spend, reported the way AGENTS.md's
  // relay contract requires (warn(), never a raw console.error — the console.error this
  // replaced never reached the result's `warnings` array, so the structured payload of an
  // otherwise-successful paid call said nothing about the replay net being gone). Returned
  // as well as warned so the caller's own result carries it verbatim: this runs AFTER the
  // call's captureCall has already drained, so nothing else would splice it in.
  const warnRecordFailure = (recordErr: unknown, outcome: string): string => {
    if (paidSpend) retainClaim = true;
    const message =
      `snapshot_now: ${outcome} but recording its idempotency-key result failed ` +
      `(idempotency_key=${JSON.stringify(idempotencyKey)}): ${errMsg(recordErr)}. ` +
      (retainClaim
        ? `The idempotency claim is being RETAINED rather than released, so a retry with this key is refused ` +
          `instead of spending again (#809). Verify the outcome, then remove ${claimLockPathForKey()} by hand to ` +
          `unblock this key — or simply use a NEW key once you know what happened.`
        : 'Nothing was spent on this call, so the claim is released normally — a retry with the same key will ' +
          're-execute rather than replay this result.');
    warn(message);
    return message;
  };
  if (idempotencyKey && lockId) {
    // No `await` between this check and the `.add()` below — see idempotencyInFlight's
    // own comment for why that is what makes it safe against a same-process concurrent
    // duplicate. Checked first because it is free (no I/O) and alone catches the common
    // case (two calls racing within THIS server process) without ever touching disk.
    if (idempotencyInFlight.has(lockId)) {
      throw new ToolError(
        'ERR_IDEMPOTENCY_IN_FLIGHT',
        `a snapshot_now call with idempotency_key ${JSON.stringify(idempotencyKey)} is already running — ` +
          'wait for it to finish rather than sending a concurrent duplicate with the same key.',
      );
    }
    idempotencyInFlight.add(lockId);
    try {
      // The cross-process counterpart of the Set just above (#636) — see
      // claimIdempotencyKey's own doc comment in idempotency.ts for exactly what it
      // closes that a process-local Set cannot: two SEPARATE cypher-brain-mcp server
      // processes sharing one CYPHER_BRAIN_HOME each have their own idempotencyInFlight.
      releaseClaim = await claimIdempotencyKey(IDEMPOTENCY_LOG, SNAPSHOT_NOW_TOOL.name, idempotencyKey);
    } catch (e) {
      idempotencyInFlight.delete(lockId);
      if (e instanceof IdempotencyClaimHeldError) {
        throw new ToolError(
          'ERR_IDEMPOTENCY_IN_FLIGHT',
          `a snapshot_now call with idempotency_key ${JSON.stringify(idempotencyKey)} is already running in ` +
            `another process sharing this CYPHER_BRAIN_HOME — wait for it to finish rather than sending a ` +
            `concurrent duplicate with the same key (${e.message})`,
        );
      }
      throw e; // an unexpected bug (e.g. an unwritable claim directory), not the held-claim case above
    }
  }

  try {
    // #220: idempotency-key replay, checked BEFORE the spend gate below — a replay of an
    // already-completed call must not need confirm_paid supplied again (nothing NEW is
    // being spent; this only returns what already happened) and must do no work at all. A
    // fingerprint mismatch means the same key named two DIFFERENT calls, refused rather
    // than silently answered with the wrong one's result (see snapshotNowFingerprint
    // above). Runs INSIDE the claim acquired above (#636), so even a pure cache-read
    // replay is briefly serialized against a concurrent duplicate for the same key — a
    // rare spurious ERR_IDEMPOTENCY_IN_FLIGHT on a read that would have been harmless on
    // its own, traded for actually closing the check-lookup race.
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
        // #789: the RESOLVED, home-contained path — this branch writes the locator file
        // just as the push path does, so it needs the same containment. Using the raw
        // `locatorFile` here would leave the whole check bypassable by sending a second
        // call with the same idempotency_key.
        if (
          savedLocatorFile !== undefined &&
          cached.result.pushed === true &&
          isStr(cached.result.locator) &&
          isStr(cached.result.backend) &&
          isStr(cached.result.sha256)
        ) {
          await writeReplayedSavedLocator(savedLocatorFile, {
            locator: cached.result.locator,
            backend: cached.result.backend,
            sha256: cached.result.sha256,
          });
          replayedResult = { ...replayedResult, locator_file: savedLocatorFile };
        }
        // #810: a replay must be reported the same way the FIRST call was. A recorded
        // partial success (the paid upload landed, a later stage failed) was re-thrown on
        // the first call — an error — but replayed through structuredOk(), which sets no
        // `isError` at all: an agent retrying after a transport hiccup saw an error once
        // and a clean success the second time for identical state, with `pushed: true` at
        // the top level. #818's uncertain-spend tombstone is the same shape and must never
        // read as a success either. Both are marked `disposition: 'error'` at record time,
        // which is what this reads — so the two calls agree, and a caller keying off
        // `isError` (the normal MCP contract) is told the truth on both.
        //
        // Records written BEFORE #818 carry no disposition and read as 'success', which is
        // exactly the pre-#818 behaviour for them: this changes how NEW records replay, it
        // does not retroactively reinterpret what is already on disk.
        return structuredOutcome(
          { ...replayedResult, idempotent_replay: true },
          { isError: cached.disposition === 'error' },
        );
      }
    }

    // Spend gate FIRST — before any snapshot work — so a refused paid push does no
    // work and leaves no artifact behind. Never silently spend: the CLI accepts
    // CYPHER_BRAIN_YES=1 for unattended cadence loops, but via MCP the consent
    // must be in the call itself.
    if (backend && PAID_BACKENDS.has(backend) && confirmPaid !== true) {
      // #796: the durability sentence is per-backend, read from the table beside
      // PAID_BACKENDS itself. It used to be hard-coded Arweave prose for every member of
      // that set, which told a ton-provider caller they were buying PERMANENT storage —
      // false, and false at the exact moment consent to spend is being requested.
      throw new ToolError(
        'ERR_CONFIRM_REQUIRED',
        `backend "${backend}" is ${paidBackendConsentDescription(backend)}. Re-call snapshot_now with ` +
          `confirm_paid=true to consent (the MCP equivalent of the CLI --yes guard). The CYPHER_BRAIN_YES ` +
          `environment escape hatch is not honored over MCP, so no call can spend without this flag.`,
      );
    }

    // #800, second evaluation — the same narrowing #792 applies to restore_now's out_dir,
    // for the same reason and with the same honesty about what it buys. This gate is
    // path-based, so it cannot BIND the snapshot to the directories it vetted; a symlink
    // swapped into place after the first check is followed by the tar all the same
    // (multi-model review, #800). What it can do is shrink the window: the first call
    // happens before the locator resolution, the idempotency claim, the log lookup and
    // the spend gate — all of which can take real time — while this one sits immediately
    // before the read. The remaining gap is a few statements rather than the whole
    // preamble.
    //
    // Two things this does NOT do, both stated rather than implied (multi-model review
    // round 3). It is not per-SOURCE: snapshot.ts archives the directories one at a time,
    // so the last entry's window is shorter than the first's, and closing that means
    // revalidating each source immediately before it is archived — inside snapshot.ts's
    // own loop, which is a change to the CLI path this policy is deliberately not on.
    // What is done here instead is to resolve the sources concurrently (see
    // assertSnapshotPolicy) so the caller cannot pad the window with extra entries.
    //
    // The vetted paths are deliberately NOT substituted for the caller's. tar does not
    // dereference a top-level symlink argument (see snapshot.ts's own comment on that),
    // so handing snapshot() a realpath'd path would silently change WHAT a legitimate
    // symlink source archives — the link becomes the target's whole contents. Closing
    // the residual properly needs descriptor-bound reads (openat/RESOLVE_BENEATH), which
    // Node does not expose and which live in snapshot.ts, not here.
    await assertSnapshotPolicy(dirs, recipients);
    const snapOpts: CliOptions = { out, pg, dirs, tables: [], recipients, scan_secrets: scanSecrets };
    let snap: CaptureResult<void>;
    try {
      snap = await captureCall(() => snapshot(snapOpts));
    } catch (e) {
      // #560: a bad recipient (neither an age1... pubkey nor an existing file) is bad
      // INPUT, not a server fault — see NO_RECIPIENT_AT_PATTERN's own comment above.
      if (e instanceof Error && NO_RECIPIENT_AT_PATTERN.test(e.message)) {
        throw reclassify('ERR_INVALID_INPUT', e.message, e);
      }
      // #726: same reclassification, with the message translated from the CLI's
      // --profile/--pg/--dir flags to this tool's own dirs/pg fields — see
      // NOTHING_TO_SNAPSHOT_PATTERN's own comment above. --profile has no MCP-side
      // equivalent, so it is dropped rather than translated.
      if (e instanceof Error && NOTHING_TO_SNAPSHOT_PATTERN.test(e.message)) {
        throw reclassify('ERR_INVALID_INPUT', 'nothing to snapshot: pass dirs and/or pg', e);
      }
      throw e;
    }
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
        save_locator: savedLocatorFile, // #789: the resolved, home-contained path, never the caller's raw one

        dirs: [],
        tables: [],
        recipients: [],
      };
      let pushRes: CaptureResult<boolean>;
      try {
        pushRes = await captureCall(() => push(pushOpts));
      } catch (e) {
        // #818: checked BEFORE the PushPartialSuccessError branch below — the two demand
        // opposite payloads and must never be confused. That branch asserts a CONFIRMED
        // spend and reports `pushed: true` with a usable locator; here the spend is
        // UNKNOWN and there is no locator at all, so borrowing its shape would tell the
        // caller an upload exists that may never have happened. (PushUncertainSpendError
        // is deliberately not a subclass, so this is belt-and-braces rather than the thing
        // that makes the ordering safe — but the ordering is what a reader checks first.)
        //
        // Recorded as a PERMANENT, error-disposition tombstone: the record is what refuses
        // the retry that would otherwise pay a second time, and expiring it would not
        // settle the ambiguity — only postpone that retry until the TTL had passed.
        if (e instanceof PushUncertainSpendError) {
          // Folded into the payload BEFORE it is recorded (multi-model review, Warning):
          // the snapshot's own warnings (a single-recipient snapshot, a secret-scan
          // finding) and any the failing push recorded must ride the REPLAY too, not only
          // the immediate response — a replay is meant to be the first call's result, and
          // #347's relay contract does not stop applying to the second delivery of it.
          const uncertainWarnings = [
            ...(Array.isArray(result.warnings) ? (result.warnings as string[]) : []),
            ...((e as Error & { cbWarnings?: string[] }).cbWarnings ?? []),
          ];
          const uncertainResult: Record<string, unknown> = {
            code: 'ERR_PUSH_OUTCOME_UNCERTAIN',
            spend_outcome: 'uncertain',
            backend: e.backend,
            // What settles it, and what to settle it WITH — the one value that must
            // survive this failure. No `pushed` and no `locator`, deliberately: an
            // upload that may not exist has nothing to point at, and a caller reading
            // either field would act on a fiction.
            check_kind: e.checkKind,
            check_identifier: e.checkIdentifier,
            // Present ONLY when the ambiguous upload was the ".minisig" sidecar and the
            // ciphertext's own upload had already succeeded (multi-model review,
            // Critical). Distinctly named rather than `locator`, and never accompanied by
            // `pushed`, so it cannot be mistaken for "the push succeeded": it is the one
            // thing here that IS confirmed, and losing it would make the "use a NEW key"
            // recovery re-pay for bytes that are already stored.
            ...(e.confirmedCiphertextLocator ? { confirmed_ciphertext_locator: e.confirmedCiphertextLocator } : {}),
            message: annotateErrorMessage(e.message),
            idempotency_key: idempotencyKey ?? null,
            idempotent_replay: false,
            ...(uncertainWarnings.length ? { warnings: uncertainWarnings } : {}),
          };
          if (idempotencyKey && fingerprint) {
            try {
              await recordIdempotencyResult(
                IDEMPOTENCY_LOG,
                SNAPSHOT_NOW_TOOL.name,
                idempotencyKey,
                fingerprint,
                uncertainResult,
                IDEMPOTENCY_TTL_SECONDS,
                Date.now(),
                { disposition: 'error', retention: 'permanent' },
              );
            } catch (recordErr) {
              // Only this one cannot be in the persisted copy — there is no persisted copy
              // to put it in. Spliced onto the RESPONSE instead, which is the only place
              // it can be delivered at all.
              const recordWarning = warnRecordFailure(recordErr, 'the push outcome is UNCERTAIN');
              return structuredOutcome(
                { ...uncertainResult, warnings: [...uncertainWarnings, recordWarning] },
                { isError: true },
              );
            }
          }
          return structuredOutcome(uncertainResult, { isError: true });
        }
        // #220 (multi-model review, P1): a PushPartialSuccessError means the ciphertext
        // upload — the actual paid, permanent spend — already happened even though THIS
        // call is about to report an error. That covers the ".minisig" signature
        // sidecar upload failing (PushSignatureUploadError, e.sigLocator undefined —
        // see its own doc comment in pushpull.ts), the LOCAL --save-locator
        // bookkeeping failing after everything durably uploaded (PushLocatorWriteError,
        // e.sigLocator set when a signed push's sidecar landed first), and issue #654's
        // PushFundingConfirmedButIncompleteError (a ton-provider deploy whose funding
        // is confirmed on-chain but whose provider notify handshake did not complete).
        // Either way, a retry carrying the same idempotency_key must be told the spend
        // already happened, not sent to spend again for an AFTERMATH failure that has
        // nothing to do with whether the paid upload/deploy itself landed — this is
        // precisely the "partial success" scenario #220 exists to make retry-safe.
        if (idempotencyKey && fingerprint && e instanceof PushPartialSuccessError) {
          // issue #654 (Codex design review): PushFundingConfirmedButIncompleteError
          // gets its OWN branch, not the `locator_file_write_failed` fallback the other
          // two subclasses shared — that fallback would misclassify it (this isn't a
          // --save-locator bookkeeping failure) and `pushed: true` alone overclaims
          // completeness (the provider has NOT confirmed the download; only the funding
          // transfer is confirmed). `provider_download_confirmed: false` is explicit
          // (not merely absent) so a caller cannot mistake "field not present" for
          // "confirmed false" if this result shape is ever extended later.
          const stageFields: Record<string, unknown> =
            e instanceof PushFundingConfirmedButIncompleteError
              ? { funding_confirmed: true, provider_download_confirmed: false, partial_stage: e.stage }
              : e.name === 'PushSignatureUploadError'
                ? { signature_upload_failed: true }
                : { locator_file_write_failed: true };
          const partialResult: Record<string, unknown> = {
            ...result,
            pushed: true,
            backend,
            locator: e.locator,
            ...(e.sigLocator ? { sig_locator: e.sigLocator } : {}),
            ...stageFields,
          };
          try {
            await recordIdempotencyResult(
              IDEMPOTENCY_LOG,
              SNAPSHOT_NOW_TOOL.name,
              idempotencyKey,
              fingerprint,
              partialResult,
              IDEMPOTENCY_TTL_SECONDS,
              Date.now(),
              // #810: the first call re-throws `e` below, so this outcome is an ERROR —
              // and its replay has to be one too. Still TTL-governed: unlike an uncertain
              // spend, the outcome here is KNOWN (the upload landed, a later stage did
              // not), so once the caller has acted on it the record has no further job.
              { disposition: 'error' },
            );
          } catch (recordErr) {
            // A record-write failure here must NEVER mask `e` (multi-model review, P1):
            // e.locator is recovery-critical, and swallowing it behind a DIFFERENT,
            // unrelated fs error (the ORIGINAL bug this fixes) would hide the one piece
            // of information the operator needs to hand-record the already-paid-for
            // upload. Best-effort only — log a warning and fall through to `throw e`
            // below unconditionally. #809: warn(), not console.error — a raw
            // console.error here bypasses the relay contract entirely (AGENTS.md), which
            // is why the structured error result said nothing about the replay net being
            // gone. Spliced onto `e.cbWarnings` as well, because captureCall bound that
            // array at the moment push() threw — i.e. before this line ran — so a warning
            // recorded now would otherwise never reach THIS call's `warnings`.
            const recordWarning = warnRecordFailure(
              recordErr,
              `the ciphertext upload already succeeded (locator=${JSON.stringify(e.locator)})`,
            );
            const withWarnings = e as Error & { cbWarnings?: string[] };
            withWarnings.cbWarnings = [...(withWarnings.cbWarnings ?? []), recordWarning];
          }
        }
        throw e;
      }
      const locator = pushRes.out.join('\n').trim(); // push() prints ONLY the locator to stdout
      result.pushed = true;
      result.backend = backend;
      result.locator = locator;
      if (savedLocatorFile) result.locator_file = savedLocatorFile;
      (result.log as string[]).push(...pushRes.err);
      // #649: `result.warnings` above was seeded from the SNAPSHOT phase (snap.warnings)
      // only — pushRes.warnings (an insufficient-funds-buffer notice, a receipt-
      // persistence failure, a too-low-bounty notice, ...) was previously dropped
      // entirely from the structured result, even though push() just succeeded. Merge
      // rather than overwrite: both phases can carry independent warnings on the same
      // call. With an idempotency_key set this `result` is also PERSISTED and replayed
      // verbatim on retry (recordIdempotencyResult() below), so an unmerged push warning
      // would have been lost for that cached response permanently, not just delayed.
      if (pushRes.warnings.length) {
        result.warnings = [
          ...(Array.isArray(result.warnings) ? (result.warnings as string[]) : []),
          ...pushRes.warnings,
        ];
      }
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
        //
        // #809: what the old console.error here said — "a retry with the SAME key ... may
        // re-execute" — understated it twice over. With the record missing AND the
        // `finally` releasing both claims, a retry WOULD re-execute, and on a paid backend
        // that is a second charge. warnRecordFailure() both relays the warning properly
        // (warn(), so it reaches this result's `warnings`) and, on a paid backend, retains
        // the claim so the retry is refused instead.
        const recordWarning = warnRecordFailure(recordErr, 'the snapshot (and any push) fully succeeded');
        result.warnings = [...(Array.isArray(result.warnings) ? (result.warnings as string[]) : []), recordWarning];
      }
    }
    return structuredOk(result);
  } finally {
    // #636: release BOTH claims acquired above, on every path out of the `try` above —
    // the cache-hit replay's `return`, every `throw`, and the real-work success path.
    // The in-process delete is synchronous and cheap; the cross-process release is
    // best-effort I/O (see claimIdempotencyKey's own doc comment for what it does and does
    // not remove — it never touches a claim it did not itself create).
    //
    // #809: the CROSS-PROCESS claim is kept when the result of a possibly-paid call could
    // not be recorded. Releasing it removes the last thing standing between a retry and a
    // second charge: the log has no record to replay, and a freed claim lets the retry
    // straight through to the paid path. A wedged key an operator can clear by hand is a
    // strictly better failure than a silent double-spend, and it is the same fail-closed
    // trade ERR_IDEMPOTENCY_STORE_UNREADABLE already makes for an unreadable log.
    //
    // The IN-PROCESS Set entry is dropped either way (multi-model review, Warning). Keeping
    // it would make the recovery this call's own warning documents — "remove the lock file
    // to unblock this key" — not actually work against THIS still-running server, which
    // would then also need a restart. Dropping it loses nothing: a retry in this process
    // still has to take the file claim, and that `writeFile(..., 'wx')` fails on the
    // retained lock exactly as another process's would, so both are refused until the file
    // is gone — and once an operator removes it, both are unblocked.
    //
    // Written as a guarded block rather than an early `return`: a `return` inside a
    // `finally` DISCARDS whatever the `try` was throwing or returning, which would swallow
    // the very error this branch exists to report.
    if (lockId) idempotencyInFlight.delete(lockId);
    if (!retainClaim && releaseClaim) await releaseClaim();
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
//
// #787: takes the ALREADY-READ text and the mtime that came off the same open handle,
// rather than opening the path itself. The caller (readContainedFileWithinHome) is what
// enforces containment and reads once, so this function cannot re-traverse a path that
// may have changed since — and it now has no way to read a file at all, which is the
// structural half of that guarantee.
function parseLocatorFile(path: string, text: string, mtime: Date): LocatorSource {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'));
  if (!line) throw new ToolError('ERR_INVALID_INPUT', `locator file ${path} has no locator line`);
  const [locator, backend, digest, contentDigest] = line.split('\t');
  if (!locator || !backend)
    // #787: the rejected line is NOT echoed. It used to be (`got: ${JSON.stringify(line)}`),
    // which — combined with the unscoped path this function used to accept — handed the
    // caller the first non-comment line of any readable file. The containment check on
    // the way in is the real fix; this stays fail-safe alongside it, because "the tool
    // only reads files it should" and "the tool never reports content it rejected" are
    // independently worth having. What a caller needs to fix a genuinely malformed
    // locator file is the expected SHAPE and how many fields arrived, not the bytes.
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `locator file ${path} must contain "<locator>\\t<backend>[\\t<sha256>[\\t<content_digest>[\\t<recipients_fingerprint>[\\t<sig_locator>[\\t<sign_key_id>]]]]]" — its first non-comment line has ${line.split('\t').length} tab-separated field(s) and does not start with a locator and a backend`,
    );
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
// Takes already-read text for the same reason parseLocatorFile above does (#787).
function parseIndexFile(path: string, text: string): LocatorSource {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (lines.length === 0) throw new ToolError('ERR_INVALID_INPUT', `index file ${path} has no entries`);
  const last = lines[lines.length - 1];
  const [timestamp, locator, digest] = last.split('\t');
  if (!timestamp || !locator)
    // #787: see readLocatorFile's own note — the rejected line is described, never echoed.
    throw new ToolError(
      'ERR_INVALID_INPUT',
      `index file ${path} lines must be "<timestamp>\\t<locator>[\\t<sha256>]" — its last non-comment line has ${last.split('\t').length} tab-separated field(s) and does not start with a timestamp and a locator`,
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
  // #787: contain-then-read through ONE handle, and PARSE what came back — this tool used
  // to readFile() whatever absolute path it was handed and report on the contents, which
  // made a readOnlyHint:true tool a general local-file disclosure oracle for an MCP caller.
  // See readContainedFileWithinHome()'s own comment for why this refuses rather than
  // warning the way restore_now's out_dir does, and for what the single handle buys over
  // the check-then-read it replaced.
  if (locatorFile) {
    const read = await readContainedFileWithinHome(locatorFile, 'locator_file');
    sources.push(parseLocatorFile(locatorFile, read.text, read.mtime));
  }
  if (indexFile) {
    const read = await readContainedFileWithinHome(indexFile, 'index_file');
    sources.push(parseIndexFile(indexFile, read.text));
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
  let resultPayload: Record<string, unknown>;
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
    // #793: built into a variable rather than returned from inside the try, so the
    // cleanup below runs OUTSIDE it. Returning from inside the try left the cleanup in a
    // bare `finally`, where a throw discarded this verdict — or, worse, discarded the
    // verification's own error — and replaced it with a temp-dir failure.
    resultPayload = {
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
    };
  } catch (e) {
    await discardFetchDirPreservingError(tdir, e, 'verify');
    throw e;
  }
  await discardFetchDirWarningOnResult(tdir, resultPayload, 'verify');
  return structuredOk(resultPayload);
}

// #509: the resolved input restore_now hands to restore() — its dual-mode
// locator/file/locator_file resolution (pull into a scratch tmpdir, or use a local file
// directly, with the same sha256 pin applied either way) extracted out of
// handleRestoreNow so that function reads as validate → resolve target → restore →
// format result instead of interleaving all four. `tdir` is returned rather than torn
// down here on the SUCCESS path — restore() still needs the file sitting in it — but on
// resolveRestoreTarget's OWN throw (pull failed, sha256 mismatch, ...) it tears down
// whatever tmpdir it created itself, since the caller never receives one to clean up.
interface ResolvedRestoreTarget {
  target: string | undefined;
  tdir: string | null;
  pulled?: Record<string, unknown>;
  signature?: Record<string, unknown>;
  effectivePin?: string;
  warning?: string;
}

async function resolveRestoreTarget(args: ToolArgs): Promise<ResolvedRestoreTarget> {
  const { locator, file, locator_file: locatorFile, backend, sha256: pin } = args;
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
  let warning: string | undefined;
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
      // #689: mirrors handleVerifyRestore's identical check (above) — restore_now is the
      // MORE consequential of the two to have this gap, since (unlike verify_restore) it
      // actually decrypts, extracts to out_dir, and — when pg is given — runs pg_restore
      // --clean --if-exists against a live database, all with zero warning that an
      // arweave/turbo locator with no sha256 pin cannot detect a gateway rollback/substitution.
      if (!effectivePin && pullOpts.backend && NON_CONTENT_ADDRESSED_BACKENDS.has(pullOpts.backend)) {
        warning =
          `integrity pin NOT applied: ${pullOpts.backend} locators are not content hashes (post-assigned ids for ` +
          'arweave/turbo, an operator-chosen remote path for rclone), so a gateway rollback/substitution that ' +
          'still decrypts with your key would go undetected — this restore is proceeding against unverified ' +
          'bytes. Pass sha256 (the expected ciphertext digest from a trusted off-box record, e.g. index.tsv) ' +
          'or use locator_file (a push --save-locator file, which carries the pin) to fail closed like the CLI recovery path.';
      }
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
    return { target, tdir, pulled, signature, effectivePin, warning };
  } catch (e) {
    // #793: an unguarded `await discardFetchDir(tdir)` here replaced `e` — the sha256
    // mismatch, the unfetchable signature — with a temp-dir error, telling the caller the
    // server broke rather than that the artifact failed its pin.
    await discardFetchDirPreservingError(tdir, e, 'restore');
    throw e;
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

  // #792: resolve out_dir the way src/lib/restore.ts's own stat() will — refusing a
  // final-component symlink outright, following ancestors — BEFORE any pull/decrypt/
  // extract work. See resolveRestoreOutDir()'s own comment for why the final component
  // is fail-closed while ancestors are not. This sits after the confirm_write gate so
  // the consent boundary still comes first, and before resolveRestoreTarget() so nothing
  // has been fetched or written by the time it can refuse.
  await resolveRestoreOutDir(outDir);

  const { target, tdir, pulled, signature, warning } = await resolveRestoreTarget(args);
  // #650: cleanup of the fetch/scratch dir used to live in a `finally` wrapping the try
  // block below. A `finally` that throws REPLACES whatever the try block already
  // returned/threw — so a transient EIO/EACCES removing `tdir` (an NFS-backed TMPDIR,
  // say) turned an ALREADY-SUCCESSFUL restore (pg_restore --clean --if-exists may have
  // already dropped and replaced live database objects by this point) into an
  // ERR_INTERNAL response. An agent seeing that error has every reason to retry, which
  // would run that same destructive pg_restore a SECOND time purely because of a
  // cleanup-step false negative. Cleanup is now handled explicitly on each path instead:
  // its failure rides along as a warning on a successful result, and never masks the
  // real error on a failed one.
  let resultPayload: Record<string, unknown>;
  try {
    // Resolved AGAIN here, and THIS is the result that gets used (multi-model review,
    // #792). The identical call before the pull is a fail-fast, so an obviously-bad
    // destination costs no fetch; between the two sits the whole pull, pin check and
    // signature verification, which is easily long enough for a symlink to be swapped in.
    // Re-resolving immediately before restore() narrows that window to a few statements —
    // it does not close it; see resolveRestoreOutDir()'s own RESIDUAL note. Inside the try
    // so a refusal here still tears down the fetch dir rather than leaking it.
    const resolvedOutDir = await resolveRestoreOutDir(outDir);
    const restoreOpts: CliOptions = {
      in: target,
      // #792: the RESOLVED path, not the caller's — same reasoning as #648's
      // resolveRealpathWithinHome(), which returns the resolved path precisely so the
      // actual operation cannot re-follow an ancestor symlink a second time.
      out_dir: resolvedOutDir,
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
      // #560: out_dir naming an EXISTING NON-DIRECTORY is bad INPUT (a caller-given path
      // collision), not a server fault — restore.ts's own throw for it has nothing to do
      // with require_signature, so it is reclassified here BEFORE that unrelated
      // carry-forward logic below, rather than falling through to it (which would only
      // trigger when `signature` happens to be set) or past it to plain ERR_INTERNAL.
      if (e instanceof Error && OUT_DIR_NOT_A_DIRECTORY_PATTERN.test(e.message)) {
        throw reclassify('ERR_INVALID_INPUT', e.message, e);
      }
      // A refusal under require_signature throws, so the structured result below — and with
      // it the `signature` object #312 added — never gets built. The caller would then read
      // restore()'s generic "no signature found" wording for a case where this server KNOWS
      // a recorded sidecar failed to fetch, and knows why.
      // Carry that diagnosis onto the error rather than losing it.
      if (!signature) throw e;
      throw reclassify(
        'ERR_INVALID_INPUT',
        `${errMsg(e)} — note: ${String(signature.note ?? '')} (${String(signature.reason ?? 'no reason recorded')})`,
        e instanceof Error ? e : new Error(errMsg(e)),
      );
    }
    // #559: non-blocking — see outsideHomeWarning()'s own comment for why restore_now
    // warns rather than refuses when out_dir sits outside CYPHER_BRAIN_HOME.
    //
    // #792: asked about the RESOLVED path. Asked about the caller's raw one, this warning
    // was silently inapplicable to exactly the case that needs it most — an in-home path
    // whose symlink target is not in home read as "inside home" and produced no warning at
    // all, while the plaintext landed outside. The final-component case is now refused
    // outright (resolveRestoreOutDir), so what remains here is ancestor resolution.
    const homeWarning = outsideHomeWarning(resolvedOutDir);
    const warnings = [...(homeWarning ? [homeWarning] : []), ...(warning ? [warning] : []), ...res.warnings];
    resultPayload = {
      out_dir: outDir,
      // Reported only when the two differ (an ancestor symlink, e.g. macOS's /var ->
      // /private/var), so a caller can always see where the plaintext actually landed
      // rather than only where it asked for it. `out_dir` itself keeps the caller's own
      // path: it names the same directory and is the value they can use again.
      ...(resolvedOutDir !== outDir ? { out_dir_resolved: resolvedOutDir } : {}),
      ...(pulled ? { pulled } : {}),
      ...(signature ? { signature } : {}),
      pg_restored: Boolean(pg),
      log: [...res.out, ...res.err],
      ...(warnings.length ? { warnings } : {}),
    };
  } catch (e) {
    // The restore itself failed (or was reclassified above) — still clean up the
    // fetch/scratch dir, but a cleanup failure here must never mask `e`: `e` is the
    // thing the caller needs to see and act on, and a cleanup error piggy-backing on
    // top of it would only obscure that (and revive the exact masking bug this fix is
    // for, just on the failure path instead of the success one). #793 moved the body
    // of this into discardFetchDirPreservingError() so verify_restore and
    // resolveRestoreTarget get the same behavior instead of the bare `finally`/`catch`
    // that discarded their outcomes; the `e.cbWarnings` relay #650 added lives there now.
    await discardFetchDirPreservingError(tdir, e, 'restore');
    throw e;
  }

  // The restore already completed successfully by this point — a cleanup failure here
  // must not override that with ERR_INTERNAL (see the comment above `resultPayload`).
  // Surface it as a warning ON the already-successful result instead.
  await discardFetchDirWarningOnResult(tdir, resultPayload, 'restore');
  return structuredOk(resultPayload);
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
  let res: CaptureResult<void>;
  try {
    res = await captureCall(() => schedule(installOpts));
  } catch (e) {
    // #726: same reclassification/translation as handleSnapshotNow's — schedule()'s
    // --max-spend/--ping-url-fail flag guidance rewritten to this tool's own
    // max_spend/ping_url_fail fields — see MAX_SPEND_REQUIRED_PATTERN's own comment
    // above. The backend name is read off the ALREADY-VALIDATED local `backend`
    // (requireBackend narrowed it to a string above), not parsed back out of e.message.
    if (e instanceof Error && MAX_SPEND_REQUIRED_PATTERN.test(e.message)) {
      throw reclassify(
        'ERR_INVALID_INPUT',
        `backend "${backend}" is a paid store: max_spend is required for an unattended schedule ` +
          '(native units: winc for turbo, winston for arweave L1) — the runner gets ' +
          'CYPHER_BRAIN_YES=1, so it must also get a spend cap',
        e,
      );
    }
    if (e instanceof Error && PING_URL_FAIL_REQUIRES_PATTERN.test(e.message)) {
      throw reclassify('ERR_INVALID_INPUT', 'ping_url_fail requires ping_url (the success URL) to also be set', e);
    }
    // #726 (sibling of snapshot()'s own check reclassified in handleSnapshotNow above):
    // validateInstallInputs() throws this SAME "nothing to snapshot" text for the SAME
    // reason — schedule_install's dirs/pg are as optional-but-one-required as
    // snapshot_now's, and its schema has no `profile` field either.
    if (e instanceof Error && NOTHING_TO_SNAPSHOT_PATTERN.test(e.message)) {
      throw reclassify('ERR_INVALID_INPUT', 'nothing to snapshot: pass dirs and/or pg', e);
    }
    throw e;
  }
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
// #440: scheduleStatusReport() throws ScheduleNotInstalledError (CB-E014) for "nothing
// installed yet" — the SAME expected precondition #426 already made the CLI's own
// `schedule status` treat as a normal, non-error result, and doctor.ts's checkSchedule()
// already treats as [SKIP] rather than a failure. Left uncaught, that throw fell through
// to the switch's generic catch and structuredErr()'s `ERR_INTERNAL` fallback — telling
// an agent the server was broken, indistinguishable from any OTHER thing scheduleStatusReport()
// could fail on (a corrupt schedule.json, a crontab/launchctl call that itself errored),
// which stay real ERR_INTERNAL failures on purpose. `ERR_NOT_CONFIGURED` names ONLY this
// one checkable (`instanceof`) condition, so a caller can branch on the code instead of
// string-matching the message the way `errors.ts`'s CB-E014 pattern already does. This
// stays a thrown error (not a structured `{installed:false}` result the way the CLI's
// `--json` output now is, #426) deliberately: the resource at SCHEDULE_STATUS_URI below
// serves this SAME scheduleStatusReport() call and is documented to error when nothing is
// installed — matching that, rather than making the tool and the resource disagree, is
// the smaller and safer fix (issue #440's own suggestion also allows for it). Shared with
// the SCHEDULE_STATUS_URI resource handler below (#558) so both surfaces reclassify the
// SAME condition identically instead of one of them falling through to ERR_INTERNAL.
async function scheduleStatusReportOrToolError(): Promise<Awaited<ReturnType<typeof scheduleStatusReport>>> {
  try {
    return await scheduleStatusReport();
  } catch (e) {
    if (!(e instanceof ScheduleNotInstalledError)) throw e;
    throw new ToolError('ERR_NOT_CONFIGURED', e.message);
  }
}

async function handleScheduleStatus(): Promise<CallToolResult> {
  return structuredOk(await scheduleStatusReportOrToolError());
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
  // #648: the actual WRITE below uses `resolvedOut` (this check's own resolved output),
  // never the caller's original `out` — see resolveRealpathWithinHome()'s own comment
  // for why (closes the check-then-use TOCTOU a separate check-and-reuse-the-original-
  // path approach would leave open).
  let resolvedOut: string | undefined;
  if (isStr(out)) {
    assertWithinHome(out); // cheap lexical pre-check every caller still gets first
    resolvedOut = await resolveRealpathWithinHome(out);
  }
  const walletOpts: CliOptions = {
    _: 'create',
    dirs: [],
    tables: [],
    recipients: [],
    out: resolvedOut,
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
  let res: CaptureResult<void>;
  try {
    res = await captureCall(() => wallet(walletOpts));
  } catch (e) {
    // #560: a missing wallet file at a caller-given path is bad INPUT, not a server
    // fault — see NO_WALLET_AT_PATTERN's own comment above.
    if (e instanceof Error && NO_WALLET_AT_PATTERN.test(e.message)) {
      throw reclassify('ERR_INVALID_INPUT', e.message, e);
    }
    throw e;
  }
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
  // #558: wrapped in try/catch — without it, both "no such resource" and whatever
  // scheduleStatusReportOrToolError() throws (including the ScheduleNotInstalledError ->
  // ERR_NOT_CONFIGURED reclassification shared with the schedule_status tool) reached the
  // SDK's own top-level catch unwrapped and came back as a bare -32603 with no `code`/
  // `cb_code`, unlike every tools/call error.
  try {
    if (uri !== SCHEDULE_STATUS_URI) throw new ToolError('ERR_INVALID_INPUT', `no such resource: ${uri}`);
    return {
      contents: [
        { uri, mimeType: 'application/json', text: JSON.stringify(await scheduleStatusReportOrToolError(), null, 2) },
      ],
    };
  } catch (err) {
    return throwStructuredResourceError(err);
  }
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
  // #558: same wrapping as ReadResourceRequestSchema above — a bad prompt name, or
  // restoreRunbook() failing to find its own text, must not fall through to the SDK's
  // generic unclassified -32603.
  try {
    if (name !== RESTORE_PROMPT) throw new ToolError('ERR_INVALID_INPUT', `no such prompt: ${name}`);
    return {
      description: 'cypher-brain restore runbook (from MANAGEMENT.md)',
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: restoreRunbook() } }],
    };
  } catch (err) {
    return throwStructuredResourceError(err);
  }
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
    return await withSpan(
      name,
      async (): Promise<CallToolResult> => {
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
        if (!tool) {
          // #728: the same "did you mean" idiom assertDeclaredArgs (unknown argument
          // names) and assertDeclaredEnums (out-of-enum values) already use for a
          // near-miss — TOOLS_BY_NAME's own keys are exactly the candidate set a tool
          // name is checked against, so wiring it in here needs no new list to drift.
          const near = nearestName(name, TOOLS_BY_NAME.keys());
          return structuredErr(
            new ToolError('ERR_INVALID_INPUT', `Unknown tool: ${name}${near ? ` (${didYouMean(near)})` : ''}`),
          );
        }
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
            return structuredErr(
              new ToolError('ERR_INTERNAL', `${name} is advertised in tools/list but not dispatched`),
            );
        }
      },
      { isError: (r) => r.isError === true, onFlushWarning: attachLateFlushWarning },
    );
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
  // #715: same posture as the two guards above — a non-integer CYPHER_BRAIN_MAX_SPEND/
  // CYPHER_BRAIN_TON_PROVIDER_MAX_SPEND used to throw a raw SyntaxError straight out of
  // config.ts's module body, before this server ever got a chance to start (or fail
  // cleanly). config.ts now records the failure instead of throwing it.
  if (AR_MAX_SPEND_ERROR) throw AR_MAX_SPEND_ERROR;
  if (TON_PROVIDER_MAX_SPEND_ERROR) throw TON_PROVIDER_MAX_SPEND_ERROR;
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
