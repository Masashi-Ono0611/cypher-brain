---
'cypher-brain': patch
---

An unrecognized command name combined with `--help` (e.g. `recoverykit --help`,
a typo for `recovery-kit`, or `totally-bogus-command --help`) used to silently
succeed at exit 0, dumping the ENTIRE ~26KB help reference with zero indication
the command name wasn't real — worse than the exact same typo without `--help`,
which already correctly refuses (#269/#427) with a short "unknown command"
reply and a did-you-mean suggestion when one applies. This combination now
refuses the exact same way: exit 2, stdout empty, the same `unknown command: X
(did you mean Y?)` reply on stderr (#929).

`<valid-command> --help` (scoped to that command's section) and bare
`cypher-brain --help` (the full reference) are both unaffected.
