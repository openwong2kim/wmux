/**
 * v2 RCA fix (reboot-reattach, axis A) — AppLayout session-save invariants.
 *
 * Structural test (house pattern: sessionEnd.daemonShutdown.test.ts,
 * pty.handler.resize-retry.test.ts): AppLayout has no jsdom fixture, and these
 * invariants encode review-confirmed data-loss/correctness decisions that a
 * refactor could silently undo with every unit test staying green:
 *
 *   1. The startup save runs on the SUCCESS path only, generation-guarded —
 *      NOT in the finally (the catch just ran clearAllPtyState; persisting
 *      that wipes good ptyIds from disk — codex P1).
 *   2. The registered saver + beforeunload are BOTH gated on sessionLoadedRef
 *      (a failed session.load must never let the default empty workspace
 *      overwrite a good session.json — Claude adversarial P2).
 *   3. Rebind/clear actions apply through a compare-and-swap on the surface's
 *      CURRENT ptyId (a ≥600ms-stale snapshot must not stomp a ptyId that
 *      useTerminal's own reattach already replaced — Claude adversarial P2).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('AppLayout — axis A session-save invariants', () => {
  const appLayoutPath = path.join(__dirname, '..', 'AppLayout.tsx');
  const source = fs.readFileSync(appLayoutPath, 'utf-8');

  function startupRegion(): string {
    const start = source.indexOf('// 앱 시작 시 세션 복원');
    expect(start, 'startup restore effect not found').toBeGreaterThanOrEqual(0);
    const end = source.indexOf('First-run wizard', start);
    return source.slice(start, end > 0 ? end : start + 8000);
  }

  it('startup save is success-only + generation-guarded, and NOT in the finally', () => {
    const region = startupRegion();
    expect(region).toMatch(/if \(gen === startupGenRef\.current\) saveSessionNow\(\);/);
    const finallyIdx = region.indexOf('} finally {');
    expect(finallyIdx).toBeGreaterThan(0);
    const finallyBlock = region.slice(finallyIdx, region.indexOf('})();', finallyIdx));
    expect(finallyBlock).not.toContain('saveSessionNow');
  });

  it('registered saver and beforeunload share the sessionLoadedRef guard', () => {
    // The guarded closure must check sessionLoadedRef before saving…
    expect(source).toMatch(/const saveSessionGuarded = \(\) => \{\s*\n\s*if \(!sessionLoadedRef\.current\) return;/);
    // …and be the thing registered AND bound to beforeunload (not the raw saver).
    expect(source).toMatch(/registerSessionSaver\(saveSessionGuarded\)/);
    expect(source).toMatch(/addEventListener\('beforeunload', saveSessionGuarded\)/);
    expect(source).not.toMatch(/addEventListener\('beforeunload', saveSession\)/);
  });

  it('rebind/clear actions CAS-guard on the surface’s current ptyId', () => {
    const idx = source.indexOf('resolveReconcileRebind(absentCandidates');
    expect(idx, 'rebind decision call not found').toBeGreaterThanOrEqual(0);
    const applyRegion = source.slice(idx, idx + 3000);
    expect(applyRegion).toMatch(/currentPtyId !== a\.stalePtyId/);
    // Rebind targets must come from the freshest (second) snapshot when available.
    expect(applyRegion).toMatch(/secondSnapshot \?\? activePtys/);
  });
});
