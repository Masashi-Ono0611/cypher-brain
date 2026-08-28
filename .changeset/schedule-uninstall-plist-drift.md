---
"cypher-brain": patch
---

`schedule uninstall` (macOS) now reports when the launchd plist it expected
to remove is already gone (#529). Previously, if the plist was deleted or
lost out-of-band (e.g. by another tool, or manually) before `uninstall`
ran, the `removed: launchd plist <path>` line simply vanished with no
substitute message — an operator (or an automated `doctor`/monitoring
flow) had no way to tell "cypher-brain cleanly tore down a live trigger"
from "the trigger was already gone and we don't know why" from the output
alone. Now, when `schedule.json` still records this home's own launchd
trigger at that exact path but the file itself is missing, uninstall
prints `drift: launchd plist <path> already missing — was it removed
manually?` instead of silently omitting the line. The normal case (plist
present and removed) is unchanged.
