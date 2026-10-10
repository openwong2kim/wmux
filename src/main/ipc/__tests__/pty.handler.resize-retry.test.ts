import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Regression test for the v2.9.0-rc.1 recovery-PTY mute race.
 *
 * Symptom (reported during v2.9.0-rc.1 dogfood, Windows reboot):
 *   After a reboot, every recovered pane accepted keystrokes but
 *   dropped echo and command output. Switching to another workspace
 *   and back restored output — at the cost of visual interference
 *   between the newly-flushed buffer and the previously-restored
 *   scrollback content.
 *
 * Root cause:
 *   Recovery sessions are created with `deferOutput=true`, which
 *   leaves the DaemonPTYBridge muted until `resizeSession` runs
 *   (DaemonSessionManager.ts:290-298 — the unmute trigger lives
 *   inside `resizeSession`, not `attachSession`). When useTerminal's
 *   first resize RPC lands before `daemon.attachSession` has
 *   registered the session, the daemon throws "Session 'X' not
 *   found", and the prior single-shot try/catch in `pty:resize`
 *   silently swallowed that error — so the bridge stayed muted
 *   forever.
 *
 *   Workspace switching triggered `fit()` again via useTerminal's
 *   visibility effect (useTerminal.ts:705-732), which retried the
 *   resize after attach had completed — unmuting the bridge and
 *   flushing the accumulated ring buffer over the restored
 *   scrollback area (the visual interference).
 *
 * Fix history:
 *   7d5fee3 (Wed May 13 10:03) "fix(daemon): unmute recovery PTY on
 *   attach via geometry handoff" — reordered daemon attach/resize so
 *   attach itself unmuted. Reverted in e032ae3 (Wed May 13 13:38)
 *   because the new sequencing hit an OSC 7 ConPTY interaction
 *   (`e]7;file://HOST/...` rendered as raw text on first prompt).
 *   The revert message named two v2.9.1 fix options:
 *     (1) retry-on-not-found in pty.handler.ts pty:resize  ← this fix
 *     (2) attach-ack-then-resize ordering driven from the renderer
 *
 *   Option (1) is the smallest blast radius: it does not reorder
 *   daemon-side attach/resize, so the OSC 7 regression cannot
 *   resurface. The retry rides out the attach race entirely on the
 *   main-process IPC handler boundary.
 *
 * This test is structural: it scans `pty.handler.ts` and fails if a
 * future refactor strips the retry loop or weakens the constants.
 * A behavioral test using a mocked DaemonClient would also work, but
 * the structural shape of the bug is "the wrong single-shot catch is
 * called from the wrong place" — checking the source directly catches
 * the regression with no plumbing.
 */
describe('pty.handler PTY_RESIZE retry (v2.9.0-rc.2 recovery race)', () => {
  const handlerPath = path.join(__dirname, '..', 'handlers', 'pty.handler.ts');
  const source = fs.readFileSync(handlerPath, 'utf-8');

  /**
   * Narrow to the daemon-mode PTY_RESIZE handler region so retry-loop
   * assertions can't match unrelated code elsewhere in the file.
   * Throws if the region marker has moved — that itself is a useful
   * signal during refactors.
   */
  function resizeBlock(): string {
    const match = source.match(
      /ipcMain\.handle\(IPC\.PTY_RESIZE,[\s\S]*?ipcMain\.handle\(IPC\.PTY_DISPOSE/,
    );
    if (!match) {
      throw new Error(
        'PTY_RESIZE → PTY_DISPOSE handler region not found in pty.handler.ts. ' +
          'If the file layout changed, update the regex above before assuming ' +
          'the retry logic is gone.',
      );
    }
    return match[0];
  }

  it('declares retry constants at module scope', () => {
    // If this fires, a future change removed or renamed the retry
    // constants. The recovery PTY mute race comes back the next time
    // someone reboots and useTerminal's first resize loses to attach.
    //
    // Budget: 50 attempts * 20ms = ~1s. Lower budgets (the original
    // 5 * 20 = 80ms) were observed to be too short during dogfood —
    // attach can stretch into hundreds of ms on cold restart and the
    // shorter budget left the bridge muted.
    expect(source).toMatch(/const\s+RESIZE_RETRY_ATTEMPTS\s*=\s*50\b/);
    expect(source).toMatch(/const\s+RESIZE_RETRY_DELAY_MS\s*=\s*20\b/);
  });

  it('PTY_RESIZE handler uses a retry loop with the retry constants', () => {
    const block = resizeBlock();
    // Retry loop must reference the named constant — not a hardcoded
    // literal — so the constant doc block stays authoritative.
    expect(block).toMatch(/for\s*\([^)]*attempt[^)]*<\s*RESIZE_RETRY_ATTEMPTS/);
    expect(block).toMatch(/RESIZE_RETRY_DELAY_MS/);
  });

  it('retry loop gates on "not found" / "not exist" error messages', () => {
    const block = resizeBlock();
    // Non-not-found errors must continue to throw immediately. If this
    // assertion fires, the retry loop has been broadened to swallow
    // unrelated daemon errors — which would hide real failures behind
    // an ~80ms stall on every resize.
    expect(block).toMatch(/includes\(['"]not found['"]\)/);
    expect(block).toMatch(/includes\(['"]not exist['"]\)/);
    // The non-not-found path must throw, not return.
    expect(block).toMatch(/if\s*\(!\s*isNotFound\)\s*throw\s+err/);
  });

  it('preserves graceful-return behavior on the final not-found failure', () => {
    const block = resizeBlock();
    // The prior single-shot handler swallowed not-found because the
    // session can also genuinely disappear (reconciliation, post-dispose
    // race). That behavior must survive the retry: after exhausting
    // attempts, the handler still returns gracefully. Otherwise we'd
    // surface noise for normal teardown races.
    expect(block).toMatch(/attempt\s*===\s*RESIZE_RETRY_ATTEMPTS\s*-\s*1/);
    // The final-attempt branch must return, not throw.
    expect(block).toMatch(/Final attempt[\s\S]*?return;/);
  });

  it('retry loop sleeps between attempts via setTimeout', () => {
    const block = resizeBlock();
    // Without a delay, the retry would burn through all attempts in
    // microseconds and still lose to attach completion. The 20ms
    // spacing gives attach a real window to finish.
    expect(block).toMatch(/setTimeout\([^,]+,\s*RESIZE_RETRY_DELAY_MS\)/);
  });

  it('logs a diagnostic line when retry actually rode out >=1 attempt', () => {
    const block = resizeBlock();
    // We need to know how many attempts dogfood is hitting in the
    // wild — that's the data we need to decide whether to keep
    // tuning the budget or move to renderer-side attach-await
    // (option 2). The success log fires only when attempt > 0 so
    // steady-state resize stays silent.
    expect(block).toMatch(/attach race retry succeeded/);
    expect(block).toMatch(/attempt\s*>\s*0/);
  });

  it('warns on retry exhaustion so dogfood can spot real-world latency tail', () => {
    const block = resizeBlock();
    // If exhaustion ever fires in dogfood, the attach is taking
    // longer than the budget — which means option 2 is mandatory,
    // not optional. The warn line gives a clear breadcrumb.
    expect(block).toMatch(/attach race retry exhausted/);
  });

  it('surfaces a daemon "rate limited" reply as a failure so the renderer re-sends', () => {
    const block = resizeBlock();
    // Swallowing it (`if (…'rate limit'…) return;`) resolved the IPC as success,
    // so useTerminal's sendResize never ran its one delayed re-send and a burst's
    // final size could be lost. The error must reach `throw err` instead.
    expect(block).not.toMatch(/rate limit[^\n]*\)\s*return\b/);
    expect(block).toMatch(/if\s*\(!\s*isNotFound\)\s*throw\s+err/);
    // The renderer side of the contract: the rejection is recognised by message.
    const renderer = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'renderer', 'hooks', 'useTerminal.ts'), 'utf-8');
    expect(renderer).toMatch(/pty\.resize\(targetPtyId, cols, rows\)\.catch[\s\S]{0,200}includes\('rate limited'\)/);
  });
});
