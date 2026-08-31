import { describe, expect, it, vi, beforeEach } from 'vitest';

// The one stash-adjacent path that genuinely destroys a pane must run the same
// teardown closePane does — assert the publish instead of trusting a comment.
vi.mock('../../../events/publisher', () => ({
  publishPaneClosed: vi.fn(),
}));
import { publishPaneClosed } from '../../../events/publisher';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { createSurfaceSlice } from '../surfaceSlice';
import { panePrincipalId } from '../../../../shared/principals';

type TestState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  surfaceAgent: Record<string, { name: string; status: string; slug?: string }>;
  surfaceActivity: Record<string, string>;
  surfacePorts: Record<string, number[]>;
  surfaceAgentStatus: Record<string, string>;
  purgeMembershipDaemon: ReturnType<typeof vi.fn>;
  principalRemoveDaemon: ReturnType<typeof vi.fn>;
};

function createHarness() {
  const workspace = createWorkspace('Test');
  const state: TestState = {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    surfaceAgent: {},
    surfaceActivity: {},
    surfacePorts: {},
    surfaceAgentStatus: {},
    purgeMembershipDaemon: vi.fn(),
    principalRemoveDaemon: vi.fn(),
  };

  const set = (updater: (state: TestState) => void) => {
    updater(state);
  };

  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  return { state, slice };
}

describe('surfaceSlice.addSurface — workspace targeting (#236)', () => {
  it('lands the surface in a background workspace when workspaceId is given', () => {
    const { state, slice } = createHarness();
    const ws1 = state.workspaces[0];
    const ws2 = createWorkspace('Background');
    state.workspaces.push(ws2);

    slice.addSurface(ws2.rootPane.id, 'pty-bg', 'pwsh', 'D:\\bg', ws2.id);

    const ws2Pane = state.workspaces.find((w) => w.id === ws2.id)!.rootPane;
    if (ws2Pane.type !== 'leaf') throw new Error('expected leaf');
    // 터미널만 push(2026-07-20 원형 복귀 — Git·Review는 워크스페이스 헤더 탭으로 이관).
    expect(ws2Pane.surfaces).toHaveLength(1);
    expect(ws2Pane.surfaces[0].ptyId).toBe('pty-bg');
    expect(ws2Pane.activeSurfaceId).toBe(ws2Pane.surfaces[0].id);

    // ws1 (the active ws) must NOT receive the surface.
    const ws1Pane = ws1.rootPane;
    if (ws1Pane.type !== 'leaf') throw new Error('expected leaf');
    expect(ws1Pane.surfaces).toHaveLength(0);
    expect(state.activeWorkspaceId).toBe(ws1.id);
  });

  it('defaults to the active workspace when workspaceId is omitted (back-compat)', () => {
    const { state, slice } = createHarness();
    slice.addSurface(state.workspaces[0].rootPane.id, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    // 터미널만 push(원형).
    expect(pane.surfaces).toHaveLength(1);
    expect(pane.surfaces[0].ptyId).toBe('pty-1');
  });
});

describe('surfaceSlice.addDiffSurface — J2 4번째 서피스', () => {
  it('diff 서피스는 ptyId="" + surfaceType="diff" + taskId 영속(PTY 자가생성 방지 불변식)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addDiffSurface(paneId, 'wtask-42', 'My Diff');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(1);
    const s = pane.surfaces[0];
    expect(s.surfaceType).toBe('diff');
    // PTY 없음 — 복원 시 자가생성 경로에 걸리지 않음(스펙 §1 성공기준).
    expect(s.ptyId).toBe('');
    expect(s.diffTaskId).toBe('wtask-42');
    expect(s.title).toBe('My Diff');
    expect(pane.activeSurfaceId).toBe(s.id);
  });

  it('같은 taskId 재요청 시 새 탭 대신 기존 탭 전환', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addDiffSurface(paneId, 'wtask-1');
    slice.addDiffSurface(paneId, 'wtask-2');
    slice.addDiffSurface(paneId, 'wtask-1'); // 중복.
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(2); // 3개가 아니라 2개.
    const first = pane.surfaces.find((s) => s.diffTaskId === 'wtask-1')!;
    expect(pane.activeSurfaceId).toBe(first.id); // 첫 탭으로 전환됨.
  });

  it('workspaceId로 백그라운드 워크스페이스 타겟팅', () => {
    const { state, slice } = createHarness();
    const ws2 = createWorkspace('BG');
    state.workspaces.push(ws2);
    slice.addDiffSurface(ws2.rootPane.id, 'wtask-bg', undefined, ws2.id);
    const bgPane = state.workspaces.find((w) => w.id === ws2.id)!.rootPane;
    if (bgPane.type !== 'leaf') throw new Error('expected leaf');
    expect(bgPane.surfaces).toHaveLength(1);
    expect(bgPane.surfaces[0].diffTaskId).toBe('wtask-bg');
  });
});

describe('surfaceSlice.addWorkspaceDiffSurface — 워크스페이스 diff 서피스', () => {
  it('ptyId="" + surfaceType="diff" + diffRepoPath 영속(diffTaskId 없음)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addWorkspaceDiffSurface(paneId, 'D:\\proj\\repo', 'diff: repo');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(1);
    const s = pane.surfaces[0];
    expect(s.surfaceType).toBe('diff');
    // PTY 없음 — 복원 시 자가생성 경로에 걸리지 않음(diffTaskId 서피스와 동일 불변식).
    expect(s.ptyId).toBe('');
    expect(s.diffRepoPath).toBe('D:\\proj\\repo');
    expect(s.diffTaskId).toBeUndefined();
    expect(s.title).toBe('diff: repo');
    expect(pane.activeSurfaceId).toBe(s.id);
  });

  it('같은 repoPath 재요청 시 새 탭 대신 기존 탭 전환', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addWorkspaceDiffSurface(paneId, 'D:\\a');
    slice.addWorkspaceDiffSurface(paneId, 'D:\\b');
    slice.addWorkspaceDiffSurface(paneId, 'D:\\a'); // 중복.
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(2);
    const first = pane.surfaces.find((s) => s.diffRepoPath === 'D:\\a')!;
    expect(pane.activeSurfaceId).toBe(first.id);
  });

  it('태스크 diff(diffTaskId)와 워크스페이스 diff(diffRepoPath)는 서로 dedup되지 않음', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addDiffSurface(paneId, 'wtask-1');
    slice.addWorkspaceDiffSurface(paneId, 'D:\\repo');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(2);
  });
});

describe('surfaceSlice.updateSurfaceCwd', () => {
  it('updates the cwd of the surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\start');

    // POSIX 경로 사용 — updateSurfaceCwd는 실행 플랫폼에서 불가능한 모양(테스트
    // 러너는 POSIX이므로 Windows 경로)을 거부한다(cwdShape 가드).
    slice.updateSurfaceCwd('pty-1', '/proj/api');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].cwd).toBe('/proj/api');
  });

  it('only touches the surface that owns the ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');

    slice.updateSurfaceCwd('pty-2', '/moved');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces.find((s) => s.ptyId === 'pty-1')?.cwd).toBe('C:\\a');
    expect(pane.surfaces.find((s) => s.ptyId === 'pty-2')?.cwd).toBe('/moved');
  });

  it('is a no-op for an empty or unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    // POSIX shapes on purpose: a Windows path would also be dropped by the
    // cwdShape guard on a POSIX runner, so this would pass without the ptyId
    // check doing any work at all.
    slice.updateSurfaceCwd('', '/nope');
    slice.updateSurfaceCwd('ghost', '/nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].cwd).toBe('C:\\a');
  });

  // Issue #833 — on a Windows host the per-surface cwd never followed a `cd`.
  // updateSurfaceCwd guards with isPlausibleCwd() and passed no platform; the
  // renderer has no `process` (contextIsolation), so the default resolved to
  // 'linux' and rejected every `C:\…`. The workspace-level cwd has a second,
  // unguarded feeder (the metadata route), which is why only the surface value
  // looked frozen — and why `surface.list`/`pane.list` reported the spawn
  // directory forever, breaking task.fanout.start's repo precondition.
  //
  // The suite runs on POSIX in CI, so the host platform is stubbed through the
  // preload bridge — the same channel the renderer really reads.
  it('follows a cd on a Windows host (#833)', () => {
    const host = globalThis as { electronAPI?: { platform?: string } };
    host.electronAPI = { platform: 'win32' };
    try {
      const { state, slice } = createHarness();
      const paneId = state.workspaces[0].rootPane.id;
      slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\Users\\rizz');

      slice.updateSurfaceCwd('pty-1', 'D:\\AI_Projects\\wmux-fork');

      const pane = state.workspaces[0].rootPane;
      if (pane.type !== 'leaf') throw new Error('expected leaf pane');
      expect(pane.surfaces[0].cwd).toBe('D:\\AI_Projects\\wmux-fork');
    } finally {
      delete host.electronAPI;
    }
  });

  it('still rejects an implausible shape for the host (prompt-scrape guard)', () => {
    const host = globalThis as { electronAPI?: { platform?: string } };
    host.electronAPI = { platform: 'darwin' };
    try {
      const { state, slice } = createHarness();
      const paneId = state.workspaces[0].rootPane.id;
      slice.addSurface(paneId, 'zsh-1', 'zsh', '/Users/me');

      // The 2026-07-20 incident: "PS C:\…>" scraped off screen text on a mac.
      slice.updateSurfaceCwd('zsh-1', 'C:\\Users\\me');

      const pane = state.workspaces[0].rootPane;
      if (pane.type !== 'leaf') throw new Error('expected leaf pane');
      expect(pane.surfaces[0].cwd).toBe('/Users/me');
    } finally {
      delete host.electronAPI;
    }
  });
});

describe('surfaceSlice.updateSurfaceTitle', () => {
  it('renames the surface with the given id (the tab "mark")', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'api-server');

    expect(pane.surfaces[0].title).toBe('api-server');
  });
});

describe('surfaceSlice.updateSurfaceTitleByPty', () => {
  it('sets the title of the terminal surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    slice.updateSurfaceTitleByPty('pty-1', 'claude: feature-x');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe('claude: feature-x');
  });

  it('is a no-op for an unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane0 = state.workspaces[0].rootPane;
    if (pane0.type !== 'leaf') throw new Error('expected leaf pane');
    const before = pane0.surfaces[0].title;

    slice.updateSurfaceTitleByPty('ghost', 'nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe(before);
  });

  it('is ignored once the surface title is locked by a manual rename', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'my-name'); // manual rename → locks
    slice.updateSurfaceTitleByPty('pty-1', 'shell-set'); // must be ignored

    expect(pane.surfaces[0].title).toBe('my-name');
    expect(pane.surfaces[0].titleLocked).toBe(true);
  });
});

describe('surfaceSlice.updateBrowserUrl', () => {
  function harnessWithBrowser() {
    const h = createHarness();
    const paneId = h.state.workspaces[0].rootPane.id;
    h.slice.addBrowserSurface(paneId, 'https://start.example', 'persist:wmux-default');
    const pane = h.state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    return { ...h, pane, surfaceId: pane.surfaces[0].id };
  }

  it('persists the navigated URL on the browser surface', () => {
    const { pane, slice, surfaceId } = harnessWithBrowser();

    slice.updateBrowserUrl(surfaceId, 'http://localhost:5173/app');

    expect(pane.surfaces[0].browserUrl).toBe('http://localhost:5173/app');
  });

  it('ignores non-http(s) URLs (about:blank must not survive into the session)', () => {
    const { pane, slice, surfaceId } = harnessWithBrowser();

    slice.updateBrowserUrl(surfaceId, 'about:blank');
    slice.updateBrowserUrl(surfaceId, 'devtools://devtools/x');

    expect(pane.surfaces[0].browserUrl).toBe('https://start.example');
  });

  it('ignores terminal surfaces and unknown surface ids', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.updateBrowserUrl(pane.surfaces[0].id, 'http://localhost:1');
    slice.updateBrowserUrl('ghost', 'http://localhost:1');

    expect(pane.surfaces[0].browserUrl).toBeUndefined();
  });
});

describe('surfaceSlice.setActiveSurface', () => {
  it('targets the active workspace when no workspaceId is given', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', '');
    slice.addSurface(paneId, 'pty-2', 'pwsh', '');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.setActiveSurface(paneId, pane.surfaces[0].id);

    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
  });

  it('targets a non-active workspace via the workspaceId parameter', () => {
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    pane.surfaces.push({ ...pane.surfaces[0], id: 'surface-second' });

    slice.setActiveSurface(pane.id, pane.surfaces[0].id, other.id);

    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
    expect(state.activeWorkspaceId).not.toBe(other.id);
  });
});

describe('surfaceSlice.closeSurface', () => {
  it('targets the active workspace when no workspaceId is given', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', '');
    slice.addSurface(paneId, 'pty-2', 'pwsh', '');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const firstId = pane.surfaces[0].id;

    slice.closeSurface(paneId, firstId);

    // pty-2 터미널만 남는다(자동 세트 없음 — 원형 복귀).
    expect(pane.surfaces).toHaveLength(1);
    expect(pane.surfaces.find((s) => s.id === firstId)).toBeUndefined();
  });

  it('targets a non-active workspace via the workspaceId parameter', () => {
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.closeSurface(pane.id, surfaceId, other.id);

    expect(pane.surfaces).toHaveLength(0);
    expect(state.activeWorkspaceId).not.toBe(other.id);
  });

  it('is a no-op for a non-active workspace pane without the workspaceId parameter', () => {
    // Documents WHY callers must thread workspaceId: the pane lookup runs
    // inside one workspace tree, so a background-workspace pane silently
    // no-ops instead of closing (the browser.close asymmetry).
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.closeSurface(pane.id, pane.surfaces[0].id);

    expect(pane.surfaces).toHaveLength(1);
  });
});

describe('surfaceSlice browser partition state', () => {
  it('stores the provided partition on new browser surfaces', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addBrowserSurface(paneId, 'https://example.com', 'persist:wmux-login');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].browserPartition).toBe('persist:wmux-login');
  });

  it('updates browser partitions across surfaces when a new profile is applied', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addBrowserSurface(paneId, 'https://one.example', 'persist:wmux-default');
    slice.addBrowserSurface(paneId, 'https://two.example', 'persist:wmux-default');
    slice.updateBrowserPartition('persist:wmux-login');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces.every((surface) => surface.browserPartition === 'persist:wmux-login')).toBe(true);
  });
});

describe('surfaceSlice.closeSurface — surfaceAgent cleanup (Part A leak-prevention)', () => {
  it('clears the surfaceAgent entry for the closed surface ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceAgent['pty-1'] = { name: 'Claude Code', status: 'running' };

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfaceAgent['pty-1']).toBeUndefined();
  });
});

describe('surfaceSlice.closeSurface — surfaceActivity cleanup (Fleet activity teardown)', () => {
  it('clears the surfaceActivity entry for the closed surface ptyId (the OTHER real teardown site)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceActivity['pty-1'] = '✎ fleet.ts';

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfaceActivity['pty-1']).toBeUndefined();
  });

  it('leaves activity for other surfaces untouched when one closes', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId1 = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceActivity['pty-1'] = '$ build';
    state.surfaceActivity['pty-2'] = '✎ keep.ts';

    slice.closeSurface(paneId, surfaceId1);

    expect(state.surfaceActivity['pty-1']).toBeUndefined();
    expect(state.surfaceActivity['pty-2']).toBe('✎ keep.ts');
  });
});

// surfacePorts and surfaceAgentStatus were the two transient per-ptyId maps
// still leaking here: every closed surface left a dead entry behind, and a
// REUSED ptyId inherited the previous surface's status (reading as blocked or
// running from birth). Found in the fleet-activity adversarial review.
describe('surfaceSlice.closeSurface — surfacePorts / surfaceAgentStatus cleanup', () => {
  it('clears BOTH transient maps for the closed surface ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfacePorts['pty-1'] = [5173];
    state.surfaceAgentStatus['pty-1'] = 'awaiting_input';

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfacePorts['pty-1']).toBeUndefined();
    expect(state.surfaceAgentStatus['pty-1']).toBeUndefined();
  });

  it('leaves other surfaces’ ports and status untouched', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId1 = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfacePorts['pty-1'] = [3000];
    state.surfacePorts['pty-2'] = [4000];
    state.surfaceAgentStatus['pty-1'] = 'running';
    state.surfaceAgentStatus['pty-2'] = 'complete';

    slice.closeSurface(paneId, surfaceId1);

    expect(state.surfacePorts['pty-1']).toBeUndefined();
    expect(state.surfacePorts['pty-2']).toEqual([4000]);
    expect(state.surfaceAgentStatus['pty-1']).toBeUndefined();
    expect(state.surfaceAgentStatus['pty-2']).toBe('complete');
  });

  it('a ptyId reused by a later surface starts with NO inherited status', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-reused', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const firstId = pane.surfaces.find((s) => s.ptyId === 'pty-reused')!.id;
    state.surfaceAgentStatus['pty-reused'] = 'awaiting_input';

    slice.closeSurface(paneId, firstId);
    slice.addSurface(paneId, 'pty-reused', 'pwsh', 'C:\\a');

    expect(state.surfaceAgentStatus['pty-reused']).toBeUndefined();
  });
});

// ─── A stashed pane that loses its last tab must go with it (#977) ──────────
//
// An empty leaf is a legitimate thing ON SCREEN — the AppLayout funnel backfills
// it. An empty STASHED pane is a ghost: the roster builds its row from a surface
// and skips it, so the pane sits there holding an ordinal and a slot against the
// pane cap with no way for anyone to click it back.

describe('surfaceSlice.closeSurface — stashed panes', () => {
  beforeEach(() => {
    vi.mocked(publishPaneClosed).mockClear();
  });

  function harnessWithStash() {
    const { state, slice } = createHarness();
    const ws = state.workspaces[0];
    ws.stashedPanes = [{
      pane: {
        id: 'p-stashed',
        type: 'leaf',
        activeSurfaceId: 'sf-a',
        ordinal: 7,
        surfaces: [
          { id: 'sf-a', ptyId: 'pty-a', title: 'a', shell: 'pwsh', cwd: 'C:\repo' },
          { id: 'sf-b', ptyId: 'pty-b', title: 'b', shell: 'pwsh', cwd: 'C:\repo' },
        ],
      },
      stashedAt: 1,
    }];
    return { state, slice, ws };
  }

  it('closes a tab of a stashed pane without dropping the pane', () => {
    const { state, slice, ws } = harnessWithStash();
    state.surfaceAgent['pty-a'] = { name: 'Claude Code', status: 'idle' };

    slice.closeSurface('p-stashed', 'sf-a');

    expect(ws.stashedPanes).toHaveLength(1);
    expect(ws.stashedPanes![0].pane.surfaces.map((s) => s.id)).toEqual(['sf-b']);
    // The closed surface's identity is torn down; the pane's is not.
    expect(state.surfaceAgent['pty-a']).toBeUndefined();
  });

  it('drops the stash entry when the LAST tab is closed', () => {
    const { slice, ws } = harnessWithStash();

    slice.closeSurface('p-stashed', 'sf-a');
    slice.closeSurface('p-stashed', 'sf-b');

    // Not an empty stashed leaf holding an ordinal nobody can reach.
    expect(ws.stashedPanes).toBeUndefined();
  });

  it('publishes pane.closed when the LAST tab goes — the pane is gone, not stashed', () => {
    const { slice, ws } = harnessWithStash();

    slice.closeSurface('p-stashed', 'sf-a');
    expect(publishPaneClosed).not.toHaveBeenCalled();

    slice.closeSurface('p-stashed', 'sf-b');
    expect(ws.stashedPanes).toBeUndefined();
    // Without this, an external poller (and stability.md's "leaving a listing
    // is always explained by an event") is left holding a paneId that silently
    // stopped existing.
    expect(publishPaneClosed).toHaveBeenCalledWith(ws.id, 'p-stashed');
  });

  it('purges the channel principal when the closed tab was an agent', () => {
    const { state, slice, ws } = harnessWithStash();
    state.surfaceAgent['pty-b'] = { name: 'Claude Code', status: 'idle', slug: 'claude' };

    slice.closeSurface('p-stashed', 'sf-a');
    slice.closeSurface('p-stashed', 'sf-b');

    // Same R2 cleanup closePane runs: canonical principalId, legacy autoName
    // row, then the principal itself. The id comes from the SAME helper the
    // slice uses — a hand-built format string is how this assertion was wrong
    // on its first run.
    const principalId = panePrincipalId(ws.id, 'p-stashed');
    expect(state.purgeMembershipDaemon).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: ws.id, principalId }),
    );
    expect(state.principalRemoveDaemon).toHaveBeenCalledWith(principalId);
  });

  it('does NOT purge a principal when the closed tab was a plain shell', () => {
    const { state, slice } = harnessWithStash();

    slice.closeSurface('p-stashed', 'sf-a');
    slice.closeSurface('p-stashed', 'sf-b');

    expect(state.purgeMembershipDaemon).not.toHaveBeenCalled();
    expect(state.principalRemoveDaemon).not.toHaveBeenCalled();
  });

  it('leaves an empty VISIBLE pane alone — the funnel backfills those', () => {
    const { state, slice } = createHarness();
    const ws = state.workspaces[0];
    const root = ws.rootPane as Extract<Workspace['rootPane'], { type: 'leaf' }>;
    root.surfaces = [{ id: 'sf-v', ptyId: 'pty-v', title: 'v', shell: 'pwsh', cwd: 'C:\repo' }];
    root.activeSurfaceId = 'sf-v';

    slice.closeSurface(root.id, 'sf-v');

    expect(root.surfaces).toHaveLength(0);
    expect(ws.stashedPanes).toBeUndefined();
  });
});

describe('surfaceSlice.addRemoteSurface (#1086/#1091)', () => {
  it('pushes a remote-terminal surface into an ordinary local workspace pane, with an empty ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addRemoteSurface(paneId, 'host-abc', 'session-xyz', 'bash', '/root');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces).toHaveLength(1);
    const surface = pane.surfaces[0];
    expect(surface.surfaceType).toBe('remote-terminal');
    expect(surface.ptyId).toBe('');
    expect(surface.remoteHostId).toBe('host-abc');
    expect(surface.remoteSessionId).toBe('session-xyz');
    expect(surface.shell).toBe('bash');
    expect(surface.cwd).toBe('/root');
    expect(pane.activeSurfaceId).toBe(surface.id);
  });

  it('lands in a background workspace when workspaceId is given, mirroring addBrowserSurface/#236', () => {
    const { state, slice } = createHarness();
    const ws2 = createWorkspace('Background');
    state.workspaces.push(ws2);

    slice.addRemoteSurface(ws2.rootPane.id, 'host-1', 'session-1', 'pwsh', 'D:\\bg', ws2.id);

    const ws2Pane = state.workspaces.find((w) => w.id === ws2.id)!.rootPane;
    if (ws2Pane.type !== 'leaf') throw new Error('expected leaf');
    expect(ws2Pane.surfaces).toHaveLength(1);
    expect(ws2Pane.surfaces[0].remoteSessionId).toBe('session-1');
  });

  it('defaults shell/cwd to empty strings when omitted', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addRemoteSurface(paneId, 'host-abc', 'session-xyz');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].shell).toBe('');
    expect(pane.surfaces[0].cwd).toBe('');
    expect(pane.surfaces[0].title).toBe('Remote');
  });

  // #1129 — ownership decides whether closing the tab destroys the session.
  it('marks the surface owned only when the caller says it minted the session', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addRemoteSurface(paneId, 'host-abc', 'minted', undefined, undefined, undefined, true);
    slice.addRemoteSurface(paneId, 'host-abc', 'viewed');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].remoteOwned).toBe(true);
    // Not merely false — absent, so a persisted surface from before #1129
    // reads the same as an explicit "not mine".
    expect(pane.surfaces[1].remoteOwned).toBeUndefined();
  });

  it('is a no-op when the target pane does not exist', () => {
    const { state, slice } = createHarness();

    slice.addRemoteSurface('no-such-pane', 'host-abc', 'session-xyz');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces).toHaveLength(0);
  });
});

describe('surfaceSlice.updateRemoteSurfaceTitle (#1086/#1091)', () => {
  it('sets the title of the remote-terminal surface identified by surfaceId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addRemoteSurface(paneId, 'host-abc', 'session-xyz');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateRemoteSurfaceTitle(surfaceId, 'my-remote-shell');

    expect(pane.surfaces[0].title).toBe('my-remote-shell');
  });

  it('is a no-op for an unknown surfaceId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addRemoteSurface(paneId, 'host-abc', 'session-xyz');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const before = pane.surfaces[0].title;

    slice.updateRemoteSurfaceTitle('ghost', 'nope');

    expect(pane.surfaces[0].title).toBe(before);
  });

  it('never touches a terminal surface, even by a matching surfaceId collision', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;
    const before = pane.surfaces[0].title;

    slice.updateRemoteSurfaceTitle(surfaceId, 'should-not-apply');

    expect(pane.surfaces[0].title).toBe(before);
  });

  it('is ignored once the surface title is locked by a manual rename', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addRemoteSurface(paneId, 'host-abc', 'session-xyz');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'my-name'); // manual rename → locks
    slice.updateRemoteSurfaceTitle(surfaceId, 'osc-set'); // must be ignored

    expect(pane.surfaces[0].title).toBe('my-name');
    expect(pane.surfaces[0].titleLocked).toBe(true);
  });
});
