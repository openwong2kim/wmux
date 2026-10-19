// @vitest-environment jsdom
//
// The file tree column: which folder it starts from, its row menu, and the
// toggle shared by the titlebar, the shortcut and the palette.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FileTreePanel, { fileTreeCwd, isAtOrUnder, relativeTo } from '../FileTreePanel';
import { toggleFileTreePanel } from '../fileTreeToggle';
import { filterTree } from '../fileTreeFilter';
import { fileTreeWidthForDrag } from '../FileTreeResizeHandle';
import { useStore } from '../../../stores';
import { DEFAULT_PC_RAIL_PERSISTED } from '../../../../shared/pcRail';
import { clampFileTreeWidth, FILE_TREE_DEFAULT_WIDTH, FILE_TREE_MAX_WIDTH, FILE_TREE_MIN_WIDTH } from '../../../utils/fileTreeLayout';
import type { Workspace } from '../../../../shared/types';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Two side-by-side panes; `active` is focused. */
function workspace(active: 'p1' | 'p2', meta?: string): Workspace {
  return {
    id: 'a', name: 'a',
    rootPane: {
      id: 'root', type: 'branch', direction: 'horizontal', sizes: [50, 50],
      children: [
        { id: 'p1', type: 'leaf', activeSurfaceId: 's1', surfaces: [{ id: 's1', ptyId: 'pty-1', title: '1', shell: 'zsh', cwd: '/code/one', surfaceType: 'terminal' }] },
        { id: 'p2', type: 'leaf', activeSurfaceId: 's2', surfaces: [{ id: 's2', ptyId: 'pty-2', title: '2', shell: 'zsh', cwd: '/code/two/src', surfaceType: 'terminal' }] },
      ],
    },
    activePaneId: active,
    metadata: meta ? { cwd: meta } : {},
  } as unknown as Workspace;
}

let container: HTMLDivElement;
let root: Root;
let readDir: ReturnType<typeof vi.fn>;
let resolveRepo: ReturnType<typeof vi.fn>;
let writeText: ReturnType<typeof vi.fn>;

const flush = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };

beforeEach(() => {
  readDir = vi.fn(async (dir: string) => [
    { name: 'lib', path: `${dir}/lib`, isDirectory: true, isSymlink: false },
    { name: 'README.md', path: `${dir}/README.md`, isDirectory: false, isSymlink: false },
  ]);
  resolveRepo = vi.fn(async () => ({ ok: false }));
  writeText = vi.fn(async () => undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    fs: { readDir, watch: vi.fn(), unwatch: vi.fn(), onChanged: vi.fn(() => () => undefined), readFile: vi.fn() },
    diff: { resolveRepo },
    shell: { openPath: vi.fn(async () => ({ ok: true })) },
  };
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = { writeText };
  act(() => useStore.setState({
    workspaces: [workspace('p2')],
    activeWorkspaceId: 'a',
    pcRailHosts: [],
    pcRail: { ...DEFAULT_PC_RAIL_PERSISTED },
    appRoute: 'workspaces',
    fileTreeVisible: false,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { clipboardAPI?: unknown }).clipboardAPI;
});

describe('fileTreeCwd', () => {
  it("follows the focused pane, not the workspace's first pane", () => {
    expect(fileTreeCwd(workspace('p2'))).toBe('/code/two/src');
    expect(fileTreeCwd(workspace('p1'))).toBe('/code/one');
  });

  it("falls back to the workspace folder when the focused pane has no cwd", () => {
    const ws = workspace('p2', '/code/meta');
    (ws.rootPane as unknown as { children: { surfaces: { cwd?: string }[] }[] }).children[1].surfaces[0].cwd = undefined;
    expect(fileTreeCwd(ws)).toBe('/code/meta');
  });
});

describe('relativeTo', () => {
  it('strips the base, and leaves a path outside it whole', () => {
    expect(relativeTo('/code/two', '/code/two/src/a.ts')).toBe('src/a.ts');
    expect(relativeTo('/code/two/', '/code/two/a.ts')).toBe('a.ts');
    expect(relativeTo('/code/two', '/elsewhere/a.ts')).toBe('/elsewhere/a.ts');
  });
});

describe('isAtOrUnder', () => {
  it('matches the root and paths below it, across Windows separator and drive-case differences', () => {
    expect(isAtOrUnder('/code/two', '/code/two')).toBe(true);
    expect(isAtOrUnder('/code/two', '/code/two/src')).toBe(true);
    expect(isAtOrUnder('/code/two', '/code/twofold')).toBe(false);
    expect(isAtOrUnder('C:/code/two', 'c:\\code\\two\\src')).toBe(true);
    expect(isAtOrUnder('/', '/code')).toBe(true);
    expect(isAtOrUnder(undefined, '/code')).toBe(false);
  });
});

describe('FileTreePanel', () => {
  it('hides itself from its own close button', async () => {
    act(() => useStore.setState({ fileTreeVisible: true }));
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    const close = container.querySelector('[data-file-tree-close]') as HTMLButtonElement;
    expect(close.getAttribute('aria-label')).toBeTruthy();
    act(() => { close.click(); });
    expect(useStore.getState().fileTreeVisible).toBe(false);
  });

  it("lists the focused pane's folder outside a repository", async () => {
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    expect(readDir).toHaveBeenCalledWith('/code/two/src');
    expect(container.querySelectorAll('[data-file-tree-row]')).toHaveLength(2);
    expect(container.querySelector('[data-file-tree-root]')?.textContent).toBe('src');
  });

  it("starts at the repository root when the pane's folder is inside one", async () => {
    resolveRepo.mockResolvedValue({ ok: true, repoPath: '/code/two' });
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    expect(resolveRepo).toHaveBeenCalledWith('/code/two/src');
    expect(readDir).toHaveBeenLastCalledWith('/code/two');
    expect(container.querySelector('[data-file-tree-root]')?.textContent).toBe('two');
  });

  it("stays on the pane's terminal folder, and can still insert a path, while an editor tab is active", async () => {
    resolveRepo.mockResolvedValue({ ok: true, repoPath: '/code/two' });
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    act(() => useStore.getState().addEditorSurface('p2', '/code/two/README.md'));
    await flush();
    expect(fileTreeCwd(useStore.getState().workspaces[0])).toBe('/code/two/src');
    expect(container.querySelector('[data-file-tree-root]')?.textContent).toBe('two');
    const file = container.querySelector('[data-file-tree-row="file"]') as HTMLElement;
    act(() => { file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    expect(container.querySelector('[data-file-tree-action="insert"]')).not.toBeNull();
  });

  it('a cd inside the same repository does not reload the tree from the subfolder', async () => {
    resolveRepo.mockResolvedValue({ ok: true, repoPath: '/code/two' });
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    readDir.mockClear();
    act(() => useStore.getState().updateSurfaceCwd('pty-2', '/code/two/src/lib'));
    await flush();
    expect(resolveRepo).toHaveBeenLastCalledWith('/code/two/src/lib');
    expect(readDir).not.toHaveBeenCalledWith('/code/two/src/lib');
    expect(readDir).not.toHaveBeenCalledWith('/code/two');
    expect(container.querySelector('[data-file-tree-root]')?.textContent).toBe('two');
  });

  it('copies a path relative to the tree root from the row menu', async () => {
    resolveRepo.mockResolvedValue({ ok: true, repoPath: '/code/two' });
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    const file = container.querySelector('[data-file-tree-row="file"]') as HTMLElement;
    act(() => { file.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })); });
    expect(file.getAttribute('aria-selected')).toBe('true');
    const copy = container.querySelector('[data-file-tree-action="copy-relative"]') as HTMLElement;
    act(() => { copy.click(); });
    expect(writeText).toHaveBeenCalledWith('README.md');
    expect(container.querySelector('[data-file-tree-menu]')).toBeNull();
  });
});

describe('toggleFileTreePanel', () => {
  it('toggles on the Workspaces page', () => {
    toggleFileTreePanel(useStore.getState());
    expect(useStore.getState().fileTreeVisible).toBe(true);
    toggleFileTreePanel(useStore.getState());
    expect(useStore.getState().fileTreeVisible).toBe(false);
  });

  it('from a rail page, opens the column on the Workspaces page', () => {
    act(() => useStore.setState({ appRoute: 'git' }));
    toggleFileTreePanel(useStore.getState());
    expect(useStore.getState().fileTreeVisible).toBe(true);
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('from a rail page with the column already on, brings it into view instead of hiding it', () => {
    act(() => useStore.setState({ appRoute: 'git', fileTreeVisible: true }));
    toggleFileTreePanel(useStore.getState());
    expect(useStore.getState().fileTreeVisible).toBe(true);
    expect(useStore.getState().appRoute).toBe('workspaces');
  });
});

describe('file tree width', () => {
  it('clamps, and falls back to the default on a corrupt value', () => {
    expect(clampFileTreeWidth(100)).toBe(FILE_TREE_MIN_WIDTH);
    expect(clampFileTreeWidth(9999)).toBe(FILE_TREE_MAX_WIDTH);
    expect(clampFileTreeWidth('x')).toBe(FILE_TREE_DEFAULT_WIDTH);
  });

  it('widens when the inner edge is dragged away from the window edge', () => {
    expect(fileTreeWidthForDrag(260, -40, 'right')).toBe(300);
    expect(fileTreeWidthForDrag(260, 40, 'left')).toBe(300);
  });

  it('survives a session round trip', () => {
    act(() => useStore.setState({ fileTreeVisible: false, fileTreeWidth: FILE_TREE_DEFAULT_WIDTH }));
    useStore.getState().loadSession({
      workspaces: [workspace('p1')], activeWorkspaceId: 'a', sidebarVisible: true,
      fileTreeVisible: true, fileTreeWidth: 333,
    });
    expect(useStore.getState().fileTreeVisible).toBe(true);
    expect(useStore.getState().fileTreeWidth).toBe(333);
  });
});

describe('name filter', () => {
  /** /r: src/{app.ts, util/{appHelper.ts, z.ts}}, docs/{guide.md}, App.md, link → (symlinked folder) */
  const FS: Record<string, { name: string; isDirectory: boolean; isSymlink?: boolean }[]> = {
    '/r': [
      { name: 'src', isDirectory: true }, { name: 'docs', isDirectory: true },
      { name: 'App.md', isDirectory: false }, { name: 'link', isDirectory: true, isSymlink: true },
    ],
    '/r/src': [{ name: 'app.ts', isDirectory: false }, { name: 'util', isDirectory: true }],
    '/r/src/util': [{ name: 'appHelper.ts', isDirectory: false }, { name: 'z.ts', isDirectory: false }],
    '/r/docs': [{ name: 'guide.md', isDirectory: false }],
    '/r/link': [{ name: 'app-loop.ts', isDirectory: false }],
  };
  const fakeReadDir = async (dir: string) =>
    (FS[dir] ?? []).map((e) => ({ name: e.name, path: `${dir}/${e.name}`, isDirectory: e.isDirectory, isSymlink: !!e.isSymlink }));
  const names = (nodes: { name: string; children?: unknown[] }[]): unknown[] =>
    nodes.map((n) => (n.children ? { [n.name]: names(n.children as never) } : n.name));

  it('keeps matches in any folder, with the folders leading to them, case-insensitively', async () => {
    const r = await filterTree('/r', 'APP', fakeReadDir);
    expect(names(r!.nodes)).toEqual([{ src: [{ util: ['appHelper.ts'] }, 'app.ts'] }, 'App.md']);
    expect(r!.matchCount).toBe(3);
    expect(r!.truncated).toBe(false);
  });

  it('does not walk into a symlinked folder', async () => {
    const r = await filterTree('/r', 'loop', fakeReadDir);
    expect(r!.matchCount).toBe(0);
  });

  it('returns a matched folder collapsed, so it expands like any folder', async () => {
    const r = await filterTree('/r', 'doc', fakeReadDir);
    expect(r!.nodes).toHaveLength(1);
    expect(r!.nodes[0]).toMatchObject({ name: 'docs', matched: true, isExpanded: false });
    expect(r!.nodes[0].children).toBeUndefined();
  });

  it('stops at the entry cap and says so', async () => {
    const r = await filterTree('/r', 'z', fakeReadDir, () => false, 5);
    expect(r!.truncated).toBe(true);
  });

  it('abandons a walk a newer query cancelled', async () => {
    expect(await filterTree('/r', 'app', fakeReadDir, () => true)).toBeNull();
  });

  it('the panel opens the field from its button, filters, and folds it away on Escape', async () => {
    readDir.mockImplementation(fakeReadDir);
    resolveRepo.mockResolvedValue({ ok: true, repoPath: '/r' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
      await flush();
      expect(container.querySelector('[data-file-tree-filter]')).toBeNull();
      act(() => { (container.querySelector('[data-file-tree-filter-toggle]') as HTMLElement).click(); });
      const input = container.querySelector('[data-file-tree-filter]') as HTMLInputElement;
      expect(document.activeElement).toBe(input);
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      act(() => { setValue.call(input, 'helper'); input.dispatchEvent(new Event('input', { bubbles: true })); });
      await act(async () => { vi.advanceTimersByTime(200); });
      await flush();
      const rows = [...container.querySelectorAll('[data-file-tree-row]')].map((r) => r.textContent);
      expect(rows).toEqual(['src', 'util', 'appHelper.ts']);
      expect(container.querySelector('.wmux-filetree-match')?.textContent).toBe('Helper');
      act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(container.querySelector('[data-file-tree-filter]')).toBeNull();
      expect(container.querySelectorAll('[data-file-tree-row]')).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('opening a file from the tree (#2150)', () => {
  it('opens an image or PDF in a preview tab, and other files in the editor', async () => {
    readDir.mockImplementation(async (dir: string) => [
      { name: 'plot.png', path: `${dir}/plot.png`, isDirectory: false, isSymlink: false },
      { name: 'README.md', path: `${dir}/README.md`, isDirectory: false, isSymlink: false },
    ]);
    resolveRepo.mockResolvedValue({ ok: true, repoPath: '/code/two' });
    act(() => root.render(createElement(FileTreePanel, { position: 'right' })));
    await flush();
    const rows = [...container.querySelectorAll('[data-file-tree-row="file"]')] as HTMLElement[];
    const row = (name: string) => rows.find((r) => r.textContent?.includes(name))!;
    act(() => { row('plot.png').click(); });
    act(() => { row('README.md').click(); });
    const ws = useStore.getState().workspaces[0];
    const pane = ws.rootPane.type === 'branch' ? ws.rootPane.children[1] : ws.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces.map((s) => [s.surfaceType, s.previewFilePath ?? s.editorFilePath])).toEqual([
      ['terminal', undefined],
      ['preview', '/code/two/plot.png'],
      ['editor', '/code/two/README.md'],
    ]);
  });
});
