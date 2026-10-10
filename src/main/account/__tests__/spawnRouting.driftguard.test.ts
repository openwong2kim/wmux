// Drift guard (Codex 3-way review P1): the original plan said "wire accountEnv at
// both PTY callsites", but there are FIVE vendor-process launch paths, and any
// new one that spawns a vendor CLI while bypassing the account seam would
// silently run on the DEFAULT account. This test pins the known launch paths to
// the account store so a future edit that removes the wiring — or a NEW spawn
// site added without it — fails loudly here.
//
// It is intentionally a coarse source-string assertion, not a runtime test:
// the failure mode we guard against is "someone adds src/main/.../fooSpawn.ts
// that calls spawn('claude') and forgets the account env". When that happens,
// add the new file to KNOWN_VENDOR_SPAWN_PATHS (PTY) or BACKGROUND_SPAWN_PATHS
// with its wiring — that edit is
// the checklist item this test forces.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../../..');

/** Every file that creates a vendor (claude/codex) child process. Each MUST
 *  resolve account env through the shared store. */
const KNOWN_VENDOR_SPAWN_PATHS = [
  'src/main/pty/PTYManager.ts',
  'src/main/ipc/handlers/pty.handler.ts',
];

/** Background claude launches (no PTY_CREATE gate). Each MUST resolve its
 *  account through resolveBackgroundLaunch so "Switch accounts by quota" and
 *  the out-of-quota hold reach them too. */
const BACKGROUND_SPAWN_PATHS = [
  'src/main/deck/ClaudeSdkAdapter.ts',
  'src/main/deck/ClaudePtyBrainAdapter.ts',
  'src/main/a2a/ClaudeWorker.ts',
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('account spawn-routing drift guard', () => {
  it.each(KNOWN_VENDOR_SPAWN_PATHS)('%s routes through getAccountStore', (rel) => {
    const src = read(rel);
    expect(src, `${rel} must resolve account env via getAccountStore (multi-account M0)`).
      toContain('getAccountStore');
  });

  it.each(BACKGROUND_SPAWN_PATHS)('%s routes through resolveBackgroundLaunch', (rel) => {
    const src = read(rel);
    expect(src, `${rel} must resolve its account via resolveBackgroundLaunch`).toContain('resolveBackgroundLaunch(');
    expect(src, `${rel} must not bypass quota with a bare binding read`).not.toContain('resolveAccountEnv(');
  });

  it('every resolveSpawnEnv caller references accountEnv', () => {
    // The two PTY callsites take account env as the 6th positional arg. A file
    // that calls resolveSpawnEnv but never mentions accountEnv has dropped the
    // wiring — file-level check avoids brittle balanced-paren parsing.
    for (const rel of ['src/main/pty/PTYManager.ts', 'src/main/ipc/handlers/pty.handler.ts']) {
      const src = read(rel);
      expect(src, `${rel} should call resolveSpawnEnv`).toContain('resolveSpawnEnv(');
      expect(src, `${rel}: resolveSpawnEnv wiring must pass accountEnv`).toContain('accountEnv');
    }
  });

  it('resolveSpawnEnv applies accountEnv BEFORE the profile (manual override wins)', () => {
    const src = read('src/main/pty/resolveSpawnEnv.ts');
    const accountIdx = src.indexOf('applyOverlay(env, accountEnv)');
    const profileIdx = src.indexOf('applyOverlay(env, profileEnv)');
    expect(accountIdx).toBeGreaterThan(-1);
    expect(profileIdx).toBeGreaterThan(-1);
    // Account overlay must be applied first so the profile can override it.
    expect(accountIdx).toBeLessThan(profileIdx);
  });
});
