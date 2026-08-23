import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #1002 — terminal adoption across a pane-tree restructure, locked at the
// source level.
//
// The bug: splitting a pane replaced the target leaf with a new branch node, so
// React unmounted and remounted the surviving leaf. The unmount disposed its
// xterm; the remount built a fresh one and refilled it from the daemon ring
// buffer, and the user watched the conversation get written from the top down.
//
// The fix parks the live terminal on teardown and adopts it on the next mount
// for the same ptyId. Four things have to stay true or the replay comes back
// silently, and none of them are reachable from a unit test of this hook —
// useTerminal is a 2600-line xterm-bound effect. Matching the daemon-reattach
// and A6 race-cancel tests, the invariants are asserted against the source.
describe('#1002 — pane-restructure terminal adoption (source-level)', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  // Main terminal-creation effect: from its unique `if (!container || !ptyId)
  // return;` guard to the next `}, [ptyId, containerRef]);`.
  const mainStart = src.indexOf('if (!container || !ptyId) return;');
  const mainEffectEnd = src.indexOf('}, [ptyId, containerRef]);', mainStart);
  const mainEffect = src.slice(mainStart, mainEffectEnd);
  const afterMainEffect = src.slice(mainEffectEnd);

  it('locates the main effect boundary', () => {
    expect(mainStart).toBeGreaterThan(0);
    expect(mainEffectEnd).toBeGreaterThan(mainStart);
  });

  it('asks for a parked terminal before it constructs one', () => {
    const adoptAt = mainEffect.indexOf('adoptTerminal(ptyId)');
    const constructAt = mainEffect.indexOf('new Terminal({');
    expect(adoptAt).toBeGreaterThan(-1);
    expect(constructAt).toBeGreaterThan(-1);
    // A construct-then-discard order would create a second xterm per split —
    // the cost the adoption is meant to remove.
    expect(adoptAt).toBeLessThan(constructAt);
    expect(mainEffect).toMatch(/const terminal = adopted \? adopted\.terminal : new Terminal\(\{/);
  });

  it('adopts by moving the element, never by re-opening the terminal', () => {
    // terminal.open() rebuilds the screen — precisely what adoption preserves.
    expect(mainEffect).toMatch(/if \(adopted\) \{[\s\S]*container\.appendChild\(adopted\.element\);[\s\S]*\} else \{[\s\S]*terminal\.open\(container\);/);
    // And exactly one open() call site, still on the fresh-terminal side.
    expect(mainEffect.match(/terminal\.open\(/g)).toHaveLength(1);
  });

  it('skips the scrollback restore for an adopted terminal', () => {
    // The adopted instance already holds the scrollback; running the `.txt`
    // restore would write a second copy over the screen it reproduces.
    expect(mainEffect).toMatch(/if \(scrollbackFile && !adopted\) \{/);
  });

  it('clears the restore overlay on the adopting mount', () => {
    // Terminal.tsx raises `restoring` for any scrollbackFile pane and drops it
    // on first data. An adopted pane has no replay coming, so without this the
    // split trades the scroll-from-the-top flash for a 3 s curtain.
    expect(mainEffect).toMatch(/if \(adopted\) fireFirstData\(\);/);
  });

  it('suppresses only the active-at-mount daemon reattach after an adoption', () => {
    // pty.reconnect is what makes the daemon replay its ring buffer. An
    // adopting mount is still attached, so asking for one buys nothing but the
    // replay.
    expect(afterMainEffect).toMatch(/if \(isDaemonModeActive\(\) && !adoptedAtMountRef\.current\) reattach\('active-at-mount'\);/);
    // A later connect/respawn is a real new daemon generation and MUST still
    // reattach — gating that would strand the pane on a dead session.
    expect(afterMainEffect).toMatch(/daemon\.onConnected\(\(\) => reattach\('daemon:connected'\)\)/);
    expect(afterMainEffect).not.toMatch(/adoptedAtMountRef[\s\S]{0,80}daemon:connected/);
  });

  it('parks on teardown only when the buffer is a faithful copy of the session', () => {
    // A dirty pane, or one mid-resync, is exactly the case that needs the
    // replay: adopting it would leave a stale screen with nothing to repair it.
    expect(mainEffect).toMatch(/const canPark = parkElement !== null\s*\n\s*&& !resyncRef\.current\.pending\s*\n\s*&& !isTerminalDirty\(terminal\);/);
    expect(mainEffect).toMatch(/parkTerminal\(ptyId, terminal, parkElement, disposeTerminal\)/);
  });

  it('reads the resync flag before teardown clears it', () => {
    // cancelResync() wipes `pending`, so a canPark computed after it would read
    // false-clean on every pane that was mid-resync — the one case that must
    // not be adopted.
    const canParkAt = mainEffect.indexOf('const canPark =');
    const cancelResyncAt = mainEffect.indexOf('cancelResync(ptyId);');
    expect(canParkAt).toBeGreaterThan(-1);
    expect(cancelResyncAt).toBeGreaterThan(canParkAt);
  });

  it('keeps a parked terminal\'s queued output and discards it if the park expires', () => {
    // The scheduler queue belongs to the instance. Discarding it on the way out
    // would drop bytes the adopting mount is the only reader of, and (unlike
    // the dispose path) no resync follows to replace them.
    expect(mainEffect).toMatch(/if \(!canPark\) discardTerminalOutput\(terminal\);/);
    expect(mainEffect).toMatch(/const disposeTerminal = \(\) => \{\s*\n\s*discardTerminalOutput\(terminal\);\s*\n\s*disposeWhenDragEnds\(\(\) => terminal\.dispose\(\)\);/);
  });

  it('releases the addons it loaded before parking', () => {
    // terminal.dispose() is what normally disposes them, and a parked terminal
    // never reaches it — the adopting mount loads its own set, so without this
    // the instance accumulates one per restructure.
    expect(mainEffect).toMatch(/if \(canPark\) \{[\s\S]*fitAddon\.dispose\(\);[\s\S]*searchAddon\.dispose\(\);[\s\S]*webLinksAddon\.dispose\(\);[\s\S]*parkTerminal\(/);
  });

  it('still disposes directly when the terminal cannot be parked', () => {
    expect(mainEffect).toMatch(/\} else \{\s*\n\s*disposeWhenDragEnds\(\(\) => terminal\.dispose\(\)\);\s*\n\s*\}/);
  });
});
