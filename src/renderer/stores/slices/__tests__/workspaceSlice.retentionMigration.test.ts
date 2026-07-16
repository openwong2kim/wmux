import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// P0-1 (app-weight plan) — source-level wiring checks for the retention
// default flip + one-shot migration. Full loadSession is too entangled for a
// slice harness (same convention as useTerminal.hiddenRetention.test.ts); the
// ledger POLICY itself is behaviorally covered by retentionMigration.test.ts.
const workspaceSrc = fs.readFileSync(
  path.join(__dirname, '..', 'workspaceSlice.ts'), 'utf-8');
const uiSrc = fs.readFileSync(
  path.join(__dirname, '..', 'uiSlice.ts'), 'utf-8');

describe('retention default flip — migration wiring (source-level)', () => {
  it('uiSlice defaults hiddenPaneRetentionEnabled to true', () => {
    expect(uiSrc).toMatch(/hiddenPaneRetentionEnabled:\s*true,/);
  });

  it('the Settings setter stamps the ledger (explicit intent is permanent — fresh-install case)', () => {
    // lastIndexOf: the first occurrence is the interface declaration.
    const idx = uiSrc.lastIndexOf('setHiddenPaneRetentionEnabled:');
    expect(idx).toBeGreaterThan(0);
    expect(uiSrc.slice(idx, idx + 500)).toMatch(/markRetentionMigrationDone\(\)/);
  });

  it('loadSession flips a persisted false ONLY when the ledger marker is absent', () => {
    expect(workspaceSrc).toMatch(
      /data\.hiddenPaneRetentionEnabled === false && !retentionMigrationDone\(\)/,
    );
  });

  it('loadSession preserves the persisted value when no migration applies', () => {
    const idx = workspaceSrc.indexOf('data.hiddenPaneRetentionEnabled === false');
    expect(idx).toBeGreaterThan(0);
    expect(workspaceSrc.slice(idx, idx + 2800)).toMatch(
      /state\.hiddenPaneRetentionEnabled = data\.hiddenPaneRetentionEnabled/,
    );
  });

  it('loadSession stamps the ledger unconditionally after processing', () => {
    const idx = workspaceSrc.indexOf('data.hiddenPaneRetentionEnabled === false');
    expect(workspaceSrc.slice(idx, idx + 2200)).toMatch(/markRetentionMigrationDone\(\)/);
  });

  it('the migration announces itself with a one-time toast (post-upgrade notice)', () => {
    const idx = workspaceSrc.indexOf('one-shot default-ON migration applied');
    expect(idx).toBeGreaterThan(0);
    expect(workspaceSrc.slice(idx, idx + 900)).toMatch(/pushToast\(/);
  });
});
