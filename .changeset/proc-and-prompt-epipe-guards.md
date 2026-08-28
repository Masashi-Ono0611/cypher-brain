---
'cypher-brain': patch
---

Two latent EPIPE crash hazards, both found by dogfooding `src/lib`'s process/UI
primitives directly (#602, #603).

`src/lib/proc.ts`'s shared `run()` helper wrote to a piped child's `stdin` with no
`error` listener attached first. Node re-raises a stdin write failure asynchronously
as an uncaught `'error'` event, not a rejected promise, so a large input piped to a
fast-exiting child crashed the whole process instead of surfacing as a normal
rejection — a hazard `src/lib/crypt.ts`'s own `decryptToChild()` had already guarded
against with the identical `cons.stdin?.on('error', () => {})` pattern; `run()` now
does the same before writing.

`src/lib/crypt.ts`'s `promptHidden()` (every passphrase prompt during `keygen
--passphrase` / `restore` / `snapshot`) and `src/lib/progress.ts`'s default progress
sink (`console.error`, used by every push/pull/tar pipeline) wrote directly to
`process.stderr` without first calling `src/lib/ui.ts`'s `installEpipeGuard()` — the
guard `warn.ts`/`wisdom.ts` already install before their own raw writes. Piping
`restore`'s or `snapshot`'s output into something that closes early (`| head`, a
wrapper that stops reading) could crash the operation mid-way with an uncaught
exception instead of exiting cleanly. Both call sites now install the guard before
their first write.
