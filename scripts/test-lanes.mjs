#!/usr/bin/env node
// Sort the test files into lanes: `integration` (touches the OS) or `unit`.
//
//   node scripts/test-lanes.mjs              counts, then every integration file and why
//   node scripts/test-lanes.mjs --check      exit 1 when a file's name puts it in another
//                                            lane than the rule does, printing the `git mv`s
//   node scripts/test-lanes.mjs --why <file> the lane of one test file, and why
//
// The rule (and why a file counts as touching the OS) is in
// scripts/lib/test-lanes.mjs. The lane itself is in the file's name:
// vitest.config.ts runs `*.os.test.*` files in the `integration` project and
// every other file it includes in `unit`. scripts/__tests__/testLanes.os.test.mjs
// runs --check's comparison, so a misnamed file fails the suite with the
// command that fixes it.
//
// Exit codes: 0 ok, 1 misnamed files (--check) or unknown file (--why), 2 bad usage.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, classifyAll, classifyTestFile, laneMismatches } from './lib/test-lanes.mjs';

const USAGE = 'usage: node scripts/test-lanes.mjs [--check | --why <file>]';

function main(argv) {
  const [flag, arg, ...rest] = argv;
  if (rest.length > 0 || (flag && !['--check', '--why'].includes(flag)) || (flag === '--why') !== Boolean(arg)) {
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

  if (flag === '--check') {
    const mismatches = laneMismatches(lanes);
    if (mismatches.length === 0) {
      console.log(`test-lanes: every name matches its lane (${lanes.integration.length} integration, ${lanes.unit.length} unit)`);
      return 0;
    }
    for (const { message } of mismatches) console.error(message);
    console.error('\nTo rename them all (a file that should keep its lane takes a pragma instead):');
    for (const { file, to } of mismatches) console.error(`  git mv ${file} ${to}`);
    return 1;
  }

  console.log(`${lanes.integration.length} integration, ${lanes.unit.length} unit (${lanes.byFile.size} files)\n`);
  for (const file of lanes.integration) {
    console.log(`${file}\n  - ${lanes.byFile.get(file).reasons.join('\n  - ')}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
