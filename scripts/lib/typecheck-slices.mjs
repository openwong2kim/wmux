// Type-check slices: the root project split into programs small enough to fit
// a CI runner's default V8 heap.
//
// One `tsc -p tsconfig.json` program holds ~3,600 files (half of them tests)
// and peaks near 2.4 GB of heap. On macos-14 (7 GB RAM) that sits on the
// default heap limit, so the check died with "JavaScript heap out of memory"
// on and off from 2026-09-27, and six parallel local gates pushed a 16 GB Mac
// into swap. Each slice below is its own program; together they must list
// exactly the files the root tsconfig does, which coverageGaps() enforces so a
// new directory can never fall out of type checking unnoticed.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ROOT_CONFIG = path.join(ROOT, 'tsconfig.json');
export const SLICE_DIR = path.join(ROOT, 'scripts', 'typecheck');

/** Slice configs in run order: the app source first, then the test areas. */
export const SLICES = ['src', 'tests-renderer', 'tests-main', 'tests-daemon', 'tests-rest'];

export function sliceConfig(name, dir = SLICE_DIR) {
  return path.join(dir, `${name}.json`);
}

/** The root files a tsconfig selects (include/exclude expanded), without building a program. */
export function rootFiles(configPath) {
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath), undefined, configPath);
  const fatal = parsed.errors.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (fatal.length > 0) throw new Error(fatal.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n'));
  return parsed.fileNames.map((f) => path.resolve(f));
}

/**
 * Files the root config checks that no slice does (`missing`), and files a
 * slice checks that the root config does not (`extra`). Both must be empty.
 */
export function coverageGaps(rootConfig, sliceConfigs) {
  const root = new Set(rootFiles(rootConfig));
  const union = new Set(sliceConfigs.flatMap((c) => rootFiles(c)));
  return {
    missing: [...root].filter((f) => !union.has(f)).sort(),
    extra: [...union].filter((f) => !root.has(f)).sort(),
  };
}

export function assertSlicesExist(names, dir = SLICE_DIR) {
  for (const n of names) {
    if (!fs.existsSync(sliceConfig(n, dir))) throw new Error(`unknown type-check slice "${n}" (have: ${SLICES.join(', ')})`);
  }
}
