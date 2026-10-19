#!/usr/bin/env node
// Fold changelog.d/<pr>.md fragments into CHANGELOG.md under [Unreleased].
//
//   node scripts/collect-changelog.mjs           fold and delete fragments
//   node scripts/collect-changelog.mjs --check   report only, write nothing
//
// The folding itself lives in scripts/lib/changelog-fragments.mjs so it can be
// imported by tests; this file is the command line around it. Fragments the
// checker (scripts/check-changelog-fragments.mjs) finds errors in are not
// folded: deleting them would leave the mistake only in the release notes.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHANGELOG, fragmentFiles, collect, applyToChangelog } from './lib/changelog-fragments.mjs';
import { checkFragments } from './check-changelog-fragments.mjs';

function main() {
  const check = process.argv.includes('--check');
  const files = fragmentFiles();
  if (files.length === 0) {
    console.log('collect-changelog: no fragments in changelog.d/');
    return;
  }

  // Errors only: warnings never block a release, so git history is not read.
  const errors = checkFragments(files, { history: false }).filter((p) => p.severity === 'error');
  if (errors.length > 0) {
    for (const p of errors) console.error(`${p.file}:${p.line}: error: ${p.message}`);
    console.error(`collect-changelog: refusing to fold, ${errors.length} error(s) in changelog.d/. Fix them (npm run changelog:check) and run again; nothing was written.`);
    process.exitCode = 1;
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
