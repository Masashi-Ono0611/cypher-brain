---
"cypher-brain": minor
---

Part 3 of #226 (structured JSONL logging + hash-chain audit trail + OTel-lite
opt-in — part 2 shipped as the hash-chain audit trail in #419): every CLI
command and MCP tool call now becomes an OpenTelemetry span when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set — the same "off by default, on only when
an OTLP endpoint is configured" pattern the Claude Code CLI itself uses, so no
bundled collector is required. Unset (the default): a pure passthrough — no
`@opentelemetry/*` package is even imported, so a machine that has never
heard of OTel pays nothing for this feature existing. `@opentelemetry/api`,
`sdk-trace-node`, `sdk-trace-base` and `exporter-trace-otlp-http` are new
`optionalDependencies` — like `@ardrive/turbo-sdk`, a normal registry or
from-source install already carries them, resolving their transitive tree;
only an install run with `--omit=optional` skips them, in which case the
same lazy-import + absent/broken install-advice pattern `@ardrive/turbo-sdk`
already uses (`sdkImportAdvice()`, reused as-is) WARNS once on stderr and
falls back to a no-op — tracing must never gate a real push/restore/verify
the way a missing SDK gates an actual paid upload elsewhere.

Every span is force-flushed before the wrapping command/call returns, bounded
to a short fixed timeout rather than the SDK's own longer defaults
(`OTLPTraceExporter`'s request timeout defaults to 10s; `BatchSpanProcessor`'s
export timeout defaults to 30s). This was not optional polish: a probe run
during review found the CLI — a one-shot process — exiting before
`BatchSpanProcessor`'s own scheduled export timer (5s, deliberately
`.unref()`d so it never itself keeps a CLI process alive) ever fired, so
every span was silently dropped while the feature still paid its full
import/construction cost. A second probe found that bounding the flush with
an *external* `Promise.race` did not actually bound the CLI's wall time
either — the SDK's own internal timers are not cancelled by losing a race
external to them, and Node does not exit while it still holds one of their
referenced handles. The fix passes the same short bound into the SDK's own
`timeoutMillis`/`exportTimeoutMillis` options instead, so it is the SDK's own
timer that fires early. New `selftest:otel` suite step (now part of
`verify:suite`) is a regression test for both failure modes, driving two real
child processes against a real local OTLP/HTTP receiver rather than asserting
against mocks.

`OTEL_EXPORTER_OTLP_ENDPOINT` is documented in `--help`/README as its own
`Tracing:` section — deliberately NOT under `CYPHER_BRAIN_*`/`CIPHER_BRAIN_*`
naming (it is a third-party standard env var, so it is not read under the
`CIPHER_BRAIN_*` pre-rename spelling and has no `config.env` entry, unlike
every other setting in that reference).

## Second commit (Codex review response)

A bounded `codex exec` (high effort, given the timer/process-lifecycle
subtlety above) review flagged four Warnings, all addressed:

- Passing `OTEL_EXPORTER_OTLP_ENDPOINT` directly as the exporter's `url`
  option bypasses the SDK's own env-based URL resolution — which is what
  appends the `/v1/traces` signal path per the OTel spec. A spec-conformant
  base value like `http://collector:4318` (no path) would have posted to the
  wrong path. Fixed by not passing `url` at all, letting the exporter resolve
  it from the same env var itself (confirmed against this checkout's
  installed SDK: an explicit `url` option unconditionally wins over its own
  env-derived fallback, so the path was never appended before this fix).
- Spans only began after CLI arg parsing / MCP arg validation, so a rejected
  invalid-flag or invalid-tool-call invocation produced no span at all —
  undercutting the "every command/call" claim and the audit-trail-adjacent
  motivation of seeing failures too. Fixed by moving the `withSpan()` wrap in
  both `cli.ts` and `mcp.ts` to cover validation, not just successful
  dispatch (the command/tool name is known before validation can throw, so
  the span name doesn't depend on it succeeding).
- `selftest:otel`'s check 1 (default-off) merged `{...process.env, ...env}`,
  so it would silently inherit an ambient `OTEL_EXPORTER_OTLP_ENDPOINT` from
  the runner's own shell/CI environment instead of actually testing the
  unset path. Fixed by dropping that key from the base env before merging.
- README/changeset claimed the new `optionalDependencies` are "not installed
  by default" — wrong; npm/bun install them by default like any dependency,
  they just don't fail the install if unavailable (`--omit=optional` is what
  skips them). Fixed to match this repo's own existing, correct framing for
  `@ardrive/turbo-sdk`.

The URL fix also updated `selftest:otel` checks 2/3 to set the endpoint as a
BASE URL (no `/v1/traces` suffix) — this is what a real spec-conformant value
looks like, and it is what actually exercises the auto-append path the fix
restored (the original checks set the var WITH the path already appended,
which happened to still work under the old `url:`-forwarding code but would
have masked this exact bug).
