---
"cypher-brain": patch
---

Fix #637: the CLI arg parser collapsed every non-`--` token into a single
internal `o._` slot, with a LATER token silently overwriting an earlier
one — no error, no trace. This was a real, exploitable-by-typo data-safety
gap, not a cosmetic parsing quirk:

- `snapshot --dir one --dir two /data/three` silently dropped
  `/data/three` and backed up only `one`/`two` — `snapshot` never reads
  `o._` at all, so the stray path vanished with no error and exit 0.
- `snapshot --out x.age --dir one -r age1BACKUP…` silently omitted the
  backup recovery key: `-r` (no short-flag support) and its value both
  fell through as bare tokens and were dropped the same way — a snapshot
  meant to be recoverable by two keys ended up encrypted to only one, with
  no indication.
- `schedule install status` used to dispatch **`status`**, not `install`
  — `schedule`/`wallet` are the only two commands that read `o._` (as
  their own single sub-verb), and the LAST bare token always won, so an
  extra trailing word silently ran the wrong sub-command.

**Behavior change**: every bare (non-`--`) argument is now validated
against what the target command actually consumes. A command that never
reads `o._` (everything except `schedule`/`wallet`) now REFUSES any bare
argument outright, naming it and suggesting the flag it probably belonged
to. `schedule`/`wallet` (which read exactly one sub-verb) now refuse more
than one bare argument instead of silently dispatching the last one. An
unrecognized top-level command word is unaffected — it still gets the
existing "unknown command" reply.

This follows the same "refuse rather than silently ignore" posture #253/
#277 already apply to unrecognized/misdirected `--flags` — a bare
argument that used to be silently dropped now surfaces as a hard error
before any file is written or any backend is spent against.
