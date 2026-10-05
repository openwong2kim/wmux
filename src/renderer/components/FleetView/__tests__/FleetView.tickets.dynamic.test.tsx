// @vitest-environment jsdom
//
// Moa's delegated work shows in Fleet as tickets: the pane working on one is
// named after it, the Tickets chip lists them, and a finished ticket's result
// is read back from the durable task copy.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface } from '../../../../shared/types';
import type { WorkLink } from '../../../../shared/workLink';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function leaf(id: string, ptyId: string): Pane {
  const surface: Surface = { id: `s-${id}`, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}
function workspace(id: string, name: string, pane: Pane): Workspace {
  return { id, name, rootPane: pane, activePaneId: pane.id };
}

const LINK: WorkLink = {
  id: 'wl-1', origin: 'moa', title: 'Fix the login redirect', a2aTaskId: 'task-1', a2aState: 'working',
  owner: { workspaceId: 'ws-1', paneId: 'p1' }, agent: 'claude', state: 'running',
  decisionIds: [], createdAt: Date.now() - 60_000, updatedAt: Date.now() - 60_000,
};

let container: HTMLDivElement;
let root: Root;
const openExternal = vi.fn();

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.resolve();
    });
  }
}

let links: WorkLink[] = [LINK];
/** main's a2a.task.query, answering from the durable task copy. */
const rpcInvoke = vi.fn(async (method: string, params: Record<string, unknown>) => (method === 'a2a.task.query' && params.taskId === 'task-1'
  ? { id: 'q', ok: true, result: { task: { id: 'task-1', kind: 'task', history: [], artifacts: [], metadata: { title: 'Fix the login redirect' },
    status: { state: 'completed', timestamp: new Date().toISOString(), evidence: { summary: 'Redirect fixed; e2e passes.', items: [] } } } } }
  : { ok: false }));

beforeEach(() => {
  openExternal.mockReset();
  rpcInvoke.mockClear();
  window.localStorage.clear();
  links = [LINK];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn() },
    workLinks: { list: async () => links, onChanged: () => () => undefined },
    deck: { moa: { decisions: async () => ({ decisions: [] }), onChanged: () => () => undefined } },
    rpc: { invoke: rpcInvoke },
    shell: { openExternal },
  };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      appRoute: 'fleet', fleetViewVisible: true,
      workspaces: [workspace('ws-1', 'app', leaf('p1', 'pty-1'))],
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'running' } },
      surfaceTurnOpenAt: { 'pty-1': Date.now() },
    });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — tickets', () => {
  it('names the pane after its open ticket and lists tickets behind their chip', async () => {
    act(() => { root.render(React.createElement(FleetView)); });
    await settle();
    const row = container.querySelector<HTMLElement>('[data-fleet-card][data-pty-id="pty-1"]')!;
    expect(row.querySelector('.wmux-fleet-name')?.textContent).toBe('Fix the login redirect');

    const chip = container.querySelector<HTMLButtonElement>('[data-filter="tickets"]')!;
    expect(chip.textContent).toContain('1');
    act(() => chip.click());
    await settle();
    expect(container.querySelector('[data-fleet-card]')).toBeNull();
    const ticket = container.querySelector<HTMLButtonElement>('[data-fleet-ticket="wl-1"]')!;
    expect(ticket.textContent).toContain('Working');
    expect(ticket.textContent).toContain('app · claude');

    act(() => ticket.click());
    await settle();
    const detail = container.querySelector('[data-fleet-ticket-detail="wl-1"]')!;
    expect(detail).not.toBeNull();
    // Nothing on a ticket opens anything outside the app.
    expect(container.querySelector('[data-fleet-ticket-issue]')).toBeNull();
    expect(openExternal).not.toHaveBeenCalled();

    // Enter on the ticket jumps to the agent working on it, as on an agent row.
    act(() => ticket.focus());
    act(() => { ticket.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('a working ticket stays quiet: not in Needs you, no Needs you count', async () => {
    act(() => { root.render(React.createElement(FleetView)); });
    await settle();
    expect(container.querySelector('[data-fleet-ticket]')).toBeNull();
    expect(container.querySelector('[data-filter="attention"]')).toBeNull();
    expect(container.querySelector('[data-fleet-section="needsYou"]')).toBeNull();
  });

  it('a finished ticket asks once in Needs you; viewing its report clears it', async () => {
    links = [{ ...LINK, a2aState: 'completed', state: 'done' }];
    act(() => { root.render(React.createElement(FleetView)); });
    await settle();
    const report = container.querySelector<HTMLButtonElement>('[data-fleet-ticket="wl-1"]')!;
    expect(report).not.toBeNull();
    expect(report.closest('[role=listbox]')?.querySelector('[data-fleet-section="needsYou"]')).not.toBeNull();
    expect(container.querySelector('[data-filter="attention"]')?.textContent).toContain('1');
    // Open it: the result comes from the durable task copy (the renderer's
    // mirror is empty, as after a reload), the report is viewed, and the row
    // stays put while it is selected.
    act(() => report.click());
    await settle();
    expect(container.querySelector('[data-fleet-ticket-detail="wl-1"]')).not.toBeNull();
    expect(rpcInvoke).toHaveBeenCalledWith('a2a.task.query', { workspaceId: 'ws-1', view: 'page', taskId: 'task-1' });
    expect(container.querySelector('[data-fleet-ticket-result]')?.textContent).toBe('Redirect fixed; e2e passes.');
    expect(container.querySelector('[data-fleet-ticket="wl-1"]')).not.toBeNull();
    expect(container.querySelector('[data-filter="attention"]')).toBeNull();
    // Selection moves on: the ticket leaves Needs you, still under Tickets.
    act(() => container.querySelector<HTMLElement>('[data-fleet-card]')!.focus());
    await settle();
    expect(container.querySelector('[data-fleet-ticket="wl-1"]')).toBeNull();
    act(() => container.querySelector<HTMLButtonElement>('[data-filter="tickets"]')!.click());
    await settle();
    expect(container.querySelector('[data-fleet-ticket="wl-1"]')).not.toBeNull();
  });

  it('a report is not viewed when it was never shown, or the selection only fell onto it', async () => {
    links = [{ ...LINK, a2aState: 'completed', state: 'done' }];
    act(() => { root.render(React.createElement(FleetView)); });
    await settle();
    // Open the agent row's detail, then the agent goes: the selection falls onto
    // the report ticket with the detail open. That is not the operator's choice.
    act(() => container.querySelector<HTMLButtonElement>('[data-fleet-detail-toggle]')!.click());
    await settle();
    act(() => { useStore.setState({ workspaces: [] }); });
    await settle();
    expect(container.querySelector('[data-fleet-ticket-detail="wl-1"]')).not.toBeNull();
    expect(container.querySelector('[data-filter="attention"]')?.textContent).toContain('1');

    // Chosen, but the result cannot be read: still not viewed.
    rpcInvoke.mockImplementation(async () => ({ ok: false }));
    const chosen = () => container.querySelector<HTMLButtonElement>('[data-fleet-ticket="wl-1"]')!;
    act(() => chosen().click());
    await settle();
    // The click toggles: the detail was already open on this row.
    if (!container.querySelector('[data-fleet-ticket-detail="wl-1"]')) { act(() => chosen().click()); await settle(); }
    expect(container.querySelector('[data-fleet-ticket-detail="wl-1"]')).not.toBeNull();
    expect(container.querySelector('[data-fleet-ticket-result]')).toBeNull();
    expect(container.querySelector('[data-filter="attention"]')?.textContent).toContain('1');
  });

  it('a report whose result is no longer kept says so, and choosing it counts as viewed', async () => {
    links = [{ ...LINK, a2aState: 'completed', state: 'done' }];
    // The daemon keeps a finished task for 30 minutes; after that it is not found.
    rpcInvoke.mockImplementation(async () => ({ ok: true, result: { error: 'a2a_task_query: task task-1 not found (or filtered out by status/role/updated_since)' } }));
    act(() => { root.render(React.createElement(FleetView)); });
    await settle();
    act(() => container.querySelector<HTMLButtonElement>('[data-fleet-ticket="wl-1"]')!.click());
    await settle();
    expect(container.querySelector('[data-fleet-ticket-result-gone]')?.textContent).toContain('no longer kept');
    expect(container.querySelector('[data-filter="attention"]')).toBeNull();
  });
});

