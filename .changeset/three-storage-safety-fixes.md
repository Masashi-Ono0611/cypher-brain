---
'cypher-brain': patch
---

Three storage-backend safety/UX fixes:

- `arweave` pull: a malicious/compromised gateway could keep resetting the per-chunk
  stall timeout by trickling bytes forever, growing the pulled `.part` file until local
  disk was exhausted — a per-gateway attempt is now also bounded by a total-duration cap
  (`CYPHER_BRAIN_PIPE_TIMEOUT`, the same overall-operation budget `ton.ts`'s P2P download
  already uses), independent of the stall timer (#641).
- `file` backend `get()`: the object was hashed, then separately re-read by `copyFile()`
  — a process with `FILE_DIR` write access could swap the object between those two reads
  and have the swapped bytes served as though they'd passed the content-address check.
  `get()` now hashes the bytes WHILE copying them (one streaming pass into a
  same-directory temp file, renamed onto `--out` only if the digest matches), so there is
  no second read of the object for anything to race (#642).
- `push --backend file --remote <name>:<path>` (and every other non-rclone backend) used
  to silently ignore `--remote` — it is now refused up front, mirroring the existing
  `--vault`/`--zip`/`--export`/`--pg-filter` companion-flag validation (#655).
