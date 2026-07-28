#!/usr/bin/env node
// Fold changelog.d/<pr>.md fragments into CHANGELOG.md under [Unreleased].
//
//   node scripts/collect-changelog.mjs           fold and delete fragments
//   node scripts/collect-changelog.mjs --check   report only, write nothing
//
// The folding itself lives in scripts/lib/changelog-fragments.mjs so it can be
// imported by tests; this file is the command line around it.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHANGELOG, fragmentFiles, collect, applyToChangelog } from './lib/changelog-fragments.mjs';

function main() {
  const check = process.argv.includes('--check');
  const files = fragmentFiles();
  if (files.length === 0) {
    console.log('collect-changelog: no fragments in changelog.d/');
    return;
  }

  const merged = collect(files);
  const counts = Object.entries(merged)
    .map(([s, e]) => `${s} ${e.length}`)
    .join(', ');
  console.log(`collect-changelog: ${files.length} fragment(s) — ${counts}`);
  for (const f of files) console.log(`  ${path.relative(ROOT, f)}`);

  if (check) {
    console.log('collect-changelog: --check, nothing written');
    return;
  }

  fs.writeFileSync(CHANGELOG, applyToChangelog(fs.readFileSync(CHANGELOG, 'utf8'), merged));
  for (const f of files) fs.unlinkSync(f);
  console.log('collect-changelog: folded into CHANGELOG.md, fragments removed');
}

main();
