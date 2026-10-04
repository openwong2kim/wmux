// @vitest-environment jsdom
// Moa's HQ workspace is app-owned: it is left out of the sidebar list, its
// count, the collapsed rail and Ctrl+N; while it is the active workspace it
// shows as its own row above the list with Close and Archive disabled (with
// the reason); and every close path refuses it before any session dies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import Sidebar from '../Sidebar';
import MiniSidebar from '../MiniSidebar';
import { useKeyboard } from '../../../hooks/useKeyboard';
import { closeReviewTask } from '../../FleetView/FleetReviewRow';
import { useStore } from '../../../stores';
import { setLocale } from '../../../i18n';
import type { Pane, Workspace } from '../../../../shared/types';
import type { MoaState } from '../../../../shared/moa';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REASON = "Moa's workspace is managed by Moa and can't be closed or archived. Turn Moa off in Settings → Moa instead.";

function ws(id: string): Workspace {
  const rootPane: Pane = {
    id: `${id}-p`, type: 'leaf', activeSurfaceId: `${id}-s`,
    surfaces: [{ id: `${id}-s`, ptyId: `pty-${id}`, title: '', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }],
  };
  return { id, name: id, rootPane, activePaneId: `${id}-p` };
}
function moaState(workspaceId: string | null, state: MoaState['hq']['state'] = 'ok', enabled = true): MoaState {
  return {
    config: { enabled, onboarded: true, level: 1, maxTurnsPerHour: 20, bubbles: true, reduceMotion: false, defaultReason: null },
    hq: { workspaceId, state },
    archive: { unacked: 0, total: 0 },
  };
}
/** `a`, the HQ (`moa`) and `b`, in that stored order. */
function seed(active = 'a') {
  act(() => useStore.setState({
    workspaces: ['a', 'moa', 'b'].map(ws),
    activeWorkspaceId: active,
    activeRemoteKey: null,
    appRoute: 'workspaces',
    readOnly: false,
    sidebarSortMode: 'manual',
    sidebarAttentionFirst: false,
    sidebarPinnedIds: [],
    sidebarNewAt: {},
    sidebarFilter: { status: [], kind: [], agent: [], other: [] },
    archivedWorkspaces: [],
    toasts: [],
    missionByPaneGroup: {},
    fanoutLineage: {},
    fanoutSpawnOwner: {},
    moa: moaState('moa'),
  } as never));
}
const rows = () => [...document.querySelectorAll('.sidebar-row')]
  .filter((r) => !r.closest('[data-moa-hq-row]'))
  .map((r) => r.textContent?.match(/^[a-z]+/)?.[0]);
const hqRow = () => document.querySelector('[data-moa-hq-row] .sidebar-row') as HTMLElement | null;
const toastMessages = () => useStore.getState().toasts.map((t) => t.message);

let container: HTMLDivElement;
let root: Root;
let dispose: ReturnType<typeof vi.fn>;
let taskClose: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setLocale('en');
  dispose = vi.fn();
  taskClose = vi.fn(async () => ({ ok: true }));
  const stub = (): unknown => new Proxy(() => Promise.resolve([]), { get: (_t, key) => (key === 'then' ? undefined : stub()) });
  const own: Record<string, unknown> = { platform: 'win32', pty: { dispose }, workTask: { close: taskClose } };
  (window as unknown as { electronAPI: unknown }).electronAPI = new Proxy(own, {
    get: (t, key: string) => (key in t ? t[key] : stub()),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Moa's HQ is left out of the workspace list", () => {
  it('the sidebar lists, counts and numbers only the operator\'s workspaces', () => {
    seed();
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual(['a', 'b']);
    expect(container.querySelector('[data-sidebar-total]')?.textContent).toBe('2');
    // Ctrl+N skips the HQ: `b` is stored third but is the second listed.
    const b = [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith('b')) as HTMLElement;
    expect(b.textContent).toContain('^2');
    expect(b.textContent).not.toContain('^3');
    // Not active: no HQ row either.
    expect(hqRow()).toBeNull();
  });

  it("Moa's fan-out tasks still show (their owner is not in the list)", () => {
    seed();
    act(() => useStore.setState({
      workspaces: [...useStore.getState().workspaces, { ...ws('t1'), name: 'wtask: alpha' }],
      fanoutLineage: { t1: 'moa' },
      fanoutRefreshSettled: true,
    } as never));
    act(() => root.render(<Sidebar />));
    expect([...document.querySelectorAll('.sidebar-row')].some((r) => r.textContent?.includes('alpha'))).toBe(true);
  });

  it('the collapsed rail leaves it out and numbers the rest as listed', () => {
    seed();
    act(() => root.render(<MiniSidebar />));
    const titles = [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'))
      .filter((t) => /\(Ctrl\+\d\)$/.test(t ?? ''));
    expect(titles).toEqual(['a (Ctrl+1)', 'b (Ctrl+2)']);
  });

  it('Ctrl+2 and Ctrl+9 jump through the listed workspaces, never to the HQ', () => {
    seed();
    function Harness(): null { useKeyboard(); return null; }
    act(() => root.render(<Harness />));
    const press = (key: string) => act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, key, code: `Digit${key}` }));
    });
    press('2');
    expect(useStore.getState().activeWorkspaceId).toBe('b');
    act(() => useStore.setState({ activeWorkspaceId: 'a' }));
    press('9');
    expect(useStore.getState().activeWorkspaceId).toBe('b');
  });
});

describe('the HQ row while the HQ is active', () => {
  it('shows above the list with Close and Archive present but disabled, giving the reason', () => {
    seed('moa');
    act(() => root.render(<Sidebar />));
    const row = hqRow();
    expect(row).not.toBeNull();
    expect(row!.textContent?.startsWith('moa')).toBe(true);
    // Above the Workspaces header, and not counted in it.
    const header = container.querySelector('.wmux-sidebar-section') as HTMLElement;
    expect(row!.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-sidebar-total]')?.textContent).toBe('2');
    // The selected-hidden note is not shown for it.
    expect(container.querySelector('[data-ws-filter-hidden-active]')).toBeNull();

    const close = row!.querySelector('[data-workspace-action="close"]') as HTMLButtonElement;
    expect(close.getAttribute('aria-disabled')).toBe('true');
    expect(close.getAttribute('aria-description')).toBe(REASON);
    expect(close.title).toBe(REASON);
    // Still focusable, so the reason can be read.
    expect(close.disabled).toBe(false);
    act(() => close.click());
    expect(document.querySelector('[data-workspace-close-confirm]')).toBeNull();

    act(() => { row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    const archive = document.querySelector('[data-workspace-action="archive"]') as HTMLButtonElement;
    expect(archive.getAttribute('aria-disabled')).toBe('true');
    expect(archive.getAttribute('aria-description')).toBe(REASON);
    // No pin: the HQ is not in the list.
    expect(document.querySelector('[data-workspace-action="pin"]')).toBeNull();
    act(() => archive.click());
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['a', 'moa', 'b']);
    expect(useStore.getState().archivedWorkspaces).toEqual([]);
    expect(dispose).not.toHaveBeenCalled();
  });

  it('a normal row\'s Close and Archive stay enabled', () => {
    seed();
    act(() => root.render(<Sidebar />));
    const a = [...document.querySelectorAll('.sidebar-row')].find((r) => r.textContent?.startsWith('a')) as HTMLElement;
    expect(a.querySelector('[data-workspace-action="close"]')?.getAttribute('aria-disabled')).toBeNull();
  });
});

describe('close paths refuse the HQ before any session dies', () => {
  it('Ctrl+Shift+W on the HQ disposes nothing and says why', () => {
    seed('moa');
    function Harness(): null { useKeyboard(); return null; }
    act(() => root.render(<Harness />));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: 'W', code: 'KeyW' }));
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.some((w) => w.id === 'moa')).toBe(true);
    expect(toastMessages()).toEqual([REASON]);
  });

  it('Ctrl+Shift+W on an ordinary workspace still closes it', () => {
    seed('a');
    function Harness(): null { useKeyboard(); return null; }
    act(() => root.render(<Harness />));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: 'W', code: 'KeyW' }));
    });
    expect(dispose).toHaveBeenCalledWith('pty-a');
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['moa', 'b']);
  });

  it("Fleet's task close refuses the HQ before the task close or any dispose", async () => {
    seed();
    const ok = await closeReviewTask('moa', (k) => (k === 'moa.guard.reason' ? REASON : k));
    expect(ok).toBe(false);
    expect(taskClose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(toastMessages()).toEqual([REASON]);
  });
});

describe('[HQ, A]: A is the last listed workspace, so every close path refuses it before any dispose', () => {
  const LAST = 'This is your only workspace, so it stays open. Create another workspace first.';
  function seedTwo() {
    seed('a');
    act(() => useStore.setState({ workspaces: ['moa', 'a'].map(ws) } as never));
  }
  const rowOf = (name: string) => [...document.querySelectorAll('.sidebar-row')]
    .find((r) => r.textContent?.startsWith(name)) as HTMLElement;

  it('the sidebar Close button', () => {
    seedTwo();
    act(() => root.render(<Sidebar />));
    act(() => (rowOf('a').querySelector('[data-workspace-action="close"]') as HTMLButtonElement).click());
    const buttons = document.querySelectorAll('[data-workspace-close-confirm] button');
    act(() => (buttons[buttons.length - 1] as HTMLButtonElement).click());
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['moa', 'a']);
    expect(toastMessages()).toEqual([LAST]);
  });

  it('the sidebar Archive action', () => {
    seedTwo();
    act(() => root.render(<Sidebar />));
    act(() => { rowOf('a').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })); });
    act(() => (document.querySelector('[data-workspace-action="archive"]') as HTMLButtonElement).click());
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().archivedWorkspaces).toEqual([]);
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['moa', 'a']);
  });

  it('Ctrl+Shift+W', () => {
    seedTwo();
    function Harness(): null { useKeyboard(); return null; }
    act(() => root.render(<Harness />));
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ctrlKey: true, shiftKey: true, key: 'W', code: 'KeyW' }));
    });
    expect(dispose).not.toHaveBeenCalled();
    expect(useStore.getState().workspaces.map((w) => w.id)).toEqual(['moa', 'a']);
    expect(toastMessages()).toEqual([LAST]);
  });

  it("Fleet's task close", async () => {
    seedTwo();
    const ok = await closeReviewTask('a', (k) => k);
    expect(ok).toBe(false);
    expect(taskClose).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
  });
});

describe('before main answers, the remembered HQ id stands in', () => {
  it('the list, its count and Ctrl+N leave the remembered HQ out', () => {
    seed();
    act(() => useStore.setState({ moa: null, moaHqSeed: 'moa' } as never));
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual(['a', 'b']);
    expect(container.querySelector('[data-sidebar-total]')?.textContent).toBe('2');
  });

  it("main's answer wins over a stale remembered id", () => {
    seed();
    act(() => useStore.setState({ moa: moaState(null, 'unset'), moaHqSeed: 'moa' } as never));
    act(() => root.render(<Sidebar />));
    expect(rows()).toEqual(['a', 'moa', 'b']);
  });
});
