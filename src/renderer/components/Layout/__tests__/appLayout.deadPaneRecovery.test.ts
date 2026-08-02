import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'src/renderer/components/Layout/AppLayout.tsx'),
  'utf8',
);

describe('AppLayout dead-pane recovery wiring (#650)', () => {
  const start = source.indexOf('const reconcilePtys = useCallback');
  const end = source.indexOf('// 앱 시작 시 세션 복원', start);
  const reconcile = source.slice(start, end);

  it('requests tombstones explicitly and excludes them from the active set', () => {
    expect(reconcile).toMatch(/pty\.list\(\{ includeDead: true \}\)/);
    expect(reconcile).toMatch(/listedPtys\.filter\(\(p\) => p\.state !== 'dead'\)/);
  });

  it('preserves unknown ids on an empty live list but still recovers confirmed tombstones', () => {
    expect(reconcile).toMatch(/preserveUnconfirmedOnEmpty\s*=\s*activeIds\.size === 0 && hasSavedPtyIds/);
    expect(reconcile).toMatch(/preserveUnconfirmedOnEmpty && !deadPtys\.has\(surface\.ptyId\)/);
  });

  it('stages recovery before clearing the stale surface binding', () => {
    const clearBranch = reconcile.indexOf("const deadSession = deadPtys.get(a.stalePtyId)");
    const stage = reconcile.indexOf('stageDeadPaneRecovery(', clearBranch);
    const clear = reconcile.indexOf('updateSurfacePtyId(a.paneId, a.surfaceId, a.newPtyId)', clearBranch);
    expect(clearBranch).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(clearBranch);
    expect(clear).toBeGreaterThan(stage);
  });
});
