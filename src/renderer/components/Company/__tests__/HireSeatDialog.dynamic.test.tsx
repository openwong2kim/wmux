// @vitest-environment jsdom
//
// "Add a seat on this PC…": a free default name held to the pane-label rules,
// the exact request main gets, the new pane split from the last staff pane
// and seeded for the funnel, the CEO watch started for it, and nothing to add
// while the CEO seat is vacant, the pane cap is reached, or the seat would
// share a checkout with another staff agent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import { getLeafPanes } from '../../../../shared/paneUtils';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import type { HireSeatRequest, HireSeatResult } from '../../../../main/company/seatLaunch';
import HireSeatDialog from '../HireSeatDialog';

const watchHireNotice = vi.hoisted(() => vi.fn<(seat: unknown) => () => void>(() => () => undefined));
vi.mock('../../../hooks/companyHireNotice', () => ({ watchHireNotice }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const surface = (id: string, ptyId: string): Surface => ({ id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal' });
const leaf = (id: string, ordinal: number, s: Surface): Pane => ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;
const company = (coordinatorPaneId: string | null): Workspace => ({
  id: 'ws-co',
  name: 'Acme',
  wsOrdinal: 1,
  activePaneId: 'p1',
  nextPaneOrdinal: 3,
  profile: { startupCwd: '/repo' },
  company: { v: 1, id: 'co-1', coordinatorPaneId, mission: 'Ship it', standingOrders: 'Live check first.' },
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p1', 1, surface('s1', 'pty-1')), leaf('p2', 2, surface('s2', 'pty-2'))],
  } as unknown as Pane,
}) as Workspace;
const other = { id: 'ws-other', name: 'Other', wsOrdinal: 2, activePaneId: 'o1', rootPane: leaf('o1', 1, surface('so', 'pty-o')) } as Workspace;

let el: HTMLDivElement;
let root: Root;
let hireSeat: ReturnType<typeof vi.fn<(req: HireSeatRequest) => Promise<HireSeatResult>>>;
let isRepo: boolean;
const onClose = vi.fn();

const q = <E extends Element = HTMLElement>(id: string) => document.body.querySelector<E>(`[data-testid="${id}"]`);
const add = () => q<HTMLButtonElement>('hire-seat-add');

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  });
};

async function render(): Promise<void> {
  act(() => root.render(createElement(HireSeatDialog, { workspaceId: 'ws-co', onClose })));
  await flush();
}

function type(id: string, value: string): void {
  const node = q<HTMLInputElement>(id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function pick(id: string, value: string): void {
  const node = q<HTMLSelectElement>(id)!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

beforeEach(() => {
  hireSeat = vi.fn<(req: HireSeatRequest) => Promise<HireSeatResult>>();
  isRepo = true;
  onClose.mockReset();
  watchHireNotice.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    company: { hireSeat },
    diff: { resolveRepo: () => Promise.resolve(isRepo ? { ok: true, repoPath: '/repo' } : { ok: false }) },
    factory: {
      workerAgents: () => Promise.resolve([
        { agent: 'claude', label: 'Claude Code', installed: true },
        { agent: 'codex', label: 'Codex', installed: true },
        { agent: 'gemini', label: 'Gemini CLI', installed: false },
      ]),
    },
  };
  act(() => useStore.setState({
    ...useStore.getInitialState(),
    locale: 'en',
    workspaces: [other, company('p1')],
    activeWorkspaceId: 'ws-other',
    paneLabel: { p1: 'pm', p2: 'dev' },
    paneRole: { p2: 'Frontend' },
    surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' }, 'pty-2': { name: 'Claude Code', status: 'idle' } },
  }));
  el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
});

afterEach(() => {
  act(() => root.unmount());
  el.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('HireSeatDialog', () => {
  it('names the company and its CEO, offers a free name, the installed agents and where the seat works', async () => {
    await render();
    expect(q('hire-seat')?.textContent).toContain('Starts an agent for Acme on this PC. It takes briefs from pm, the CEO.');
    // `dev` is a pane's label already.
    expect(q<HTMLInputElement>('hire-seat-name')?.value).toBe('dev-2');
    const agent = q<HTMLSelectElement>('hire-seat-agent')!;
    expect(agent.value).toBe('claude');
    expect([...agent.options].map((o) => [o.value, o.disabled])).toEqual([['claude', false], ['codex', false], ['gemini', true]]);
    expect(q('hire-seat-works-in')?.textContent).toContain('Its own worktree of /repo, on a new branch');
    expect(add()?.disabled).toBe(false);
  });

  it('holds the name to the pane-label rules and keeps it free', async () => {
    await render();
    for (const bad of ['w1-2', 'has space', '#pm', '9lives', 'PM', 'Dev']) {
      type('hire-seat-name', bad);
      expect(q('hire-seat-name-error'), bad).not.toBeNull();
      expect(add()?.disabled, bad).toBe(true);
    }
    type('hire-seat-name', '');
    expect(add()?.disabled).toBe(true);
    type('hire-seat-name', 'windows');
    expect(q('hire-seat-name-error')).toBeNull();
    expect(add()?.disabled).toBe(false);
  });

  it('asks main for exactly this seat, then opens it under the last staff pane, seeded, and watches it for the CEO', async () => {
    hireSeat.mockResolvedValue({ ok: true, label: 'dev-2', command: 'codex "$(cat \'/b/hire.md\')"', cwd: '/wt/dev-2', branch: 'company/dev-2-1a2b3c4d' });
    await render();
    pick('hire-seat-agent', 'codex');
    type('hire-seat-owns', 'Windows checks');
    await act(async () => { add()!.click(); });
    await flush();
    expect(hireSeat).toHaveBeenCalledWith({
      workspaceId: 'ws-co',
      company: 'Acme',
      mission: 'Ship it',
      standingOrders: 'Live check first.',
      folder: '/repo',
      ceo: { label: 'pm' },
      staff: [{ label: 'dev', owns: 'Frontend', agent: true }],
      seat: { label: 'dev-2', owns: 'Windows checks', agent: 'codex' },
    });

    const state = useStore.getState();
    const ws = state.workspaces.find((w) => w.id === 'ws-co')!;
    const ids = getLeafPanes(ws.rootPane).map((l) => l.id);
    expect(ids.slice(0, 2)).toEqual(['p1', 'p2']);
    expect(ids).toHaveLength(3);
    const paneId = ids[2];
    // Split from the last staff pane: stacked below it, right of the CEO.
    const right = (ws.rootPane as { children: Pane[] }).children[1] as { type: string; direction: string; children: Pane[] };
    expect(right.type).toBe('branch');
    expect(right.direction).toBe('vertical');
    expect(right.children.map((c) => c.id)).toEqual(['p2', paneId]);
    expect(state.projectPaneSeed[paneId]).toEqual({ label: 'dev-2', command: 'codex "$(cat \'/b/hire.md\')"', cwd: '/wt/dev-2', role: 'Windows checks' });
    expect(state.activeWorkspaceId).toBe('ws-co');
    expect(ws.activePaneId).toBe(paneId);
    expect(watchHireNotice).toHaveBeenCalledWith({ workspaceId: 'ws-co', paneId, label: 'dev-2', owns: 'Windows checks', branch: 'company/dev-2-1a2b3c4d' });
    expect(onClose).toHaveBeenCalled();
  });

  it('splits beside the CEO when the company has no staff pane yet', async () => {
    hireSeat.mockResolvedValue({ ok: true, label: 'dev-2', command: 'claude', cwd: null });
    act(() => useStore.setState({ workspaces: [other, { ...company('p1'), rootPane: leaf('p1', 1, surface('s1', 'pty-1')) }] }));
    await render();
    await act(async () => { add()!.click(); });
    await flush();
    expect(hireSeat.mock.calls[0][0].staff).toEqual([]);
    const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-co')!;
    const top = ws.rootPane as { type: string; direction: string; children: Pane[] };
    expect(top.direction).toBe('horizontal');
    expect(top.children[0].id).toBe('p1');
    // No folder of its own: the seed keeps the split's.
    expect(useStore.getState().projectPaneSeed[top.children[1].id]).toEqual({ label: 'dev-2', command: 'claude' });
  });

  it('keeps the form and says why when main refuses', async () => {
    hireSeat.mockResolvedValue({ ok: false, error: 'another pane is named dev-2' });
    await render();
    await act(async () => { add()!.click(); });
    await flush();
    expect(q('hire-seat-error')?.textContent).toBe('The seat was not added: another pane is named dev-2');
    expect(onClose).not.toHaveBeenCalled();
    expect(getLeafPanes(useStore.getState().workspaces[1].rootPane)).toHaveLength(2);
  });

  it('adds nothing outside a repository while another staff agent works in the folder', async () => {
    isRepo = false;
    await render();
    expect(q('hire-seat-works-in')?.textContent).toContain('/repo, the company folder');
    expect(q('hire-seat-shared')).not.toBeNull();
    expect(add()?.disabled).toBe(true);
  });

  it('adds nothing at the pane cap, and says so as a split would', async () => {
    const many = Array.from({ length: 20 }, (_, i) => leaf(`p${i + 1}`, i + 1, surface(`s${i + 1}`, `pty-${i + 1}`)));
    act(() => useStore.setState({
      workspaces: [other, { ...company('p1'), rootPane: { id: 'split', type: 'branch', direction: 'vertical', sizes: many.map(() => 5), children: many } as unknown as Pane }],
    }));
    await render();
    expect(q('hire-seat-cap')?.textContent).toBe('Pane limit reached (20). Close a pane before splitting again.');
    expect(add()?.disabled).toBe(true);
  });

  it('asks nothing while the CEO seat is vacant', async () => {
    act(() => useStore.setState({ workspaces: [other, company(null)] }));
    await render();
    expect(q('hire-seat-no-ceo')).not.toBeNull();
    expect(q('hire-seat-name')).toBeNull();
    expect(add()).toBeNull();
  });
});
