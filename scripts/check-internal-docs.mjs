#!/usr/bin/env node
/**
 * CLI for the internal-document policy gate.
 *
 * The audit itself lives in scripts/lib/internal-doc-guard.mjs so the test suite
 * can import it — this file carries the `#!` line, and a module with a shebang
 * cannot be imported under vitest.
 *
 * Usage:
 *   node scripts/check-internal-docs.mjs             # staged changes (pre-commit)
 *   node scripts/check-internal-docs.mjs --tracked   # every tracked file (CI / npm test)
 *   node scripts/check-internal-docs.mjs --json      # machine-readable findings
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { checkGitignore, checkPaths } from './lib/internal-doc-guard.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Paths git will record in the next commit: added, copied, modified, renamed. */
function stagedPaths() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']).split('\n').filter(Boolean);
}

function trackedPaths() {
  return git(['ls-files']).split('\n').filter(Boolean);
}

/**
 * In staged mode the staged blob is what the commit will contain, so a
 * `.gitignore` weakened in the working tree but not staged is not this commit's
 * problem. Falling back to the working copy keeps the check useful when
 * `.gitignore` is untouched (the common case — nothing staged for it).
 */
function gitignoreText(staged) {
  if (staged) {
    try {
      return git(['show', ':.gitignore']);
    } catch {
      // Not staged — fall through to the working copy.
    }
  }
  try {
    return readFileSync('.gitignore', 'utf8');
  } catch {
    return '';
  }
}

function main() {
  const args = process.argv.slice(2);
  const tracked = args.includes('--tracked');

  const paths = tracked ? trackedPaths() : stagedPaths();
  const violations = [
    ...checkGitignore(gitignoreText(!tracked)),
    ...checkPaths(paths),
  ];

  if (args.includes('--json')) {
    process.stdout.write(`${JSON.stringify({ scope: tracked ? 'tracked' : 'staged', checked: paths.length, violations }, null, 2)}\n`);
    process.exit(violations.length ? 1 : 0);
  }

  if (violations.length === 0) {
    console.log(`[internal-docs] OK — ${paths.length} ${tracked ? 'tracked' : 'staged'} path(s), no internal documents.`);
    return;
  }

  console.error(`\n[internal-docs] BLOCKED — ${violations.length} policy violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.path ?? `.gitignore: ${v.entry}`}  [${v.rule}]`);
    console.error(`    ${v.detail}`);
  }
  console.error(
    '\n  This repository is public. Internal strategy, roadmap, and competitive\n' +
      '  documents belong outside it — write them to a private location instead.\n' +
      '  A document that is genuinely meant to be published goes in the allowlist\n' +
      '  in scripts/lib/internal-doc-guard.mjs, together with the reason.\n',
  );
  process.exit(1);
}

main();
