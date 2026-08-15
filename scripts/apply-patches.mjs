#!/usr/bin/env node
/**
 * Run patch-package after install. Kept out of `dependencies` so the
 * production license/notices closure does not grow a build-tool tree
 * (jsonify@0.0.1 declares "Public Domain" with no LICENSE file).
 *
 * `npm ci --omit=dev` has no patch-package binary; skip rather than
 * fail the hook. Full `npm ci` (CI, packaging) still applies the patch,
 * and atlasCoherence.test.ts fails if the installed addon is unpatched.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let bin;
try {
  bin = path.join(path.dirname(require.resolve('patch-package/package.json')), 'index.js');
} catch {
  console.warn('[apply-patches] patch-package not installed (omit-dev?). Skipping.');
  process.exit(0);
}

const result = spawnSync(process.execPath, [bin], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
