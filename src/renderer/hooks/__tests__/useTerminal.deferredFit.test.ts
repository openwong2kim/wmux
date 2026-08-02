import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #747 regression lock (source-level).
//
// The selection guard skips fit() so a mid-drag reflow can't wipe the user's
// selection. Every skip site used to just `return`, on the shared assumption
// that "the next ResizeObserver tick (after the user releases)" would run the
// deferred fit. Releasing a selection is not a size change and fires no tick,
// so a resize that landed while a selection was live was lost outright: xterm
// and — through sendResize — the daemon PTY stayed pinned to the old cols/rows.
// Output wrapped at the wrong column and full-screen TUIs drew against stale
// dimensions until something unrelated happened to resize the container.
//
// A skipped fit is now a recorded debt (pendingFitRef) settled by the
// onSelectionChange handler. The dangerous edit is a future contributor adding
// a fifth guarded site that bails without recording the debt — silently
// reintroducing the bug for that path only. Like the #191 atlas lock and the
// Fix D / A6 invariants next to it, this is xterm-bound behaviour that can't be
// asserted without a real terminal, so it is pinned at the source level.
describe('#747 — a deferred fit must be recorded and settled', () => {
  const hookPath = path.join(__dirname, '..', 'useTerminal.ts');
  const src = fs.readFileSync(hookPath, 'utf-8');

  it('every selection-guard bail records the debt', () => {
    // Each guard reads `if (!shouldFitWhilePreservingSelection(...)) { ... }`.
    // Slice each block and require pendingFitRef to be set inside it.
    const sites = [...src.matchAll(/if \(!shouldFitWhilePreservingSelection\([^)]*\)\) \{/g)];
    expect(sites.length).toBeGreaterThan(0);

    for (const site of sites) {
      const start = site.index as number;
      const block = src.slice(start, src.indexOf('}', src.indexOf('return;', start)));
      expect(
        block,
        `a selection-guard bail at index ${start} returns without recording pendingFitRef — ` +
          'the deferred fit would be lost (#747)',
      ).toMatch(/pendingFitRef\.current = true/);
    }
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
    // sendResize dedupe. A hand-rolled `fitAddon.fit()` in the handler would
    // resize xterm while leaving the PTY on the old size — the same class of
    // desync this fixes.
    const start = src.indexOf('const runFit = () => {');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('\n    };', start));
    expect(block).toMatch(/fitAddon\.fit\(\)/);
    expect(block).toMatch(/sendResize\(/);
    expect(block).toMatch(/scrollToLine\(/);
    // Clearing the debt on the path that actually fits is what stops the retry
    // from firing forever on every subsequent selection change.
    expect(block).toMatch(/pendingFitRef\.current = false/);
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
