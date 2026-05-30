import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Fix D (2026-05-30 blank-terminal-on-restore) regression lock.
//
// Original root cause: the mount-time daemon reattach lived INSIDE the main
// terminal-creation effect, guarded with `() => terminalRef.current ===
// terminal`. reconnectPtyWithRetry evaluates that isCurrent guard SYNCHRONOUSLY
// on invocation — but the call ran BEFORE the effect's own later
// `terminalRef.current = terminal` assignment, so on every fresh mount the guard
// was false, the retry bailed immediately, and pty.reconnect was never called.
// The daemon never attached a SessionPipe to a recovered session: no RingBuffer
// replay, blank terminal.
//
// Fix: a dedicated effect that runs AFTER the mount effect (so terminalRef is
// set) and reattaches when daemon mode is active at mount OR on a later
// daemon:connected, guarded with `terminalRef.current !== null`.
//
// Codex review P2 hardening: the daemon:connected path must NOT be gated on
// isDaemonModeActive() (our listener can run before AppLayout flips that module
// flag, dropping the only reattach for that generation) and must NOT be
// permanently latched (a respawn fires daemon:connected again and must reattach
// to the new daemon generation — an `attached = true` latch left the pane bound
// to a dead session). A transient in-flight guard prevents only the concurrent
// active-at-mount + daemon:connected double-replay.
//
// useTerminal is a large xterm-bound hook, so (matching the A6 race-cancel test)
// the structural invariants are locked at the source level.
describe('Fix D — daemon session reattach (source-level)', () => {
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
    // A reconnect call here runs before terminalRef is assigned, so its
    // isCurrent guard bails and the reattach silently no-ops (the original bug).
    expect(mainEffect).not.toMatch(/reconnectPtyWithRetry\(/);
  });

  it('reattaches from a dedicated effect after the main effect', () => {
    expect(afterMainEffect).toMatch(/reconnectPtyWithRetry\(/);
  });

  it('never passes the assigned-later `() => terminalRef.current === terminal` guard', () => {
    expect(src).not.toContain('() => terminalRef.current === terminal');
    expect(afterMainEffect).toMatch(/terminalRef\.current !== null/);
  });

  it('reattaches on daemon:connected for late-connect / respawn', () => {
    expect(afterMainEffect).toMatch(/daemon\.onConnected\(\s*\(\)\s*=>\s*reattach\(/);
  });

  it('gates only the at-mount reattach on isDaemonModeActive(), never the event path (Codex P2)', () => {
    // active-at-mount has no event to ride, so it reads the module flag once.
    expect(afterMainEffect).toMatch(/if\s*\(\s*isDaemonModeActive\(\)\s*\)\s*reattach\(/);
    // The reattach helper itself must NOT re-check the flag — a daemon:connected
    // that races AppLayout's flag flip would otherwise be dropped.
    const reIdx = afterMainEffect.indexOf('const reattach =');
    const reEnd = afterMainEffect.indexOf('\n    };', reIdx); // helper close
    expect(reIdx).toBeGreaterThan(0);
    expect(reEnd).toBeGreaterThan(reIdx);
    expect(afterMainEffect.slice(reIdx, reEnd)).not.toMatch(/isDaemonModeActive\(/);
  });

  it('does not permanently latch the reattach so a respawn reattaches again (Codex P2)', () => {
    // The bug latched with `attached = true` after the first attach, dropping
    // every daemon generation after the first. The guard must be a transient
    // in-flight flag, not a permanent latch.
    expect(afterMainEffect).not.toMatch(/attached\s*=\s*true/);
    expect(afterMainEffect).toMatch(/inFlight/);
  });
});
