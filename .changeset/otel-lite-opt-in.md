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
`optionalDependencies`, following the same lazy-import + absent/broken
install-advice pattern `@ardrive/turbo-sdk` already uses (`sdkImportAdvice()`,
reused as-is) — a missing or broken install WARNS once on stderr and falls
back to a no-op, since tracing must never gate a real push/restore/verify.

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
