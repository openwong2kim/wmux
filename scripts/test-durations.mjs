#!/usr/bin/env node
// Regenerate vitest.durations.json, the per-file durations the `--shard`
// sequencer balances by (scripts/lib/duration-sequencer.mjs).
//
//   node scripts/test-durations.mjs --write <dir>
//       Read every durations-*.json under <dir> (searched recursively, so one
//       subdirectory per run works) and write the median of each file across
//       them. The reports are what CI's test-report-* artifacts carry:
//         gh run download <run-id> -p 'test-report-*' -D <dir>/<run-id>
//       A lane with no report under <dir> keeps its current entries.
//
//   node scripts/test-durations.mjs --from-vitest-cache <results.json>
//       Fill from vitest's local results cache
//       (node_modules/.vite/vitest/<hash>/results.json), for when no CI
//       artifact is at hand. A cache key without a project name is put in the
//       lane the path's name gives (`*.os.test.*` is integration); a lane the cache has no file
//       for keeps its current entries. The cache records test time only (no
//       import or environment time), so its numbers run below CI's full
//       per-file cost: a stopgap, not a substitute for --write.
//
// Both keep only the `unit` and `integration` lanes and only test files that
// exist and vitest.config.ts includes. The format is in
// scripts/lib/test-durations.mjs.
//
// Exit codes: 0 ok, 1 nothing to read, 2 bad usage.

import fs from 'node:fs';
import path from 'node:path';
import {
  DURATIONS_FILE_NAME,
  durationsFromVitestCache,
  findDurationReports,
  mergeDurationReports,
  readDurationsFile,
  readDurationsReport,
  renderDurationsFile,
  updateDurations,
} from './lib/test-durations.mjs';
import { LANES, ROOT, listTestFiles } from './lib/test-lanes.mjs';

const USAGE = 'usage: node scripts/test-durations.mjs (--write <dir> | --from-vitest-cache <results.json>)';
const OUTPUT = path.join(ROOT, DURATIONS_FILE_NAME);

function main(argv) {
  const [flag, arg, ...rest] = argv;
  if (rest.length > 0 || !arg || !['--write', '--from-vitest-cache'].includes(flag)) {
    console.error(USAGE);
    return 2;
  }
  const testFiles = new Set(listTestFiles());

  let fresh;
  if (flag === '--write') {
    const reports = [];
    for (const file of findDurationReports(arg)) {
      try {
        reports.push(readDurationsReport(file));
      } catch (error) {
        console.warn(`test-durations: skipping ${file}: ${error.message}`);
      }
    }
    if (reports.length === 0) {
      console.error(`test-durations: no durations-*.json under ${arg}`);
      return 1;
    }
    fresh = mergeDurationReports(reports, { projects: LANES, testFiles });
    console.log(`test-durations: ${reports.length} report(s), lanes: ${Object.keys(fresh).sort().join(', ')}`);
  } else {
    let cache;
    try {
      cache = JSON.parse(fs.readFileSync(arg, 'utf8'));
    } catch (error) {
      console.error(`test-durations: cannot read ${arg}: ${error.message}`);
      return 1;
    }
    fresh = durationsFromVitestCache(cache, { testFiles });
  }

  // A lane the input says nothing about keeps what it had: both readers
  // return only the lanes they found data for.
  const durations = updateDurations(readDurationsFile(OUTPUT), fresh, LANES);

  fs.writeFileSync(OUTPUT, renderDurationsFile(durations));
  for (const lane of LANES) {
    const files = Object.keys(durations[lane]).length;
    const total = Object.values(durations[lane]).reduce((sum, ms) => sum + ms, 0);
    console.log(`  ${lane}: ${files} files, ${Math.round(total / 1000)} s in total`);
  }
  console.log(`wrote ${path.relative(process.cwd(), OUTPUT) || OUTPUT}`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
