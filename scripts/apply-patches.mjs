#!/usr/bin/env node
/**
 * Run patch-package after install, then VERIFY the patch actually landed.
 * Kept out of `dependencies` so the production license/notices closure does
 * not grow a build-tool tree (jsonify@0.0.1 declares "Public Domain" with no
 * LICENSE file).
 *
 * Verification (scripts/lib/patch-verify.mjs): probe the installed
 * @xterm/addon-webgl bundle for the patch marker. An unpatched install fails
 * the hook EXCEPT in the one legitimate unpatched state — `npm ci --omit=dev`
 * has neither patch-package nor devDependencies, and that flow must keep
 * passing. The two failure modes the probe distinguishes:
 *
 *   • HYBRID install (dev deps present, patch-package missing) — a broken
 *     local node_modules that previously skipped SILENTLY and surfaced days
 *     later as phantom test/tsc failures (2026-09-07 incident). Now a hard
 *     error with the recovery command.
 *   • PATCH DRIFT (patch-package ran but the marker is still absent) — the
 *     patch no longer applies to the installed version; needs a human, so it
 *     fails regardless of install flavor.
 *
 * Full `npm ci` (CI, packaging) still applies the patch, and
 * atlasCoherence.test.ts fails in CI if the installed addon is unpatched.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { verifyPatchState } from './lib/patch-verify.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let bin = null;
try {
  bin = path.join(path.dirname(require.resolve('patch-package/package.json')), 'index.js');
} catch {
  bin = null;
}

const hadPatcher = bin !== null;
if (hadPatcher) {
  const result = spawnSync(process.execPath, [bin], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
} else {
  console.warn('[apply-patches] patch-package not installed (omit-dev?). Verifying installed state instead.');
}

const verdict = verifyPatchState(undefined, root);
if (verdict.ok) process.exit(0);

if (verdict.state === 'unpatched' && !verdict.devInstall && !hadPatcher) {
  // The one legitimate unpatched state: a production (--omit=dev) install.
  // Legacy behavior preserved — packaging flows must not fail here.
  console.warn(
    '[apply-patches] patches are NOT applied (production install without patch-package). ' +
      'Packaged builds install with a full `npm ci`, which applies them.',
  );
  process.exit(0);
}

if (verdict.state === 'unpatched' && verdict.devInstall && !hadPatcher) {
  console.error(
    '[apply-patches] node_modules is inconsistent: dev dependencies are installed but ' +
      'patch-package is missing, so the @xterm patches were never applied. ' +
      'Symptoms appear later as atlasCoherence test failures and phantom tsc errors. ' +
      'Fix: run `npm ci`.',
  );
  process.exit(1);
}

// patch-package ran (or was expected) yet the marker is absent: patch drift.
console.error(
  '[apply-patches] patch verification FAILED — the @xterm/addon-webgl patch marker is ' +
    'absent after patch-package ran. The patch in patches/ likely no longer applies to the ' +
    'installed version. Regenerate it: npx patch-package @xterm/addon-webgl',
);
process.exit(1);
