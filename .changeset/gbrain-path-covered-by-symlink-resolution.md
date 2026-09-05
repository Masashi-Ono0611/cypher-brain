---
"cypher-brain": patch
---

Fix a symlink-coverage gap in `src/lib/gbrain.ts`'s `pathCoveredBy()`, left
unimplemented as a design-decision finding in #858.

Coverage used to be computed with node:path's `resolve()` alone — purely
lexical, never touching the filesystem — so a symlink anywhere in the
store path was left exactly as written. A PGLite `database_path` that is
itself a symlink pointing outside every covered `--dir` was reported
"covered" merely because the symlink file happened to sit inside one
lexically, even though archiving that directory only captures the link
itself (`tar` does not dereference) — a backup that looks complete but
silently omits the real data. `storePath` is now resolved through the
real filesystem (following every symlink along its full path, not just
its own final component) before the containment check, closing that false
positive and also fixing the symmetric false negative: a symlink that
sits outside every covered root but points at real data genuinely inside
one is now correctly reported as covered.

A `dirs` entry, by contrast, is deliberately left unresolved at its own
top level: `tar` never dereferences a top-level `--dir` symlink argument
either, so a `dirs` entry that is itself a symlink cannot cover anything
through it no matter where it points (an earlier version of this fix
resolved both sides the same way, which a diff-only Codex re-review
correctly flagged as a new false positive — closed here, with a real
`tar` invocation as a regression test proving why). A storePath that
resolves through a dangling symlink (a link whose target does not exist,
anywhere along its path) is never treated as covered either — a dangling
link cannot lead to real, archivable data. A path that does not exist yet
at all is still handled the same way as before (walked up to the nearest
existing ancestor rather than treated as an error).

`pathCoveredBy()` is now async; its two call sites (`src/mcp.ts`'s
snapshot-policy gate and `src/lib/wizard.ts`'s init coverage message) are
updated to `await` it, and the `mcp.ts` call is wrapped in that gate's
existing `underPolicy()` helper so a resolution failure there fails closed
through the same sanitized denial as every other filesystem check in that
gate, rather than escaping as a raw, unsanitized error.
