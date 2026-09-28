#!/usr/bin/env node
// Type-check the root project as a sequence of smaller programs.
//
//   node scripts/typecheck.mjs                 every slice (what CI runs)
//   node scripts/typecheck.mjs src tests-main  only the named slices
//
// The slices live in scripts/typecheck/*.json; why they exist is in
// scripts/lib/typecheck-slices.mjs. The checks before and around tsc stand in
// for what one whole program used to catch on its own: a file no slice
// selects, a slice that loosens compiler options, globals split across
// programs, and import paths whose casing differs from the file on disk.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import {
  ROOT, ROOT_CONFIG, SLICES, sliceConfig, coverageGaps, assertSlicesExist,
  sliceConfigProblems, scopeProblems, casingMismatches,
} from './lib/typecheck-slices.mjs';

const require = createRequire(import.meta.url);

function fail(header, lines) {
  console.error(`typecheck: ${header}`);
  for (const l of lines) console.error(`  ${l}`);
  process.exit(1);
}

function main() {
  const asked = process.argv.slice(2);
  const names = asked.length > 0 ? asked : SLICES;
  assertSlicesExist(names);

  const configProblems = sliceConfigProblems(SLICES);
  if (configProblems.length > 0) fail('slice configs are invalid', configProblems);

  const { missing, extra } = coverageGaps(ROOT_CONFIG, SLICES.map((n) => sliceConfig(n)));
  if (missing.length > 0 || extra.length > 0) {
    fail('slices do not cover tsconfig.json exactly — update scripts/typecheck/*.json', [
      ...missing.map((f) => `not in any slice: ${path.relative(ROOT, f)}`),
      ...extra.map((f) => `not in tsconfig.json: ${path.relative(ROOT, f)}`),
    ]);
  }

  const scope = scopeProblems(ROOT_CONFIG, sliceConfig('src'));
  if (scope.length > 0) fail('the split would hide whole-program checks', scope);

  const tsc = require.resolve('typescript/bin/tsc');
  const failed = [];
  for (const name of names) {
    const started = Date.now();
    const args = [tsc, '--noEmit', '--listFiles', '-p', sliceConfig(name)];
    if (process.stdout.isTTY) args.push('--pretty');
    const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] });
    // --listFiles prints one absolute path per line after the diagnostics.
    const lines = (run.stdout ?? '').split(/\r?\n/);
    const files = lines.filter((l) => path.isAbsolute(l.trim()) && !/\(\d+,\d+\)/.test(l)).map((l) => l.trim());
    const diagnostics = lines.filter((l) => !files.includes(l.trim())).join('\n').trim();
    if (diagnostics) console.log(diagnostics);

    const casing = casingMismatches(files);
    for (const c of casing) console.error(`error: ${c.listed} is imported with different casing than the file on disk (${c.onDisk})`);

    const ok = run.status === 0 && casing.length === 0;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`typecheck: ${name} ${ok ? 'ok' : 'FAILED'} (${secs}s)`);
    if (!ok) failed.push(name);
  }

  if (failed.length > 0) {
    console.error(`typecheck: failed in ${failed.join(', ')}`);
    process.exit(1);
  }
}

main();
