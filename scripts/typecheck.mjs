#!/usr/bin/env node
// Type-check the root project as a sequence of smaller programs.
//
//   node scripts/typecheck.mjs                 every slice (what CI runs)
//   node scripts/typecheck.mjs src tests-main  only the named slices
//
// The slices live in scripts/typecheck/*.json; why they exist is in
// scripts/lib/typecheck-slices.mjs. Coverage is checked first, so a file the
// root tsconfig selects but no slice does fails the run instead of going
// unchecked.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ROOT, ROOT_CONFIG, SLICES, sliceConfig, coverageGaps, assertSlicesExist } from './lib/typecheck-slices.mjs';

const require = createRequire(import.meta.url);

function main() {
  const asked = process.argv.slice(2);
  const names = asked.length > 0 ? asked : SLICES;
  assertSlicesExist(names);

  const { missing, extra } = coverageGaps(ROOT_CONFIG, SLICES.map((n) => sliceConfig(n)));
  if (missing.length > 0 || extra.length > 0) {
    console.error('typecheck: slices do not cover tsconfig.json exactly — update scripts/typecheck/*.json');
    for (const f of missing) console.error(`  not in any slice: ${path.relative(ROOT, f)}`);
    for (const f of extra) console.error(`  not in tsconfig.json: ${path.relative(ROOT, f)}`);
    process.exit(1);
  }

  const tsc = require.resolve('typescript/bin/tsc');
  const failed = [];
  for (const name of names) {
    const started = Date.now();
    const run = spawnSync(process.execPath, [tsc, '--noEmit', '-p', sliceConfig(name)], { cwd: ROOT, stdio: 'inherit' });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const ok = run.status === 0;
    console.log(`typecheck: ${name} ${ok ? 'ok' : 'FAILED'} (${secs}s)`);
    if (!ok) failed.push(name);
  }

  if (failed.length > 0) {
    console.error(`typecheck: failed in ${failed.join(', ')}`);
    process.exit(1);
  }
}

main();
