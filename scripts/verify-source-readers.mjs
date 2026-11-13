#!/usr/bin/env node
// Prints the tests that read a file changed since <base> as text, one path per
// line, for the repository the current directory is in. scripts/verify.sh runs
// them beside `vitest --changed`, which cannot see them.
//
//   node scripts/verify-source-readers.mjs <base-commit>
//
// See scripts/lib/verify-source-readers.mjs.
import { execFileSync } from 'node:child_process';
import { changedFiles, readOrNull, sourceReaders, testFiles } from './lib/verify-source-readers.mjs';

const base = process.argv[2];
if (!base) {
  process.stderr.write('usage: verify-source-readers.mjs <base-commit>\n');
  process.exit(2);
}
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const picked = sourceReaders({ changed: changedFiles(root, base), tests: testFiles(root), read: readOrNull(root) });
for (const test of picked) process.stdout.write(`${test}\n`);
