---
"cypher-brain": patch
---

Four fixes to the OTel-lite opt-in (`src/lib/otel.ts`, #226 part 3), all found via a
dogfooding pass on 2026-08-28:

- **#473**: `getTracer()`'s error handler always attributed an import-resolution
  failure to a hardcoded `@opentelemetry/sdk-trace-node`, regardless of which of the
  five dynamic imports actually threw. In the simplest case — none of the OTel
  packages installed at all — the FIRST import to fail is `@opentelemetry/api`, so the
  advisory falsely claimed `sdk-trace-node` was already installed and sent an operator
  down the wrong (isolated-directory) remediation path instead of the simple
  `npm install @opentelemetry/api`. Fixed by tracking which package is actually in
  flight and passing that to `sdkImportAdvice()`.
- **#474**: an unreachable/misconfigured OTLP collector made every command ~20x slower
  (measured: 2.87s vs 0.11–0.27s) with byte-identical stdout/stderr to a healthy run —
  the existing bounded flush (`FLUSH_TIMEOUT_MS`, already ~3s) correctly kept this from
  gating the command, but gave no diagnostic, so the added latency was unexplained.
  `boundedFlush()` now tracks whether the flush actually completed and warns once on
  stderr when it did not, without changing the never-gates-the-command behavior.
- **#476**: every span's `resource.service.name` reported as `unknown_service:bun`
  (or `unknown_service:node`), even with `OTEL_SERVICE_NAME` set — `otel.ts` built its
  `NodeTracerProvider` with no `resource` at all, so `OTEL_SERVICE_NAME`/
  `OTEL_RESOURCE_ATTRIBUTES` were silently never read. Now wires a default
  `service.name: 'cypher-brain'`, merged with the SDK's own standard env-based
  resource detection (`@opentelemetry/resources`' `envDetector`) so `OTEL_SERVICE_NAME`
  overrides it when set — new `optionalDependency` `@opentelemetry/resources` (already
  an existing transitive dependency of `sdk-trace-base`, now also declared directly so
  `scripts/build.ts`'s externals derivation keeps it out of the shipped bundle).
- **#475**: documented a one-line local verification recipe for both `README.md`'s
  `Tracing:` section and `--help`'s (kept in sync via
  `node scripts/check-help-docs.mjs --write`) — `nc -l 4318` in one terminal,
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 cypher-brain doctor` in another,
  watch for the raw `POST /v1/traces` request landing. No code change needed.

`scripts/selftest-otel.mjs` gained two new checks (2b: `OTEL_SERVICE_NAME` override;
3b: connection-refused, the #474 issue's exact repro, distinct from the existing
accept-but-never-respond check 3) and extended checks 2/3/4 to assert the resource
`service.name`, the new stderr diagnostic, and the corrected package-name attribution
respectively — all against real child processes and a real local OTLP/JSON receiver,
not mocks. Each new/changed assertion was verified to genuinely fail against the
pre-fix code (a temporary revert) before confirming it passes against the fix.
