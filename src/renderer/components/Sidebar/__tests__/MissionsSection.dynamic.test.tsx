// @vitest-environment jsdom
//
// The sidebar's Tasks line after the 2026-09-05 de-duplication: ONE summary
// row, no per-task rows (they live in the deck's ledger panel), nothing at all
// when there are no tasks, and a click that lands on the surface that owns
// them.

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
    surfaceAgentStatus: {},
    channelDockVisible: false,
    activeDeckTab: 'channels',
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

describe('MissionsSection summary', () => {
  it('renders nothing when there are no tasks (no dead header)', async () => {
    await render();
    expect(container.querySelector('[data-missions-section]')).toBeNull();
    expect(container.textContent).toBe('');
  });

  it('renders ONE summary row and no per-task rows', async () => {
    useStore.setState({
      workspaces: [workspace('parent'), workspace('child-1'), workspace('child-2')],
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
    expect(container.querySelector('[data-missions-done-group]')).toBeNull();
    // The titles themselves are not restated here — that is the deck's job.
    expect(container.textContent).not.toContain('one');
  });

  it('keeps the Clean up action on the summary header', async () => {
    useStore.setState({
      workspaces: [workspace('parent')],
      missionsByWorkspace: { parent: [mission({ id: 't1', title: 'one' })] },
    });
    await render();
    expect(container.querySelector('[data-missions-cleanup]')).not.toBeNull();
  });

  it('states "need you" only when somebody is actually waiting', async () => {
    useStore.setState({
      workspaces: [workspace('parent'), workspace('child-1')],
      missionsByWorkspace: {
        parent: [mission({ id: 't1', title: 'one', paneGroupId: 'child-1' })],
      },
    });
    await render();
    expect(container.querySelector('[data-missions-need-you]')).toBeNull();

    await act(async () => {
      useStore.setState({ surfaceAgentStatus: { 'pty-child-1': 'awaiting_input' } });
    });
    const needYou = container.querySelector('[data-missions-need-you]');
    expect(needYou).not.toBeNull();
    expect(
      container.querySelector('[data-missions-summary]')?.getAttribute('data-need-you-count'),
    ).toBe('1');
  });

  it('opens the deck on its Agent tab when the summary is clicked', async () => {
    useStore.setState({
      workspaces: [workspace('parent')],
      missionsByWorkspace: { parent: [mission({ id: 't1', title: 'one' })] },
    });
    await render();
    const summary = container.querySelector('[data-missions-summary]') as HTMLButtonElement;
    await act(async () => {
      summary.click();
    });
    expect(useStore.getState().channelDockVisible).toBe(true);
    expect(useStore.getState().activeDeckTab).toBe('commander');
  });
});
