// Patch-state verification for the postinstall hook (apply-patches.mjs).
//
// Patch application is load-bearing: the shipped @xterm/addon-webgl has a
// glyph-atlas bug (xterm.js #4480 page-merge) that wmux's patches/ fix repairs,
// and atlasCoherence.test.ts fails in CI when the patch is absent. But nothing
// guarded the LOCAL case: a hybrid node_modules — dev dependencies present,
// patch-package missing (an --omit=dev-style install layered over a full one) —
// made the postinstall hook skip silently, and the broken state surfaced days
// later as a phantom test failure plus phantom tsc errors (2026-09-07 incident).
//
// This module is the probe: read the installed addon-webgl bundle and check for
// the patch marker. It is the CANARY for patch application generally — when
// patch-package never ran, every patch in patches/ is missing, so probing the
// one marker atlasCoherence already guards detects the whole class. Pure and
// dependency-injected so the postinstall script and the unit tests share one
// implementation with no fs mocking frameworks.

import path from 'node:path';
import fs from 'node:fs';

/** Bundle file the addon-webgl patch rewrites, relative to the repo root. */
export const PATCH_PROBE_FILE = path.join('node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js');

/** Marker the patch's I1 hunk leaves in the bundle
 *  (grep-identical to the string atlasCoherence.test.ts asserts). */
export const PATCH_PROBE_MARKER = 'I1 — clearTexture is total';

/** A devDependency that exists in every FULL install but never in an
 *  --omit=dev install. Its presence with an unpatched probe file means the
 *  install is a broken hybrid, not a deliberate production install. */
export const DEV_INSTALL_SENTINEL = path.join('node_modules', 'typescript');

/**
 * Probe the installed tree and classify the patch state.
 *
 * @param {object} [deps] injectable fs surface (defaults to node:fs) so tests
 *   can stub existence/content without touching a real node_modules.
 * @param {string} [root] repo root to probe (defaults to cwd). apply-patches
 *   passes its own module-derived root; tests pass a fabricated tree.
 * @returns {{
 *   state: 'patched' | 'target-absent' | 'unpatched',
 *   ok: boolean,
 *   devInstall?: boolean,
 * }} `ok` is the verdict for THIS hook run: 'patched' and 'target-absent'
 *   (nothing installed to verify — e.g. a scoped install) pass; 'unpatched'
 *   fails and carries `devInstall` so the caller can choose the failure mode.
 */
export function verifyPatchState(deps = fs, root = process.cwd()) {
  const { existsSync, readFileSync } = deps;
  const probePath = path.join(root, PATCH_PROBE_FILE);
  if (!existsSync(probePath)) return { state: 'target-absent', ok: true };
  let content;
  try {
    content = readFileSync(probePath, 'utf8');
  } catch {
    // Unreadable probe file: treat as unpatched rather than silently passing.
    return { state: 'unpatched', ok: false, devInstall: existsSync(path.join(root, DEV_INSTALL_SENTINEL)) };
  }
  if (content.includes(PATCH_PROBE_MARKER)) return { state: 'patched', ok: true };
  return {
    state: 'unpatched',
    ok: false,
    devInstall: existsSync(path.join(root, DEV_INSTALL_SENTINEL)),
  };
}
