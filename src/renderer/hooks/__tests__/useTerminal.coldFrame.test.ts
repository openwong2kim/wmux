import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Cold-park reveal (blank pane on workspace switch), locked at the source
// level like the other useTerminal wiring tests: the hook is an xterm-bound
// effect that unit tests cannot mount. The cache and the swap state machine
// are tested for real in terminal/__tests__/coldFrame.test.ts.
describe('cold-park reveal — cold frame wiring (source-level)', () => {
  // LF only: with core.autocrlf (the Windows default) the checkout is CRLF,
  // and a `.` in the patterns below does not match the `\r`.
  const src = fs.readFileSync(path.join(__dirname, '..', 'useTerminal.ts'), 'utf-8').replace(/\r\n/g, '\n');
  const mainStart = src.indexOf('if (!container || !ptyId) return;');
  const mainEnd = src.indexOf('}, [ptyId, containerRef]);', mainStart);
  const mainEffect = src.slice(mainStart, mainEnd);
  const afterMainEffect = src.slice(mainEnd);

  it('captures the screen at final disposal only, before terminal.dispose()', () => {
    const dispose = mainEffect.slice(
      mainEffect.indexOf('const disposeTerminal = () => {'),
      mainEffect.indexOf('};', mainEffect.indexOf('const disposeTerminal = () => {')),
    );
    const captureAt = dispose.indexOf('captureColdFrame(ptyId, terminal)');
    expect(captureAt).toBeGreaterThan(-1);
    expect(captureAt).toBeLessThan(dispose.indexOf('terminal.dispose()'));
    // Never on the park path itself: an adopted terminal keeps its screen.
    expect(mainEffect).not.toMatch(/parkTerminal\([^)]*\);[\s\S]{0,40}captureColdFrame/);
    expect(mainEffect).toMatch(/const captureFrame = isDaemonModeActive\(\) && !fixedGeometryRef\.current && parkRefusal !== 'not-registry-owner';/);
  });

  it('paints a cached frame only on a fresh, fitted daemon mount at the cached width', () => {
    expect(mainEffect).toMatch(/const coldFrame = !adopted && !fixedGeometryRef\.current && isDaemonModeActive\(\)\s*\n\s*\? takeColdFrame\(ptyId\)/);
    expect(mainEffect).toMatch(/const paintColdFrame = coldFrame !== null && initialFitRan && coldFrameFits\(coldFrame, terminal\.cols\);/);
    expect(mainEffect).toMatch(/if \(paintColdFrame\) \{\s*\n\s*terminal\.write\(coldFrame\.frame\);\s*\n\s*warmSwap\.painted\(\);/);
  });

  it('paints before any PTY listener is wired, so the replay always lands on top', () => {
    const paintAt = mainEffect.indexOf('terminal.write(coldFrame.frame)');
    expect(paintAt).toBeGreaterThan(-1);
    expect(paintAt).toBeLessThan(mainEffect.indexOf('if (scrollbackFile && !adopted) {'));
    // The daemon reattach lives in a later effect.
    expect(afterMainEffect).toMatch(/reattach\('active-at-mount'\)/);
  });

  it('prefixes the replay past the resync hold-out and sends the result to the scheduler', () => {
    const deliver = mainEffect.slice(mainEffect.indexOf('const deliverPtyData'), mainEffect.indexOf('const writeSwapBytes'));
    const holdOut = deliver.indexOf('st.buffer.push(payload)');
    const swap = deliver.indexOf('const data = warmSwap.onData(payload.data);');
    expect(holdOut).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(holdOut);
    expect(deliver).toMatch(/writeTerminalOutput\(terminal, data, \{/);
    // Not inside routePtyData: the resting-cursor guard must never see it.
    const route = mainEffect.slice(mainEffect.indexOf('const routePtyData'), mainEffect.indexOf('const deliverPtyData'));
    expect(route).not.toMatch(/warmSwap/);
  });

  it('defers a cached frame the first fit did not match to the first resize at its width', () => {
    // The first fit runs with the DOM renderer's measured cell; WebGL then
    // rounds it to whole device pixels and refits (125 %: 115 -> 118 cols).
    expect(mainEffect).toMatch(/deferredColdFrame = coldFrame !== null && !paintColdFrame && initialFitRan \? coldFrame : null;/);
    const resize = mainEffect.slice(mainEffect.indexOf('const deferredColdFrameResize'), mainEffect.indexOf('if (isVisibleRef.current) {', mainEffect.indexOf('const deferredColdFrameResize')));
    expect(resize).toMatch(/terminal\.onResize\(/);
    // Painted only at the cached width, once, and never after PTY output was
    // routed to this mount (routePtyData sets revealFirstDataLogged for every
    // payload, before the resync hold-out and the scheduler).
    expect(resize).toMatch(/if \(!frame \|\| revealFirstDataLogged \|\| !coldFrameFits\(frame, cols\)\) return;\s*\n\s*deferredColdFrame = null;\s*\n\s*terminal\.write\(frame\.frame\);\s*\n\s*warmSwap\.painted\(\);/);
    expect(mainEffect).toMatch(/const routePtyData = \(payload: PtyDataPayload\) => \{\s*\n\s*logRevealFirstData\(payload\);/);
    expect(mainEffect).toMatch(/if \(revealFirstDataLogged\) return;\s*\n\s*revealFirstDataLogged = true;/);
    // Nor after the attach settled (a flush with nothing replayed must not
    // leave a cosmetic frame on screen for good), at both flush listeners.
    expect((mainEffect.match(/revealTimingT0\.delete\(ptyId\);\s*\n\s*deferredColdFrame = null;[^\n]*\n\s*if \(completeResyncFromFlush\(recoveredBytes\)\) return;/g) ?? []).length).toBe(2);
    // The resize subscription goes with the mount.
    expect(mainEffect).toMatch(/warmSwap\.cancel\(\);\s*\n\s*deferredColdFrameResize\?\.dispose\(\);\s*\n\s*deferredColdFrame = null;/);
  });

  it('closes the swap at both flush-complete listeners, after resync settlement', () => {
    const closes = mainEffect.match(/if \(completeResyncFromFlush\(recoveredBytes\)\) return;\s*\n(?:\s*\/\/.*\n)*\s*writeSwapBytes\(warmSwap\.onFlush\(recoveredBytes\)\);/g) ?? [];
    expect(closes).toHaveLength(2);
    // Owed bytes go through the scheduler, in order with the replay.
    expect(mainEffect).toMatch(/const writeSwapBytes = \(bytes: string \| null\) => \{[\s\S]{0,120}writeTerminalOutput\(terminal, bytes,/);
  });

  it('settles the swap after held payloads on both scrollback-load paths', () => {
    const settles = mainEffect.match(/for \(const payload of pendingData\) \{\s*\n\s*routePtyData\(payload\);\s*\n\s*\}\s*\n(?:\s*\/\/.*\n)*\s*writeSwapBytes\(warmSwap\.settleHeld\(\)\);/g) ?? [];
    expect(settles).toHaveLength(2);
  });

  it('a resync settlement cancels a pending swap (its RIS repaints from scratch)', () => {
    const flush = mainEffect.slice(mainEffect.indexOf('const completeResyncFromFlush'));
    expect(flush.indexOf('warmSwap.cancel()')).toBeGreaterThan(-1);
    expect(flush.indexOf('warmSwap.cancel()')).toBeLessThan(flush.indexOf('terminal.write(REPAINT_BEGIN'));
  });

  it('closes an open swap on teardown so an adopting mount is not left holding a 2026 frame', () => {
    expect(mainEffect).toMatch(/writeSwapBytes\(warmSwap\.close\(\)\);\s*\n\s*warmSwap\.cancel\(\);/);
  });

  it('a resync settlement writes END before the escape sequence its replay ends inside', () => {
    const flush = mainEffect.slice(mainEffect.indexOf('const completeResyncFromFlush'));
    expect(flush).toMatch(/const held = splitTrailingEscape\(st\.buffer\);\s*\n\s*for \(const chunk of held\.complete\) \{\s*\n\s*writePtyDataImmediately\(terminal, chunk, replayMuteRef\.current\);\s*\n\s*\}\s*\n\s*terminal\.write\(REPAINT_END\);\s*\n\s*if \(held\.pending\) writePtyDataImmediately\(terminal, held\.pending, replayMuteRef\.current\);/);
  });

  it('forgets a deferred cold frame when the PTY exits, at both exit listeners', () => {
    const exits = mainEffect.match(/removeExitListener = ptyExitDispatcher\.register\(ptyId, \(exitCode\) => \{\s*\n(?:\s*\/\/.*\n)*\s*deferredColdFrame = null;/g) ?? [];
    expect(exits).toHaveLength(2);
    // A painted frame still waiting for its replay is dropped before the
    // marker, so that replay's RIS cannot wipe the marker.
    const drops = mainEffect.match(/deferredColdFrame = null;\s*\n\s*if \(warmSwap\.phase === 'warm'\) \{ warmSwap\.cancel\(\); writeSwapBytes\(FULL_RESET\); \}\s*\n(?:\s*\/\/.*\n)*\s*writeTerminalOutput\(terminal, `\\r\\n\$\{t\('terminal\.exitedBracket'/g) ?? [];
    expect(drops).toHaveLength(2);
  });

  it('a read waits (bounded) for a painted cold frame to be swapped out', () => {
    const hydrate = mainEffect.slice(mainEffect.indexOf('const hydrateForRead'), mainEffect.indexOf('const parsed = await awaitParseBarrier(terminal);'));
    expect(hydrate).toMatch(/while \(warmSwap\.phase !== 'idle' && terminalRef\.current === terminal && performance\.now\(\) < swapDeadline\)/);
    expect(hydrate.indexOf('swapDeadline')).toBeLessThan(hydrate.indexOf('isTerminalDirty(terminal)'));
  });

  it('drops a cached frame when its PTY exits, through the single exit subscription', () => {
    expect(src).toMatch(/window\.electronAPI\.pty\.onExit\(\(ptyId, exitCode\) => \{[\s\S]{0,400}dropColdFrame\(ptyId\);\s*\n\s*cb\(ptyId, exitCode\);/);
    expect((src.match(/window\.electronAPI\.pty\.onExit\(/g) ?? []).length).toBe(1);
  });

  it('logs [wmux:reveal-timing] once per stage per reveal', () => {
    expect(mainEffect).toMatch(/stage=mount \+0\.0ms mode=\$\{adopted \? 'adopted' : 'fresh'\} cachedFrame=/);
    expect(mainEffect).toMatch(/revealTiming\(ptyId, 'first-data'/);
    expect((mainEffect.match(/revealTiming\(ptyId, 'flush-complete'/g) ?? []).length).toBe(2);
    // The flush marker closes the window, so later flushes stay quiet.
    expect((mainEffect.match(/revealTiming\(ptyId, 'flush-complete'[^\n]*\n\s*revealTimingT0\.delete\(ptyId\);/g) ?? []).length).toBe(2);
    expect(afterMainEffect).toMatch(/revealTiming\(id, 'reattach-start'/);
    expect(afterMainEffect).toMatch(/revealTiming\(id, 'reattach-resolved'\)/);
    // A window only opens for a fresh, visible mount.
    expect(mainEffect).toMatch(/if \(isVisibleRef\.current\) \{\s*\n\s*if \(!adopted\) revealTimingT0\.set\(ptyId, performance\.now\(\)\);/);
  });
});
