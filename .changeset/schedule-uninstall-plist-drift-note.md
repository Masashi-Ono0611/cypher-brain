---
'cypher-brain': patch
---

`schedule uninstall` now reports it explicitly when the launchd plist it expected to
remove is already gone (#529). The removal was a bare `if (exists) { rm; report }` with
no `else` — when the plist had drifted out from under the bookkeeping (deleted
manually, or by another tool) while schedule.json still recorded it as installed right
there, the `removed: launchd plist <path>` line simply vanished from the output with
nothing calling attention to it, exit 0, indistinguishable-looking from an ordinary
clean uninstall except for one silently-missing line. `uninstall` now raises a ⚠
warning — `launchd plist <path> was already missing on uninstall (removed manually, or
drift from a prior uninstall?)` — through the same warn() chokepoint (#347) every other
must-reach-a-human runtime warning goes through, so it prints inline AND is repeated in
the end-of-run summary an agent is asked to relay verbatim. That lets a human or an
automated doctor/monitoring flow tell "cleanly tore down a live trigger" apart from "the
trigger's registration artifact vanished out-of-band and nobody knows why". The exit
code and end state (no plist, no bookkeeping) are unchanged — this only makes the drift
visible. A plist found at a DIFFERENT recorded path (CYPHER_BRAIN_LAUNCHD_DIR changed
since install, or a pre-#114 legacy scheme) is unaffected: that was already reported as
a "legacy launchd plist" removal and still is — only a plist missing from EXACTLY where
this home's own bookkeeping says it was installed counts as drift. `schedule uninstall`
has no `--json` output today (only `schedule status` does), so there is no existing
JSON shape to add a matching field to.
