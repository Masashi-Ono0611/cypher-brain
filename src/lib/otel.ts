// OTel-lite opt-in (#226 part 3): each CLI command / MCP tool call becomes a span,
// active ONLY when OTEL_EXPORTER_OTLP_ENDPOINT is set. Reads it via plain process.env,
// bypassing readEnv()/ENV_NAMES on purpose — it is a THIRD-PARTY standard env var, not
// a CYPHER_BRAIN_* name, the same situation schedule.ts's own direct
// process.env.TMPDIR read (schedule.ts) is already in.
//
// Zero-cost passthrough when unset: withSpan() returns fn() directly, by construction
// — no OTel-related import is even attempted, let alone a TracerProvider constructed,
// so a machine that has never heard of OTel pays nothing for this feature existing.
//
// When set: a NodeTracerProvider + BatchSpanProcessor(OTLPTraceExporter) is lazily
// constructed and registered ONCE per process (memoized — an MCP server handles many
// tool calls over one long-lived process; re-registering a provider per call would
// leak exporters). Packages are dynamically imported, never at module top level,
// matching backends/turbo.ts's/arweave.ts's own "only import the optional SDK when
// this code path is actually reached" convention. Missing/broken packages: warn ONCE
// (sdkImportAdvice()'s existing absent/broken classification) and fall back to a
// passthrough — OTel is pure observability, it must never gate a real push/restore/
// verify the way a missing SDK gates an actual paid upload elsewhere in this codebase.
//
// forceFlush() after every span (bounded, see FLUSH_TIMEOUT_MS below) is NOT optional
// polish — without it this feature silently does nothing for the CLI. Measured: the
// CLI is a one-shot process, BatchSpanProcessor's own export timer is `.unref()`d (by
// design — it must never be the thing keeping a CLI process alive), and its default
// scheduledDelayMillis (5000ms) is far longer than a typical command's own runtime. A
// probe run (`cypher-brain doctor` against a local OTLP receiver, #226 part 3 review)
// confirmed the exporter never fired at all: the process exits, the unref'd timer is
// dropped with it, and the span is silently discarded — the whole feature was a no-op
// while STILL paying every import/construction cost. The MCP server (long-lived, one
// process handles many tool calls) would eventually flush on its own timer, but a
// crash/SIGTERM between calls loses whatever is still queued either way — flushing
// per-span makes both entry points behave the same, at the cost of one exporter round
// trip per command/call. Bounded to FLUSH_TIMEOUT_MS rather than the exporter's own
// defaults (OTLPTraceExporter's own request timeoutMillis defaults to 10000ms;
// BatchSpanProcessor's exportTimeoutMillis defaults to 30000ms): an unreachable/slow
// collector must cost this run a few seconds at most, never a default measured in the
// tens of seconds — tracing observes, it does not gate.
//
// The bound MUST be applied to the SDK's own timeoutMillis/exportTimeoutMillis
// options, not layered on from outside via e.g. `Promise.race`ing forceFlush()
// against our own timer: measured (a two-process probe: a receiver that accepts the
// connection but never responds, `cypher-brain doctor` pointed at it) — an outside
// race lets withSpan() ITSELF return early, but the SDK's real internal timer/socket
// backing the abandoned forceFlush() call is untouched by that race and keeps running
// regardless, and a Node process does not exit while it still holds a referenced
// (non-`.unref()`d) handle — so the CLI process kept running for the SDK's own
// ~10s default (OTLPTraceExporter's default request timeout) despite our function
// having "moved on" after FLUSH_TIMEOUT_MS. Passing FLUSH_TIMEOUT_MS as BOTH options
// below makes the SDK's own timers the ones that fire early, which is what actually
// releases the process — confirmed with the same two-process probe.
//
// That bound was already enough to keep an unreachable/slow collector from ever
// GATING a command (#474) — the timeoutMillis above already caps the retryable-network-
// error backoff (ECONNREFUSED/ETIMEDOUT/etc. are retried with jittered backoff by the
// exporter's own transport) to ~FLUSH_TIMEOUT_MS. What it did NOT do was tell anyone
// that happened: a misconfigured collector made every command ~20x slower with byte-
// identical stdout/stderr to a healthy run — a real dogfooding session had no way to
// tell "tracing silently failed" from "this machine is just slow today". boundedFlush()
// below now reports whether the flush actually completed, ONCE per process (the same
// once-per-process shape the packages-not-available case already uses) — still never
// gating: the command's own result is untouched either way.
//
// #653: boundedFlush() itself does NOT call warn() any more — it used to, but warn()'s
// `recorded` buffer (warn.ts) is drained per CALL (mcp.ts's captureCall()), and this
// flush only ever runs AFTER the handler that owns THIS span has already built its
// CallToolResult (withSpan() wraps the whole handler, span.end()+flush happen in ITS
// finally, once fn() — the handler — has already returned). In the CLI (one command per
// process) that lag is invisible: the SAME run's end-of-run summary drains it moments
// later either way. In the long-lived MCP server, the NEXT tool call's captureCall()
// drains the buffer FIRST and reports the PREVIOUS call's flush failure as its own —
// warning ownership becomes nondeterministic whenever OTel tracing is enabled. Instead
// boundedFlush() returns the message (or null) to withSpan(), which attaches it to
// THIS call's own result (mcp.ts's `onFlushWarning`) or, for a caller that gave it no
// such hook (cli.ts), falls back to the original warn() behavior — see withSpan() below.
import { warn } from './warn.js';
import { sdkImportAdvice, errMsg } from './util.js';

type OtelApi = typeof import('@opentelemetry/api');
type OtelProvider = import('@opentelemetry/sdk-trace-node').NodeTracerProvider;

interface TracerHandle {
  api: OtelApi;
  tracer: import('@opentelemetry/api').Tracer;
  provider: OtelProvider;
}

const FLUSH_TIMEOUT_MS = 3000;

// Races `provider.forceFlush()` against a timer so a slow/unreachable collector delays
// this run by at most FLUSH_TIMEOUT_MS — never by the exporter's own longer internal
// timeout. Never THROWS either way (a flush failure is exactly as inconsequential to
// the caller as tracing being off entirely). `flushed` distinguishes "forceFlush()
// resolved" from "the outer race's own timer won" (belt-and-suspenders over the SDK's
// own bound, see the header comment above) — either way, not settling successfully
// means this run's span(s) may not have reached the collector.
//
// Returns the warning message (once per process, #474) instead of calling warn()
// itself (#653) — see the header comment above for why: the CALLER is the only one
// that knows whether it has somewhere per-call to attach this to, or whether the
// shared warn()/recorded buffer is the right (and, for the CLI, correct) fallback.
async function boundedFlush(provider: OtelProvider): Promise<string | null> {
  let flushed = false;
  await Promise.race([
    provider
      .forceFlush()
      .then(() => {
        flushed = true;
      })
      .catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref()),
  ]);
  if (flushed || flushWarnedOnce) return null;
  flushWarnedOnce = true;
  return (
    `OTEL_EXPORTER_OTLP_ENDPOINT is set but exporting a span did not complete within ` +
    `${FLUSH_TIMEOUT_MS}ms (the collector may be unreachable, slow, or refusing the request) — ` +
    `tracing may be incomplete for this run, everything else proceeds normally`
  );
}

let providerPromise: Promise<TracerHandle | null> | null = null;
let warnedOnce = false;
let flushWarnedOnce = false;

async function getTracer(): Promise<TracerHandle | null> {
  // Gate ONLY — never passed to the exporter as its `url` (see the header comment on
  // the exporter constructor below for why).
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  if (providerPromise) return providerPromise;
  providerPromise = (async (): Promise<TracerHandle | null> => {
    // Tracks which of the imports below is currently in flight, so the catch block can
    // attribute a resolution failure to the package that ACTUALLY failed (#473), not a
    // hardcoded one. sdkImportAdvice()'s absent/broken classification hinges on
    // comparing the failing specifier against the `pkg` name it is given — a hardcoded
    // name only matched by coincidence (when that exact package happened to be the one
    // missing), and otherwise always fell into the "broken install" branch even for the
    // simplest "opted in, never ran npm install" case. Kept as a plain reassigned
    // variable rather than making the specifiers themselves dynamic (`import(pkg)`):
    // every other lazy import in this codebase (arweave.ts/wallet.ts/ton-dns.ts/etc.)
    // uses a literal string specifier, which is what scripts/build.ts's externals
    // derivation (reads package.json, matches import specifiers) is written against —
    // a dynamic specifier here would be an unproven deviation from that pattern for a
    // purely cosmetic gain.
    let pkg = '@opentelemetry/api';
    try {
      const api = await import('@opentelemetry/api');
      pkg = '@opentelemetry/sdk-trace-node';
      const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
      pkg = '@opentelemetry/sdk-trace-base';
      const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
      pkg = '@opentelemetry/exporter-trace-otlp-http';
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      pkg = '@opentelemetry/resources';
      const { resourceFromAttributes, detectResources, envDetector } = await import('@opentelemetry/resources');
      // #476: without an explicit `resource`, NodeTracerProvider falls back to
      // defaultResource() (`@opentelemetry/resources`), whose service.name is derived
      // from the running binary (measured: 'unknown_service:bun' under this project's
      // own `bun run` dev path) — useless for telling this tool's spans apart from any
      // other project's in a shared collector, and NOT what OTEL_SERVICE_NAME being set
      // would lead an operator to expect (the env var was silently not honored at all).
      // `envDetector` is the SDK's own OTEL_SERVICE_NAME/OTEL_RESOURCE_ATTRIBUTES reader
      // (genuine detection, not a hand-rolled process.env read) — merged so ITS
      // attributes win over the 'cypher-brain' default (Resource#merge: the argument's
      // attributes take precedence, see ResourceImpl.merge), i.e. OTEL_SERVICE_NAME
      // overrides the default when set, and the default otherwise applies.
      const resource = resourceFromAttributes({ 'service.name': 'cypher-brain' }).merge(
        detectResources({ detectors: [envDetector] }),
      );
      // No `url` option here — deliberately. Per the OTel spec, OTEL_EXPORTER_OTLP_ENDPOINT
      // is a BASE endpoint, and the SDK itself is responsible for appending the per-signal
      // path ('v1/traces' for this exporter) when resolving it. Passing `url` explicitly
      // bypasses that resolution entirely (verified against this checkout's installed
      // otlp-exporter-base: an explicit `url` wins outright over its own env-derived
      // fallback config in mergeOtlpHttpConfigurationWithDefaults, so the signal path is
      // never appended) — a value like 'http://collector:4318' (a valid, spec-conformant
      // base endpoint with no path) would have posted to the WRONG path with `url` set
      // explicitly. Passing nothing lets the exporter's own env resolution do this
      // correctly, using the exact same OTEL_EXPORTER_OTLP_ENDPOINT this gate already read.
      const provider = new NodeTracerProvider({
        resource,
        spanProcessors: [
          new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: FLUSH_TIMEOUT_MS }), {
            exportTimeoutMillis: FLUSH_TIMEOUT_MS,
          }),
        ],
      });
      provider.register();
      // provider.getTracer(), NOT api.trace.getTracer() (Codex review, #226 part 3):
      // register() sets the GLOBAL provider only if none is already registered — a
      // process that preloaded its own OTel auto-instrumentation (e.g. via
      // NODE_OPTIONS --require) could already have one, in which case
      // api.trace.getTracer() would silently hand back a tracer backed by THAT
      // provider while boundedFlush() below keeps flushing the (now orphaned, unused)
      // one just constructed here — spans would be created but never exported, and
      // never warned about either. Getting the tracer directly off the provider
      // instance this function just built makes the flushed provider and the one
      // actually producing spans always the same object, regardless of what else may
      // already be registered globally.
      return { api, tracer: provider.getTracer('cypher-brain'), provider };
    } catch (e) {
      // sdkImportAdvice() only classifies import-resolution failures (absent/broken
      // package) — for anything else (e.g. NodeTracerProvider/OTLPTraceExporter
      // construction throwing on a malformed OTEL_EXPORTER_OTLP_ENDPOINT value) it
      // returns null, and `problem` stays undefined. Framing that case as "packages
      // are not available" would be actively misleading (Codex review, #226 part 3) —
      // the packages loaded fine; something else about this run's config didn't.
      // `pkg` (not a hardcoded package name, #473) names whichever import above was
      // actually in flight when `e` was thrown.
      const problem = sdkImportAdvice(e, pkg);
      if (!warnedOnce) {
        warnedOnce = true;
        warn(
          problem
            ? `OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry packages are not available ` +
                `(${problem.advice}) — tracing disabled for this run, everything else proceeds normally`
            : `OTEL_EXPORTER_OTLP_ENDPOINT is set but tracing failed to initialize (${errMsg(e)}) — ` +
                `tracing disabled for this run, everything else proceeds normally`,
        );
      }
      return null;
    }
  })();
  return providerPromise;
}

// Wraps `fn()` in a span named `name` when OTel is active; otherwise a pure
// passthrough. Transparent either way: `fn()`'s return value/thrown error propagates
// unchanged — this function only OBSERVES, it never alters what the caller sees.
//
// `opts.isError` is for callers whose success/failure is a normal RETURN value rather
// than a thrown exception — mcp.ts's tool handlers never throw on a refused call, they
// return a CallToolResult with `isError: true` (structuredErr()). Without this, every
// such refusal would record span status OK (Codex review, #226 part 3) — a rejected
// unknown-tool or invalid-arg call reading as a successful one, working against #226's
// own "what actually happened" motivation. cli.ts's commands (which DO throw) simply
// omit `opts` and get the exception-only behavior unchanged.
//
// `opts.onFlushWarning` (#653) is how a caller with somewhere per-call to put a LATE
// OTel flush warning (boundedFlush() resolving only after `fn()` has already built its
// own result — see otel.ts's header comment) opts into that instead of the shared
// warn()/recorded buffer a differently-timed, unrelated call could otherwise drain
// first. Given the message and this call's own already-built `result`, it returns the
// (possibly modified) result to use in `result`'s place — mcp.ts uses this to splice
// the warning into `result`'s OWN structured `warnings` field. cli.ts omits it (a
// single-command process has nowhere more specific to attach it than the run-level
// buffer it already drains at exit) and keeps exactly today's warn() behavior.
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { isError?: (result: T) => boolean; onFlushWarning?: (message: string, result: T) => T },
): Promise<T> {
  const handle = await getTracer();
  if (!handle) return fn();
  const { api, tracer, provider } = handle;
  return tracer.startActiveSpan(name, async (span) => {
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: errMsg(e) });
      span.end();
      const flushWarning = await boundedFlush(provider);
      if (flushWarning) {
        // This call is about to throw — attach the late flush warning directly to the
        // error object (the SAME `cbWarnings` convention mcp.ts's captureCall()/
        // reclassify() already use to ride a warning onto a thrown error) rather than
        // the shared buffer, UNLESS this caller has no such convention (cli.ts), in
        // which case warn() is still the right (and correct — see header comment)
        // fallback: a single CLI command drains that same buffer for its own summary
        // moments later either way.
        if (opts?.onFlushWarning && e instanceof Error) {
          (e as Error & { cbWarnings?: string[] }).cbWarnings = [
            ...((e as Error & { cbWarnings?: string[] }).cbWarnings ?? []),
            flushWarning,
          ];
        } else {
          warn(flushWarning);
        }
      }
      throw e;
    }
    span.setStatus(
      opts?.isError?.(result)
        ? { code: api.SpanStatusCode.ERROR, message: 'the call completed but returned a logical error result' }
        : { code: api.SpanStatusCode.OK },
    );
    span.end();
    const flushWarning = await boundedFlush(provider);
    if (!flushWarning) return result;
    if (opts?.onFlushWarning) return opts.onFlushWarning(flushWarning, result);
    warn(flushWarning);
    return result;
  });
}
