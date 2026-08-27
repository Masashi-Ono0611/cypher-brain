---
"cypher-brain": patch
---

The printable recovery kit (`init`'s end-of-wizard kit, and `cypher-brain
recovery-kit`) now leads with a compact "QUICK RECOVERY" block right after
the warning banner, before any other content (#428). Under real recovery
pressure the reader wants "what do I type, right now" first — previously
the actual pull/restore commands were buried roughly 50 lines in, after
several caveat paragraphs. The quick block reuses the exact same command
logic the detailed "RECOVERY STEPS" section further down already computes
(one shared helper, so the two can never state different commands): when a
working single-identity recovery path exists (a backup identity, or an
inlined primary via `--inline-identity`), it shows the concrete
install/copy/pull/restore steps, with a short pointer to the file-backend
"LOCATOR IS LOCAL-ONLY" and Postgres caveats when they apply; when neither
exists, it says upfront — as clearly as the detailed section already does —
that kit-only recovery on a fresh machine is not possible right now, and
points at "Your actual options" below rather than implying commands work
when they don't. Purely additive resequencing: every caveat, section, and
identity/locator block below the new top block is unchanged.
