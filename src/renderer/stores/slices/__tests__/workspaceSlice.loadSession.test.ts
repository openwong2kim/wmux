import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createWorkspaceSlice, type WorkspaceSlice } from '../workspaceSlice';
import { DEFAULT_PREFIX_CONFIG, DEFAULT_CUSTOM_KEYBINDINGS, type BrainVendor, type Company, type Pane, type SessionData, type Workspace } from '../../../../shared/types';

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
  uiScale: number;
  terminalFontFamily: string;
  terminalCursorStyle: 'block' | 'bar' | 'underline';
  defaultShell: string;
  scrollbackLines: number;
  a2aAutoApproveExecute: boolean;
  sidebarPosition: 'left' | 'right';
  multiviewArrangement: 'auto' | 'columns' | 'rows';
  notificationSoundEnabled: boolean;
  toastEnabled: boolean;
  notificationRingEnabled: boolean;
  anthropicUsageEnabled: boolean;
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
  // #517 — main-owned browser backend mirror (NOT a SessionData key).
  browserBackend: 'builtin' | 'external';
  // Orchestrator brain vendor — loadSession re-coerces it on every load.
  deckBrainVendor: BrainVendor;
  deckBrainVendorMigrated: boolean;
  // paneSlice / workTaskSlice registries that removeWorkspace evicts. Declared
  // here (rather than composing those slices) because loadSession never writes
  // them — only the teardown path reads and deletes.
  paneNotificationRing: Record<string, 'flash' | 'glow'>;
  taskPtyRegistry: Record<string, string>;
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
      uiScale: 1,
      terminalFontFamily: 'Cascadia Code',
      terminalCursorStyle: 'block',
      defaultShell: 'powershell',
      scrollbackLines: 10000,
      a2aAutoApproveExecute: false,
      sidebarPosition: 'left',
      multiviewArrangement: 'auto',
      notificationSoundEnabled: true,
      toastEnabled: true,
      notificationRingEnabled: true,
      anthropicUsageEnabled: false,
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
      // #517 — main-owned backend mirror. Seeded here so the non-persistence
      // test can prove loadSession never writes it (it isn't a SessionData key).
      browserBackend: 'builtin',
      deckBrainVendor: 'claude-pty',
      // Seeded false (not the uiSlice default) so the marker assertions prove
      // loadSession sets it rather than reading back the fixture.
      deckBrainVendorMigrated: false,
      paneNotificationRing: {},
      taskPtyRegistry: {},
    }))
  );
}

const setUsageEnabled = vi.fn();

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
    usage: {
      setEnabled: setUsageEnabled,
    },
  };
  // document is provided by jsdom in vitest; safe to call setAttribute.
});

beforeEach(() => {
  setUsageEnabled.mockReset();
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

// J2 — diff 서피스 트리(ptyId 없음, taskId만 영속).
function makeDiffSurfaceTree(taskId: string): Pane {
  return {
    id: 'pane-root',
    type: 'leaf',
    surfaces: [
      {
        id: 'surface-diff',
        surfaceType: 'diff',
        ptyId: '',
        diffTaskId: taskId,
        title: 'Diff',
      },
    ],
    activeSurfaceId: 'surface-diff',
  } as unknown as Pane;
}

describe('WorkspaceSlice.loadSession — J2 diff 서피스 복원(PTY 자가생성 0)', () => {
  it('diff 서피스 복원 시 surfaceType·taskId 보존 + ptyId="" 유지', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-1',
      name: 'DiffRestore',
      rootPane: makeDiffSurfaceTree('wtask-restore'),
      activePaneId: 'pane-root',
    };
    const data: SessionData = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as unknown as SessionData;

    store.getState().loadSession(data);
    // clearAllPtyState는 복원 폴백 경로 — diff 서피스는 PTY 클리어 대상이 아님.
    store.getState().clearAllPtyState();

    const root = store.getState().workspaces[0].rootPane as unknown as {
      surfaces: { ptyId: string; surfaceType?: string; diffTaskId?: string }[];
    };
    const s = root.surfaces[0];
    // 핵심 불변식: PTY 자가생성 경로에 걸리지 않도록 ptyId는 계속 비어 있고
    // surfaceType='diff'가 보존되어 렌더 스위치가 DiffPanel로 라우팅한다.
    expect(s.surfaceType).toBe('diff');
    expect(s.ptyId).toBe('');
    expect(s.diffTaskId).toBe('wtask-restore');
  });
});

describe('WorkspaceSlice.loadSession — git/review surface 정리(2026-07-20 헤더 승격)', () => {
  it('구 세션의 git·review surface를 걸러내고, activeSurfaceId가 걸린 surface를 가리키면 재조정한다', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-1',
      name: 'LegacyUtil',
      rootPane: {
        id: 'pane-root',
        type: 'leaf',
        surfaces: [
          { id: 'term-1', ptyId: 'pty-1', title: 'T', shell: 'bash', cwd: '/', surfaceType: 'terminal' },
          { id: 'git-1', ptyId: '', title: 'Git', shell: '', cwd: '/repo', surfaceType: 'git' },
          { id: 'rev-1', ptyId: '', title: 'Review', shell: '', cwd: '', surfaceType: 'review' },
        ],
        // 활성 surface가 걸러질 git을 가리킨다 — 재조정 대상.
        activeSurfaceId: 'git-1',
      },
      activePaneId: 'pane-root',
    } as unknown as Workspace;
    const data: SessionData = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as unknown as SessionData;

    store.getState().loadSession(data);

    const root = store.getState().workspaces[0].rootPane as unknown as {
      surfaces: { id: string; surfaceType?: string }[];
      activeSurfaceId: string;
    };
    // git·review는 사라지고 터미널만 남는다.
    expect(root.surfaces.map((s) => s.surfaceType)).toEqual(['terminal']);
    expect(root.surfaces.some((s) => s.surfaceType === 'git' || s.surfaceType === 'review')).toBe(false);
    // 걸러진 surface를 가리키던 activeSurfaceId는 남은 첫 surface로 재조정된다.
    expect(root.activeSurfaceId).toBe('term-1');
  });
});

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

describe('loadSession — A2A execute auto-approve', () => {
  it('hydrates the global A2A execute auto-approve flag', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-a2a',
      name: 'A2A',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    expect(store.getState().a2aAutoApproveExecute).toBe(false);
    store.getState().loadSession({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
      a2aAutoApproveExecute: true,
    } as unknown as SessionData);
    expect(store.getState().a2aAutoApproveExecute).toBe(true);
  });

  it('fails closed on a non-boolean persisted value', () => {
    const store = createTestStore();
    const ws: Workspace = {
      id: 'ws-a2a',
      name: 'A2A',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    // A malformed persisted string is truthy; the guard must reject it so a
    // corrupted session can't silently enable bypassPermissions auto-approval.
    store.getState().loadSession({
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
      a2aAutoApproveExecute: 'true',
    } as unknown as SessionData);
    expect(store.getState().a2aAutoApproveExecute).toBe(false);
  });
});

describe('loadSession — multiview arrangement (#746)', () => {
  function sessionWith(arrangement: unknown): SessionData {
    const ws: Workspace = {
      id: 'ws-mv',
      name: 'MV',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    return {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
      multiviewArrangement: arrangement,
    } as unknown as SessionData;
  }

  it('restores a saved arrangement', () => {
    // The save side (AppLayout.buildSessionPayload) and this read-back are
    // separate edits; without this the pref silently resets on every restart.
    const store = createTestStore();
    expect(store.getState().multiviewArrangement).toBe('auto');
    store.getState().loadSession(sessionWith('rows'));
    expect(store.getState().multiviewArrangement).toBe('rows');
  });

  it('rejects an unknown arrangement instead of parking it in the store', () => {
    // Downgrading from a build that ships a fourth mode: the string is truthy,
    // so a bare `if (data.x)` would keep it and leave the settings segmented
    // control with nothing selected.
    const store = createTestStore();
    store.getState().loadSession(sessionWith('masonry'));
    expect(store.getState().multiviewArrangement).toBe('auto');
  });
});

describe('loadSession — Anthropic usage meter (#896)', () => {
  function sessionWith(enabled: unknown = undefined): SessionData {
    const ws: Workspace = {
      id: 'ws-usage',
      name: 'Usage',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    const session = {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
    } as Record<string, unknown>;
    if (enabled !== undefined) session.anthropicUsageEnabled = enabled;
    return session as unknown as SessionData;
  }

  it('restores an enabled opt-in and starts main-process polling', () => {
    const store = createTestStore();

    store.getState().loadSession(sessionWith(true));

    expect(store.getState().anthropicUsageEnabled).toBe(true);
    expect(setUsageEnabled).toHaveBeenCalledOnce();
    expect(setUsageEnabled).toHaveBeenCalledWith(true);
  });

  it('restores an explicit disabled value and stops main-process polling', () => {
    const store = createTestStore();
    store.setState({ anthropicUsageEnabled: true });

    store.getState().loadSession(sessionWith(false));

    expect(store.getState().anthropicUsageEnabled).toBe(false);
    expect(setUsageEnabled).toHaveBeenCalledOnce();
    expect(setUsageEnabled).toHaveBeenCalledWith(false);
  });

  it('keeps the safe default and does not touch main for an older session', () => {
    const store = createTestStore();

    store.getState().loadSession(sessionWith());

    expect(store.getState().anthropicUsageEnabled).toBe(false);
    expect(setUsageEnabled).not.toHaveBeenCalled();
  });

  it.each(['true', 1, null, {}])('ignores malformed persisted value %j', (enabled) => {
    const store = createTestStore();

    store.getState().loadSession(sessionWith(enabled));

    expect(store.getState().anthropicUsageEnabled).toBe(false);
    expect(setUsageEnabled).not.toHaveBeenCalled();
  });
});

describe('loadSession — UI scale (#822)', () => {
  function sessionWith(uiScale: unknown): SessionData {
    const ws: Workspace = {
      id: 'ws-zoom',
      name: 'Zoom',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    return {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      sidebarVisible: true,
      uiScale,
    } as unknown as SessionData;
  }

  it('restores a saved factor', () => {
    // The save side (AppLayout.buildSessionData) and this read-back are
    // separate edits; without both the pref silently resets to 1 on restart.
    const store = createTestStore();
    expect(store.getState().uiScale).toBe(1);
    store.getState().loadSession(sessionWith(1.4));
    expect(store.getState().uiScale).toBe(1.4);
  });

  it('ignores a non-finite value and keeps the default', () => {
    // session.json is hand-editable/untrusted — a garbage value must not
    // round-trip into the store and onward to setZoomFactor.
    const store = createTestStore();
    store.getState().loadSession(sessionWith('wide'));
    expect(store.getState().uiScale).toBe(1);
  });

  it('clamps an out-of-range factor so the readout tracks the applied zoom', () => {
    // main's applyUiZoom clamps the real zoom; the store must too, else a
    // hand-edited uiScale: 5 shows "500%" and re-saves as 5 (drift).
    const store = createTestStore();
    store.getState().loadSession(sessionWith(5));
    expect(store.getState().uiScale).toBe(1.6);
    store.getState().loadSession(sessionWith(-3));
    expect(store.getState().uiScale).toBe(0.8);
  });
});

describe('WorkspaceSlice.loadSession — terminalCursorStyle', () => {
  function sessionWith(style: unknown): SessionData {
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
      terminalCursorStyle: style,
    } as unknown as SessionData;
  }

  it('restores a saved bar cursor', () => {
    const store = createTestStore();
    expect(store.getState().terminalCursorStyle).toBe('block');
    store.getState().loadSession(sessionWith('bar'));
    expect(store.getState().terminalCursorStyle).toBe('bar');
  });

  it('falls back to block when the saved value is garbage', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWith('beam'));
    expect(store.getState().terminalCursorStyle).toBe('block');
  });

  it('keeps the default when the field is absent (pre-cursor sessions)', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWith(undefined));
    expect(store.getState().terminalCursorStyle).toBe('block');
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

  it('does NOT hydrate browserBackend from a session file (main owns that value)', () => {
    // The backend setting is persisted by MAIN, not the renderer session file.
    // Even if a hand-edited/legacy session.json smuggles in a browserBackend
    // field, loadSession must ignore it — it is deliberately absent from the
    // SessionData allowlist, so the mirror stays at its seeded value and only
    // AppLayout's IPC hydration can change it.
    const store = createTestStore();
    expect(store.getState().browserBackend).toBe('builtin');
    store.getState().loadSession(
      makeSession({ browserBackend: 'external' } as unknown as Partial<SessionData>)
    );
    expect(store.getState().browserBackend).toBe('builtin');
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

  it('upgrades an existing macOS user\'s untouched F7 default to Ctrl+7 on load', () => {
    // 기존 Mac 사용자(Ctrl+7 기본값 이전 설치)의 저장된 원본 F7을 로드 시 승격한다.
    // platform을 darwin으로 세팅해 시드/백필/승격의 macOS 분기를 실제로 태운다.
    const prevPlatform = (globalThis.window as unknown as { electronAPI: { platform?: string } }).electronAPI.platform;
    (globalThis.window as unknown as { electronAPI: { platform?: string } }).electronAPI.platform = 'darwin';
    try {
      const store = createTestStore();
      store.getState().loadSession(
        makeSession({ customKeybindings: [{ id: 'kb-default-f7', key: 'F7', label: 'Claude (skip permissions)', command: 'claude --dangerously-skip-permissions', sendEnter: true }] })
      );
      const kbs = store.getState().customKeybindings as { id: string; key: string }[];
      const def = kbs.filter((k) => k.id === 'kb-default-f7');
      expect(def).toHaveLength(1); // 중복 백필 없음
      expect(def[0].key).toBe('Ctrl+7'); // 승격됨
    } finally {
      (globalThis.window as unknown as { electronAPI: { platform?: string } }).electronAPI.platform = prevPlatform;
    }
  });

  it('does NOT upgrade a macOS user\'s deliberately repurposed F7 (different command)', () => {
    const prevPlatform = (globalThis.window as unknown as { electronAPI: { platform?: string } }).electronAPI.platform;
    (globalThis.window as unknown as { electronAPI: { platform?: string } }).electronAPI.platform = 'darwin';
    try {
      const store = createTestStore();
      store.getState().loadSession(
        makeSession({ customKeybindings: [{ id: 'kb-default-f7', key: 'F7', label: 'Edited', command: 'vim', sendEnter: true }] })
      );
      const kbs = store.getState().customKeybindings as { id: string; key: string }[];
      const def = kbs.filter((k) => k.id === 'kb-default-f7');
      expect(def[0].key).toBe('F7'); // 사용자 편집 → 승격 안 함
    } finally {
      (globalThis.window as unknown as { electronAPI: { platform?: string } }).electronAPI.platform = prevPlatform;
    }
  });
});

// The terminal brain became the default orchestrator (owner decision
// 2026-07-30). The coercion below is the whole migration: 'claude' stopped
// being the fallback, so it has to be whitelisted explicitly or a user who
// deliberately picked the SDK brain gets silently moved onto the terminal one
// — and onto a different session key, orphaning their live conversation.
describe('loadSession — orchestrator brain vendor coercion', () => {
  function sessionWithVendor(vendor: unknown, migrated?: boolean): SessionData {
    const ws: Workspace = {
      id: 'ws-1',
      name: 'WS',
      rootPane: makeBrowserSurfaceTree('https://example.com'),
      activePaneId: 'pane-root',
    };
    return {
      workspaces: [ws],
      activeWorkspaceId: ws.id,
      ...(vendor === undefined ? {} : { deckBrainVendor: vendor }),
      ...(migrated === undefined ? {} : { deckBrainVendorMigrated: migrated }),
    } as unknown as SessionData;
  }

  // ── pre-migration sessions (no marker) — every install on disk looks like this
  it("upgrades a pre-migration 'claude' — it is the OLD DEFAULT, not a choice", () => {
    // The load-bearing case. AppLayout always serialized the vendor, so an
    // untouched pre-migration profile carries a literal 'claude'; reading that
    // as a deliberate pick would strand the whole install base on the SDK brain
    // and leave the new default reaching new profiles only.
    const store = createTestStore();
    store.getState().loadSession(sessionWithVendor('claude'));
    expect(store.getState().deckBrainVendor).toBe('claude-pty');
  });

  it('keeps a pre-migration hermes/claude-pty pick (only reachable explicitly)', () => {
    for (const picked of ['hermes', 'claude-pty'] as const) {
      const store = createTestStore();
      store.getState().loadSession(sessionWithVendor(picked));
      expect(store.getState().deckBrainVendor).toBe(picked);
    }
  });

  it('marks any loaded session migrated so the upgrade cannot run twice', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithVendor('claude'));
    expect(store.getState().deckBrainVendorMigrated).toBe(true);
  });

  // ── post-migration sessions (marker present) — the vendor is authoritative
  it('restores an SDK choice made AFTER the migration', () => {
    // Without the marker this would be re-upgraded on every load and the user
    // could never stay on the SDK brain.
    const store = createTestStore();
    store.getState().loadSession(sessionWithVendor('claude', true));
    expect(store.getState().deckBrainVendor).toBe('claude');
  });

  it('treats a non-boolean marker as unmigrated (session.json is hand-editable)', () => {
    // `"false"` is truthy: read loosely it would pass as a migrated marker and
    // lock a legacy 'claude' in as a deliberate choice, permanently exempting
    // that profile from the upgrade.
    for (const junk of ['false', 'true', 1, {}]) {
      const store = createTestStore();
      store.getState().loadSession(sessionWithVendor('claude', junk as never));
      expect(store.getState().deckBrainVendor).toBe('claude-pty');
    }
  });

  it('falls back to the default for an unknown vendor id, migrated or not', () => {
    for (const migrated of [undefined, true]) {
      const store = createTestStore();
      store.getState().loadSession(sessionWithVendor('gpt-9', migrated));
      expect(store.getState().deckBrainVendor).toBe('claude-pty');
    }
  });
});

// ─── Stashed panes (#977) ───────────────────────────────────────────────────
//
// session.json is user-editable and can come from a newer build, so the array is
// validated entry by entry. A bad row is dropped with a warning rather than
// failing the load: the point of the feature is that a stashed pane is
// recoverable, and losing an entire session over one malformed row would be
// exactly backwards.

describe('loadSession — stashedPanes', () => {
  function stashLeaf(id: string, ptyId: string, extra: Record<string, unknown> = {}) {
    return {
      id,
      type: 'leaf' as const,
      activeSurfaceId: `sf-${id}`,
      surfaces: [{ id: `sf-${id}`, ptyId, title: id, shell: 'pwsh', cwd: 'C:\repo', ...extra }],
    };
  }

  function sessionWithStash(stashedPanes: unknown, wsExtra: Record<string, unknown> = {}): SessionData {
    return {
      workspaces: [{
        id: 'ws-1',
        name: 'WS',
        rootPane: { id: 'pane-root', type: 'leaf', surfaces: [], activeSurfaceId: '' },
        activePaneId: 'pane-root',
        stashedPanes,
        ...wsExtra,
      }],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    } as unknown as SessionData;
  }

  it('round-trips a well-formed entry', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([
      { pane: stashLeaf('p2', 'pty-2'), origin: { anchorPaneId: 'pane-root', direction: 'vertical', sourceFirst: true, sizes: [30, 70] }, stashedAt: 1234 },
    ]));

    const ws = store.getState().workspaces[0];
    expect(ws.stashedPanes).toHaveLength(1);
    expect(ws.stashedPanes![0].pane.id).toBe('p2');
    expect(ws.stashedPanes![0].pane.surfaces[0].ptyId).toBe('pty-2');
    expect(ws.stashedPanes![0].origin).toEqual({
      anchorPaneId: 'pane-root', direction: 'vertical', sourceFirst: true, sizes: [30, 70],
    });
    expect(ws.stashedPanes![0].stashedAt).toBe(1234);
  });

  it('applies the SAME sanitize pass the visible tree gets', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([
      { pane: stashLeaf('p2', '', { surfaceType: 'browser', browserUrl: 'javascript:alert(1)' }), stashedAt: 1 },
    ]));

    // A blocked scheme must not survive in the stash just because it was
    // off-screen when the rule landed.
    expect(store.getState().workspaces[0].stashedPanes![0].pane.surfaces[0].browserUrl).toBe('about:blank');
  });

  it('drops malformed entries and still loads the session', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([
      null,
      { stashedAt: 1 },                                   // no pane
      { pane: { id: 'b', type: 'branch', children: [] } }, // not a leaf
      { pane: { id: 'p9', type: 'leaf' } },                // no surfaces array
      { pane: stashLeaf('p2', 'pty-2'), stashedAt: 5 },
    ]));

    const ws = store.getState().workspaces[0];
    expect(ws.stashedPanes).toHaveLength(1);
    expect(ws.stashedPanes![0].pane.id).toBe('p2');
    expect(store.getState().workspaces).toHaveLength(1);
  });

  it.each([
    ['bad direction', { anchorPaneId: 'pane-root', direction: 'diagonal', sourceFirst: true }],
    ['bad sourceFirst', { anchorPaneId: 'pane-root', direction: 'vertical', sourceFirst: 'yes' }],
    ['missing anchor', { direction: 'vertical', sourceFirst: true }],
    ['not an object', 'nope'],
  ])('drops a malformed origin (%s) but KEEPS the pane', (_name, origin) => {
    // The origin is a hint about placement. A bad one costs a position; the
    // entry it rides on is a running session.
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([
      { pane: stashLeaf('p2', 'pty-2'), origin, stashedAt: 1 },
    ]));

    const entry = store.getState().workspaces[0].stashedPanes![0];
    expect(entry.pane.id).toBe('p2');
    expect(entry.origin).toBeUndefined();
  });

  it.each([
    ['wrong length', [50, 30, 20]],
    ['non-numeric', ['a', 'b']],
    ['zero', [0, 100]],
  ])('drops malformed origin sizes (%s) but keeps the placement', (_name, sizes) => {
    // attachBeside ignores anything that is not exactly two entries anyway; a
    // sizes/children mismatch is the bug that renders every survivor one slot
    // off, so it is discarded at the door rather than carried around.
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([
      {
        pane: stashLeaf('p2', 'pty-2'),
        origin: { anchorPaneId: 'pane-root', direction: 'vertical', sourceFirst: true, sizes },
        stashedAt: 1,
      },
    ]));

    const entry = store.getState().workspaces[0].stashedPanes![0];
    expect(entry.origin).toEqual({ anchorPaneId: 'pane-root', direction: 'vertical', sourceFirst: true });
  });

  it('drops a non-array stashedPanes outright', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash('not-an-array'));
    expect(store.getState().workspaces[0].stashedPanes).toBeUndefined();
  });

  it('leaves the field absent when nothing was stashed', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash(undefined));
    expect(store.getState().workspaces[0].stashedPanes).toBeUndefined();
  });

  it('counts stashed ordinals in the high-water mark (duplicate-ordinal regression)', () => {
    // The stashed pane holds the HIGHEST ordinal. If the recompute only walked
    // the visible tree, nextPaneOrdinal would land at 2 and the next split would
    // reissue 7 — two panes answering to the same auto name, which is also the
    // A2A address.
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash(
      [{ pane: { ...stashLeaf('p2', 'pty-2'), ordinal: 7 }, stashedAt: 1 }],
      { rootPane: { id: 'pane-root', type: 'leaf', surfaces: [], activeSurfaceId: '', ordinal: 1 }, nextPaneOrdinal: 2 },
    ));

    expect(store.getState().workspaces[0].nextPaneOrdinal).toBe(8);
  });

  it('backfills a missing ordinal PAST every stashed one', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash(
      [{ pane: { ...stashLeaf('p2', 'pty-2'), ordinal: 4 }, stashedAt: 1 }],
      { rootPane: { id: 'pane-root', type: 'leaf', surfaces: [], activeSurfaceId: '' } },
    ));

    const ws = store.getState().workspaces[0];
    const root = ws.rootPane as { ordinal?: number };
    expect(root.ordinal).toBe(5);
    expect(ws.nextPaneOrdinal).toBe(6);
  });

  it('clearAllPtyState wipes stashed ptyIds too', () => {
    // This is the "we could not reconcile anything" fallback. Leaving stashed
    // panes bound to ptyIds we just declared untrustworthy would make them the
    // only surfaces still claiming a live session.
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([{ pane: stashLeaf('p2', 'pty-2'), stashedAt: 1 }]));

    store.getState().clearAllPtyState();

    expect(store.getState().workspaces[0].stashedPanes![0].pane.surfaces[0].ptyId).toBe('');
  });

  it('clearSurfacePtyIdByPty reaches a stashed pane and logs the transition', () => {
    // Reconcile confirming a stashed session dead is what flips its DERIVED
    // liveness to `exited`. A visible-tree-only clear leaves the model stranded.
    // The log matters more here than for a visible pane: this one happened
    // off-screen, so without the line there is no trace at all that an agent
    // died except a sidebar label nobody was watching.
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([{ pane: stashLeaf('p2', 'pty-2'), stashedAt: 1 }]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    store.getState().clearSurfacePtyIdByPty('pty-2');

    expect(store.getState().workspaces[0].stashedPanes![0].pane.surfaces[0].ptyId).toBe('');
    expect(warn.mock.calls.map(([m]) => String(m)).join(' | ')).toContain('[wmux:stash]');
    warn.mockRestore();
  });

  it('removeWorkspace evicts registry entries keyed by a stashed pane', () => {
    const store = createTestStore();
    store.getState().loadSession(sessionWithStash([{ pane: stashLeaf('p2', 'pty-2'), stashedAt: 1 }]));
    store.getState().addWorkspace('Second');
    store.setState((s) => {
      s.paneNotificationRing = { p2: 'glow' };
      s.taskPtyRegistry = { 'pty-2': 'task-1' };
    });

    store.getState().removeWorkspace('ws-1');

    expect(store.getState().paneNotificationRing['p2']).toBeUndefined();
    expect(store.getState().taskPtyRegistry['pty-2']).toBeUndefined();
  });
});

// ─── Downgrade round-trip (#977, E-6) ───────────────────────────────────────
//
// The "boot fallback" idea does not work — an old binary cannot run new code.
// What ACTUALLY protects a downgraded user is duller and more reliable: the old
// buildSessionData spreads `...ws` and only overrides rootPane, so a field it
// has never heard of round-trips untouched. This pins that mechanism, because
// the changelog's downgrade note is a promise resting on it.

describe('loadSession — downgrade round-trip', () => {
  /** The pre-stash builder, reproduced exactly: spread the workspace, replace
   *  the tree, know nothing about anything else. */
  function oldBuildSessionData(workspaces: Workspace[]): SessionData {
    return {
      workspaces: workspaces.map((w) => ({ ...w, rootPane: w.rootPane })),
      activeWorkspaceId: workspaces[0].id,
      sidebarVisible: true,
    } as unknown as SessionData;
  }

  it('an old writer preserves stashedPanes it does not understand', () => {
    const store = createTestStore();
    const stashEntry = {
      pane: {
        id: 'p2',
        type: 'leaf' as const,
        activeSurfaceId: 'sf-p2',
        surfaces: [{ id: 'sf-p2', ptyId: 'pty-2', title: 'p2', shell: 'pwsh', cwd: 'C:\repo' }],
      },
      stashedAt: 42,
    };
    store.getState().loadSession({
      workspaces: [{
        id: 'ws-1',
        name: 'WS',
        rootPane: { id: 'pane-root', type: 'leaf', surfaces: [], activeSurfaceId: '' },
        activePaneId: 'pane-root',
        stashedPanes: [stashEntry],
      }],
      activeWorkspaceId: 'ws-1',
      sidebarVisible: true,
    } as unknown as SessionData);

    // …downgrade: the old build writes the session back out…
    const written = oldBuildSessionData(store.getState().workspaces);
    // …upgrade: the new build reads it again.
    const store2 = createTestStore();
    store2.getState().loadSession(written);

    expect(store2.getState().workspaces[0].stashedPanes).toHaveLength(1);
    expect(store2.getState().workspaces[0].stashedPanes![0].pane.surfaces[0].ptyId).toBe('pty-2');
    expect(store2.getState().workspaces[0].stashedPanes![0].stashedAt).toBe(42);
  });
});

// ─── stashedPanes load guards (#977 review) ──────────────────────────────────
//
// session.json is hand-editable, and the entry-by-entry validation exists for
// exactly that: these pin the three holes the three-way review found in it —
// an empty pane (a ghost holding an ordinal), a paneId duplicated against the
// visible tree (reconciled and rendered twice), and a colliding ordinal (two
// panes sharing an auto-name, which is the A2A address).

function stashLoadData(stashedPanes: unknown): SessionData {
  const ws = {
    id: 'ws-sg',
    name: 'StashGuards',
    rootPane: {
      id: 'p-vis',
      type: 'leaf',
      activeSurfaceId: 's-v',
      ordinal: 1,
      surfaces: [{ id: 's-v', ptyId: 'pty-v', title: 'v', shell: 'pwsh', cwd: 'C:/r' }],
    },
    activePaneId: 'p-vis',
    stashedPanes,
  } as unknown as Workspace;
  return {
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    sidebarVisible: true,
  } as unknown as SessionData;
}

function stashEntry(paneId: string, ordinal: number) {
  return {
    pane: {
      id: paneId,
      type: 'leaf',
      activeSurfaceId: `${paneId}-s`,
      ordinal,
      surfaces: [{ id: `${paneId}-s`, ptyId: `${paneId}-pty`, title: 't', shell: 'pwsh', cwd: 'C:/r' }],
    },
    stashedAt: 1,
  };
}

describe('WorkspaceSlice.loadSession — stashedPanes guards (#977 review)', () => {
  it('drops a stash entry with an empty surfaces array — same rule as canStashPaneSurfaces', () => {
    const store = createTestStore();
    const empty = { ...stashEntry('p-empty', 5), pane: { ...stashEntry('p-empty', 5).pane, surfaces: [] } };
    store.getState().loadSession(stashLoadData([empty, stashEntry('p-ok', 6)]));

    const ws = store.getState().workspaces[0];
    expect(ws.stashedPanes?.map((e) => e.pane.id)).toEqual(['p-ok']);
  });

  it('drops a stash entry whose id also lives in the visible tree', () => {
    const store = createTestStore();
    store.getState().loadSession(stashLoadData([stashEntry('p-vis', 5), stashEntry('p-ok', 6)]));

    const ws = store.getState().workspaces[0];
    // The visible copy is the one on screen; the stash copy loses.
    expect(ws.stashedPanes?.map((e) => e.pane.id)).toEqual(['p-ok']);
  });

  it('drops the second copy of an id duplicated inside the stash itself', () => {
    const store = createTestStore();
    store.getState().loadSession(stashLoadData([stashEntry('p-dup', 5), stashEntry('p-dup', 6)]));

    expect(store.getState().workspaces[0].stashedPanes).toHaveLength(1);
  });

  it('reassigns a stashed ordinal that collides with a visible one — auto-names are A2A addresses', () => {
    const store = createTestStore();
    // Visible pane holds ordinal 1; this stash entry claims 1 too.
    store.getState().loadSession(stashLoadData([stashEntry('p-coll', 1)]));

    const ws = store.getState().workspaces[0];
    const kept = ws.stashedPanes![0].pane;
    expect(kept.id).toBe('p-coll');
    expect(kept.ordinal).not.toBe(1);
    expect(typeof kept.ordinal).toBe('number');
  });

  it('keeps a well-formed entry untouched', () => {
    const store = createTestStore();
    store.getState().loadSession(stashLoadData([stashEntry('p-keep', 9)]));

    const ws = store.getState().workspaces[0];
    expect(ws.stashedPanes![0].pane.ordinal).toBe(9);
  });
});
