// @vitest-environment jsdom
//
// A chat-v2 chat's run state reaches the sidebar roster, Fleet and
// fleet.triage through the same per-pane store maps a terminal agent feeds.
// Driven end to end: the real controller on the contract's mock host
// publishes the binding, the mirror writes the store, the real selectors read it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import { selectFleetPanes, surfaceAttentionStatus } from '../../../stores/selectors/fleet';
import { selectWorkspaceAgentRoster } from '../../../stores/selectors/workspaceAgentRoster';
import { buildFleetTriage } from '../../../utils/fleetTriage';
import { clearSurfaceAgentsKnownGone } from '../../../utils/agentRowLiveness';
import { agentRow } from '../../../../shared/agentIdentity';
import type { ChatV2Binding } from '../../../../shared/chatv2/ipc';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import { ChatV2Controller, forgetKnownBinding, setKnownBinding } from '../controller';
import { setChatV2BridgeForTests } from '../bridge';
import { markChatV2Covering } from '../coverage';
import { chatTabLabel, startChatStatusMirror } from '../status';
import { createMockHost, type MockHost } from './mockHost';

const PTY = 'daemon-chat';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const CLAUDE = agentRow('claude')!.display;
const CODEX = agentRow('codex')!.display;

const surface = (patch: Partial<Surface> = {}): Surface => ({
  id: 'surf', ptyId: PTY, title: 'Zsh', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal', viewMode: 'chat', ...patch,
});
const workspace = (): Workspace => ({
  id: 'ws', name: 'ws',
  rootPane: { id: 'pane', type: 'leaf', surfaces: [surface()], activeSurfaceId: 'surf' } as Pane,
  activePaneId: 'pane',
});

function binding(patch: Partial<ChatV2Binding> = {}): ChatV2Binding {
  return {
    paneId: PTY, chatSessionId: 'chat-1', agent: 'claude', mode: 'default', model: '', status: 'idle',
    epoch: '0123456789abcdef', seq: 1,
    capabilities: { send: true, interrupt: true, approvals: true, questions: true, images: false, toTerminal: true },
    ...patch,
  };
}

const state = () => useStore.getState();
const rosterRow = () => selectWorkspaceAgentRoster(state(), 'ws').rows.find((r) => r.ptyId === PTY);
const fleetPane = () => selectFleetPanes(state()).find((p) => p.ptyId === PTY);
const triage = () => buildFleetTriage(state(), {}, Date.now());

let stop: () => void = () => undefined;

beforeEach(() => {
  useStore.setState({
    workspaces: [workspace()],
    activeWorkspaceId: 'ws',
    surfaceAgentStatus: {},
    surfaceAgent: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    surfaceTurnEndAt: {},
    surfacePendingQuestion: {},
    // The anchor shell idles at its prompt under a chat: OSC 133 says so.
    commandRunningByPtyId: { [PTY]: false },
    agentAliveByPtyId: {},
    agentClockMs: Date.now(),
  });
  forgetKnownBinding(PTY);
  stop = startChatStatusMirror();
});
afterEach(() => {
  stop();
  forgetKnownBinding(PTY);
  setChatV2BridgeForTests(null);
  vi.useRealTimers();
});

describe('chat status mirror', () => {
  it('a waiting card makes the pane needs-you everywhere, and answering clears it', async () => {
    const host: MockHost = createMockHost();
    await host.call('create', { paneId: PTY, agent: 'claude', mode: 'default' });
    const controller = new ChatV2Controller(host, PTY);
    await controller.start();
    expect(rosterRow()).toMatchObject({ agentName: CLAUDE, status: 'idle', needsAttention: false });

    host.emit(PTY, [
      { type: 'user.message', text: 'make a file', clientMessageId: 'c-00000001' },
      { type: 'tool.started', callId: 't1', title: 'Write', kind: 'edit', status: 'pending' },
      { type: 'approval.requested', requestId: 'r1', title: 'Write', callId: 't1' },
    ]);
    await flush();
    expect(surfaceAttentionStatus(state(), PTY)).toBe('awaiting_input');
    expect(rosterRow()).toMatchObject({ status: 'awaiting_input', needsAttention: true });
    expect(fleetPane()?.agentStatus).toBe('awaiting_input');
    expect(triage().needsYou).toEqual([expect.objectContaining({ ptyId: PTY, reason: 'input', agentName: CLAUDE })]);

    expect(await controller.answer('r1', 'allow')).toBe(true);
    await flush();
    expect(surfaceAttentionStatus(state(), PTY)).toBeUndefined();
    expect(rosterRow()).toMatchObject({ status: 'running', needsAttention: false });
    expect(fleetPane()?.agentStatus).toBe('running');
    expect(triage().needsYou).toEqual([]);
    expect(triage().running).toEqual([expect.objectContaining({ ptyId: PTY, reason: 'running' })]);

    host.emit(PTY, [{ type: 'tool.updated', callId: 't1', status: 'completed' }, { type: 'turn.ended', outcome: 'completed' }]);
    await flush();
    expect(fleetPane()?.agentStatus).toBe('complete');
    expect(triage().finished).toEqual([expect.objectContaining({ ptyId: PTY, reason: 'complete' })]);
    expect(state().surfaceTurnOpenAt[PTY]).toBeUndefined();
    controller.dispose();
  });

  it('survives the liveness poll that drops agents from a pane whose shell is at its prompt', () => {
    setKnownBinding(PTY, binding({ status: 'needs-input' }));
    clearSurfaceAgentsKnownGone({ [PTY]: false }, { [PTY]: false }, Date.now());
    expect(surfaceAttentionStatus(state(), PTY)).toBe('awaiting_input');
    expect(rosterRow()?.agentName).toBe(CLAUDE);
  });

  it('restores a running chat that a settle edge for the anchor shell dropped', () => {
    setKnownBinding(PTY, binding({ status: 'running' }));
    state().setSurfaceAgentStatus(PTY, 'idle');
    state().setSurfaceAgent(PTY, undefined, 'idle');
    setKnownBinding(PTY, binding({ status: 'running', seq: 2 }));
    expect(rosterRow()?.status).toBe('running');
  });

  it('names a Codex chat from its registry row and leaves the pane when the chat closes', () => {
    setKnownBinding(PTY, binding({ agent: 'codex', status: 'running' }));
    expect(rosterRow()).toMatchObject({ agentName: CODEX, status: 'running' });
    setKnownBinding(PTY, null);
    expect(state().surfaceAgent[PTY]).toBeUndefined();
    expect(state().surfaceTurnOpenAt[PTY]).toBeUndefined();
    expect(rosterRow()).toBeUndefined();
  });

  it('asks again for a chat whose view is not mounted, and not for one that is', async () => {
    vi.useFakeTimers();
    stop();
    stop = startChatStatusMirror(1_000);
    setKnownBinding(PTY, binding({ status: 'running' }));
    let answer = binding({ status: 'needs-input' });
    const bindingForPane = vi.fn(async () => ({ ok: true as const, binding: answer }));
    setChatV2BridgeForTests({ call: (method: string) => (method === 'bindingForPane' ? bindingForPane() : Promise.reject(new Error(method))), onEvents: () => () => undefined, onResync: () => () => undefined } as never);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(bindingForPane).toHaveBeenCalledTimes(1);
    expect(surfaceAttentionStatus(state(), PTY)).toBe('awaiting_input');

    const uncover = markChatV2Covering(PTY);
    answer = binding({ status: 'idle' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(bindingForPane).toHaveBeenCalledTimes(1);
    expect(surfaceAttentionStatus(state(), PTY)).toBe('awaiting_input');
    uncover();
  });
});

describe('chat tab label', () => {
  it('names a chat view tab after its agent, and only while the chat holds the pane in chat view', () => {
    expect(chatTabLabel(surface(), true)).toBeUndefined();
    setKnownBinding(PTY, binding());
    expect(chatTabLabel(surface(), true)).toBe(CLAUDE);
    setKnownBinding(PTY, binding({ agent: 'codex' }));
    expect(chatTabLabel(surface(), true)).toBe(CODEX);
    // Terminal view, the feature off, or a rename the person gave it: the tab's own title.
    expect(chatTabLabel(surface({ viewMode: 'terminal' }), true)).toBeUndefined();
    expect(chatTabLabel(surface(), false)).toBeUndefined();
    expect(chatTabLabel(surface({ userName: 'mine' }), true)).toBeUndefined();
    // Handed to the terminal, or closed: nothing sticks.
    setKnownBinding(PTY, binding({ status: 'handed-off' }));
    expect(chatTabLabel(surface(), true)).toBeUndefined();
    setKnownBinding(PTY, null);
    expect(chatTabLabel(surface(), true)).toBeUndefined();
    expect(state().workspaces[0].rootPane).toMatchObject({ surfaces: [{ title: 'Zsh' }] });
  });
});
