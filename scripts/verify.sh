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
#   3. the vitest files related to the change (`vitest --changed`), in the
#      main lane and the runtime lane,
#   4. the guard tests in scripts/verify-guards.txt, whatever changed: they
#      check rules of the repository (a directory scan, a doc, a generated
#      file), so `--changed`, which follows imports, rarely picks them.
# Any change at all (a deletion, a config file) runs 2, 3 and 4; only eslint
# is limited to the changed TypeScript files.
# The change is everything since the merge base with WMUX_VERIFY_BASE
# (default origin/main, refreshed first when the network allows): committed,
# staged, unstaged and untracked files.
# Test workers default to half the cores (WMUX_VERIFY_WORKERS overrides), so
# a gate leaves room for the panes and other gates running beside it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

base_ref="${WMUX_VERIFY_BASE:-origin/main}"
if [ "$base_ref" = "origin/main" ]; then
  # A verify checkout fetches only the pull request; a stale origin/main would
  # count commits already on main as part of the change. Best effort.
  GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
    fetch --quiet --no-tags origin +refs/heads/main:refs/remotes/origin/main 2>/dev/null \
    || echo "verify: could not refresh origin/main; using the local copy"
fi
if ! base="$(git merge-base HEAD "$base_ref" 2>/dev/null)"; then
  echo "verify: no merge base with $base_ref" >&2
  exit 2
fi

changed=0
ts_files=()
while IFS= read -r -d '' f; do
  changed=$((changed + 1))
  case "$f" in
    *.ts | *.tsx) if [ -f "$f" ]; then ts_files+=("$f"); fi ;;
  esac
done < <(
  {
    git diff -z --name-only "$base" HEAD
    git diff -z --name-only HEAD
    git ls-files -z --others --exclude-standard
  } | sort -zu
)

echo "verify: $changed changed file(s), ${#ts_files[@]} TypeScript to lint, since $(git rev-parse --short "$base") ($base_ref)"
if [ "$changed" -eq 0 ]; then
  echo "verify: nothing changed"
  exit 0
fi

if [ "${#ts_files[@]}" -gt 0 ]; then
  echo "verify: eslint"
  npx eslint "${ts_files[@]}"
fi

echo "verify: typecheck"
npm run --silent typecheck

workers="${WMUX_VERIFY_WORKERS:-50%}"
echo "verify: related tests"
npx vitest run --changed "$base" --maxWorkers="$workers" --passWithNoTests --reporter=dot --silent \
  --exclude "**/*.runtime.test.ts" --exclude "**/*.runtime.test.tsx" --exclude "**/*.runtime.test.mjs"

echo "verify: related runtime tests"
npx vitest run --config vitest.runtime.config.ts --changed "$base" --maxWorkers="$workers" --passWithNoTests --reporter=dot --silent

# The base's list plus the lines this change adds (scripts/lib/verify-guards.mjs).
# Read into a variable first so a failing helper stops the gate (set -e)
# instead of reading as an empty list.
guard_list="$(node scripts/verify-guards.mjs "$base")"
guards=()
while IFS= read -r g; do
  if [ -n "$g" ]; then guards+=("$g"); fi
done <<< "$guard_list"
if [ "${#guards[@]}" -gt 0 ]; then
  echo "verify: guard tests (${#guards[@]})"
  npx vitest run "${guards[@]}" --maxWorkers="$workers" --reporter=dot --silent
fi

echo "verify: passed"
