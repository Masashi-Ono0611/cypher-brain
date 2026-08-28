---
'cypher-brain': patch
---

Documents the companion-flag-required rejections `snapshot`/`schedule install` already
enforce (#525/#526/#535) but never explained in `--help` or `MANAGEMENT.md` (#576/#577/#578).
`--help` for both commands now states that `--vault`/`--zip`/`--export` are refused unless
`--profile` matches (obsidian/chatgpt-export/o2b respectively), and that
`--pg-table`/`--pg-filter`/`--pg-exclude-table-data` are refused unless `--pg <conn>` is
also given. `MANAGEMENT.md`'s "Minimal recovery profile" section now says the same about
passing `--pg-filter`/`--pg-exclude-table-data` without `--pg`. No behavior change — the
error messages already existed; only the docs were missing.
