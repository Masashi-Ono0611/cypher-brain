---
"cypher-brain": patch
---

Fixed a process-leak bug in the `scripts/selftest-*.sh` test suite's shared
`with_timeout()` helper: it only killed the direct child process on timeout, so
a timed-out `node scripts/drive-init.mjs` drive could leave its own inner CLI
subprocess running as an orphan (#569). The fix runs the timed command in its
own process group and kills the whole group.

Also de-duplicated three pieces of boilerplate that had drifted into
byte-identical (or near-identical) copies across 21+ selftest scripts into a
new shared `scripts/selftest-lib.sh`: the hardened `with_timeout()`/
`with_stdin_timeout()` helpers (#569), the `cb()`/`sha()` CLI-invocation and
checksum helpers (#572), and the mock TON seeder + PATH-shim setup used by
`selftest-ton.sh`/`selftest-ton-dns.sh` (#570). This is test-infrastructure-only;
no runtime behavior of the `cypher-brain` CLI changes.
