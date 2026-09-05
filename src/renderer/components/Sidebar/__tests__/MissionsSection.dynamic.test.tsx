// @vitest-environment jsdom
//
// The sidebar's Tasks line after the 2026-09-05 de-duplication: ONE summary
// row, no per-task rows (they live in the deck's ledger panel), no attention
// count (that fact already has its two renditions), nothing at all when there
// are no tasks, and a click that lands on the workspace whose ledger actually
// holds them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import MissionsSection from '../MissionsSection';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({
    missionsByWorkspace: {},
    workspaces: [],
    activeWorkspaceId: undefined,
    channelDockVisible: false,
    activeDeckTab: 'channels',
    deckLedgerFinishedExpanded: false,
  });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const surface = (id: string, ptyId: string): Surface => ({
  id,
  ptyId,
  title: id,
  shell: 'pwsh',
  cwd: '/repo',
  surfaceType: 'terminal',
});
const leaf = (id: string, surfaces: Surface[]): Pane => ({
  id,
  type: 'leaf',
  surfaces,
  activeSurfaceId: surfaces[0].id,
});
const workspace = (id: string): Workspace => ({
  id,
  name: id,
  rootPane: leaf(`${id}-p`, [surface(`${id}-s`, `pty-${id}`)]),
  activePaneId: `${id}-p`,
});

const mission = (over: Partial<WorkTask> & Pick<WorkTask, 'id' | 'title'>): WorkTask => {
  const ref = { principalId: 'p', verifiedWorkspaceId: 'parent' };
  return {
    status: 'open',
    missionChannelId: `chan-${over.id}`,
    createdAt: 0,
    createdBy: ref,
    owner: ref,
    ...over,
  } as WorkTask;
};

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(MissionsSection));
  });
}

async function click(selector: string): Promise<void> {
  const el = container.querySelector(selector) as HTMLButtonElement;
  await act(async () => { el.click(); });
}

describe('MissionsSection summary', () => {
  it('renders nothing when there are no tasks (no dead header)', async () => {
    await render();
    expect(container.querySelector('[data-missions-section]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders ONE summary row and no per-task rows', async () => {
    useStore.setState({
      workspaces: [workspace('parent'), workspace('child-1'), workspace('child-2')],
      activeWorkspaceId: 'parent',
      missionsByWorkspace: {
        parent: [
          mission({ id: 't1', title: 'one', paneGroupId: 'child-1' }),
          mission({ id: 't2', title: 'two', paneGroupId: 'child-2' }),
        ],
      },
    });
    await render();
    const summary = container.querySelector('[data-missions-summary]');
    expect(summary).not.toBeNull();
    expect(summary?.getAttribute('data-open-count')).toBe('2');
    // The rows the deck's ledger panel now owns are gone from the sidebar,
    // and so is the `#` channel link that used to sit on each of them.
    expect(container.querySelector('[data-mission-row]')).toBeNull();
    expect(container.querySelector('[data-mission-channel-link]')).toBeNull();
    // The titles themselves are not restated here — that is the deck's job.
    expect(container.textContent).not.toContain('one');
  });

  // Attention already has its two permitted renditions (titlebar chip + the
  // deck's red dots), and this one would have been rolled up from the pane
  // mirror while the deck rolls up from the ledger.
  it('never states an attention count, even with a worker awaiting input', async () => {
    useStore.setState({
      workspaces: [workspace('parent'), workspace('child-1')],
      activeWorkspaceId: 'parent',
      surfaceAgentStatus: { 'pty-child-1': 'awaiting_input' },
      missionsByWorkspace: {
        parent: [mission({ id: 't1', title: 'one', paneGroupId: 'child-1' })],
      },
    });
    await render();
    expect(container.querySelector('[data-missions-need-you]')).toBeNull();
    expect(container.textContent).not.toMatch(/need you/i);
  });

  it('keeps the Clean up action on the summary line', async () => {
    useStore.setState({
      workspaces: [workspace('parent')],
      activeWorkspaceId: 'parent',
      missionsByWorkspace: { parent: [mission({ id: 't1', title: 'one' })] },
    });
    await render();
    expect(container.querySelector('[data-missions-cleanup]')).not.toBeNull();
  });

  it('states the finished count only once nothing is open', async () => {
    useStore.setState({
      workspaces: [workspace('parent')],
      activeWorkspaceId: 'parent',
      missionsByWorkspace: {
        parent: [
          mission({ id: 't1', title: 'one' }),
          mission({ id: 't2', title: 'two', status: 'closed', closedAt: 1 }),
        ],
      },
    });
    await render();
    expect(container.querySelector('[data-missions-finished]')).toBeNull();

    await act(async () => {
      useStore.setState({
        missionsByWorkspace: {
          parent: [mission({ id: 't2', title: 'two', status: 'closed', closedAt: 1 })],
        },
      });
    });
    const summary = container.querySelector('[data-missions-summary]');
    expect(summary?.getAttribute('data-open-count')).toBe('0');
    expect(summary?.getAttribute('data-finished-count')).toBe('1');
    expect(container.querySelector('[data-missions-finished]')).not.toBeNull();
    // Cleanup is still reachable — that state is exactly when it matters.
    expect(container.querySelector('[data-missions-cleanup]')).not.toBeNull();
  });

  it('opens the deck on its Agent tab when the active workspace owns the tasks', async () => {
    useStore.setState({
      workspaces: [workspace('parent')],
      activeWorkspaceId: 'parent',
      missionsByWorkspace: { parent: [mission({ id: 't1', title: 'one' })] },
    });
    await render();
    await click('[data-missions-summary]');
    const state = useStore.getState();
    expect(state.channelDockVisible).toBe(true);
    expect(state.activeDeckTab).toBe('commander');
    // No hop — the deck was already pointed at the ledger that holds them.
    expect(state.activeWorkspaceId).toBe('parent');
    expect(state.deckLedgerFinishedExpanded).toBe(false);
  });

  // The dead link: the summary counts every workspace, the deck panel reads
  // one. Clicking "1 open" from a workspace with no tasks used to open an
  // empty panel.
  it('switches to the workspace that owns the tasks first', async () => {
    useStore.setState({
      workspaces: [workspace('parent'), workspace('other')],
      activeWorkspaceId: 'other',
      missionsByWorkspace: {
        parent: [mission({ id: 't1', title: 'one', createdAt: 5 })],
      },
    });
    await render();
    await click('[data-missions-summary]');
    const state = useStore.getState();
    expect(state.activeWorkspaceId).toBe('parent');
    expect(state.activeDeckTab).toBe('commander');
    expect(state.channelDockVisible).toBe(true);
  });

  it('opens the deck finished disclosure when only finished tasks are left', async () => {
    useStore.setState({
      workspaces: [workspace('parent'), workspace('other')],
      activeWorkspaceId: 'other',
      missionsByWorkspace: {
        parent: [mission({ id: 't1', title: 'one', status: 'closed', closedAt: 1 })],
      },
    });
    await render();
    await click('[data-missions-summary]');
    const state = useStore.getState();
    expect(state.activeWorkspaceId).toBe('parent');
    expect(state.deckLedgerFinishedExpanded).toBe(true);
  });
});
