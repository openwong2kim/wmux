// @vitest-environment jsdom
//
// Moa's delegated work shows in Fleet as tickets: the pane working on one is
// named after it, the Tickets chip lists them, and a ticket's detail offers a
// prefilled GitHub issue (opened in the browser, never posted).
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

beforeEach(() => {
  openExternal.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn() },
    workLinks: { list: async () => [LINK], onChanged: () => () => undefined },
    deck: { moa: { decisions: async () => ({ decisions: [] }), onChanged: () => () => undefined } },
    github: { repoKey: async () => ({ key: 'github.com/acme/app' }) },
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
    const issue = container.querySelector<HTMLButtonElement>('[data-fleet-ticket-issue]')!;
    act(() => issue.click());
    expect(openExternal).toHaveBeenCalledWith('https://github.com/acme/app/issues/new?title=Fix%20the%20login%20redirect');

    // Enter on the ticket jumps to the agent working on it, as on an agent row.
    act(() => ticket.focus());
    act(() => { ticket.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('hides the GitHub action when the repo is not on GitHub', async () => {
    (window as unknown as { electronAPI: { github: unknown } }).electronAPI.github = { repoKey: async () => ({ key: null }) };
    act(() => { root.render(React.createElement(FleetView)); });
    await settle();
    act(() => container.querySelector<HTMLButtonElement>('[data-filter="tickets"]')!.click());
    await settle();
    act(() => container.querySelector<HTMLButtonElement>('[data-fleet-ticket="wl-1"]')!.click());
    await settle();
    expect(container.querySelector('[data-fleet-ticket-detail="wl-1"]')).not.toBeNull();
    expect(container.querySelector('[data-fleet-ticket-issue]')).toBeNull();
  });
});
