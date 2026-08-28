---
'cypher-brain': patch
---

`schedule uninstall` now reports it explicitly when the launchd plist it expected to
remove is already gone (#529). The removal was a bare `if (exists) { rm; report }` with
no `else` — when the plist had drifted out from under the bookkeeping (deleted
manually, or by another tool), the `removed: launchd plist <path>` line simply vanished
from the output with nothing calling attention to it, exit 0, indistinguishable-looking
from an ordinary clean uninstall except for one silently-missing line. `uninstall` now
prints a distinct `note: launchd plist <path> was already missing (removed manually, or
drift from a prior uninstall?)` line in that case, so a human or an automated
doctor/monitoring flow can tell "cleanly tore down a live trigger" apart from "the
trigger's registration artifact vanished out-of-band and nobody knows why". The exit
code and end state (no plist, no bookkeeping) are unchanged — this only makes the drift
visible. `schedule uninstall` has no `--json` output today (only `schedule status`
does), so there is no existing JSON shape to add a matching field to.
