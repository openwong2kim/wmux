// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  buildMentionReference,
  buildMentionSendParams,
  buildMentionTargets,
  describeMentionSendResult,
  filterMentionTargets,
  focusedMentionSource,
  HUMAN_SEND_PREFIX,
  mentionSourceForKey,
  type MentionPaneTarget,
} from '../agentMention';
import type { StoreState } from '../../stores';
import type { Pane, Surface, Workspace } from '../../../shared/types';

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: 'zsh', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal', ...extra };
}
function leaf(id: string, ordinal: number, surfaces: Surface[]): Pane {
  return { id, type: 'leaf', ordinal, surfaces, activeSurfaceId: surfaces[0]?.id ?? '' } as Pane;
}
function workspace(id: string, name: string, wsOrdinal: number, children: Pane[], activePaneId: string): Workspace {
  const rootPane: Pane = children.length === 1
    ? children[0]
    : { id: `${id}-root`, type: 'branch', direction: 'horizontal', children } as Pane;
  return { id, name, wsOrdinal, rootPane, activePaneId } as Workspace;
}

// Two workspaces: "wmux" runs Claude (focused) + Codex + Gemini; "docs" runs
// one Claude and a plain shell.
const wmux = workspace('ws-1', 'wmux', 115, [
  leaf('pane-a', 1, [surface('s-a', 'pty-a')]),
  leaf('pane-b', 2, [surface('s-b', 'pty-b', { title: 'review' })]),
  leaf('pane-c', 3, [surface('s-c', 'pty-c')]),
], 'pane-a');
const docs = workspace('ws-2', 'docs', 7, [
  leaf('pane-d', 1, [surface('s-d', 'pty-d')]),
  leaf('pane-e', 2, [surface('s-e', 'pty-e')]),
], 'pane-d');

function state(overrides: Partial<Record<keyof StoreState, unknown>> = {}): StoreState {
  return {
    workspaces: [wmux, docs],
    activeWorkspaceId: 'ws-1',
    surfaceAgent: {
      'pty-a': { name: 'Claude Code', status: 'idle' },
      'pty-b': { name: 'Codex', status: 'running' },
      'pty-c': { name: 'Gemini', status: 'idle' },
      'pty-d': { name: 'Claude Code', status: 'idle' },
    },
    // An attention status the hooks reported: the roster shows it as is.
    surfaceAgentStatus: { 'pty-b': 'running' },
    surfacePendingQuestion: {},
    surfaceQuestionSeen: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    paneLabel: {},
    agentClockMs: 0,
    remoteWorkspaces: [],
    chatViewEnabled: true,
    ...overrides,
  } as unknown as StoreState;
}

describe('focusedMentionSource (the shortcut gate)', () => {
  it('is the focused pane when it runs an agent', () => {
    expect(focusedMentionSource(state())).toEqual({
      workspaceId: 'ws-1', paneId: 'pane-a', surfaceId: 's-a', ptyId: 'pty-a', chat: false,
    });
  });

  it('is null in a plain shell pane, so F2 reaches the terminal', () => {
    expect(focusedMentionSource(state({ activeWorkspaceId: 'ws-2', workspaces: [wmux, { ...docs, activePaneId: 'pane-e' }] }))).toBeNull();
  });

  it('is null once the agent has exited back to its shell, before the name poll clears', () => {
    expect(focusedMentionSource(state({ agentAliveByPtyId: { 'pty-a': false } }))).toBeNull();
    expect(focusedMentionSource(state({ commandRunningByPtyId: { 'pty-a': false } }))).toBeNull();
    expect(focusedMentionSource(state({ agentAliveByPtyId: { 'pty-a': true }, commandRunningByPtyId: { 'pty-a': true } }))).not.toBeNull();
  });

  it('declines a key typed into another terminal (floating pane, brain embed) while a leaf agent is active', () => {
    const host = (ptyId: string) => {
      const div = document.createElement('div');
      div.setAttribute('data-terminal-pty', ptyId);
      const textarea = document.createElement('textarea');
      div.appendChild(textarea);
      return textarea;
    };
    expect(mentionSourceForKey(state(), host('pty-floating'))).toBeNull();
    expect(mentionSourceForKey(state(), host('pty-a'))).toMatchObject({ ptyId: 'pty-a' });
    // Outside any terminal (Chat composer, sidebar): the active pane's.
    expect(mentionSourceForKey(state(), document.createElement('input'))).toMatchObject({ ptyId: 'pty-a' });
  });

  it('accepts a pane in Chat view and marks it for the composer', () => {
    const chatWs = workspace('ws-3', 'chat', 1, [leaf('pane-x', 1, [surface('s-x', 'pty-x', { viewMode: 'chat' })])], 'pane-x');
    const s = state({ workspaces: [chatWs], activeWorkspaceId: 'ws-3' });
    expect(focusedMentionSource(s)).toMatchObject({ ptyId: 'pty-x', chat: true });
    // Chat view switched off app-wide: the shell underneath decides.
    expect(focusedMentionSource(state({ workspaces: [chatWs], activeWorkspaceId: 'ws-3', chatViewEnabled: false }))).toBeNull();
  });
});

describe('buildMentionTargets', () => {
  it('lists agent panes across workspaces, excluding the focused pane and shells', () => {
    const targets = buildMentionTargets(state(), 'pty-a');
    expect(targets.map((t) => t.key)).toEqual(['pane:pty-b', 'pane:pty-c', 'ws:ws-1', 'pane:pty-d']);
  });

  it('carries the coordinate, tab title and status of each pane', () => {
    const [codex] = buildMentionTargets(state(), 'pty-a') as MentionPaneTarget[];
    expect(codex).toMatchObject({
      kind: 'pane', agentName: 'Codex', title: 'review', coordinate: 'w115-2',
      workspaceId: 'ws-1', workspaceName: 'wmux', paneId: 'pane-b', status: 'running',
    });
    // One tab in the pane: the pane id addresses the agent on its own.
    expect(codex.surfaceId).toBeUndefined();
  });

  it('drops a tab title that only repeats the agent name behind a status glyph', () => {
    const s = state({
      workspaces: [wmux, workspace('ws-5', 'glyph', 3, [leaf('pane-g', 1, [surface('s-g', 'pty-g', { title: '✳ Claude Code' })])], 'pane-g')],
      surfaceAgent: { 'pty-a': { name: 'Claude Code', status: 'idle' }, 'pty-g': { name: 'Claude Code', status: 'idle' } },
    });
    const [glyph] = buildMentionTargets(s, 'pty-a') as MentionPaneTarget[];
    expect(glyph.paneId).toBe('pane-g');
    expect(glyph.title).toBeUndefined();
  });

  it('adds a workspace row only when two or more agent panes remain', () => {
    const targets = buildMentionTargets(state(), 'pty-a');
    const wsRow = targets.find((t) => t.kind === 'workspace');
    expect(wsRow).toMatchObject({ workspaceId: 'ws-1', panes: [{ paneId: 'pane-b' }, { paneId: 'pane-c' }] });
    expect(targets.some((t) => t.key === 'ws:ws-2')).toBe(false);
  });

  it('expands a multi-tab pane to one row per agent tab, each with its surface id', () => {
    const multi = workspace('ws-4', 'multi', 9, [
      leaf('pane-m', 1, [surface('s-m1', 'pty-m1'), surface('s-m2', 'pty-m2')]),
    ], 'pane-m');
    const s = state({
      workspaces: [wmux, multi],
      surfaceAgent: { 'pty-a': { name: 'Claude Code', status: 'idle' }, 'pty-m1': { name: 'Codex', status: 'idle' }, 'pty-m2': { name: 'Claude Code', status: 'idle' } },
    });
    const rows = buildMentionTargets(s, 'pty-a').filter((t) => t.workspaceId === 'ws-4');
    expect(rows.map((t) => (t.kind === 'pane' ? t.surfaceId : t.kind))).toEqual(['s-m1', 's-m2', 'workspace']);
  });

  it('filters on every typed word', () => {
    const targets = buildMentionTargets(state(), 'pty-a');
    // The workspace row matches its agents' names too.
    expect(filterMentionTargets(targets, 'codex').map((t) => t.key)).toEqual(['pane:pty-b', 'ws:ws-1']);
    expect(filterMentionTargets(targets, 'claude docs').map((t) => t.key)).toEqual(['pane:pty-d']);
    expect(filterMentionTargets(targets, 'w115-3').map((t) => t.key)).toEqual(['pane:pty-c']);
    expect(filterMentionTargets(targets, '  ')).toHaveLength(targets.length);
  });
});

describe('buildMentionReference', () => {
  it('is one line with the ids send_message needs', () => {
    const [codex] = buildMentionTargets(state(), 'pty-a');
    expect(buildMentionReference(codex)).toBe(
      '[wmux agent "Codex" · workspace "wmux" (ws-1) · pane pane-b · reach it with wmux send_message]',
    );
  });

  it('lists the agent panes of a workspace instead of naming one', () => {
    const wsRow = buildMentionTargets(state(), 'pty-a').find((t) => t.kind === 'workspace')!;
    expect(buildMentionReference(wsRow)).toBe(
      '[wmux workspace "wmux" (ws-1) · agents: "Codex" pane pane-b, "Gemini" pane pane-c · reach one with wmux send_message and its pane_id]',
    );
  });

  it('keeps names on one line with balanced quotes', () => {
    const ref = buildMentionReference({
      kind: 'pane', key: 'k', workspaceId: 'ws-9', workspaceName: 'my "big"\nproject', paneId: 'p',
      surfaceId: 's', agentName: 'Codex\r', coordinate: 'w1-1', status: 'idle',
    });
    expect(ref).toBe('[wmux agent "Codex" · workspace "my \'big\' project" (ws-9) · pane p surface s · reach it with wmux send_message]');
    expect(ref).not.toMatch(/[\r\n]/);
  });
});

describe('direct send (⌘Enter)', () => {
  const source = { workspaceId: 'ws-1', ptyId: 'pty-a' };

  it('addresses the chosen pane as the focused pane, like send_message with pane_id, marked as the user\'s', () => {
    const [codex] = buildMentionTargets(state(), 'pty-a') as MentionPaneTarget[];
    expect(buildMentionSendParams(source, codex, 'please review')).toEqual({
      workspaceId: 'ws-1', senderPtyId: 'pty-a', to: 'ws-1', paneId: 'pane-b',
      message: `${HUMAN_SEND_PREFIX} please review`,
    });
  });

  it('reads the send result as sent, stored or refused', () => {
    expect(describeMentionSendResult({ ok: true, delivery: { notified: true, mode: 'nudge' } })).toEqual({ kind: 'sent', nudge: true });
    expect(describeMentionSendResult({ ok: true, delivery: { notified: true, mode: 'notification' } })).toEqual({ kind: 'sent', nudge: false });
    expect(describeMentionSendResult({ ok: true, delivery: { notified: false, reason: 'no_agent_pane' } })).toEqual({ kind: 'stored', reason: 'no_agent_pane' });
    expect(describeMentionSendResult({ error: 'a2a.task.send: workspace "wmux" runs several agents' }))
      .toEqual({ kind: 'refused', reason: 'workspace "wmux" runs several agents' });
  });
});
