---
'cypher-brain': patch
---

`init`'s Directory-path step (6/7, `profile=none`) no longer throws-and-rolls-back on
an empty answer — same bug class as #462 (the Profile prompt), fixed the same way for
the maintainer's own precedent: Enter with nothing typed (or only whitespace/commas)
used to throw immediately AFTER the primary identity, the offline backup keypair and
the signing keypair had already been written to disk, and the wizard's own rollback
then deleted all three. This prompt cannot become a `select()` menu like the profile
step (the paths are free-form), so instead it now loops — re-prompting until at least
one directory is given — rather than throwing on the first empty answer (#492).

Also corrects a doc comment in `src/lib/wizard.ts` (no behavior change): the header
claimed clack's rendering "checks NO_COLOR/FORCE_COLOR/isTTY before emitting any COLOR
escape code" and that "a real terminal is always on the other end" whenever the
`CYPHER_BRAIN_INIT_ALLOW_NONINTERACTIVE=1` automation escape hatch is used. The color
part is true (verified empirically: Node's `util.styleText`, which clack uses for
color, already suppresses every color code on a non-TTY output, NO_COLOR or not — and
FORCE_COLOR in the caller's own environment overrides NO_COLOR, so NO_COLOR alone
cannot guarantee a clean transcript). The "real terminal" part is not: this repo's own
`scripts/drive-init.mjs` drives the wizard via piped stdin AND stdout under that exact
escape hatch, and clack's own cursor-movement/hide/show/erase escapes (a separate
mechanism, not gated on NO_COLOR/FORCE_COLOR/isTTY) are written unconditionally either
way — a captured transcript is never colorized by accident, but it is not plain text.
@clack/prompts has no documented option to suppress those non-color escapes
independent of TTY detection, so the comment now says so plainly instead of asserting
a false premise (#464).
