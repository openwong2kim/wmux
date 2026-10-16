#!/usr/bin/env bash
# The completion gate for one change in this repository. wmux.json declares it
# as the project's `verify` command, so wmux's task gate runs it in a task's
# worktree instead of `npm run lint` + `npm test`.
#
# `npm run lint` lints the whole tree and still reports errors that predate
# most changes, so a gate built on it fails every change and says nothing
# about the change itself. This one checks what the change touches:
#   1. eslint on the changed .ts/.tsx files (errors fail, warnings do not),
#   2. the typecheck,
#   3. the vitest files related to the changed files (`vitest --changed`).
# The change is everything since the merge base with WMUX_VERIFY_BASE
# (default origin/main): committed, staged, unstaged and untracked files.
# Test workers default to half the cores (WMUX_VERIFY_WORKERS overrides), so
# a gate leaves room for the panes and other gates running beside it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base_ref="${WMUX_VERIFY_BASE:-origin/main}"
if ! base="$(git merge-base HEAD "$base_ref" 2>/dev/null)"; then
  echo "verify: no merge base with $base_ref" >&2
  exit 2
fi

files=()
while IFS= read -r f; do
  if [ -f "$f" ]; then files+=("$f"); fi
done < <(
  {
    git diff --name-only --diff-filter=ACMR "$base" HEAD
    git diff --name-only --diff-filter=ACMR HEAD
    git ls-files --others --exclude-standard
  } | grep -E '\.(ts|tsx)$' | sort -u
)

echo "verify: ${#files[@]} changed TypeScript file(s) since $(git rev-parse --short "$base") ($base_ref)"
if [ "${#files[@]}" -eq 0 ]; then
  echo "verify: nothing to check"
  exit 0
fi

echo "verify: eslint"
npx eslint "${files[@]}"

echo "verify: typecheck"
npm run --silent typecheck

echo "verify: related tests"
npx vitest run --changed "$base" --maxWorkers="${WMUX_VERIFY_WORKERS:-50%}" --passWithNoTests --reporter=dot --silent \
  --exclude "**/*.runtime.test.ts" --exclude "**/*.runtime.test.tsx" --exclude "**/*.runtime.test.mjs"

echo "verify: passed"
