/**
 * Unit tests for the prefix-mode action registry and pass-through helper.
 *
 * The repository's vitest config runs in `node` environment without JSDOM, so
 * we can't dispatch real `KeyboardEvent`s through `window.addEventListener`.
 * Instead we exercise the two pure pieces of the prefix machinery directly:
 *
 *   1. `ctrlByteForKeyCode` — maps a `Key<X>` `e.code` to its ASCII control
 *      byte. This is what powers tmux-style prefix pass-through (`Ctrl+B
 *      Ctrl+B` → write `\x02` into the nested PTY).
 *
 *   2. `createPrefixActions(deps)` — factory that builds the action registry
 *      consumed inside `useKeyboard`'s effect. Each action is invoked with
 *      mock store/electronAPI/document and observed for the correct side
 *      effects (store mutations, IPC calls, custom events).
 *
 * Together they cover every branch added by the tmux-compat work (rename
 * workspace, kill workspace, show cheat sheet, pass-through byte mapping) plus
 * the pre-existing actions, without needing a browser harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ctrlByteForKeyCode,
  createPrefixActions,
  clampFontSize,
  type PrefixActionDeps,
} from '../useKeyboard';
import { DEFAULT_PREFIX_CONFIG } from '../../../shared/types';
import type { Pane } from '../../../shared/types';

// ─── ctrlByteForKeyCode ─────────────────────────────────────────────────────

describe('ctrlByteForKeyCode', () => {
  it('maps KeyA → \\x01 (Ctrl+A)', () => {
    expect(ctrlByteForKeyCode('KeyA')).toBe('\x01');
  });

  it('maps KeyB → \\x02 (Ctrl+B, the tmux default)', () => {
    expect(ctrlByteForKeyCode('KeyB')).toBe('\x02');
  });

  it('maps KeyM → \\x0d (Ctrl+M, same byte as CR)', () => {
    expect(ctrlByteForKeyCode('KeyM')).toBe('\x0d');
  });

  it('maps KeyZ → \\x1a (Ctrl+Z, SIGTSTP)', () => {
    expect(ctrlByteForKeyCode('KeyZ')).toBe('\x1a');
  });

  it('returns null for non-letter codes (digits, symbols, function keys)', () => {
    // Anything other than `Key[A-Z]` falls through to a silent exit in the
    // pass-through branch — no random control byte gets emitted.
    expect(ctrlByteForKeyCode('Digit1')).toBeNull();
    expect(ctrlByteForKeyCode('Space')).toBeNull();
    expect(ctrlByteForKeyCode('F7')).toBeNull();
    expect(ctrlByteForKeyCode('Semicolon')).toBeNull();
    expect(ctrlByteForKeyCode('Backquote')).toBeNull();
    expect(ctrlByteForKeyCode('')).toBeNull();
  });

  it('rejects lowercase / malformed inputs (codes are case-sensitive)', () => {
    expect(ctrlByteForKeyCode('keyA')).toBeNull();
    expect(ctrlByteForKeyCode('Key1')).toBeNull();
    expect(ctrlByteForKeyCode('KeyAB')).toBeNull();
  });
});

// ─── createPrefixActions ────────────────────────────────────────────────────

interface MockState {
  workspaces: Array<{ id: string; rootPane: Pane; activePaneId: string }>;
  activeWorkspaceId: string;
  splitPane: ReturnType<typeof vi.fn>;
  closePane: ReturnType<typeof vi.fn>;
  addWorkspace: ReturnType<typeof vi.fn>;
  removeWorkspace: ReturnType<typeof vi.fn>;
  setActiveWorkspace: ReturnType<typeof vi.fn>;
  togglePaneZoom: ReturnType<typeof vi.fn>;
  toggleCommandPalette: ReturnType<typeof vi.fn>;
  focusPaneDirection: ReturnType<typeof vi.fn>;
  setCheatSheetForceShown: ReturnType<typeof vi.fn>;
}

function makeLeaf(paneId: string, ptyIds: string[]): Pane {
  return {
    id: paneId,
    type: 'leaf',
    surfaces: ptyIds.map((p, i) => ({
      id: `${paneId}-s${i}`,
      ptyId: p,
      title: 'Terminal',
      shell: '/bin/bash',
      cwd: '/tmp',
    })),
    activeSurfaceId: ptyIds.length > 0 ? `${paneId}-s0` : '',
  };
}

function makeBranch(id: string, children: Pane[]): Pane {
  return {
    id,
    type: 'branch',
    direction: 'horizontal',
    children,
    sizes: children.map(() => 1 / children.length),
  };
}

function makeMockStore(overrides: Partial<MockState> = {}): {
  store: PrefixActionDeps['store'];
  state: MockState;
} {
  const leaf = makeLeaf('p1', ['pty-1']);
  const state: MockState = {
    workspaces: [
      { id: 'w1', rootPane: leaf, activePaneId: 'p1' },
      { id: 'w2', rootPane: makeLeaf('p2', ['pty-2']), activePaneId: 'p2' },
    ],
    activeWorkspaceId: 'w1',
    splitPane: vi.fn(),
    closePane: vi.fn(),
    addWorkspace: vi.fn(),
    removeWorkspace: vi.fn(),
    setActiveWorkspace: vi.fn(),
    togglePaneZoom: vi.fn(),
    toggleCommandPalette: vi.fn(),
    focusPaneDirection: vi.fn(),
    setCheatSheetForceShown: vi.fn(),
    ...overrides,
  };
  const store = {
    getState: () => state,
  } as unknown as PrefixActionDeps['store'];
  return { store, state };
}

function makeMockDeps(overrides: Partial<MockState> = {}): {
  deps: PrefixActionDeps;
  state: MockState;
  disposeMock: ReturnType<typeof vi.fn>;
  hideMock: ReturnType<typeof vi.fn>;
  dispatchMock: ReturnType<typeof vi.fn>;
} {
  const { store, state } = makeMockStore(overrides);
  // Keep the original vi.fn() instances around so tests can call .mock.calls
  // without fighting the PrefixActionDeps type signature (which only sees
  // a plain `(id: string) => void`).
  const disposeMock = vi.fn();
  const hideMock = vi.fn();
  const dispatchMock = vi.fn();
  const electronAPI = {
    window: { hide: hideMock },
    pty: { dispose: disposeMock },
  };
  const doc = { dispatchEvent: dispatchMock };
  const deps: PrefixActionDeps = { store, electronAPI, doc };
  return { deps, state, disposeMock, hideMock, dispatchMock };
}

describe('createPrefixActions — registry shape', () => {
  it('exposes every action ID referenced by DEFAULT_PREFIX_CONFIG.bindings', () => {
    const { deps } = makeMockDeps();
    const actions = createPrefixActions(deps);
    const usedActionIds = new Set(Object.values(DEFAULT_PREFIX_CONFIG.bindings));
    for (const id of usedActionIds) {
      expect(actions[id]).toBeTypeOf('function');
    }
  });

  it('includes the three tmux-compat actions added in the prefix expansion', () => {
    const { deps } = makeMockDeps();
    const actions = createPrefixActions(deps);
    expect(actions.renameWorkspace).toBeTypeOf('function');
    expect(actions.killWorkspace).toBeTypeOf('function');
    expect(actions.showCheatSheet).toBeTypeOf('function');
  });
});

describe('createPrefixActions — split / pane actions', () => {
  it('splitHorizontal calls store.splitPane with active pane id + "horizontal"', () => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps).splitHorizontal();
    expect(state.splitPane).toHaveBeenCalledWith('p1', 'horizontal');
  });

  it('splitVertical calls store.splitPane with "vertical"', () => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps).splitVertical();
    expect(state.splitPane).toHaveBeenCalledWith('p1', 'vertical');
  });

  it('closePane disposes every PTY in the active leaf before calling closePane', () => {
    const { deps, disposeMock, state } = makeMockDeps({
      workspaces: [
        {
          id: 'w1',
          rootPane: makeLeaf('p1', ['pty-a', 'pty-b']),
          activePaneId: 'p1',
        },
      ],
    });
    createPrefixActions(deps).closePane();
    expect(disposeMock).toHaveBeenCalledWith('pty-a');
    expect(disposeMock).toHaveBeenCalledWith('pty-b');
    expect(state.closePane).toHaveBeenCalledWith('p1');
  });

  it('toggleZoom delegates to store.togglePaneZoom on the active pane', () => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps).toggleZoom();
    expect(state.togglePaneZoom).toHaveBeenCalledWith('p1');
  });
});

describe('createPrefixActions — workspace actions', () => {
  it('newWorkspace calls store.addWorkspace', () => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps).newWorkspace();
    expect(state.addWorkspace).toHaveBeenCalledTimes(1);
  });

  it('nextWorkspace wraps from the last workspace back to the first', () => {
    const { deps, state } = makeMockDeps({ activeWorkspaceId: 'w2' });
    createPrefixActions(deps).nextWorkspace();
    expect(state.setActiveWorkspace).toHaveBeenCalledWith('w1');
  });

  it('prevWorkspace wraps from the first workspace to the last', () => {
    const { deps, state } = makeMockDeps({ activeWorkspaceId: 'w1' });
    createPrefixActions(deps).prevWorkspace();
    expect(state.setActiveWorkspace).toHaveBeenCalledWith('w2');
  });

  it('next/prevWorkspace are no-ops when only one workspace exists', () => {
    const { deps, state } = makeMockDeps({
      workspaces: [{ id: 'w1', rootPane: makeLeaf('p1', []), activePaneId: 'p1' }],
    });
    const actions = createPrefixActions(deps);
    actions.nextWorkspace();
    actions.prevWorkspace();
    expect(state.setActiveWorkspace).not.toHaveBeenCalled();
  });
});

describe('createPrefixActions — tmux compat (new in 2026-05-18 expansion)', () => {
  it('renameWorkspace dispatches the wmux:rename-workspace custom event', () => {
    const { deps, dispatchMock } = makeMockDeps();
    createPrefixActions(deps).renameWorkspace();
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const evt = dispatchMock.mock.calls[0][0] as Event;
    expect(evt).toBeInstanceOf(Event);
    expect(evt.type).toBe('wmux:rename-workspace');
  });

  it('killWorkspace disposes every PTY in the workspace tree before removeWorkspace', () => {
    // Nested branch with two terminal leaves — both PTYs must be cleaned up
    // before the workspace itself is removed, matching the Ctrl+Shift+W path
    // in useKeyboard.ts.
    const nested = makeBranch('root', [
      makeLeaf('p1', ['pty-deep-1']),
      makeBranch('inner', [
        makeLeaf('p2', ['pty-deep-2', 'pty-deep-3']),
        makeLeaf('p3', ['pty-deep-4']),
      ]),
    ]);
    const { deps, state, disposeMock } = makeMockDeps({
      workspaces: [{ id: 'w1', rootPane: nested, activePaneId: 'p1' }],
    });
    createPrefixActions(deps).killWorkspace();

    const disposed = disposeMock.mock.calls.map((c: unknown[]) => c[0] as string);
    expect(disposed.sort()).toEqual(['pty-deep-1', 'pty-deep-2', 'pty-deep-3', 'pty-deep-4']);
    expect(state.removeWorkspace).toHaveBeenCalledWith('w1');

    // PTY dispose must precede workspace removal — otherwise the daemon
    // forgets which session owned the panes and leaks the processes.
    const disposeOrder = disposeMock.mock.invocationCallOrder;
    const removeOrder = state.removeWorkspace.mock.invocationCallOrder[0];
    for (const order of disposeOrder) {
      expect(order).toBeLessThan(removeOrder);
    }
  });

  it('killWorkspace is a no-op when no active workspace is found', () => {
    const { deps, state, disposeMock } = makeMockDeps({
      activeWorkspaceId: 'does-not-exist',
    });
    createPrefixActions(deps).killWorkspace();
    expect(disposeMock).not.toHaveBeenCalled();
    expect(state.removeWorkspace).not.toHaveBeenCalled();
  });

  it('showCheatSheet flips cheatSheetForceShown via the store setter', () => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps).showCheatSheet();
    expect(state.setCheatSheetForceShown).toHaveBeenCalledWith(true);
  });
});

describe('createPrefixActions — focus directions', () => {
  it.each([
    ['focusUp', 'up'],
    ['focusDown', 'down'],
    ['focusLeft', 'left'],
    ['focusRight', 'right'],
  ] as const)('%s calls focusPaneDirection("%s")', (actionId, dir) => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps)[actionId]();
    expect(state.focusPaneDirection).toHaveBeenCalledWith(dir);
  });
});

describe('createPrefixActions — misc', () => {
  it('hideWindow calls electronAPI.window.hide', () => {
    const { deps, hideMock } = makeMockDeps();
    createPrefixActions(deps).hideWindow();
    expect(hideMock).toHaveBeenCalledTimes(1);
  });

  it('commandPalette calls store.toggleCommandPalette', () => {
    const { deps, state } = makeMockDeps();
    createPrefixActions(deps).commandPalette();
    expect(state.toggleCommandPalette).toHaveBeenCalledTimes(1);
  });
});

// ─── DEFAULT_PREFIX_CONFIG ──────────────────────────────────────────────────

describe('DEFAULT_PREFIX_CONFIG — tmux-compat bindings', () => {
  it('binds "," to renameWorkspace', () => {
    expect(DEFAULT_PREFIX_CONFIG.bindings[',']).toBe('renameWorkspace');
  });

  it('binds "&" to killWorkspace', () => {
    expect(DEFAULT_PREFIX_CONFIG.bindings['&']).toBe('killWorkspace');
  });

  it('binds "?" to showCheatSheet', () => {
    expect(DEFAULT_PREFIX_CONFIG.bindings['?']).toBe('showCheatSheet');
  });

  it('keeps the existing tmux conventions ("%", \'"\', x, c, n, p, d, z, :)', () => {
    // Regression guard — the new bindings must not displace the original
    // set. If any of these drift, users' muscle memory breaks.
    expect(DEFAULT_PREFIX_CONFIG.bindings['%']).toBe('splitHorizontal');
    expect(DEFAULT_PREFIX_CONFIG.bindings['"']).toBe('splitVertical');
    expect(DEFAULT_PREFIX_CONFIG.bindings.x).toBe('closePane');
    expect(DEFAULT_PREFIX_CONFIG.bindings.c).toBe('newWorkspace');
    expect(DEFAULT_PREFIX_CONFIG.bindings.n).toBe('nextWorkspace');
    expect(DEFAULT_PREFIX_CONFIG.bindings.p).toBe('prevWorkspace');
    expect(DEFAULT_PREFIX_CONFIG.bindings.d).toBe('hideWindow');
    expect(DEFAULT_PREFIX_CONFIG.bindings.z).toBe('toggleZoom');
    expect(DEFAULT_PREFIX_CONFIG.bindings[':']).toBe('commandPalette');
  });

  it('default prefix trigger key is KeyB (Ctrl+B)', () => {
    expect(DEFAULT_PREFIX_CONFIG.key).toBe('KeyB');
  });
});

// ─── Sanity: prefix re-entry produces the right pass-through byte ───────────

describe('ctrlByteForKeyCode + DEFAULT_PREFIX_CONFIG — wired-up sanity', () => {
  it('pass-through for the default Ctrl+B prefix produces 0x02', () => {
    // The bridge between DEFAULT_PREFIX_CONFIG.key and the pass-through
    // pipeline: when a user presses Ctrl+B Ctrl+B with the default config,
    // useKeyboard hands DEFAULT_PREFIX_CONFIG.key (== 'KeyB') to
    // ctrlByteForKeyCode and writes the result into the active PTY. If this
    // pair drifts, nested tmux silently breaks.
    const byte = ctrlByteForKeyCode(DEFAULT_PREFIX_CONFIG.key);
    expect(byte).toBe('\x02');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── D-exclusive: inspect mode suppresses every global shortcut ───────────────
// The capture keydown handler lives inside useKeyboard's effect closure (it
// touches `window` / the live store and can't be invoked under node-env vitest),
// so we assert the suppression structurally — the same fs-read approach the
// SettingsPanel inspect suite uses for handleClose. The guard must (1) be the
// very first statement in the handler, BEFORE prefix mode is read, and (2)
// early-return so no shortcut branch runs.
describe('useKeyboard handler — inspect suppression (D-exclusive)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'useKeyboard.ts'),
    'utf-8',
  );

  /** Isolate the handler body between `const handler = (e: KeyboardEvent) => {`
   *  and the line that reads prefix mode, so assertions can't match elsewhere. */
  function handlerHead(): string {
    const start = src.indexOf('const handler = (e: KeyboardEvent) => {');
    expect(start, 'handler not found in useKeyboard.ts').toBeGreaterThan(-1);
    const prefixRead = src.indexOf('const prefixMode = store.getState().prefixMode;', start);
    expect(prefixRead, 'prefix-mode read not found').toBeGreaterThan(start);
    return src.slice(start, prefixRead);
  }

  it('early-returns from the handler while inspect mode is active', () => {
    const head = handlerHead();
    expect(head).toContain('if (store.getState().inspectModeActive) return;');
  });

  it('places the inspect guard BEFORE prefix mode is read (suppresses prefix too)', () => {
    const guard = src.indexOf('if (store.getState().inspectModeActive) return;');
    const prefixRead = src.indexOf('const prefixMode = store.getState().prefixMode;');
    expect(guard).toBeGreaterThan(-1);
    expect(prefixRead).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(prefixRead);
  });

  it('does NOT special-case Escape in the guard (ESC bubbles to the overlay)', () => {
    // The guard is a blanket early-return with no Escape branch — ESC stays
    // unconsumed so InspectOverlay's React onKeyDown handles exitInspect.
    const head = handlerHead();
    expect(head).not.toMatch(/Escape/);
  });
});

// ─── Terminal font zoom (#171) ──────────────────────────────────────────────

describe('clampFontSize', () => {
  it('passes through values inside the [12, 24] range', () => {
    expect(clampFontSize(14)).toBe(14);
    expect(clampFontSize(12)).toBe(12);
    expect(clampFontSize(24)).toBe(24);
  });

  it('clamps below the minimum up to 12', () => {
    expect(clampFontSize(11)).toBe(12);
    expect(clampFontSize(-5)).toBe(12);
    expect(clampFontSize(0)).toBe(12);
  });

  it('clamps above the maximum down to 24', () => {
    expect(clampFontSize(25)).toBe(24);
    expect(clampFontSize(100)).toBe(24);
  });
});

describe('useKeyboard handler — zoom shortcuts (#171)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'useKeyboard.ts'),
    'utf-8',
  );

  it('zoom range constants stay aligned with the Settings slider + store default', () => {
    expect(src).toContain('const FONT_SIZE_MIN = 12;');
    expect(src).toContain('const FONT_SIZE_MAX = 24;');
    expect(src).toContain('const FONT_SIZE_DEFAULT = 14;');
  });

  it('zoom in matches both e.key and physical e.code (IME-safe), incl. numpad', () => {
    // The combined zoom-in guard must accept '=' / '+' by key and Equal /
    // NumpadAdd by code so a Hangul IME (e.key = composed glyph) still zooms.
    expect(src).toMatch(/key === '=' \|\| key === '\+' \|\| code === 'Equal' \|\| code === 'NumpadAdd'/);
  });

  it('zoom out matches Ctrl+- by key and Minus / NumpadSubtract by code', () => {
    expect(src).toMatch(/key === '-' \|\| key === '_' \|\| code === 'Minus' \|\| code === 'NumpadSubtract'/);
  });

  it('reset zoom (Ctrl+0) restores FONT_SIZE_DEFAULT and excludes Shift', () => {
    const reset = src.indexOf("key === '0' || code === 'Digit0' || code === 'Numpad0'");
    expect(reset, 'reset guard not found').toBeGreaterThan(-1);
    // The reset guard line requires !shift so Ctrl+Shift+0 stays free.
    const guardLineStart = src.lastIndexOf('if (', reset);
    expect(src.slice(guardLineStart, reset)).toContain('!shift');
    expect(src).toContain('store.getState().setTerminalFontSize(FONT_SIZE_DEFAULT);');
  });

  it('places the zoom guards AFTER the Ctrl+1~9 workspace switch (so Ctrl+0 is unambiguous)', () => {
    const wsSwitch = src.indexOf("key >= '1' && key <= '9'");
    const zoomIn = src.indexOf('Zoom in: Ctrl+= or Ctrl++');
    expect(wsSwitch).toBeGreaterThan(-1);
    expect(zoomIn).toBeGreaterThan(-1);
    expect(zoomIn).toBeGreaterThan(wsSwitch);
  });

  it('zoom writes through setTerminalFontSize (runtime font effect, no re-create)', () => {
    expect(src).toContain('store.getState().setTerminalFontSize(next)');
  });
});

describe('useTerminal — zoom combos bubble past xterm (#171)', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'useTerminal.ts'),
    'utf-8',
  );

  it('returns false (bubbles) for Ctrl+= / Ctrl+- / Ctrl+0 by key and code', () => {
    // Without this, xterm would feed '=' / '-' / '0' to the PTY instead of
    // letting useKeyboard zoom. Match the guard that lists the keys + codes.
    expect(src).toMatch(/e\.key === '=' \|\| e\.key === '-' \|\| e\.key === '0'/);
    expect(src).toMatch(/e\.code === 'Equal' \|\| e\.code === 'Minus' \|\| e\.code === 'Digit0'/);
  });
});
