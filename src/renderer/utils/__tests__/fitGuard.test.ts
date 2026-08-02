/**
 * Tests for `shouldFitWhilePreservingSelection`.
 *
 * The guard is the deciding step both inside the ResizeObserver tick and the
 * font/theme effect — calling `fit()` mid-drag clears the selection (xterm's
 * SelectionService responds to `rowsChanged` by unconditionally clearing).
 */
import { describe, it, expect } from 'vitest';
import { claimFit, shouldFitWhilePreservingSelection } from '../fitGuard';

describe('shouldFitWhilePreservingSelection', () => {
  it('returns true when the terminal has no active selection', () => {
    const term = { hasSelection: () => false };
    expect(shouldFitWhilePreservingSelection(term)).toBe(true);
  });

  it('returns false when the terminal has an active selection', () => {
    const term = { hasSelection: () => true };
    expect(shouldFitWhilePreservingSelection(term)).toBe(false);
  });

  it('returns true for null/undefined term (no selection to preserve)', () => {
    expect(shouldFitWhilePreservingSelection(null)).toBe(true);
    expect(shouldFitWhilePreservingSelection(undefined)).toBe(true);
  });

  it('does not call hasSelection more than once per check', () => {
    let calls = 0;
    const term = {
      hasSelection: () => {
        calls += 1;
        return false;
      },
    };
    shouldFitWhilePreservingSelection(term);
    expect(calls).toBe(1);
  });
});

// #747 — deferring and remembering are one decision. A site that checked the
// guard but forgot to record the debt silently dropped the resize: xterm and the
// daemon PTY stayed pinned to the old cols/rows because nothing re-ran the fit
// (a selection release is not a size change, so no ResizeObserver tick fires).
// claimFit exists so a call site cannot get that half-right.
describe('claimFit', () => {
  it('allows the fit and leaves the debt alone when there is no selection', () => {
    const pending = { current: false };
    expect(claimFit({ hasSelection: () => false }, pending)).toBe(true);
    expect(pending.current).toBe(false);
  });

  it('refuses the fit AND records the debt when a selection is live', () => {
    const pending = { current: false };
    expect(claimFit({ hasSelection: () => true }, pending)).toBe(false);
    expect(pending.current).toBe(true);
  });

  it('does not clear an existing debt when it allows a fit', () => {
    // Settling is the retry path's job — it clears the flag only after the fit
    // actually runs. Clearing here would drop a debt owed by another site.
    const pending = { current: true };
    expect(claimFit({ hasSelection: () => false }, pending)).toBe(true);
    expect(pending.current).toBe(true);
  });

  it('allows the fit for a null term without recording a debt', () => {
    const pending = { current: false };
    expect(claimFit(null, pending)).toBe(true);
    expect(claimFit(undefined, pending)).toBe(true);
    expect(pending.current).toBe(false);
  });
});
