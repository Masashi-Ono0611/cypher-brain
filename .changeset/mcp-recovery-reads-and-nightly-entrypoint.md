---
'cypher-brain': patch
---

Fix MCP-installed nightly schedules to invoke the CLI rather than starting another
MCP server. Reinstall existing MCP-created schedules to update their runner.

Prevent `verify_restore` and `restore_now` from reading arbitrary paths through
`locator_file`: require a regular file inside `CYPHER_BRAIN_HOME`, at most 1 MiB,
and pull from a private copy of its checked contents. Malformed locator files and
rejected recipient-file entries no longer disclose their contents in MCP errors.
