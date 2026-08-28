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

  // Every clause of canPark is a state in which the adopting mount — which
  // skips both the restore and the reconnect — would inherit a screen nothing
  // is coming to repair. Each is pinned separately: a single regex over the
  // whole condition breaks on formatting and says nothing about WHICH guard
  // went missing.
  const refusalLadder = mainEffect.slice(
    mainEffect.indexOf('const parkRefusal ='),
    mainEffect.indexOf('const canPark ='),
  );

  it.each([
    ['no-element', /parkElement === null \? 'no-element'/],
    ['resync-pending', /resyncRef\.current\.pending \? 'resync-pending'/],
    ['dirty', /isTerminalDirty\(terminal\) \? 'dirty'/],
    ['restore-unsettled', /!restoreSettled \? 'restore-unsettled'/],
    ['txt-awaiting-verdict', /didRestoreTxt \? 'txt-awaiting-verdict'/],
    ['reconnect-in-flight', /reconnectInFlightRef\.current \? 'reconnect-in-flight'/],
    ['not-registry-owner', /terminalRegistry\.get\(ptyId\) !== terminal \? 'not-registry-owner'/],
  ])('refuses to park with reason %s', (_reason, pattern) => {
    expect(refusalLadder).toMatch(pattern as RegExp);
  });

  it('parks exactly when the ladder found no reason not to', () => {
    expect(mainEffect).toMatch(/const canPark = parkRefusal === null;/);
  });

  it('logs the mount and teardown decision where another machine can read it', () => {
    // Adoption can only be validated where the bug reproduces. Without the
    // reason on the teardown line, "the split still replays" over there is
    // indistinguishable from "one of seven guards refused".
    expect(mainEffect).toMatch(/\[wmux:pane-adopt\] ptyId=\$\{ptyId\} mount=\$\{adopted \? 'adopted' : 'fresh'\}/);
    expect(mainEffect).toMatch(/teardown=\$\{canPark \? 'parked' : `disposed reason=\$\{parkRefusal\}`\}/);
  });

  it('defers the viewport restore when the adopting container has no size yet', () => {
    // A restructure on a hidden workspace (an agent splitting a background
    // pane) adopts into a zero-size container, where there is no valid fit to
    // restore against. Dropping the parked reading there would leave the pane
    // wherever the reveal fit happened to land it.
    expect(mainEffect).toMatch(/\} else if \(adopted\) \{\s*\n\s*pendingAdoptViewport = adopted;/);
    expect(mainEffect).toMatch(/if \(pendingAdoptViewport\) \{\s*\n\s*restoreParkedViewport\(pendingAdoptViewport\);\s*\n\s*pendingAdoptViewport = null;/);
  });

  it('hands the park the element it captured, not a fresh lookup', () => {
    expect(mainEffect).toMatch(/parkTerminal\(ptyId, terminal, parkElement, disposeTerminal\)/);
  });

  it('settles the restore flag on BOTH the success and the failure path', () => {
    // A rejected scrollback.load that left restoreSettled false would refuse
    // every later park on that pane — the fix would silently stop applying.
    expect(mainEffect.match(/restoreSettled = true;/g)).toHaveLength(2);
    expect(mainEffect).toMatch(/let restoreSettled = !\(scrollbackFile && !adopted\);/);
  });

  it('removes the contextmenu listener that outlives a park', () => {
    // It lives on terminal.element, which a park keeps alive. An anonymous
    // handler was safe only because terminal.dispose() took the element with
    // it: without this removal each restructure stacks another handler and one
    // right-click pastes the clipboard into the shell once per split.
    expect(mainEffect).toMatch(/const onTerminalContextMenu = \(e: MouseEvent\) =>/);
    expect(mainEffect).toMatch(/addEventListener\('contextmenu', onTerminalContextMenu\)/);
    expect(mainEffect).toMatch(/removeEventListener\('contextmenu', onTerminalContextMenu\)/);
  });

  it('tracks the in-flight reconnect where the park decision can read it', () => {
    expect(afterMainEffect).toMatch(/reconnectInFlightRef\.current = true;/);
    expect(afterMainEffect).toMatch(/inFlight = false; reconnectInFlightRef\.current = false;/);
    // Reset per effect run, mirroring the local guard — a ref left true from a
    // previous ptyId would disable parking for the rest of the session.
    expect(afterMainEffect).toMatch(/let inFlight = false;\s*\n\s*reconnectInFlightRef\.current = false;/);
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
    expect(mainEffect).toMatch(/const disposeTerminal = \(\) => \{[\s\S]{0,360}?discardTerminalOutput\(terminal\);\s*\n\s*disposeWhenDragEnds\(\(\) => terminal\.dispose\(\)\);/);
    expect(mainEffect).toMatch(/parkTerminal\(ptyId, terminal, parkElement, disposeTerminal\);/);
    expect(mainEffect).not.toMatch(/if \(canPark\)[\s\S]{0,120}?discardTerminalOutput\(terminal\)/);
  });

  it('releases the addons it loaded before parking', () => {
    // terminal.dispose() is what normally disposes them, and a parked terminal
    // never reaches it — the adopting mount loads its own set, so without this
    // the instance accumulates one per restructure.
    expect(mainEffect).toMatch(/if \(canPark && parkElement\) \{[\s\S]*fitAddon\.dispose\(\);[\s\S]*searchAddon\.dispose\(\);[\s\S]*webLinksAddon\.dispose\(\);[\s\S]*parkTerminal\(/);
  });

  it('still disposes directly when the terminal cannot be parked', () => {
    expect(mainEffect).toMatch(/\} else \{\s*\n\s*disposeTerminal\(\);\s*\n\s*\}/);
  });
});
