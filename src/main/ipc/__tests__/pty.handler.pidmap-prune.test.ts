import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regression test for the pid-map ghost-identity leak on explicit close.
 *
 * Context (cross-verified live by the W1+W2 dogfood agents, 2026-06-07):
 *   The ghost-workspace fix (30b3f77) added `removePidMapByPtyId` and wired it
 *   into `onDaemonSessionDied` (the daemon `session:died` event) so a dying
 *   shell's pid-map anchor is pruned at the WRITE boundary instead of accreting.
 *
 * The gap that test closes:
 *   `session:died` only fires on a NATURAL/unexpected PTY exit. The common
 *   close path — a pane/workspace close in the UI — goes
 *     PTY_DISPOSE → daemon.destroySession (RPC)
 *   and `DaemonSessionManager.destroySession` removes the bridge exit listener
 *   BEFORE killing, then emits `session:destroyed` — NOT `session:died`. The
 *   DaemonClient forwards that as `session:destroyed`, so `onDaemonSessionDied`
 *   never fires for an explicit close. Without a prune in the dispose handler
 *   itself, every UI-driven close leaked its anchor (observed: PID 37008 →
 *   daemon-33d7bc91 lingering after Workspace 3 was closed), giving the OS a
 *   recycled PID to turn into a ghost workspace id.
 *
 * Fix: the daemon-mode PTY_DISPOSE handler prunes the anchor itself.
 *
 * This test is structural — same rationale as the PTY_RESIZE retry test in this
 * directory: the bug shape is "a required call is missing from a specific
 * handler region", which the source catches with no IPC/daemon plumbing (the
 * handler module pulls in electron and can't be imported under vitest). It
 * guards BOTH prune call sites (dispose + session:died) so a future refactor
 * can't silently drop either, and that they route through the shared pid-map
 * helper. The helper's own content-keying / unlink behavior is exercised at
 * runtime in src/main/pty/__tests__/pidMap.test.ts.
 */
describe('pty.handler pid-map prune (ghost-identity leak on explicit close)', () => {
  const handlerPath = path.join(__dirname, '..', 'handlers', 'pty.handler.ts');
  const source = fs.readFileSync(handlerPath, 'utf-8');

  /**
   * Isolate the whole `// pty:dispose` region (both daemon and non-daemon
   * branches), bounded by the next handler's `// pty:list` marker. Throws if a
   * marker moved — itself a useful refactor signal.
   */
  function disposeRegion(): string {
    const match = source.match(/\/\/ pty:dispose[\s\S]*?\/\/ pty:list/);
    if (!match) {
      throw new Error(
        'pty:dispose → pty:list region not found in pty.handler.ts. If the ' +
          'file layout changed, update the regex before assuming the prune is gone.',
      );
    }
    return match[0];
  }

  it('daemon-mode dispose prunes the pid-map anchor after destroySession', () => {
    const region = disposeRegion();
    // The daemon branch is everything before the non-daemon `} else {`.
    const daemonBranch = region.split(/}\s*else\s*{/)[0];

    // The leaking close path. destroySession emits session:destroyed (not
    // session:died), so the prune MUST live here too — not only in the
    // session:died handler.
    expect(daemonBranch).toMatch(/daemon\.destroySession/);
    expect(daemonBranch).toMatch(/removePidMapByPtyId\(id\)/);
  });

  it('keeps the session:died prune wiring intact (no regression of 30b3f77)', () => {
    // The original natural-exit prune must survive alongside the new
    // dispose-path prune. Both teardown paths stay covered.
    expect(source).toMatch(/onDaemonSessionDied[\s\S]*?removePidMapByPtyId\(payload\.sessionId\)/);
  });

  it('routes both prune call sites through the shared pid-map helper', () => {
    // Both call sites must use the extracted, behavior-tested helper rather
    // than a re-inlined copy. A divergent inline implementation could drift
    // from the content-keying contract (e.g. flip to match by PID filename),
    // silently reviving the ghost accretion while this file's call-site
    // assertions above still pass.
    expect(source).toMatch(
      /import\s*\{[^}]*\bremovePidMapByPtyId\b[^}]*\}\s*from\s*['"][^'"]*\/pty\/pidMap['"]/,
    );
    // The helper must NOT be re-declared locally (that's what we moved out).
    expect(source).not.toMatch(/function\s+removePidMapByPtyId\b/);
  });
});
