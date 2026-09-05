---
"cypher-brain": patch
---

Fix three narrow bugs found in a post-hoc coverage-gap audit (files a prior
full-repo review sweep never actually assigned to any group):

- `src/lib/gbrain.ts`'s `findPgDataDirs()` (used by `snapshot` to warn about
  archiving a live PGLite/Postgres data directory) stopped scanning a
  `--dir` source's immediate subdirectories the moment the source's own
  root merely *looked* like a data directory by entry name — even when
  that root then failed confirmation (wrong entry types). This could hide
  a real store one level down, the exact nested layout this function's own
  documentation says it covers.
- The same file's PGLite/Postgres warning messages embedded a scanned
  `--dir` source's path and file names verbatim. A crafted file/directory
  name containing control characters (newlines, ANSI escapes) could forge
  extra log lines or manipulate a terminal when the warning is printed, or
  when relayed verbatim through MCP's `warnings` array. Control bytes are
  now stripped before these paths reach a warning string.
- `src/lib/backends/ton-client.ts`'s ephemeral local `tonutils-storage`
  daemon startup (a) treated the mere *existence* of a generated
  `config.json` as proof the write had finished, when a SIGKILL sent right
  after could still interrupt an in-progress write and leave a truncated
  file; and (b) treated any HTTP 200 from the ready-probe URL as proof the
  real daemon was listening, when the free-port allocation it uses is
  documented as racy. Both now additionally validate the response/file
  content (a successful JSON parse, and the documented `{bags: [...]}`
  shape) before proceeding.
