// Unit tests for the postinstall patch probe (scripts/lib/patch-verify.mjs).
//
// The 2026-09-07 incident: a hybrid node_modules (dev deps present,
// patch-package missing) let the postinstall hook skip patch application
// silently; the damage surfaced days later as an atlasCoherence failure and
// phantom tsc errors. These tests pin the probe's four verdicts so the
// hook's failure-mode selection (in apply-patches.mjs) always has truthful
// input. The script-level branching is exercised by the dogfood procedure in
// the PR description; here we stub the fs surface with a fabricated tree.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  verifyPatchState,
  PATCH_PROBE_FILE,
  PATCH_PROBE_MARKER,
  DEV_INSTALL_SENTINEL,
} from '../lib/patch-verify.mjs';

function makeTree({ probeContent, devInstall }) {
  const root = mkdtempSync(path.join(tmpdir(), 'patch-verify-'));
  if (probeContent !== undefined) {
    const probe = path.join(root, PATCH_PROBE_FILE);
    mkdirSync(path.dirname(probe), { recursive: true });
    writeFileSync(probe, probeContent, 'utf8');
  }
  if (devInstall) {
    const sentinel = path.join(root, DEV_INSTALL_SENTINEL);
    mkdirSync(path.dirname(sentinel), { recursive: true });
    writeFileSync(sentinel, 'stub', 'utf8');
  }
  return root;
}

describe('verifyPatchState', () => {

  it('reports patched when the marker is present', () => {
    const root = makeTree({ probeContent: `garbage ${PATCH_PROBE_MARKER} garbage`, devInstall: true });
    try {
      expect(verifyPatchState(fs, root)).toEqual({ state: 'patched', ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('passes when the probe target is absent (scoped/partial install)', () => {
    const root = makeTree({ probeContent: undefined, devInstall: false });
    try {
      expect(verifyPatchState(fs, root)).toEqual({ state: 'target-absent', ok: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails an unpatched tree and flags a dev install (the hybrid incident state)', () => {
    const root = makeTree({ probeContent: 'pristine upstream bundle', devInstall: true });
    try {
      expect(verifyPatchState(fs, root)).toEqual({ state: 'unpatched', ok: false, devInstall: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails an unpatched production-style tree without the devInstall flag', () => {
    const root = makeTree({ probeContent: 'pristine upstream bundle', devInstall: false });
    try {
      expect(verifyPatchState(fs, root)).toEqual({ state: 'unpatched', ok: false, devInstall: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats an unreadable probe file as unpatched, never as a silent pass', () => {
    const deps = {
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('EACCES');
      },
    };
    // existsSync always true also fakes the sentinel; what matters is the
    // verdict: a probe we cannot read must not verify as patched.
    expect(verifyPatchState(deps, '/nonexistent-root')).toMatchObject({ state: 'unpatched', ok: false });
  });
});
