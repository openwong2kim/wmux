// @vitest-environment jsdom
//
// Fleet shows a fan-out task's Conversation (its mission channel) for the
// selected task: read-only, oldest first, loaded from the daemon as the human
// seat and appended live. "Open conversation" links land on the same view,
// and a task with nothing on the list still shows.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import FleetView from '../FleetView';
import { useStore } from '../../../stores';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';
import type { Channel, ChannelMessage } from '../../../../shared/channels';
import { resetReviewSummariesForTests } from '../reviewSummary';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function leaf(id: string, ptyId: string): Pane {
  const surface: Surface = { id: `s-${id}`, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}
function workspace(id: string, name: string, pane: Pane): Workspace {
  return { id, name, rootPane: pane, activePaneId: pane.id };
}
function mission(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Fix ${id}`,
    status: 'open',
    missionChannelId: `ch-${id}`,
    createdAt: 1,
    createdBy: { principalId: 'ws-o', verifiedWorkspaceId: 'ws-o' },
    owner: { principalId: 'ws-o', verifiedWorkspaceId: 'ws-o' },
    ...extra,
  } as WorkTask;
}
function channel(id: string): Channel {
  return { id, name: id, visibility: 'private', status: 'active', observed: true, nextSeq: 3 } as unknown as Channel;
}
function message(channelId: string, seq: number, text: string): ChannelMessage {
  return { channelId, seq, text, workspaceId: 'ws-t1', memberId: 'worker', postedAt: Date.UTC(2026, 9, 5, 9, 0, seq) } as ChannelMessage;
}

let container: HTMLDivElement;
let root: Root;
const rpc = vi.fn();

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(React.createElement(FleetView)); });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await Promise.resolve();
    });
  }
}

function card(paneId: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-fleet-key="${paneId}"]`)!;
}
/** Select a row and make sure the detail area (where the conversation shows) is open. */
function select(paneId: string): void {
  act(() => card(paneId).focus());
  if (!container.querySelector('[data-fleet-detail]')) {
    act(() => { card(paneId).dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })); });
  }
}
function conversationTexts(): string[] {
  return Array.from(container.querySelectorAll('[data-fleet-conversation] [data-channel-message-text]')).map((el) => el.textContent ?? '');
}

beforeEach(() => {
  resetReviewSummariesForTests();
  // The daemon holds the history out of order; the view sorts it.
  rpc.mockReset().mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.channel.getMessages') {
      const id = params.channelId as string;
      return { ok: true, messages: [message(id, 2, `${id} report`), message(id, 1, `${id} instruction`)] };
    }
    if (method === 'a2a.channel.list') return { ok: true, channels: [channel('ch-t1'), channel('ch-t2'), channel('ch-gone')], channelsEpoch: 99 };
    if (method === 'a2a.channel.getMembers') return { ok: true, members: [] };
    return { ok: false };
  });
  (window as unknown as { __wmuxChannelsRpc: unknown }).__wmuxChannelsRpc = { rpc, mutateLocal: vi.fn() };
  (window as unknown as { electronAPI: unknown }).electronAPI = { pty: { write: vi.fn() } };
  const status: Record<string, AgentStatus> = { 'pty-1': 'running', 'pty-2': 'running', 'pty-x': 'running' };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      fleetActiveTab: 'fleet',
      appRoute: 'fleet', fleetViewVisible: true,
      workspaces: [
        workspace('ws-x', 'plain project', leaf('px', 'pty-x')),
        workspace('ws-t1', 'wtask: Fix t1', leaf('p1', 'pty-1')),
        workspace('ws-t2', 'wtask: Fix t2', leaf('p2', 'pty-2')),
      ],
      missionsByWorkspace: { 'ws-o': [mission('t1', { paneGroupId: 'ws-t1' }), mission('t2', { paneGroupId: 'ws-t2' }), mission('gone', { status: 'closed' })] },
      missionByPaneGroup: { 'ws-t1': mission('t1', { paneGroupId: 'ws-t1' }), 'ws-t2': mission('t2', { paneGroupId: 'ws-t2' }) },
      channels: { 'ch-t1': channel('ch-t1'), 'ch-t2': channel('ch-t2') },
      surfaceAgent: Object.fromEntries(Object.keys(status).map((pty) => [pty, { name: 'Claude Code', status: status[pty] }])),
      surfaceTurnOpenAt: Object.fromEntries(Object.keys(status).map((pty) => [pty, Date.now()])),
    });
  });
});

afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
  document.body.innerHTML = '';
});

describe('FleetView — task conversation', () => {
  it('selecting a task shows its mission channel, oldest first, read-only', async () => {
    mount();
    await settle();
    select('p1');
    await settle();
    const conversation = container.querySelector('[data-fleet-conversation]')!;
    expect(conversation.getAttribute('data-channel-id')).toBe('ch-t1');
    expect(conversation.textContent).toContain('Fix t1');
    expect(conversationTexts()).toEqual(['ch-t1 instruction', 'ch-t1 report']);
    // Read as the human seat; nothing posts or acks.
    expect(rpc).toHaveBeenCalledWith('a2a.channel.getMessages', expect.objectContaining({ channelId: 'ch-t1', workspaceId: 'ws-human' }));
    expect(conversation.querySelector('textarea, input, [contenteditable]')).toBeNull();

    // A plain agent has no conversation.
    select('px');
    await settle();
    expect(container.querySelector('[data-fleet-conversation]')).toBeNull();
  });

  it('a live post appends at the end', async () => {
    mount();
    await settle();
    select('p1');
    await settle();
    act(() => useStore.getState().appendMessageFromEvent(message('ch-t1', 3, 'ch-t1 done')));
    expect(conversationTexts()).toEqual(['ch-t1 instruction', 'ch-t1 report', 'ch-t1 done']);
  });

  it('a channel missing from the catalog is re-read so live posts reach it', async () => {
    act(() => useStore.setState({ channels: {} }));
    mount();
    await settle();
    select('p1');
    await settle();
    expect(rpc).toHaveBeenCalledWith('a2a.channel.list', expect.objectContaining({ workspaceId: 'ws-human' }));
    expect(useStore.getState().channels['ch-t1']).toBeDefined();
    expect(conversationTexts()).toEqual(['ch-t1 instruction', 'ch-t1 report']);
  });

  it('Open conversation selects the task on the list', async () => {
    mount();
    await settle();
    act(() => card('px').focus());
    await settle();
    act(() => useStore.getState().openTaskConversation('t2'));
    await settle();
    expect(useStore.getState().fleetFocusTask).toBeNull();
    expect(card('p2').getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-fleet-conversation]')?.getAttribute('data-channel-id')).toBe('ch-t2');
  });

  it('a task with nothing on the list still shows until the selection moves', async () => {
    mount();
    await settle();
    act(() => useStore.getState().openTaskConversation('gone'));
    await settle();
    expect(container.querySelector('[data-fleet-conversation]')?.getAttribute('data-channel-id')).toBe('ch-gone');
    act(() => card('p2').focus());
    await settle();
    expect(container.querySelector('[data-fleet-conversation]')?.getAttribute('data-channel-id')).toBe('ch-t2');
  });

  it('names a post authored as a whole workspace (ledger lines) by that workspace', async () => {
    mount();
    await settle();
    select('p1');
    await settle();
    act(() => useStore.getState().appendMessageFromEvent({
      ...message('ch-t1', 3, '[ledger] t1 working→review_requested'), workspaceId: 'ws-t1', memberId: 'ws-t1', memberName: 'ws-t1',
    }));
    const authors = Array.from(container.querySelectorAll('[data-fleet-conversation] [data-channel-message-author]')).map((el) => el.textContent);
    expect(authors.at(-1)).toBe('Fix t1');
    expect(authors[0]).toBe('worker');
  });

  it('Open conversation on a finished task selects its Ready to review row', async () => {
    act(() => useStore.setState({
      surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'complete' }, 'pty-2': { name: 'Claude Code', status: 'running' }, 'pty-x': { name: 'Claude Code', status: 'running' } },
      surfaceAgentStatus: { 'pty-1': 'complete' },
      surfaceTurnOpenAt: { 'pty-2': Date.now(), 'pty-x': Date.now() },
      surfaceTurnEndAt: { 'pty-1': Date.now() - 60_000 },
    }));
    mount();
    await settle();
    act(() => card('px').focus());
    await settle();
    const row = container.querySelector('[data-fleet-review-row][data-workspace-id="ws-t1"]')!;
    expect(row).not.toBeNull();
    act(() => useStore.getState().openTaskConversation('t1'));
    await settle();
    expect(row.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-fleet-conversation]')?.getAttribute('data-channel-id')).toBe('ch-t1');
  });

  it('Open conversation on an idle task expands Idle and selects its row', async () => {
    act(() => useStore.setState({
      surfaceAgent: { ...useStore.getState().surfaceAgent, 'pty-2': { name: 'Claude Code', status: 'idle' } },
      surfaceTurnOpenAt: { 'pty-1': Date.now(), 'pty-x': Date.now() },
      fleetIdleExpanded: false,
    }));
    mount();
    await settle();
    expect(card('p2')).toBeNull();
    act(() => useStore.getState().openTaskConversation('t2'));
    await settle();
    expect(useStore.getState().fleetIdleExpanded).toBe(true);
    expect(card('p2')?.getAttribute('aria-selected')).toBe('true');
    expect(container.querySelector('[data-fleet-conversation]')?.getAttribute('data-channel-id')).toBe('ch-t2');
  });

  it('a long conversation offers earlier messages, and a live post does not move them', async () => {
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'a2a.channel.getMessages') {
        const id = params.channelId as string;
        return { ok: true, messages: Array.from({ length: 250 }, (_, i) => message(id, i + 1, `m${i + 1}`)) };
      }
      return { ok: false };
    });
    mount();
    await settle();
    select('p1');
    await settle();
    expect(conversationTexts()).toHaveLength(200);
    expect(conversationTexts()[0]).toBe('m51');
    const earlier = container.querySelector<HTMLButtonElement>('[data-fleet-conversation-earlier]')!;
    expect(earlier.textContent).toBe('Earlier messages (50)');
    act(() => earlier.click());
    await settle();
    expect(conversationTexts()).toHaveLength(250);
    expect(conversationTexts()[0]).toBe('m1');
    expect(container.querySelector('[data-fleet-conversation-earlier]')).toBeNull();
    act(() => useStore.getState().appendMessageFromEvent(message('ch-t1', 251, 'm251')));
    expect(conversationTexts()[0]).toBe('m1');
    expect(conversationTexts().at(-1)).toBe('m251');
  });

  it('pages earlier messages in from the daemon past the first load', async () => {
    act(() => useStore.setState({ channels: { 'ch-t1': { ...channel('ch-t1'), nextSeq: 401 }, 'ch-t2': channel('ch-t2') } }));
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method !== 'a2a.channel.getMessages') return { ok: false };
      const since = params.sinceSeq as number;
      const from = Math.max(1, since);
      const to = since >= 200 ? 400 : 200;
      return { ok: true, messages: Array.from({ length: to - from + 1 }, (_, i) => message('ch-t1', from + i, `m${from + i}`)) };
    });
    mount();
    await settle();
    select('p1');
    await settle();
    expect(conversationTexts()[0]).toBe('m201');
    const earlier = container.querySelector<HTMLButtonElement>('[data-fleet-conversation-earlier]')!;
    expect(earlier.textContent).toBe('Earlier messages');
    act(() => earlier.click());
    await settle();
    expect(rpc).toHaveBeenCalledWith('a2a.channel.getMessages', expect.objectContaining({ channelId: 'ch-t1', sinceSeq: 1 }));
    expect(conversationTexts()[0]).toBe('m1');
  });
});
