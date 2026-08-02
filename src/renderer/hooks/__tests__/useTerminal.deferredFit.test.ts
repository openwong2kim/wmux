import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #747 regression lock (source-level).
//
// The selection guard skips fit() so a reflow can't wipe what the user is
// selecting. Every skip site used to just `return`, on the shared assumption
// that "the next ResizeObserver tick (after the user releases)" would run the
// deferred fit. Releasing a selection is not a size change and fires no tick,
// so a resize that landed while a selection was live was lost outright: xterm
// and — through sendResize — the daemon PTY stayed pinned to the old cols/rows.
//
// The guard+debt decision now lives in claimFit(), which is unit-tested for real
// in utils/__tests__/fitGuard.test.ts. What CANNOT be asserted without a live
// xterm is the wiring in this hook, so that part is pinned here, matching the
// #191 atlas lock and the Fix D / A6 invariants alongside it.
describe('#747 — a deferred fit must be recorded and settled', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('no site calls the raw guard — every one goes through claimFit', () => {
    // This is the load-bearing assertion. Calling shouldFitWhilePreservingSelection
    // directly lets a site bail without recording the debt, which is the bug.
    // claimFit cannot be used that way: refusing and remembering are one call.
    expect(
      src,
      'a site calls shouldFitWhilePreservingSelection directly — use claimFit(term, pendingFitRef) ' +
        'so the deferred fit cannot be dropped (#747)',
    ).not.toMatch(/shouldFitWhilePreservingSelection/);
    expect(src).toMatch(/claimFit\(/);
  });

  it('the selection-release handler settles the debt', () => {
    const start = src.indexOf('terminal.onSelectionChange(');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('});', start));
    expect(block).toMatch(/pendingFitRef\.current/);
    expect(block).toMatch(/hasSelection\(\)/);
    expect(block).toMatch(/runFit/);
  });

  it('the settled fit runs the real fit path, not a thinner copy', () => {
    // The retry must go through runFit so it keeps scroll preservation and the
    // sendResize dedupe. A hand-rolled fitAddon.fit() in the handler would
    // resize xterm while leaving the PTY on the old size — the same class of
    // desync this fixes.
    const start = src.indexOf('const runFit = () => {');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n    };', start));
    expect(block).toMatch(/fitAddon\.fit\(\)/);
    expect(block).toMatch(/sendResize\(/);
    expect(block).toMatch(/scrollToLine\(/);
    // Clearing the debt on the path that actually fits is what stops the retry
    // from re-firing on every later selection change.
    expect(block).toMatch(/pendingFitRef\.current = false/);
    // Identity guard: a ptyId change re-runs the create effect, and a frame
    // queued by the previous one must not fit the old container and then send
    // those dimensions to ptyIdRef.current, which now points at the new pty.
    expect(block).toMatch(/term !== terminal/);
  });

  it('the queued retry is cancellable and cancelled at teardown', () => {
    // Without a handle, several selection changes in one debt window each queue
    // their own fit, and a frame can still land after the terminal is disposed.
    expect(src).toMatch(/pendingFitRaf/);
    const cleanupStart = src.indexOf('if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);\n      if (pendingFitRaf');
    expect(
      cleanupStart,
      'the queued fit frame is not cancelled next to the debounce timer in cleanup',
    ).toBeGreaterThan(-1);
  });

  it('the ResizeObserver delegates to runFit instead of duplicating it', () => {
    const start = src.indexOf('new ResizeObserver(');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('resizeObserver.observe(', start));
    expect(block).toMatch(/runFit/);
    // A second copy of the fit body here would drift out of sync with the retry.
    expect(block).not.toMatch(/fitAddon\.fit\(\)/);
  });
});
