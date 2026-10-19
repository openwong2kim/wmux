#!/usr/bin/env node
// Prints the guard tests scripts/verify.sh runs on every change, one path per
// line, for the repository the current directory is in. A listed path that is
// not in the tree is named on stderr and left out.
//
//   node scripts/verify-guards.mjs <base-commit>
//
// See scripts/lib/verify-guards.mjs and scripts/verify-guards.txt.
import { execFileSync } from 'node:child_process';
import { guardTests } from './lib/verify-guards.mjs';

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const { run, missing } = guardTests({ root, base: process.argv[2] ?? '' });
for (const entry of missing) process.stderr.write(`verify: guard test ${entry} is listed but not in this tree; skipped\n`);
for (const entry of run) process.stdout.write(`${entry}\n`);
