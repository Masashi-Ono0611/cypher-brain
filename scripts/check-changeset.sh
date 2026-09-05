#!/usr/bin/env bash
# Issue #227 part 1: a PR that changes SHIPPED code (src/) must carry a changeset,
# so `changeset version` can generate the CHANGELOG entry and the version bump
# rather than someone hand-writing both at release time and, in practice,
# forgetting (CHANGELOG.md has been touched exactly once since it was created).
#
# Scoped to src/ deliberately: CI, docs, scripts and test-only changes reach no
# user, and demanding a changeset for them would train people to write empty ones.
# `bun run changeset --empty` is the documented escape hatch for a src/ change that
# genuinely ships nothing user-visible (a comment, a pure internal refactor).
#
# Usage: bash scripts/check-changeset.sh <base-ref>   (e.g. origin/main)
# Exits 0 when no changeset is needed or one is present, 1 when one is missing.
# Follows rules/shell-ops discipline: explicit FAIL + exit 1, no `cond && echo PASS`.
set -u

BASE="${1:-origin/main}"

if ! git rev-parse --verify "$BASE" >/dev/null 2>&1; then
  echo "[FAIL] base ref '$BASE' not found — this check needs the merge base (fetch-depth: 0)"
  exit 1
fi

# ...HEAD (three dots) = changed since the MERGE BASE, so commits that landed on the
# base branch after this one forked are not counted as this PR's changes.
# Fail CLOSED if git itself fails — an empty CHANGED from a broken diff would
# otherwise sail through the "no src/ changes" branch below as a PASS.
#
# This is the FULL diff (every status, deletions included): a PR that ships nothing
# but a src/ DELETION (e.g. dropping a CLI flag or a whole file) is still a
# user-visible change and must trigger the changeset requirement below — a plain
# --diff-filter=d here would silently exempt exactly that PR (a deleted src/ file
# never appears in CHANGED at all, so the "did src/ change" grep never fires).
if ! CHANGED="$(git diff --name-only "$BASE...HEAD")"; then
  echo "[FAIL] 'git diff $BASE...HEAD' failed — cannot tell what this PR changed"
  exit 1
fi

if ! printf '%s\n' "$CHANGED" | grep -q '^src/'; then
  echo "[PASS] no src/ changes in this diff — no changeset required"
  exit 0
fi

# --diff-filter=d EXCLUDES deletions, computed separately from CHANGED above and used
# ONLY for the "is a changeset present" check that follows: a PR that removes a
# changeset must not be credited with having one (multi-model review finding).
# Applying that same exclusion to the "did src/ change" trigger above would reopen
# the deleted-src/-file loophole this comment just closed, so the two questions use
# two different diffs on purpose.
if ! CHANGED_NO_DEL="$(git diff --name-only --diff-filter=d "$BASE...HEAD")"; then
  echo "[FAIL] 'git diff $BASE...HEAD' failed — cannot tell what this PR changed"
  exit 1
fi

# .changeset/README.md is the tool's own boilerplate, not a changeset.
# Each candidate must still EXIST at HEAD: --diff-filter=d already excludes a
# deletion, and this also rules out a path that is gone for any other reason, so
# "a changeset is present" means present rather than merely mentioned in the diff
# (multi-model review finding).
FOUND=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ "$f" = ".changeset/README.md" ] && continue
  [ -f "$f" ] || continue
  FOUND="$FOUND $f"
done <<EOF
$(printf '%s\n' "$CHANGED_NO_DEL" | grep -E '^\.changeset/[^/]+\.md$')
EOF

if [ -n "$FOUND" ]; then
  echo "[PASS] src/ changed and this PR adds a changeset:$FOUND"
  exit 0
fi

echo "[FAIL] this PR changes src/ but adds no changeset."
echo
echo "  Run one of these, commit the generated .changeset/*.md, and push:"
echo "    bun run changeset           # describe the user-visible change (patch/minor/major)"
echo "    bun run changeset --empty   # the change ships nothing user-visible"
echo
echo "  src/ files changed in this PR:"
printf '%s\n' "$CHANGED" | grep '^src/' | sed 's/^/    /'
exit 1
