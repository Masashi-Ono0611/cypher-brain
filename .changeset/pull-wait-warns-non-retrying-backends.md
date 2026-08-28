---
"cypher-brain": patch
---

`pull --wait <seconds>` was a silent no-op for the `file`, `rclone`, `ton`, and
`ton-provider` backends (#465): the retry loop only catches the `RetryableError` that
arweave's/turbo's `get()` throw for "not yet propagated" — every other backend's "not
found" is a plain `Error`, so `--wait` retried nothing, and a run failed in the same
~0.1s as `--wait 0` with no indication the flag was accepted and then ignored. `file` is
the backend the docs recommend for local dogfooding of retry logic, making this an easy
trap.

`pull --wait <N>` where `N > 0` now prints a warning up front when the chosen backend
does not actually retry (`--wait has no effect on the "<backend>" backend — only
arweave/turbo backends retry while an item is not yet retrievable`), and `--help`/
README.md document the same. This is deliberately a warning, not new retry behavior for
those backends: teaching their "not found" to retry would risk a genuinely permanent
miss (e.g. a mistyped rclone remote path) waiting out the full `--wait` budget before
failing, instead of failing fast as it does today.
