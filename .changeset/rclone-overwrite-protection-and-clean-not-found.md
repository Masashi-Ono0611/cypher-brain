---
'cypher-brain': patch
---

Two rclone backend fixes found during a dogfooding pass, both in `src/lib/backends/rclone.ts`:

- **#533** — `push --backend rclone --remote <name>:<path>` now refuses to upload when an
  object already exists at that exact `--remote` path, matching every other output-writing
  command's refuse-by-default posture (`pull --out`, `restore --out-dir`, `keygen`,
  `wallet create`, `estimate --out`). Previously a second push to a reused `--remote` path
  silently replaced the earlier snapshot with no warning — `rclone` destinations are
  operator-named, not content-addressed (`NON_CONTENT_ADDRESSED_BACKENDS`,
  `src/lib/config.ts`), unlike `file`'s `<sha256>.age` locator, where a same-path
  "overwrite" is always byte-identical. `--force` opts in to overwriting anyway —
  deliberately the SAME flag `push`'s own `--skip-unchanged` digest override already uses,
  not a second flag, since both mean "push despite this safety net." Reuses the existing
  `already exists — refusing to overwrite` wording, so it shares CB-E009 with the other
  no-clobber checks.
- **#539** — `pull`'s error for a nonexistent `--remote`/locator object is now a clean
  `no object at <locator>` message (a new CB-E018) instead of rclone's own raw, 3x-repeated
  retry-loop stderr, which also mislabeled a missing FILE as a missing "directory" (an
  artifact of rclone's own generic single-object path resolution).
