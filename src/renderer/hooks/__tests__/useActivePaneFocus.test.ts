/**
 * Unit tests for the two extracted halves of useActivePaneFocus:
 * `resolveActivePanePtyId` (pure target resolution) and
 * `driveFocusToTerminal` (retry + late-registration focus driver, with raf /
 * registry deps injected so the node-env vitest can exercise it — previously
 * the rAF half was dogfood-only and its 10-frame give-up shipped a boot-
 * restore focus hole).
 *
 * These tests pin the regression behind the "red border moves but typing lands
 * in the old pane" bug: the resolver must follow BOTH pane switches and
 * same-pane surface (tab) switches, and must decline non-terminal surfaces.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveActivePanePtyId,
  computeFocusKey,
  driveFocusToTerminal,
  isFocusOrphaned,
  reassertFocusIfOrphaned,
  type FocusDriverDeps,
  type FocusReassertDeps,
} from '../useActivePaneFocus';
import type { Workspace, Pane, PaneLeaf, Surface } from '../../../shared/types';

function surface(id: string, ptyId: string, surfaceType?: Surface['surfaceType']): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: '.', surfaceType };
}

function leaf(id: string, surfaces: Surface[], activeSurfaceId: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId };
}

function ws(id: string, rootPane: Pane, activePaneId: string): Workspace {
  return { id, name: id, rootPane, activePaneId };
}

describe('resolveActivePanePtyId', () => {
  it('returns the active surface ptyId of the active pane', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    const state = { workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' };
    expect(resolveActivePanePtyId(state)).toBe('pty-1');
  });

  it('follows a pane switch — picks the ptyId of whichever pane is active', () => {
    // Two side-by-side leaves; activePaneId selects the target. This is the
    // reported bug: navigating the active pane must change the focus target.
    const root: Pane = {
      id: 'branch',
      type: 'branch',
      direction: 'horizontal',
      children: [
        leaf('p1', [surface('s1', 'pty-1')], 's1'),
        leaf('p2', [surface('s2', 'pty-2')], 's2'),
      ],
    };
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p2')], activeWorkspaceId: 'w1' })).toBe('pty-2');
  });

  it('follows a same-pane tab switch — picks the active surface ptyId', () => {
    // In-scope per the chosen fix: keyboard tab switches must move focus too.
    const a = leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's1');
    const b = leaf('p1', [surface('s1', 'pty-1'), surface('s2', 'pty-2')], 's2');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', a, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', b, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-2');
  });

  it('returns null for a browser surface (no xterm to focus)', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'browser')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  // ─── computeFocusKey — input-dead (multiview remount) regression ────────────
  describe('computeFocusKey', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    const base = { workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1', multiviewIds: [] as string[] };

    it('encodes ws + pane + surface + pty', () => {
      const key = computeFocusKey(base);
      expect(key).toContain('w1');
      expect(key).toContain('p1');
      expect(key).toContain('s1');
      expect(key).toContain('pty-1');
    });

    it('CHANGES when the active workspace enters/leaves the multiview grid', () => {
      // Single view vs grid remounts the active terminal, but leaves the focus
      // target (ws/pane/surface/pty) unchanged. The key MUST differ so the focus
      // effect re-runs and re-focuses the freshly remounted xterm — otherwise
      // typing is dead until a click.
      const single = computeFocusKey({ ...base, multiviewIds: [] });
      const grid = computeFocusKey({ ...base, multiviewIds: ['w1', 'w2'] }); // active w1 ∈ grid
      expect(single).not.toBe(grid);
    });

    it('does NOT change for edits to OTHER workspaces while the active one stays gridded', () => {
      // Adding/removing an unrelated workspace does not remount the active
      // terminal, so it must not re-run the focus effect (no needless focus steal).
      const two = computeFocusKey({ ...base, multiviewIds: ['w1', 'w2'] });
      const three = computeFocusKey({ ...base, multiviewIds: ['w1', 'w2', 'w3'] });
      expect(two).toBe(three);
    });

    it('is stable when nothing changes', () => {
      expect(computeFocusKey(base)).toBe(computeFocusKey({ ...base, workspaces: [ws('w1', root, 'p1')] }));
    });

    it('returns empty string when no active workspace resolves', () => {
      expect(computeFocusKey({ workspaces: [], activeWorkspaceId: 'nope', multiviewIds: [] })).toBe('');
    });
  });

  it('returns null for an editor surface', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'editor')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('treats an explicit "terminal" surfaceType the same as undefined', () => {
    const root = leaf('p1', [surface('s1', 'pty-1', 'terminal')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBe('pty-1');
  });

  it('returns null when the active surface has no ptyId yet (mid-create / cleared)', () => {
    const root = leaf('p1', [surface('s1', '')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when no workspace is active', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'missing' })).toBeNull();
  });

  it('returns null when activePaneId does not resolve to a leaf', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 's1');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'ghost')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when activePaneId points at a branch, not a leaf', () => {
    const root: Pane = {
      id: 'branch',
      type: 'branch',
      direction: 'vertical',
      children: [leaf('p1', [surface('s1', 'pty-1')], 's1')],
    };
    // findLeaf only matches leaves, so a branch id resolves to null.
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'branch')], activeWorkspaceId: 'w1' })).toBeNull();
  });

  it('returns null when the active surface id is missing from the pane', () => {
    const root = leaf('p1', [surface('s1', 'pty-1')], 'gone');
    expect(resolveActivePanePtyId({ workspaces: [ws('w1', root, 'p1')], activeWorkspaceId: 'w1' })).toBeNull();
  });
});

// ─── driveFocusToTerminal ────────────────────────────────────────────────────

/** Fake registry + manual raf queue so the retry loop runs deterministically. */
function makeDriverHarness() {
  const registry = new Map<string, { focus(): void }>();
  const focused: string[] = [];
  const listeners = new Set<(id: string) => void>();
  const rafQueue: Array<() => void> = [];

  const deps: FocusDriverDeps = {
    getTerminal: (id) => registry.get(id),
    onRegistered: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    raf: (cb) => rafQueue.push(cb),
    caf: () => undefined,
  };

  return {
    deps,
    focused,
    listenerCount: () => listeners.size,
    register: (id: string) => {
      registry.set(id, { focus: () => focused.push(id) });
      for (const l of [...listeners]) l(id);
    },
    /** Drain pending animation frames (each may schedule the next). */
    runFrames: (n: number) => {
      for (let i = 0; i < n; i++) {
        const cb = rafQueue.shift();
        if (!cb) return;
        cb();
      }
    },
  };
}

describe('driveFocusToTerminal', () => {
  it('focuses immediately when the terminal is already registered, and disarms', () => {
    const h = makeDriverHarness();
    h.register('pty-1');
    h.focused.length = 0;

    driveFocusToTerminal('pty-1', h.deps);

    expect(h.focused).toEqual(['pty-1']);
    // One-shot: a later re-registration (font-change remount, multiview exit)
    // must not yank focus back — the subscription is already disarmed.
    h.register('pty-1');
    expect(h.focused).toEqual(['pty-1']);
    expect(h.listenerCount()).toBe(0);
  });

  it('focuses via the frame retry when registration lands within the window', () => {
    const h = makeDriverHarness();
    driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(3);
    h.register('pty-1'); // registration listener fires first…
    expect(h.focused).toContain('pty-1');
  });

  it('boot-restore: focuses on registration AFTER the frame retries give up', () => {
    const h = makeDriverHarness();
    driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(20); // exhaust all retries (maxTries=10) — registry still empty
    expect(h.focused).toEqual([]);

    // Scrollback restore completes much later and registers the terminal.
    h.register('pty-1');
    expect(h.focused.filter((f) => f === 'pty-1').length).toBeGreaterThan(0);
    expect(h.listenerCount()).toBe(0); // one-shot disarmed after firing
  });

  it('ignores registrations of other terminals', () => {
    const h = makeDriverHarness();
    driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(20);
    h.register('pty-OTHER');
    expect(h.focused).toEqual([]);
    expect(h.listenerCount()).toBe(1); // still armed for the real target
  });

  it('cleanup disarms the subscription so a stale target cannot steal focus', () => {
    const h = makeDriverHarness();
    const cleanup = driveFocusToTerminal('pty-1', h.deps);
    h.runFrames(20);
    cleanup();
    h.register('pty-1');
    expect(h.focused).toEqual([]);
    expect(h.listenerCount()).toBe(0);
  });
});

// ─── isFocusOrphaned ─────────────────────────────────────────────────────────
// The guard that lets the self-heal RECLAIM abandoned focus without ever
// STEALING focus the user placed on a real element.

describe('isFocusOrphaned', () => {
  const body = {} as Element;
  const real = {} as Element;

  it('true when nothing holds focus (activeElement null)', () => {
    expect(isFocusOrphaned(null, body)).toBe(true);
  });
  it('true when <body> holds focus', () => {
    expect(isFocusOrphaned(body, body)).toBe(true);
  });
  it('false when a real interactive element holds focus', () => {
    expect(isFocusOrphaned(real, body)).toBe(false);
  });
});

// ─── reassertFocusIfOrphaned ─────────────────────────────────────────────────
// Pins the fix for the field bug "typing dies in the Claude pane until I toggle
// multiview": an overlay closes, focus falls to <body>, and the terminal must
// be re-focused — but only when focus is genuinely orphaned.

/** Drives the heal with a controllable activeElement sequence + manual defer. */
function makeReassertHarness(
  seq: Array<'body' | 'real' | 'null'>,
  target: string | null,
  focusSucceeds = true,
) {
  const body = {} as Element;
  const real = {} as Element;
  const resolve = { body, real, null: null } as const;
  const active = seq.map((s) => resolve[s]);
  let i = 0;
  const focused: string[] = [];
  const healed: string[] = [];
  const culprits: Array<string | null> = [];
  const deferQueue: Array<() => void> = [];

  const deps: FocusReassertDeps = {
    resolveTarget: () => target,
    // Each read advances the staged sequence, clamping at the last entry so a
    // heal that reads activeElement twice (sync + deferred) sees both stages.
    getActiveElement: () => active[Math.min(i++, active.length - 1)],
    getBody: () => body,
    // Returns whether focus actually landed. focusSucceeds=false models an
    // invisible / mid-remount terminal whose focus() is a silent no-op.
    focusTerminal: (id) => { focused.push(id); return focusSucceeds; },
    defer: (cb) => deferQueue.push(cb),
    describeCulprit: () => 'textarea.xterm-helper-textarea',
    onHeal: (id, culprit) => { healed.push(id); culprits.push(culprit); },
  };

  return {
    deps,
    focused,
    healed,
    culprits,
    deferredCount: () => deferQueue.length,
    drain: () => { while (deferQueue.length) { const cb = deferQueue.shift(); if (cb) cb(); } },
  };
}

describe('reassertFocusIfOrphaned', () => {
  it('focuses the active terminal when focus is orphaned to <body>', () => {
    const h = makeReassertHarness(['body', 'body'], 'pty-1');
    reassertFocusIfOrphaned(h.deps);
    // Deferred — nothing focused synchronously.
    expect(h.focused).toEqual([]);
    h.drain();
    expect(h.focused).toEqual(['pty-1']);
    expect(h.healed).toEqual(['pty-1']);
  });

  it('fast-bails (schedules no defer) when a real element holds focus', () => {
    const h = makeReassertHarness(['real'], 'pty-1');
    reassertFocusIfOrphaned(h.deps);
    expect(h.deferredCount()).toBe(0); // hot per-keystroke path stays cheap
    h.drain();
    expect(h.focused).toEqual([]);
  });

  it('does nothing when no terminal target resolves (browser/editor/empty)', () => {
    const h = makeReassertHarness(['body', 'body'], null);
    reassertFocusIfOrphaned(h.deps);
    h.drain();
    expect(h.focused).toEqual([]);
    expect(h.healed).toEqual([]);
  });

  it('records the orphaning culprit on a real heal', () => {
    const h = makeReassertHarness(['body', 'body'], 'pty-1');
    reassertFocusIfOrphaned(h.deps);
    h.drain();
    expect(h.healed).toEqual(['pty-1']);
    expect(h.culprits).toEqual(['textarea.xterm-helper-textarea']);
  });

  it('does NOT count a heal when focus() fails to land (invisible / mid-remount terminal)', () => {
    // The reclaim↔orphan thrash: focus target resolves and we attempt it, but
    // the terminal is invisible so focus() is a no-op and DOM focus stays on
    // <body>. focusTerminal returns false → no heal fires, so the loop can't
    // spin and the log isn't spammed.
    const h = makeReassertHarness(['body', 'body'], 'pty-1', false);
    reassertFocusIfOrphaned(h.deps);
    h.drain();
    expect(h.focused).toEqual(['pty-1']); // we DID attempt it
    expect(h.healed).toEqual([]);         // but it was not a heal
  });

  it('does NOT yank focus when a real element claims it before the deferred frame', () => {
    // Orphaned at the synchronous check (body), but a legit element (palette
    // input) takes focus by the time the deferred re-check runs — the user
    // moved focus on purpose, so the heal must stand down.
    const h = makeReassertHarness(['body', 'real'], 'pty-1');
    reassertFocusIfOrphaned(h.deps);
    expect(h.deferredCount()).toBe(1);
    h.drain();
    expect(h.focused).toEqual([]);
    expect(h.healed).toEqual([]);
  });
});
