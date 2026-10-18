#!/usr/bin/env node
// Sort the test files into lanes: `integration` (touches the OS) or `unit`.
//
//   node scripts/test-lanes.mjs              counts, then every integration file and why
//   node scripts/test-lanes.mjs --write      regenerate vitest.lanes.json
//   node scripts/test-lanes.mjs --check      exit 1 when vitest.lanes.json is stale
//   node scripts/test-lanes.mjs --why <file> the lane of one test file, and why
//
// The rule (and why a file counts as touching the OS) is in
// scripts/lib/test-lanes.mjs. vitest.config.ts reads vitest.lanes.json: the
// files listed there are the `integration` project, everything else it
// includes is `unit`. The list is checked in rather than computed when vitest
// starts because classifying ~2,000 files costs ~0.5 s of CPU, and vitest
// loads its config on every run, `vitest run one.test.ts` included.
// scripts/__tests__/testLanes.test.mjs runs --check's comparison, so a stale
// list fails the suite with the command that fixes it.
//
// Exit codes: 0 ok, 1 stale (--check) or unknown file (--why), 2 bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { LANES_FILE, ROOT, classifyAll, classifyTestFile, laneDrift, readLanesFile, renderLanesFile } from './lib/test-lanes.mjs';

const USAGE = 'usage: node scripts/test-lanes.mjs [--write | --check | --why <file>]';

function main(argv) {
  const [flag, arg, ...rest] = argv;
  if (rest.length > 0 || (flag && !['--write', '--check', '--why'].includes(flag)) || (flag === '--why') !== Boolean(arg)) {
    console.error(USAGE);
    return 2;
  }

  if (flag === '--why') {
    const file = path.relative(ROOT, path.resolve(arg)).split(path.sep).join('/');
    const result = classifyAll().byFile.get(file);
    if (!result) {
      console.error(`test-lanes: ${file} is not a test file vitest.config.ts includes (runtime suites have their own config)`);
      // Still say what the rule would make of it, when it is a readable file.
      if (fs.existsSync(path.join(ROOT, file))) {
        const guess = classifyTestFile(file);
        console.error(`  as a test it would be ${guess.lane}${guess.reasons.length ? `: ${guess.reasons.join('; ')}` : ''}`);
      }
      return 1;
    }
    console.log(`${file}: ${result.lane}`);
    for (const reason of result.reasons) console.log(`  - ${reason}`);
    if (result.reasons.length === 0) console.log('  - no OS import, no OS-importing helper, no temp dir over OS-importing code');
    return 0;
  }

  const lanes = classifyAll();

  if (flag === '--write') {
    fs.writeFileSync(LANES_FILE, renderLanesFile(lanes.integration));
    console.log(`test-lanes: wrote ${path.relative(ROOT, LANES_FILE)} (${lanes.integration.length} integration, ${lanes.unit.length} unit)`);
    return 0;
  }

  if (flag === '--check') {
    const drift = laneDrift(readLanesFile(), lanes);
    if (drift.length === 0) {
      console.log(`test-lanes: ${path.relative(ROOT, LANES_FILE)} is current (${lanes.integration.length} integration, ${lanes.unit.length} unit)`);
      return 0;
    }
    for (const line of drift) console.error(line);
    console.error('\nRun `node scripts/test-lanes.mjs --write` and commit vitest.lanes.json.');
    return 1;
  }

  console.log(`${lanes.integration.length} integration, ${lanes.unit.length} unit (${lanes.byFile.size} files)\n`);
  for (const file of lanes.integration) {
    console.log(`${file}\n  - ${lanes.byFile.get(file).reasons.join('\n  - ')}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
