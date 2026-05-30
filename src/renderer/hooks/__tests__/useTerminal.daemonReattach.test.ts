import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Fix D (2026-05-30 blank-terminal-on-restore) regression lock.
//
// Root cause: the mount-time daemon reattach used to live INSIDE the main
// terminal-creation effect, guarded with `() => terminalRef.current ===
// terminal`. reconnectPtyWithRetry() evaluates that isCurrent guard
// SYNCHRONOUSLY on invocation — but the invocation happened BEFORE the effect's
// own later `terminalRef.current = terminal` assignment ran. So on every fresh
// mount the guard was false, reconnectPtyWithRetry bailed at its first
// `if (!isCurrent()) return`, and pty.reconnect was NEVER called. The daemon
// therefore never attached a SessionPipe, no RingBuffer replay arrived, and a
// recovered session rendered blank (the dogfood symptom: 20 live daemon
// sessions, zero daemon-side attachSession).
//
// Fix: the reattach moved to a DEDICATED effect that runs AFTER the main effect
// (so terminalRef.current is set), fires when daemon mode is active at mount OR
// on a later daemon:connected (fresh-daemon-spawn race / mid-session respawn),
// and guards with `terminalRef.current !== null` instead of the assigned-later
// `=== terminal`.
//
// useTerminal is a large xterm-bound hook, so (matching the A6 race-cancel
// test) the structural invariants are locked at the source level.
describe('Fix D — daemon session reattach fires after terminalRef is set (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  // Main terminal-creation effect: from its unique `if (!container || !ptyId)
  // return;` guard to the next `}, [ptyId, containerRef]);` (the `fit`
  // useCallback shares those deps and closes earlier, so anchor past mainStart).
  const mainStart = src.indexOf('if (!container || !ptyId) return;');
  const mainEffectEnd = src.indexOf('}, [ptyId, containerRef]);', mainStart);
  const mainEffect = src.slice(mainStart, mainEffectEnd);
  const afterMainEffect = src.slice(mainEffectEnd);

  it('locates the main effect boundary', () => {
    expect(mainStart).toBeGreaterThan(0);
    expect(mainEffectEnd).toBeGreaterThan(mainStart);
  });

  it('does NOT call reconnectPtyWithRetry inside the main mount effect', () => {
    // The buggy location. A reconnect call here runs before terminalRef is
    // assigned, so its isCurrent guard bails and the reattach silently no-ops.
    expect(mainEffect).not.toMatch(/reconnectPtyWithRetry\(/);
  });

  it('reattaches from a dedicated effect that runs after the main effect', () => {
    expect(afterMainEffect).toMatch(/reconnectPtyWithRetry\(/);
  });

  it('never passes the assigned-later `() => terminalRef.current === terminal` guard to reconnect', () => {
    // That comparison is false until the main effect assigns terminalRef at its
    // very end; using it as the reattach isCurrent guard is the exact bug.
    expect(src).not.toContain('() => terminalRef.current === terminal');
  });

  it('reattach effect wires a daemon.onConnected listener (late-connect / respawn)', () => {
    // Must also fire when the daemon connects AFTER mount, not only at mount —
    // the fresh-daemon-spawn startup race and mid-session respawn both land here.
    expect(afterMainEffect).toMatch(/daemon\.onConnected\(/);
  });

  it('reattach is gated on isDaemonModeActive() and guarded by a non-null terminalRef', () => {
    const reattachIdx = afterMainEffect.indexOf('reconnectPtyWithRetry(');
    const region = afterMainEffect.slice(Math.max(0, reattachIdx - 700), reattachIdx + 300);
    expect(region).toMatch(/isDaemonModeActive\(\)/);
    expect(region).toMatch(/terminalRef\.current !== null/);
  });
});
