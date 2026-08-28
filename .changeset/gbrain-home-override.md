---
'cypher-brain': patch
---

`init`'s gbrain-detection prompt and `doctor`'s `gbrain-engine-detection` check now
honor `GBRAIN_HOME`, found in review of #534/#540/#541/#542/#543. Both had
independently hard-coded gbrain's config path as `join(homedir(), '.gbrain',
'config.json')` — the default gbrain itself falls back to, but not what it actually
uses once `GBRAIN_HOME` is set. A machine that had relocated its gbrain home got a
false "not set up" from both: `init` silently skipped its whole gbrain-detection
prompt, and `doctor` reported `gbrain-engine-detection` as `skip` — a fully configured
gbrain read back as absent.

A new `resolveGbrainConfigPath()` (gbrain.ts) is the single place this resolution now
lives, mirroring gbrain's own `configDir()`: `GBRAIN_HOME` is a parent directory gbrain
appends `.gbrain` to itself, so `GBRAIN_HOME=/srv/x` means the config lives at
`/srv/x/.gbrain/config.json`. Unlike gbrain, an invalid override (relative, or
containing a `..` segment) does not throw — it falls back to `~/.gbrain`, since gbrain
itself would refuse to start against that same value, so a read-only check crashing
over another tool's malformed env var would be worse than a fallback.

That fallback is flagged, not silent (multi-model review): an invalid `GBRAIN_HOME`
now makes `init` print a notice naming the bad value, and `doctor`'s
`gbrain-engine-detection` WARN by name instead of PASSing on whatever it happens to
find at `~/.gbrain` — a stale config left over from before `GBRAIN_HOME` was ever set
would otherwise be reported as a genuine, working setup even though gbrain itself will
never touch it once it refuses to start.
