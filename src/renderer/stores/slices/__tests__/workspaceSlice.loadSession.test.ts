import { describe, it, expect, beforeAll } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { DEFAULT_PREFIX_CONFIG, DEFAULT_CUSTOM_KEYBINDINGS, type Company, type Pane, type SessionData, type Workspace } from '../../../../shared/types';

// Fix 0 — minimum cross-slice state surface that workspaceSlice.loadSession
// and clearAllPtyState mutate. We intentionally don't pull in the full
// uiSlice / companySlice creators here — those creators have
// side effects (apply DOM theme classes, sync i18n locale, register
// listeners). The tests below only need the FIELDS those slices declare,
// so we hand-roll them as initial state.
type TestState = WorkspaceSlice & {
  // uiSlice fields touched by loadSession / clearAllPtyState
  paneGate: 'pending' | 'ready';
  sidebarVisible: boolean;
  theme: string;
  locale: string;
  terminalFontSize: number;
  terminalFontFamily: string;
  defaultShell: string;
  scrollbackLines: number;
  sidebarPosition: 'left' | 'right';
  notificationSoundEnabled: boolean;
  toastEnabled: boolean;
  notificationRingEnabled: boolean;
  customKeybindings: unknown[];
  autoUpdateEnabled: boolean;
  sidebarMode: 'workspaces' | 'company';
  customThemeColors: null;
  layoutTemplates: unknown[];
  recentCommands: string[];
  prefixConfig: unknown;
  onboardingCompleted: boolean;
  firstRunCompleted: boolean;
  cheatSheetDismissed: boolean;
  floatingPanePtyId: string | null;
  terminalBookmarks: Record<string, number[]>;
  // companySlice fields
  company: Company | null;
  memberCosts: Record<string, number>;
  sessionStartTime: number | null;
  // agentToolbarSlice fields touched by loadSession
  agentToolbarEnabled: boolean;
  toolbarSnippets: { id: string; label: string; text: string }[];
  newConversationCommand: string;
};

function createTestStore() {
  return create<TestState>()(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    immer((...args: any) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createWorkspaceSlice(...args),
      // Initial values for cross-slice fields (workspaceSlice doesn't own these
      // but mutates them via loadSession / clearAllPtyState).
      paneGate: 'pending',
      sidebarVisible: true,
      theme: 'catppuccin-mocha',
      locale: 'en',
      terminalFontSize: 14,
      terminalFontFamily: 'Cascadia Code',
      defaultShell: 'powershell',
      scrollbackLines: 10000,
      sidebarPosition: 'left',
      notificationSoundEnabled: true,
      toastEnabled: true,
      notificationRingEnabled: true,
      customKeybindings: [],
      autoUpdateEnabled: true,
      sidebarMode: 'workspaces',
      customThemeColors: null,
      layoutTemplates: [],
      recentCommands: [],
      prefixConfig: null,
      onboardingCompleted: false,
      firstRunCompleted: false,
      cheatSheetDismissed: false,
      floatingPanePtyId: null,
      terminalBookmarks: {},
      company: null,
      memberCosts: {},
      sessionStartTime: null,
      agentToolbarEnabled: true,
      toolbarSnippets: [],
      newConversationCommand: '/clear',
    }))
  );
}

// Stub Electron settings/i18n bridges so loadSession's optional side-effects
// don't throw. Tests don't assert on these — they just need them to no-op.
beforeAll(() => {
  // jsdom doesn't expose window.electronAPI; tests run before AppLayout mounts.
  // loadSession calls window.electronAPI.settings.setToastEnabled etc. only when
  // the corresponding data.* field is present, so we provide a minimal stub.
  (globalThis as unknown as { window: Window & { electronAPI?: unknown } }).window =
    (globalThis as unknown as { window?: Window }).window || ({} as Window);
  (globalThis.window as unknown as { electronAPI: unknown }).electronAPI = {
    settings: {
      setToastEnabled: () => undefined,
      setAutoUpdateEnabled: () => undefined,
    },
  };
  // document is provided by jsdom in vitest; safe to call setAttribute.
});

// Pane tree builder helper: nested split with two leaves at depth 2.
function makeNestedTree(ptyA: string, ptyB: string, ptyC: string): Pane {
  return {
    id: 'pane-root',
    type: 'branch',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [
      {
        id: 'pane-left',
        type: 'leaf',
        surfaces: [
          {
            id: 'surface-a',
            ptyId: ptyA,
            title: 'A',
            shell: 'bash',
            cwd: '/',
            scrollbackFile: null,
          },
        ],
        activeSurfaceId: 'surface-a',
      },
      {
        id: 'pane-right',
        type: 'branch',
        direction: 'vertical',
        sizes: [50, 50],
        children: [
          {
            id: 'pane-right-top',
            type: 'leaf',
            surfaces: [
              {
                id: 'surface-b',
                ptyId: ptyB,
                title: 'B',
                shell: 'bash',
                cwd: '/',
                scrollbackFile: null,
              },
            ],
            activeSurfaceId: 'surface-b',
          },
          {
            id: 'pane-right-bottom',
            type: 'leaf',
            surfaces: [
              {
                id: 'surface-c',
                ptyId: ptyC,
                title: 'C',
                shell: 'bash',
                cwd: '/',
                scrollbackFile: null,
              },
            ],
            activeSurfaceId: 'surface-c',
          },
        ],
      },
    ],
  } as unknown as Pane;
}

function makeBrowserSurfaceTree(url: string): Pane {
  return {
    id: 'pane-root',
    type: 'leaf',
    surfaces: [
      {
        id: 'surface-browser',
        surfaceType: 'browser',
        ptyId: '',
        browserUrl: url,
        browserPartition: 'persist:wmux-default',
      },
    ],
    activeSurfaceId: 'surface-browser',
  } as unknown as Pane;
}

describe('WorkspaceSlice.loadSession — Fix 0 contract', () => {
  it('preserves saved surface.ptyId (no wipe)', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-1',
      name: 'Restored',
      rootPane: makeNestedTree('saved-pty-a', 'saved-pty-b', 'saved-pty-c'),
      activePaneId: 'pane-left',
    };
    const data: SessionData = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as unknown as SessionData;

    store.getState().loadSession(data);

    const root = store.getState().workspaces[0].rootPane as unknown as { children: { surfaces?: { ptyId: string }[]; children?: { surfaces: { ptyId: string }[] }[] }[] };
    const leafA = root.children[0];
    const rightBranch = root.children[1];
    const leafB = rightBranch.children![0];
    const leafC = rightBranch.children![1];

    expect(leafA.surfaces![0].ptyId).toBe('saved-pty-a');
    expect(leafB.surfaces[0].ptyId).toBe('saved-pty-b');
    expect(leafC.surfaces[0].ptyId).toBe('saved-pty-c');
  });

  it('rewrites dangerous browser URLs to about:blank (regression guard)', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-1',
      name: 'Browser',
      rootPane: makeBrowserSurfaceTree('javascript:alert(1)'),
      activePaneId: 'pane-root',
    };
    const data: SessionData = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as unknown as SessionData;

    store.getState().loadSession(data);

    const root = store.getState().workspaces[0].rootPane as unknown as { surfaces: { browserUrl: string }[] };
    expect(root.surfaces[0].browserUrl).toBe('about:blank');
  });

  it('is a no-op when data.workspaces is empty', () => {
    const store = createTestStore();
    const beforeWorkspaces = store.getState().workspaces;
    const data: SessionData = {
      workspaces: [],
      activeWorkspaceId: '',
      sidebarVisible: true,
    } as unknown as SessionData;

    store.getState().loadSession(data);

    // Initial state preserved — no replacement.
    expect(store.getState().workspaces).toBe(beforeWorkspaces);
  });
});

describe('WorkspaceSlice.clearAllPtyState — Fix 0 fallback', () => {
  it('clears terminal surface ptyId across nested split panes', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-1',
      name: 'Nested',
      rootPane: makeNestedTree('pty-a', 'pty-b', 'pty-c'),
      activePaneId: 'pane-left',
    };
    const data: SessionData = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as unknown as SessionData;
    store.getState().loadSession(data);

    store.getState().clearAllPtyState();

    const root = store.getState().workspaces[0].rootPane as unknown as { children: { surfaces?: { ptyId: string }[]; children?: { surfaces: { ptyId: string }[] }[] }[] };
    const leafA = root.children[0];
    const rightBranch = root.children[1];
    const leafB = rightBranch.children![0];
    const leafC = rightBranch.children![1];

    expect(leafA.surfaces![0].ptyId).toBe('');
    expect(leafB.surfaces[0].ptyId).toBe('');
    expect(leafC.surfaces[0].ptyId).toBe('');
  });

  it('leaves browser surface ptyId field alone', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-1',
      name: 'Browser',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    const data: SessionData = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as unknown as SessionData;
    store.getState().loadSession(data);

    // Pre-clear the ptyId so we can prove it stays whatever it was set to.
    store.setState((s) => {
      const root = s.workspaces[0].rootPane as unknown as { surfaces: { ptyId: string }[] };
      root.surfaces[0].ptyId = 'browser-should-not-clear';
    });

    store.getState().clearAllPtyState();

    const root = store.getState().workspaces[0].rootPane as unknown as { surfaces: { ptyId: string }[] };
    // Browser surfaces are filtered out of the walk — ptyId stays.
    expect(root.surfaces[0].ptyId).toBe('browser-should-not-clear');
  });

  it('clears floatingPanePtyId, terminalBookmarks in a single atomic set', () => {
    const store = createTestStore();
    // Seed cross-slice state that clearAllPtyState should wipe.
    store.setState((s) => {
      s.floatingPanePtyId = 'pty-floating';
      s.terminalBookmarks = { 'pty-x': [10, 20], 'pty-y': [3] };
    });

    store.getState().clearAllPtyState();

    expect(store.getState().floatingPanePtyId).toBeNull();
    expect(store.getState().terminalBookmarks).toEqual({});
  });

  it('clears company member.ptyId across all departments when company mode active', () => {
    const store = createTestStore();
    const company: Company = {
      id: 'co-1',
      name: 'Acme',
      createdAt: Date.now(),
      departments: [
        {
          id: 'dept-eng',
          name: 'Engineering',
          leadId: 'm-1',
          members: [
            // @ts-expect-error — partial fixture, runtime tolerates extra/missing optionals
            { id: 'm-1', name: 'Alice', preset: 'engineer', workspaceId: 'ws-1', status: 'idle', ptyId: 'pty-alice' },
            // @ts-expect-error — partial fixture
            { id: 'm-2', name: 'Bob', preset: 'engineer', workspaceId: 'ws-2', status: 'idle', ptyId: 'pty-bob' },
          ],
        },
        {
          id: 'dept-pm',
          name: 'Product',
          leadId: 'm-3',
          // @ts-expect-error — partial fixture
          members: [{ id: 'm-3', name: 'Carol', preset: 'pm', workspaceId: 'ws-3', status: 'idle', ptyId: 'pty-carol' }],
        },
      ],
    };
    store.setState((s) => {
      s.company = company;
    });

    store.getState().clearAllPtyState();

    const c = store.getState().company!;
    expect(c.departments[0].members[0].ptyId).toBeUndefined();
    expect(c.departments[0].members[1].ptyId).toBeUndefined();
    expect(c.departments[1].members[0].ptyId).toBeUndefined();
  });

  it('is a no-op for company state when company is null', () => {
    const store = createTestStore();
    expect(store.getState().company).toBeNull();
    expect(() => store.getState().clearAllPtyState()).not.toThrow();
    expect(store.getState().company).toBeNull();
  });
});

describe('loadSession — agent toolbar prefs', () => {
  it('restores enabled, snippets, and new command', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-toolbar',
      name: 'Toolbar',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    store.getState().loadSession({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
      agentToolbarEnabled: false,
      agentToolbarSnippets: [{ id: 's1', label: 'A', text: 'aaa' }],
      agentToolbarNewCommand: '/reset',
    } as any);
    expect(store.getState().agentToolbarEnabled).toBe(false);
    expect(store.getState().toolbarSnippets).toEqual([{ id: 's1', label: 'A', text: 'aaa' }]);
    expect(store.getState().newConversationCommand).toBe('/reset');
  });
});

// Forward-compat config merge: a session saved by an older build must not strip
// newly-shipped default bindings/keybindings on load. Regression guard for the
// "prefix + arrow does nothing after upgrade" bug.
describe('WorkspaceSlice.loadSession — config merge (forward-compat)', () => {
  function makeSession(extra: Partial<SessionData>): SessionData {
    const ws: Workspace = {
      id: 'ws-1',
      name: 'WS',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    return {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
      ...extra,
    } as unknown as SessionData;
  }

  it('back-fills new default prefix bindings (arrow keys) absent from a stale saved config', () => {
    const store = createTestStore();
    // Simulate a session saved before arrow-key bindings existed: no Arrow* keys,
    // and a rebound 'x' (toggleZoom instead of the default closePane).
    store.getState().loadSession(
      makeSession({ prefixConfig: { key: 'KeyA', bindings: { 'x': 'toggleZoom', ':': 'commandPalette' } } as unknown as SessionData['prefixConfig'] })
    );
    const cfg = store.getState().prefixConfig as { key: string; bindings: Record<string, string> };
    // New default bindings are present after load…
    expect(cfg.bindings['ArrowUp']).toBe('focusUp');
    expect(cfg.bindings['ArrowDown']).toBe('focusDown');
    expect(cfg.bindings['ArrowLeft']).toBe('focusLeft');
    expect(cfg.bindings['ArrowRight']).toBe('focusRight');
    // …saved rebinding wins on collision with the default…
    expect(cfg.bindings['x']).toBe('toggleZoom');
    // …and the user's prefix key is preserved.
    expect(cfg.key).toBe('KeyA');
  });

  it('falls back to DEFAULT_PREFIX_CONFIG.key when the saved prefix key is missing', () => {
    const store = createTestStore();
    store.getState().loadSession(
      makeSession({ prefixConfig: { bindings: {} } as unknown as SessionData['prefixConfig'] })
    );
    const cfg = store.getState().prefixConfig as { key: string; bindings: Record<string, string> };
    expect(cfg.key).toBe(DEFAULT_PREFIX_CONFIG.key);
    expect(cfg.bindings['ArrowUp']).toBe('focusUp');
  });

  it('back-fills a missing default keybinding while preserving saved entries', () => {
    const store = createTestStore();
    store.getState().loadSession(
      makeSession({ customKeybindings: [{ id: 'kb-user-1', key: 'F8', label: 'Mine', command: 'echo hi', sendEnter: true }] })
    );
    const kbs = store.getState().customKeybindings as { id: string }[];
    const ids = kbs.map((k) => k.id);
    expect(ids).toContain('kb-user-1');
    expect(ids).toContain('kb-default-f7'); // back-filled from DEFAULT_CUSTOM_KEYBINDINGS
  });

  it('does NOT back-fill a default whose key a saved binding already repurposed under a different id', () => {
    // Runtime lookup is by key (first match wins), so resurrecting kb-default-f7
    // ahead of a user's own F7 binding would shadow it. Guard against that.
    const store = createTestStore();
    store.getState().loadSession(
      makeSession({ customKeybindings: [{ id: 'kb-user-f7', key: 'F7', label: 'My F7', command: 'vim', sendEnter: true }] })
    );
    const kbs = store.getState().customKeybindings as { id: string; key: string }[];
    const f7Bindings = kbs.filter((k) => k.key === 'F7');
    expect(f7Bindings).toHaveLength(1); // built-in NOT back-filled — no key collision shadow
    expect(f7Bindings[0].id).toBe('kb-user-f7');
    expect(kbs.map((k) => k.id)).not.toContain('kb-default-f7');
  });

  it('places saved entries before back-filled defaults so saved bindings win the key lookup', () => {
    const store = createTestStore();
    store.getState().loadSession(
      makeSession({ customKeybindings: [{ id: 'kb-user-1', key: 'F9', label: 'Mine', command: 'ls', sendEnter: true }] })
    );
    const kbs = store.getState().customKeybindings as { id: string }[];
    // kb-user-1 (F9, no collision with F7 default) first, kb-default-f7 back-filled after.
    expect(kbs[0].id).toBe('kb-user-1');
    expect(kbs.map((k) => k.id)).toContain('kb-default-f7');
  });

  it('keeps the saved (edited) default keybinding rather than the built-in on id collision', () => {
    const store = createTestStore();
    store.getState().loadSession(
      makeSession({ customKeybindings: [{ id: 'kb-default-f7', key: 'F7', label: 'Edited', command: 'custom', sendEnter: false }] })
    );
    const kbs = store.getState().customKeybindings as { id: string; label: string; command: string }[];
    const f7 = kbs.filter((k) => k.id === 'kb-default-f7');
    expect(f7).toHaveLength(1); // not duplicated
    expect(f7[0].label).toBe('Edited'); // saved edit wins over the built-in default
    expect(DEFAULT_CUSTOM_KEYBINDINGS[0].command).toBe('claude --dangerously-skip-permissions');
  });
});
