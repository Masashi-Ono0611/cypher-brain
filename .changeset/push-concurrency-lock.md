---
'cypher-brain': patch
---

Two pushes that overlap no longer step on each other (#806, #807). Both bugs had the
same shape — check the destination, act on what was read, write the result, with nothing
serializing the three steps across processes — and both are realistic whenever a
`schedule`d run overlaps a manual one or an MCP agent call.

- `push --skip-unchanged` with a shared `--save-locator`: two runs could each read
  "nothing recorded yet", each **pay** for the same content, and the second could then
  overwrite the first's line — so one of the two paid-for locators was recorded nowhere.
- `push --backend rclone`: two runs to the same absent `--remote` could each see nothing
  there and each `copyto`, leaving whichever finished last. An rclone `--remote` is not
  content-addressed, so that silently destroyed a distinct snapshot — exactly what the
  `--force` gate exists to prevent.

A push now takes a same-machine advisory lock for the whole sequence, keyed by the
resolved `--save-locator` path (taken for **every** `--save-locator` push, not only
`--skip-unchanged` ones) and by the rclone `--remote`. A second push waits a few seconds
and then behaves as if it had simply run later: with `--skip-unchanged` it sees the
first one's pointer and prints the usual `SKIPPED`, and against an occupied rclone
remote it gets the usual "already exists — refusing to overwrite it". Only a push whose
predecessor is still running when that wait expires is refused, with the new **CB-E028**
code, instead of paying or overwriting.

A lock left behind by a crashed or killed push does not wedge anything: the next run
detects that its process is no longer running, says so, clears it and proceeds, so an
unattended nightly `schedule` recovers on its own — and a lock more than a day old is
cleared even then, so a pid since reused by some other program cannot wedge backups
permanently either.

The lock is same-machine only, and covers pushes sharing one `CYPHER_BRAIN_HOME`; two
different machines writing one cloud remote are still unserialized (`rclone copyto
--immutable` was measured and does not provide the atomic create that would close that).
