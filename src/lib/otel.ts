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
// timeout. Never throws either way (a flush failure is exactly as inconsequential to
// the caller as tracing being off entirely).
async function boundedFlush(provider: OtelProvider): Promise<void> {
  await Promise.race([
    provider.forceFlush().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, FLUSH_TIMEOUT_MS).unref()),
  ]);
}

let providerPromise: Promise<TracerHandle | null> | null = null;
let warnedOnce = false;

async function getTracer(): Promise<TracerHandle | null> {
  // Gate ONLY — never passed to the exporter as its `url` (see the header comment on
  // the exporter constructor below for why).
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return null;
  if (providerPromise) return providerPromise;
  providerPromise = (async (): Promise<TracerHandle | null> => {
    try {
      const api = await import('@opentelemetry/api');
      const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
      const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
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
        spanProcessors: [
          new BatchSpanProcessor(new OTLPTraceExporter({ timeoutMillis: FLUSH_TIMEOUT_MS }), {
            exportTimeoutMillis: FLUSH_TIMEOUT_MS,
          }),
        ],
      });
      provider.register();
      return { api, tracer: api.trace.getTracer('cypher-brain'), provider };
    } catch (e) {
      const problem = sdkImportAdvice(e, '@opentelemetry/sdk-trace-node');
      if (!warnedOnce) {
        warnedOnce = true;
        warn(
          `OTEL_EXPORTER_OTLP_ENDPOINT is set but the OpenTelemetry packages are not available ` +
            `(${problem?.advice ?? errMsg(e)}) — tracing disabled for this run, everything else proceeds normally`,
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
export async function withSpan<T>(
  name: string,
  fn: () => Promise<T>,
  opts?: { isError?: (result: T) => boolean },
): Promise<T> {
  const handle = await getTracer();
  if (!handle) return fn();
  const { api, tracer, provider } = handle;
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const result = await fn();
      span.setStatus(
        opts?.isError?.(result)
          ? { code: api.SpanStatusCode.ERROR, message: 'the call completed but returned a logical error result' }
          : { code: api.SpanStatusCode.OK },
      );
      return result;
    } catch (e) {
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: errMsg(e) });
      throw e;
    } finally {
      span.end();
      await boundedFlush(provider);
    }
  });
}
