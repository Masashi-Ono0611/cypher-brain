// Conventional Commits enforcement (issue #227, part 3). Deliberately thin: this
// only constrains the SHAPE of a message, never its content, and semantic-release
// is not used (Changesets owns versioning here — see .changeset/ and CONTRIBUTING).
//
// What CI actually lints is the PULL REQUEST TITLE, not the branch's individual
// commits: this repo squash-merges, so the PR title is the message that lands on
// main and is the only one that ends up in `git log`. Linting per-commit would
// enforce a shape on messages that are about to be discarded, while leaving the
// one that survives unchecked. See .github/workflows/pr-hygiene.yml's `commitlint` job.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // GitHub appends " (#123)" to a squashed PR title, and this repo's own history
    // reaches 88 characters with that suffix (`git log --pretty=%s`), so the
    // 100-character default would start rejecting titles it has always accepted.
    'header-max-length': [2, 'always', 120],
    // config-conventional's default type list plus the ones already in this repo's
    // history — `style` (#260) and `security`, kept available for the class of
    // change CONTRIBUTING.md singles out for extra scrutiny.
    'type-enum': [
      2,
      'always',
      ['build', 'chore', 'ci', 'docs', 'feat', 'fix', 'perf', 'refactor', 'revert', 'security', 'style', 'test'],
    ],
  },
};
