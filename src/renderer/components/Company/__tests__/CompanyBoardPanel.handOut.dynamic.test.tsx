// @vitest-environment jsdom
//
// To hand out on the Company board: the items for the company's folder with
// Hand out… (the CEO is the company's way in), Add a task… with that folder
// first, one line with Add a task… when there is nothing to hand out, nothing
// read while the board is hidden, and "From To hand out" on a picked job.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import type { HandOutEntry } from '../../../../shared/handOut';
import type { WorkLink } from '../../../../shared/workLink';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import CompanyBoardPanel from '../CompanyBoardPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const surface = (id: string, ptyId: string): Surface => ({ id, ptyId, title: '', shell: 'zsh', cwd: '/code/wmux', surfaceType: 'terminal' });
const leaf = (id: string, ordinal: number, s: Surface): Pane => ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;
const company = (startupCwd?: string): Workspace => ({
  id: 'ws-co',
  name: 'wmux co.',
  wsOrdinal: 1,
  activePaneId: 'p1',
  nextPaneOrdinal: 3,
  ...(startupCwd ? { profile: { startupCwd } } : {}),
  company: { v: 1, id: 'co-1', coordinatorPaneId: 'p1', mission: 'Ship 4.14' },
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p1', 1, surface('s1', 'pty-1')), leaf('p2', 2, surface('s2', 'pty-2'))],
  } as unknown as Pane,
}) as Workspace;

const HOUR = 3_600_000;
const item = (id: string, folder: string, over: Partial<HandOutEntry> = {}): HandOutEntry =>
  ({ id, title: `title ${id}`, folder, addedBy: { kind: 'owner' }, createdAt: Date.now() - HOUR, state: 'open', ...over });
const handOutLink = (id: string, over: Partial<WorkLink>): WorkLink => ({
  id, origin: 'hand-out', handOutId: 'ho-x', a2aTaskId: `task-${id}`, title: `job ${id}`,
  owner: { workspaceId: 'ws-co', paneId: 'p2' }, requester: { workspaceId: 'ws-co', paneId: 'p1' },
  state: 'running', decisionIds: [], createdAt: 0, updatedAt: Date.now() - HOUR, ...over,
}) as WorkLink;

let el: HTMLDivElement;
let root: Root;
let items: HandOutEntry[];
let links: WorkLink[];
let list: ReturnType<typeof vi.fn<() => Promise<HandOutEntry[]>>>;
let changed: () => void;
/** Element rects jsdom does not lay out, by `data-board-hand-out` or `data-testid`. */
let rects: Map<string, { top: number; left: number; right: number; bottom: number }>;

const q = <E extends Element = HTMLElement>(sel: string) => el.querySelector<E>(sel);
const popover = () => document.body.querySelector<HTMLElement>('[data-testid="fleet-hand-out"]');

/** main's change push, then the list's coalesced re-read. */
async function pushChange(): Promise<void> {
  const reads = list.mock.calls.length;
  act(() => changed());
  await act(async () => {
    await vi.waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads), { timeout: 5_000 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function render(isActive = true, visible = true): Promise<void> {
  act(() => root.render(createElement(CompanyBoardPanel, { workspaceId: 'ws-co', isActive, visible })));
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function seed(ws: Workspace): void {
  act(() => useStore.setState({
    ...useStore.getInitialState(),
    locale: 'en',
    workspaces: [ws],
    activeWorkspaceId: ws.id,
    surfaceAgent: {
      'pty-1': { name: 'Claude Code', status: 'idle' as const },
      'pty-2': { name: 'Claude Code', status: 'idle' as const },
    },
  }));
}

beforeEach(() => {
  items = [];
  links = [];
  list = vi.fn(async () => items);
  changed = () => undefined;
  rects = new Map();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const key = this.getAttribute('data-board-hand-out') ?? this.getAttribute('data-testid') ?? '';
    const r = rects.get(key) ?? { top: 0, left: 0, right: 0, bottom: 0 };
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r } as DOMRect;
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    handOut: { list, onChanged: (cb: () => void) => { changed = cb; return () => undefined; } },
    workLinks: { list: async () => links, onChanged: () => () => undefined },
  };
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  vi.restoreAllMocks();
  act(() => root.unmount());
  el.remove();
  document.body.innerHTML = '';
});

describe('Company board: To hand out', () => {
  it('lists the open items for the company\'s folder, newest first, between Waiting on you and Seats', async () => {
    items = [
      item('ho-root', '/code/wmux', { createdAt: Date.now() - 3 * HOUR }),
      item('ho-app', '/code/wmux/app', { agent: 'claude', addedBy: { kind: 'pane', workspaceId: 'ws-co', paneId: 'p1', name: 'ceo' } }),
      item('ho-ios', '/code/wmux-ios'),
    ];
    seed(company('/code/wmux'));
    await render();
    const section = q('[data-board-hand-out-section]')!;
    expect(section.querySelector('h3')?.textContent).toBe('To hand out2');
    const rows = [...section.querySelectorAll<HTMLElement>('[data-board-hand-out]')];
    expect(rows.map((r) => r.dataset.boardHandOut)).toEqual(['ho-app', 'ho-root']);
    // A pane of this company is named without its workspace.
    expect(rows[0].querySelector('[data-board-hand-out-meta]')?.textContent).toBe('claude · Added by #ceo · 1h');
    expect(rows[1].querySelector('[data-board-hand-out-meta]')?.textContent).toBe('any agent · Added by you · 3h');
    expect(rows[0].querySelector('[data-board-hand-out-pick]')?.textContent).toBe('Hand out…');
    const folder = section.querySelector<HTMLElement>('[data-board-hand-out-folder]')!;
    expect(folder.title).toBe('/code/wmux');
    expect(folder.querySelector('[aria-hidden="true"]')?.textContent).toBe('/code/wmux');
    expect(folder.textContent).toContain('this company\'s folder. The CEO picks from here too.');
    // After the board's header, before Seats.
    const headings = [...el.querySelectorAll('h3')].map((h) => h.textContent);
    expect(headings.indexOf('To hand out2')).toBeLessThan(headings.indexOf('Seats'));
  });

  it('opens Hand out… on a row, with this company offered as its CEO', async () => {
    items = [item('ho-root', '/code/wmux')];
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-pick]')!.click());
    const popover = document.body.querySelector('[data-testid="fleet-hand-out"]');
    expect(popover).not.toBeNull();
    expect(popover!.querySelector('[data-hand-out-option="company:ws-co"]')).not.toBeNull();
    // The CEO pane is the company's way in, never a pane of its own.
    expect(popover!.querySelector('[data-hand-out-option="pane:pty-1"]')).toBeNull();
  });

  it('keeps Hand out…\'s agent panes live: one that comes to need you leaves the list', async () => {
    items = [item('ho-root', '/code/wmux')];
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-pick]')!.click());
    expect(popover()!.querySelector('[data-hand-out-option="pane:pty-2"]')).not.toBeNull();
    act(() => useStore.setState({ surfacePendingQuestion: { 'pty-2': 'Which branch should I target?' } }));
    expect(popover()!.querySelector('[data-hand-out-option="pane:pty-2"]')).toBeNull();
  });

  it('closes Hand out… once its workspace is hidden or another pane is zoomed', async () => {
    items = [item('ho-root', '/code/wmux')];
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-pick]')!.click());
    expect(document.body.querySelector('[data-testid="fleet-hand-out"]')).not.toBeNull();
    // Still the active tab of its pane, but the pane is out of sight.
    await render(true, false);
    expect(document.body.querySelector('[data-testid="fleet-hand-out"]')).toBeNull();
    const reads = list.mock.calls.length;
    await render(true, false);
    expect(list).toHaveBeenCalledTimes(reads);
  });

  it('closes Hand out… when the board scrolls', async () => {
    items = [item('ho-root', '/code/wmux')];
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-pick]')!.click());
    expect(popover()).not.toBeNull();
    act(() => { q('[data-testid="company-board"]')!.dispatchEvent(new Event('scroll')); });
    expect(popover()).toBeNull();
  });

  it('moves Hand out… with its row when the list changes above it', async () => {
    items = [item('ho-root', '/code/wmux')];
    rects.set('ho-root', { top: 100, left: 0, right: 300, bottom: 130 });
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-pick]')!.click());
    expect(popover()?.style.top).toBe('100px');
    // A newer item lands above it and pushes the row down.
    items = [item('ho-new', '/code/wmux', { createdAt: Date.now() }), ...items];
    rects.set('ho-root', { top: 140, left: 0, right: 300, bottom: 170 });
    await pushChange();
    expect(popover()?.style.top).toBe('140px');
  });

  it('keeps Hand out… its own width in a narrow board, past the board\'s edge', async () => {
    items = [item('ho-root', '/code/wmux')];
    rects.set('company-board', { top: 0, left: 0, right: 120, bottom: 768 });
    rects.set('ho-root', { top: 100, left: 0, right: 120, bottom: 130 });
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-pick]')!.click());
    expect(popover()?.style.width).toBe('420px');
  });

  it('opens the add form with the company\'s folder first, and Escape closes it', async () => {
    items = [item('ho-root', '/code/wmux')];
    seed(company('/code/wmux'));
    await render();
    act(() => q<HTMLButtonElement>('[data-board-hand-out-add]')!.click());
    expect(q<HTMLInputElement>('[data-fleet-hand-out-folder]')?.value).toBe('/code/wmux');
    act(() => {
      q('[data-fleet-hand-out-title]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(q('[data-fleet-hand-out-form]')).toBeNull();
    expect(q('[data-board-hand-out-add]')).not.toBeNull();
  });

  it('draws only the heading and Add a task… with nothing to hand out, and nothing for a company with no folder', async () => {
    items = [item('ho-ios', '/code/wmux-ios'), item('ho-out', '/code/wmux', { state: 'out' })];
    seed(company('/code/wmux'));
    await render();
    const section = q('[data-board-hand-out-section]')!;
    expect(section.querySelector('h3')?.textContent).toBe('To hand out');
    expect(section.querySelector('[data-board-hand-out-add]')?.textContent).toBe('Add a task…');
    expect(section.querySelector('[data-board-hand-out]')).toBeNull();
    expect(section.querySelector('[data-board-hand-out-folder]')).toBeNull();

    // No folder of its own and none where the CEO works.
    const homeless = company();
    const [ceo] = (homeless.rootPane as unknown as { children: { surfaces: Surface[] }[] }).children;
    ceo.surfaces[0].cwd = '';
    seed(homeless);
    await render();
    expect(q('[data-board-hand-out-section]')).toBeNull();
  });

  it('keeps the focus on Add a task… when the first item arrives', async () => {
    seed(company('/code/wmux'));
    await render();
    const add = q<HTMLButtonElement>('[data-board-hand-out-add]')!;
    act(() => add.focus());
    items = [item('ho-first', '/code/wmux')];
    await pushChange();
    expect(q('[data-board-hand-out="ho-first"]')).not.toBeNull();
    expect(document.activeElement).toBe(add);
    expect(add.isConnected).toBe(true);
  });

  it('reads the list only while the board is shown', async () => {
    seed(company('/code/wmux'));
    await render(false);
    expect(list).not.toHaveBeenCalled();
    await render(true);
    expect(list).toHaveBeenCalled();
  });

  it('says From To hand out, with the PR, on a seat\'s job and in the Log', async () => {
    links = [
      handOutLink('running', {
        a2aState: 'working',
        pr: { host: 'github.com', owner: 'o', repo: 'r', number: 2991 },
        prStatus: { state: 'open', checks: 'pending', reviewDecision: null, mergeable: null, observedAt: 0 } as unknown as WorkLink['prStatus'],
      }),
      handOutLink('shipped', { a2aState: 'completed' }),
      { ...handOutLink('plain', { a2aState: 'working' }), origin: 'manual', handOutId: undefined },
    ];
    seed(company('/code/wmux'));
    await render();
    const seat = q('[data-board-seat="p2"]')!;
    const lines = [...seat.querySelectorAll('[data-board-hand-out-line]')].map((n) => n.textContent);
    expect(lines).toEqual(['From To hand out · PR #2991 · checks pending']);
    expect(q('[data-board-ticket="shipped"] [data-board-hand-out-line]')?.textContent).toBe('From To hand out');
  });
});
