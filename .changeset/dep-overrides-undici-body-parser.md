---
'cypher-brain': patch
---

Pin `undici` to 6.29.1 and `body-parser` to 2.4.0 via `overrides`. Both fix
denial-of-service advisories in which one crafted request or response crashes
the Node.js process: `undici` through the optional `@ardrive/turbo-sdk`
(CVE-2026-109869), and `body-parser` through the MCP SDK's HTTP server
(CVE-2026-111181). Patch and minor releases only; nothing changes for CLI users.
