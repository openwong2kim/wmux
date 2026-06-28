/**
 * Tests for `resolveCopyTarget` — the pure decision core of the
 * focus-independent terminal Ctrl+C copy (fix B).
 *
 * It decides, from a DOM-free snapshot, whether a document-level Ctrl+C should
 * copy a terminal's selection or YIELD (return null) so the pre-existing copy /
 * SIGINT / composer-copy behavior is preserved. Every branch is covered, with
 * the original bug pinned as an explicit regression: focus on an empty composer
 * + a non-empty terminal selection must resolve to that terminal.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCopyTarget,
  type ActiveElementInfo,
  type CopyTargetInput,
} from '../resolveCopyTarget';

function activeEl(overrides: Partial<ActiveElementInfo> = {}): ActiveElementInfo {
  return {
    isXtermTextarea: false,
    isEditable: false,
    hasOwnSelection: false,
    ...overrides,
  };
}

function input(overrides: Partial<CopyTargetInput> = {}): CopyTargetInput {
  return {
    selections: [],
    activePtyId: null,
    activeElement: null,
    ...overrides,
  };
}

describe('resolveCopyTarget — regression (the reported bug)', () => {
  it('[REGRESSION] focus on an empty composer + terminal has a selection → that terminal', () => {
    // This is exactly the bug: the channel composer (editable, but with NO
    // selection of its own) holds DOM focus while the user has selected
    // terminal text. Ctrl+C must copy the terminal selection, not go silent.
    const result = resolveCopyTarget(
      input({
        selections: [{ ptyId: 'pty-term', selection: 'copied text' }],
        activePtyId: 'pty-term',
        activeElement: activeEl({ isEditable: true, hasOwnSelection: false }),
      }),
    );
    expect(result).toEqual({ ptyId: 'pty-term', selection: 'copied text' });
  });

  it('[REGRESSION] composer focus also works when activePtyId is null but one terminal is selected', () => {
    // Same composer-focus scenario, but the active pane did not resolve to a
    // terminal (e.g. focus model lost it). A single selected terminal is still
    // unambiguous, so the copy must land on it rather than going silent.
    const result = resolveCopyTarget(
      input({
        selections: [{ ptyId: 'pty-only', selection: 'hello' }],
        activePtyId: null,
        activeElement: activeEl({ isEditable: true, hasOwnSelection: false }),
      }),
    );
    expect(result).toEqual({ ptyId: 'pty-only', selection: 'hello' });
  });
});

describe('resolveCopyTarget — yield branches (preserve existing behavior)', () => {
  it('yields when focus is on a terminal xterm-helper-textarea (xterm owns copy/SIGINT)', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [{ ptyId: 'pty-1', selection: 'sel' }],
          activePtyId: 'pty-1',
          activeElement: activeEl({ isXtermTextarea: true }),
        }),
      ),
    ).toBeNull();
  });

  it('yields when an editable element holds its own non-empty selection (composer copy)', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [{ ptyId: 'pty-1', selection: 'term sel' }],
          activePtyId: 'pty-1',
          activeElement: activeEl({ isEditable: true, hasOwnSelection: true }),
        }),
      ),
    ).toBeNull();
  });

  it('yields when no terminal holds a selection (SIGINT must fire)', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: '' },
            { ptyId: 'pty-2', selection: '' },
          ],
          activePtyId: 'pty-1',
          activeElement: activeEl({ isEditable: true, hasOwnSelection: false }),
        }),
      ),
    ).toBeNull();
  });

  it('yields when no terminals are registered at all', () => {
    expect(
      resolveCopyTarget(input({ selections: [], activePtyId: 'pty-1' })),
    ).toBeNull();
  });

  it('yields when multiple terminals are selected and none is the active pane (ambiguous)', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: 'a' },
            { ptyId: 'pty-2', selection: 'b' },
          ],
          activePtyId: null,
        }),
      ),
    ).toBeNull();
  });

  it('yields when multiple terminals are selected and the active pane has no selection', () => {
    // The active pane's terminal is NOT among the selected ones, so even with an
    // active pane the choice between the other two is ambiguous → yield.
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: 'a' },
            { ptyId: 'pty-2', selection: 'b' },
          ],
          activePtyId: 'pty-3',
        }),
      ),
    ).toBeNull();
  });
});

describe('resolveCopyTarget — copy branches', () => {
  it('returns the active pane terminal when it holds a selection', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: 'first' },
            { ptyId: 'pty-2', selection: 'second' },
          ],
          activePtyId: 'pty-2',
        }),
      ),
    ).toEqual({ ptyId: 'pty-2', selection: 'second' });
  });

  it('prefers the active pane terminal over other selected terminals', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: 'a' },
            { ptyId: 'pty-2', selection: 'b' },
            { ptyId: 'pty-3', selection: 'c' },
          ],
          activePtyId: 'pty-1',
        }),
      ),
    ).toEqual({ ptyId: 'pty-1', selection: 'a' });
  });

  it('returns the single selected terminal when activeElement is null (no focus)', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [{ ptyId: 'pty-solo', selection: 'lone' }],
          activePtyId: null,
          activeElement: null,
        }),
      ),
    ).toEqual({ ptyId: 'pty-solo', selection: 'lone' });
  });

  it('returns the lone selected terminal when the active pane resolves but holds no selection', () => {
    // GLM-flagged gap: activePtyId DOES resolve, but that terminal is not among
    // the ones holding a selection, while exactly one OTHER terminal is. The
    // active-pane preference finds no candidate, yet the single selected
    // terminal is unambiguous, so it must be returned rather than yielding.
    // (Visibility filtering is the hook's job; at the pure layer one candidate
    // still wins.)
    expect(
      resolveCopyTarget(
        input({
          selections: [{ ptyId: 'pty-other', selection: 'only one' }],
          activePtyId: 'pty-active',
          activeElement: activeEl({ isEditable: true, hasOwnSelection: false }),
        }),
      ),
    ).toEqual({ ptyId: 'pty-other', selection: 'only one' });
  });

  it('returns the only selected terminal even when other terminals exist but are empty', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: '' },
            { ptyId: 'pty-2', selection: 'picked' },
            { ptyId: 'pty-3', selection: '' },
          ],
          activePtyId: null,
        }),
      ),
    ).toEqual({ ptyId: 'pty-2', selection: 'picked' });
  });

  it('still copies the active terminal even if its selection equals another (active wins by id)', () => {
    // Sanity: the active-pane preference is by ptyId, independent of selection
    // content collisions.
    expect(
      resolveCopyTarget(
        input({
          selections: [
            { ptyId: 'pty-1', selection: 'dup' },
            { ptyId: 'pty-2', selection: 'dup' },
          ],
          activePtyId: 'pty-2',
        }),
      ),
    ).toEqual({ ptyId: 'pty-2', selection: 'dup' });
  });

  it('non-editable focused element (e.g. a button) does not block a terminal copy', () => {
    expect(
      resolveCopyTarget(
        input({
          selections: [{ ptyId: 'pty-1', selection: 'x' }],
          activePtyId: 'pty-1',
          activeElement: activeEl({ isEditable: false, hasOwnSelection: false }),
        }),
      ),
    ).toEqual({ ptyId: 'pty-1', selection: 'x' });
  });
});
