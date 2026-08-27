---
"cypher-brain": patch
---

Unknown-command and unknown-flag errors now suggest the likely intended
name when one is close enough, generalizing the "did you mean" idiom
restore's `--out`/`--out-dir` case already used (#425 — the "would be
nice-to-have" follow-up #253 itself deferred when it made unrecognized
flags a hard error instead of a silent no-op). `cypher-brain snapsho` now
says `did you mean snapshot?`; `--recipiant` (typo for `--recipient`) says
`did you mean --recipient?`; a genuinely unrelated typo still gets no
suggestion. Uses the same Levenshtein-based matcher (`src/lib/suggest.ts`)
the restore case already relied on — no new matching logic, just a wider
set of candidate names (every command name, every known flag including the
four repeatable array flags handled outside the main flag tables).
