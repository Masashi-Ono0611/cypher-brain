---
'cypher-brain': patch
---

gbrain engine detection hardening, found via dogfooding (#534, #540, #541, #542,
#543).

`detectGbrainEngine` (gbrain.ts, #367) now correctly fails toward the safe pre-#367
Postgres default when `config.json`'s `engine` field is present but is not exactly
`'pglite'`/`'postgres'` — a case-mismatched typo (`"Postgres"`) or a hypothetical
future gbrain engine type — instead of falling through to the `database_path`-implies-
PGLite heuristic (#534). That fallthrough inverted the one case the module explicitly
documents as `engine` winning over a stale `database_path`, the moment the string
wasn't byte-identical.

`init`'s gbrain-detection prose now distinguishes a genuinely-parsed config from one
that could not be read at all (invalid JSON, or the config path being a directory):
the latter now says "could not be read (defaulting to Postgres)" instead of the
confident "Detected a gbrain config … lives in Postgres" claim a real detection gets
(#543). The `--pg` connection-string prefill's wording is also now explicit that it is
a generic OS-user guess, not read from the detected gbrain config (#540) — the module's
"reads exactly two fields, nothing else out of config.json" privacy contract is
preserved as-is, since gbrain's own `database_url` field typically embeds a credential.

`doctor` gained a `gbrain-engine-detection` check (#542): `init` refuses to rerun once
an identity exists, so there was previously no way to re-check which engine gbrain is
configured for (e.g. after a PGLite→Postgres migration) without redriving the wizard.
The check is informational (PASS-with-note on a genuine detection, WARN — never FAIL —
on an unreadable config) and standalone, matching the version-citation refresh in
gbrain.ts's own header comment (v0.42.75.0 → v0.47.3.0, #541, re-confirmed live against
gbrain's current `src/core/config.ts` before updating the number).
