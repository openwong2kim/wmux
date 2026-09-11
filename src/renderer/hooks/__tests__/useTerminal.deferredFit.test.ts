import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source locks must not depend on line endings: `validate` runs on
// windows-latest, where the checkout is CRLF, so any assertion carrying a
// literal \n passes on macOS/Linux and fails only in CI. Normalise once here and
// keep every pattern below whitespace-tolerant.
const readSource = (p: string) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');

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
  const src = readSource(hookPath);

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
    // Bound the block by the next declaration rather than an indentation
    // pattern — a formatter change must not silently shrink or widen the slice.
    const end = src.indexOf('const autoCopy = createAutoSelectionCopy', start);
    expect(end, 'runFit is no longer followed by autoCopy — re-anchor this slice').toBeGreaterThan(start);
    const block = src.slice(start, end);
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
    expect(
      src,
      'the queued fit frame is not cancelled next to the debounce timer in cleanup',
    ).toMatch(
      /clearTimeout\(resizeDebounceTimer\);\s*if \(pendingFitRaf !== null\) cancelAnimationFrame\(pendingFitRaf\);/,
    );
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

// #1255 — sub-floor fits are skipped, and recovered sessions re-assert their
// real geometry. A transient small-but-nonzero container (mid-split, session
// restore before the panels settle) used to be FITTED: the tiny columns were
// applied to the xterm buffer and the reflow re-wrapped the whole scrollback
// at that width — damage a later correct fit does not undo, which is how a
// pane rendered ~1 column wide forever. The daemon clamps its side to
// MIN_SAFE_COLS(10) regardless, so the two sides of the pipe also split.
describe('#1255 — every fit() apply site is floor-gated, every recovery re-asserts', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = readSource(hookPath);

  it('imports the shared floor (single-sourced with the daemon clamp)', () => {
    expect(src).toMatch(/import \{ isSafeGeometry \} from '\.\.\/\.\.\/shared\/terminalGeometry'/);
  });

  it('the exported fit() gates below the floor, after the zero-dimension guard', () => {
    const start = src.indexOf('const fit = useCallback');
    const block = src.slice(start, src.indexOf('}, [ptyId, containerRef]', start));
    const zero = block.indexOf('offsetWidth === 0');
    const gate = block.indexOf('proposedSafeDimensions(fitAddonRef.current)');
    const fitCall = block.indexOf('fitAddonRef.current.fit()');
    expect(zero).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(zero);
    expect(fitCall).toBeGreaterThan(gate);
  });

  it('the initial mount fit treats a sub-floor container like a hidden one', () => {
    const anchor = 'container.offsetWidth > 0 && container.offsetHeight > 0 && proposedSafeDimensions(fitAddon)';
    expect(src).toContain(anchor);
  });

  it('fonts.ready and runFit gate their fits too', () => {
    const fonts = src.slice(src.indexOf('document.fonts.ready'), src.indexOf('document.fonts.ready') + 1400);
    expect(fonts).toMatch(/if \(proposedSafeDimensions\(fitAddon\)\) fitAddon\.fit\(\)/);
    const runFitStart = src.indexOf('const runFit = () => {');
    const runFit = src.slice(runFitStart, src.indexOf('const autoCopy = createAutoSelectionCopy', runFitStart));
    // BEFORE claimFit: a floor skip records no selection debt — the settled
    // layout re-fires the ResizeObserver, which is the retry.
    const gate = runFit.indexOf('proposedSafeDimensions(fitAddon)) return');
    const claim = runFit.indexOf('claimFit(');
    expect(gate).toBeGreaterThan(-1);
    expect(claim).toBeGreaterThan(gate);
  });

  it('the font/theme effect gates its fit as well', () => {
    // The zero-dimension skip logs a near-identical line; anchor on the
    // sub-floor one specifically.
    const start = src.indexOf('[Terminal] font/theme fit skipped — sub-floor dimensions');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start - 500, start);
    expect(block).toMatch(/proposedSafeDimensions\(fitAddonRef\.current\)/);
  });

  it('a resync settle and a daemon reattach both re-assert DOM geometry (no dedup)', () => {
    // sendResize carries no lastSentCols dedup — these two points must push
    // the real size even when the renderer cache already "matches", or the
    // daemon stays pinned at its clamp after a transient tiny fit.
    // Window covers the whole settle fn — #1258's scroll-preservation block
    // also lives inside it, ahead of the re-assert.
    const resync = src.slice(src.indexOf('const completeResyncFromFlush'), src.indexOf('const completeResyncFromFlush') + 2700);
    expect(resync).toMatch(/proposedSafeDimensions\(fitAddon\)/);
    expect(resync).toMatch(/sendResize\(ptyId, dims\.cols, dims\.rows\)/);
    // Anchor on the reattach log line itself — plain "daemon reattach" also
    // appears in unrelated comments above this effect.
    const reattach = src.slice(src.indexOf('[useTerminal] daemon reattach ptyId='), src.indexOf('[useTerminal] daemon reattach ptyId=') + 2200);
    expect(reattach).toMatch(/proposedSafeDimensions\(fitAddonRef\.current\)/);
    expect(reattach).toMatch(/sendResize\(id, dims\.cols, dims\.rows\)/);
  });
});
