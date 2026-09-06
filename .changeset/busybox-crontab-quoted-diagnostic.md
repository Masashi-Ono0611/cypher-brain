---
'cypher-brain': patch
---

Fix `schedule install`/`schedule status` misclassifying a first-time BusyBox crontab
install as a real error (regression from #875). `crontabText()`'s "no crontab yet"
detection was extended in #875 to recognize vixie-cron/cronie/bsd-cron's message
shapes, but BusyBox's actual `crontab -l` diagnostic wraps the missing filename in
single quotes and prefixes it with "can't open" (`crontab: can't open 'root': No such
file or directory` — see BusyBox's `libbb/xfuncs_printf.c` open helper). The existing
bare-trailing-segment parse extracted `can't open 'root'` instead of the bare username
and never matched, so a first-time `cypher-brain schedule install` on BusyBox (common
on Alpine-based containers) failed closed instead of installing, and `schedule status`
reported `unknown` instead of `no`. `looksLikeNoCrontabYet()` now recognizes BusyBox's
quoted diagnostic as an additional pattern, matched with the same exact-username
discipline as the existing patterns.
