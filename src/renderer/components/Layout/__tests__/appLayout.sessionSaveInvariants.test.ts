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

  // Fix B — cap-skipped suspended promote. Boot recovery honours a session cap,
  // so a workspace beyond the cap came back with its ptyId absent and reconcile
  // destructively cleared it (losing the pane's scrollback and identity). The
  // promote attempt must therefore run BEFORE the clear path, and only ptyIds
  // that are still absent afterwards may be cleared or rebound.
  describe('Fix B — promote before clear', () => {
    function reconcileRegion(): string {
      const start = source.indexOf('if (absentCandidates.length > 0');
      expect(start, 'absent-candidate branch not found').toBeGreaterThanOrEqual(0);
      return source.slice(start, start + 4000);
    }

    it('attempts a promote before computing the clear set', () => {
      const region = reconcileRegion();
      const promoteAt = region.indexOf('pty.promote(');
      const clearAt = region.indexOf('const firstAbsent');
      expect(promoteAt, 'promote call not found').toBeGreaterThanOrEqual(0);
      expect(clearAt, 'firstAbsent not found').toBeGreaterThanOrEqual(0);
      expect(promoteAt).toBeLessThan(clearAt);
    });

    it('only asks the daemon to promote ptyIds it confirmed are SUSPENDED', () => {
      const region = reconcileRegion();
      // The suspended set comes from an includeSuspended listing, not from the
      // absent set — promoting an id that is merely missing would spawn a
      // session the daemon never had.
      expect(region).toMatch(/pty\.list\(\{ includeSuspended: true \}\)/);
      expect(region).toMatch(/state === 'suspended'/);
      expect(region).toMatch(/if \(!suspendedIds\.has\(candidate\.ptyId\)\) \{[\s\S]*?stillAbsent\.push\(candidate\);/);
    });

    it('keeps a FAILED promote on the clear path (cap hit / spawn error)', () => {
      const region = reconcileRegion();
      // Both the ipc-level failure and a {success:false} body must fall through
      // to stillAbsent, or a pane whose promote failed would be left bound to a
      // ptyId that does not exist.
      expect(region).toMatch(/if \(promoteRes\.ok && promoteRes\.data\.success\)/);
      const elseAt = region.indexOf('} else {', region.indexOf('promoteRes.ok && promoteRes.data.success'));
      expect(elseAt).toBeGreaterThan(0);
      expect(region.slice(elseAt, elseAt + 400)).toContain('stillAbsent.push(candidate)');
    });

    it('falls back to the pre-Fix-B behaviour when the promote API is absent', () => {
      // An older main process (or local mode) exposes no pty.promote; reconcile
      // must then treat every absent candidate exactly as before.
      const region = reconcileRegion();
      expect(region).toMatch(/if \(window\.electronAPI\?\.pty\?\.promote\)/);
      expect(region).toMatch(/stillAbsent\.push\(\.\.\.absentCandidates\)/);
    });

    it('respects the abort signal inside the promote loop', () => {
      const region = reconcileRegion();
      const loopAt = region.indexOf('for (const candidate of absentCandidates)');
      expect(loopAt).toBeGreaterThanOrEqual(0);
      expect(region.slice(loopAt, loopAt + 200)).toMatch(/if \(signal\?\.aborted\) break;/);
    });
  });

  it('rebind/clear actions CAS-guard on the surface’s current ptyId', () => {
    const idx = source.indexOf('resolveReconcileRebind(stillAbsent');
    expect(idx, 'rebind decision call not found').toBeGreaterThanOrEqual(0);
    const applyRegion = source.slice(idx, idx + 3000);
    expect(applyRegion).toMatch(/currentPtyId !== a\.stalePtyId/);
    // Rebind targets must come from the freshest (second) snapshot when available.
    expect(applyRegion).toMatch(/secondSnapshot \?\? activePtys/);
  });
});
