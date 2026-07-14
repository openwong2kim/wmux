// Unit tests for the Commander brain thread reducer + fleet-context builder
// (Command Deck P2d). Pure — no store, no Electron.

import { describe, it, expect } from 'vitest';
import {
  applyBrainEvent,
  buildWorkspaceContextSummary,
  shortToolName,
  type DeckBrainMessage,
} from '../deckBrain';
import { createLeafPane, createSurface, type Pane, type Workspace } from '../../../../shared/types';
import type { Channel } from '../../../../shared/channels';

/** A fresh open turn: human message + a streaming assistant placeholder (what
 *  the slice pushes on send). */
function openTurn(): DeckBrainMessage[] {
  return [
    { id: 'u1', role: 'user', text: 'do it' },
    { id: 'a1', role: 'assistant', text: '', tools: [], status: 'streaming' },
  ];
}

describe('applyBrainEvent', () => {
  it('accumulates text-delta into the open assistant message', () => {
    let msgs = openTurn();
    msgs = applyBrainEvent(msgs, { type: 'text-delta', text: 'Hello ' });
    msgs = applyBrainEvent(msgs, { type: 'text-delta', text: 'world' });
    expect(msgs[1].text).toBe('Hello world');
  });

  it('opens a tool chip on tool-start and closes it on tool-end', () => {
    let msgs = openTurn();
    msgs = applyBrainEvent(msgs, {
      type: 'tool-start',
      name: 'mcp__wmux__pane_split',
      inputSummary: 'ws-1',
      toolId: 'tu-1',
      paneId: 'pane-9',
      workspaceId: 'ws-1',
    });
    expect(msgs[1].tools).toHaveLength(1);
    expect(msgs[1].tools![0]).toMatchObject({ name: 'pane_split', paneId: 'pane-9' });
    expect(msgs[1].tools![0].ok).toBeUndefined(); // still running

    msgs = applyBrainEvent(msgs, { type: 'tool-end', name: 'mcp__wmux__pane_split', ok: true, toolId: 'tu-1' });
    expect(msgs[1].tools![0].ok).toBe(true);
  });

  it('closes tool-end by name when no toolId is present', () => {
    let msgs = openTurn();
    msgs = applyBrainEvent(msgs, { type: 'tool-start', name: 'mcp__wmux__terminal_read', inputSummary: '' });
    msgs = applyBrainEvent(msgs, { type: 'tool-end', name: 'mcp__wmux__terminal_read', ok: false });
    expect(msgs[1].tools![0].ok).toBe(false);
  });

  it('marks the turn done on turn-end and errored on error', () => {
    let a = openTurn();
    a = applyBrainEvent(a, { type: 'turn-end', sessionId: 's' });
    expect(a[1].status).toBe('done');

    let b = openTurn();
    b = applyBrainEvent(b, { type: 'error', message: 'boom' });
    expect(b[1].status).toBe('error');
    expect(b[1].errorText).toBe('boom');
  });

  it('is a no-op when there is no open assistant message', () => {
    const msgs: DeckBrainMessage[] = [{ id: 'u1', role: 'user', text: 'hi' }];
    expect(applyBrainEvent(msgs, { type: 'text-delta', text: 'x' })).toBe(msgs);
  });

  // ── limit events → surfaced notices (M3) ──────────────────────────────────

  it('surfaces a rejected limit as an amber notice (not spliced into text)', () => {
    let m = openTurn();
    m = applyBrainEvent(m, { type: 'limit', status: 'rejected', window: 'five_hour', resetsAtMs: 1_700_000_000_000, accountId: 'a', accountName: 'Work Max' });
    expect(m[1].text).toBe(''); // streaming text untouched
    expect(m[1].limitNotices).toHaveLength(1);
    expect(m[1].limitNotices![0]).toMatchObject({ status: 'rejected', window: 'five_hour', accountName: 'Work Max' });
  });

  it('surfaces allowed_warning too', () => {
    let m = openTurn();
    m = applyBrainEvent(m, { type: 'limit', status: 'allowed_warning', window: 'seven_day', utilization: 85, accountId: 'a' });
    expect(m[1].limitNotices![0]).toMatchObject({ status: 'allowed_warning', utilization: 85 });
  });

  it('NEVER surfaces a retrying limit (SDK auto-recovers)', () => {
    const before = openTurn();
    const after = applyBrainEvent(before, { type: 'limit', status: 'retrying', attempt: 2, maxRetries: 5 } as never);
    expect(after).toBe(before); // true no-op — same array reference, nothing inserted
    expect(after[1].limitNotices).toBeUndefined();
  });

  it('ESCALATION: rejected after allowed_warning for the same episode still shows', () => {
    let m = openTurn();
    const ep = { window: 'five_hour', resetsAtMs: 1_700_000_000_000, accountId: 'a' };
    m = applyBrainEvent(m, { type: 'limit', status: 'allowed_warning', ...ep });
    m = applyBrainEvent(m, { type: 'limit', status: 'rejected', ...ep });
    expect(m[1].limitNotices).toHaveLength(2);
    expect(m[1].limitNotices!.map((n) => n.status)).toEqual(['allowed_warning', 'rejected']);
  });

  it('dedupes a same-or-lower severity repeat for the same episode', () => {
    let m = openTurn();
    const ep = { status: 'rejected' as const, window: 'five_hour', resetsAtMs: 1_700_000_000_000, accountId: 'a' };
    m = applyBrainEvent(m, { type: 'limit', ...ep });
    const after = applyBrainEvent(m, { type: 'limit', ...ep }); // duplicate rejected
    expect(after).toBe(m); // suppressed, no new array
    // and a lower-severity warning after a rejected is also suppressed
    const afterWarn = applyBrainEvent(m, { type: 'limit', status: 'allowed_warning', window: 'five_hour', resetsAtMs: 1_700_000_000_000, accountId: 'a' });
    expect(afterWarn).toBe(m);
  });

  it('a new resetsAtMs is a new episode (shows again for the same account/window)', () => {
    let m = openTurn();
    m = applyBrainEvent(m, { type: 'limit', status: 'rejected', window: 'five_hour', resetsAtMs: 1_700_000_000_000, accountId: 'a' });
    m = applyBrainEvent(m, { type: 'limit', status: 'rejected', window: 'five_hour', resetsAtMs: 1_700_099_999_000, accountId: 'a' });
    expect(m[1].limitNotices).toHaveLength(2);
  });

  it('a keyless limit (no account/window/reset) is never treated as a dup', () => {
    let m = openTurn();
    m = applyBrainEvent(m, { type: 'limit', status: 'rejected' });
    m = applyBrainEvent(m, { type: 'limit', status: 'rejected' });
    expect(m[1].limitNotices).toHaveLength(2);
  });

  it('does NOT dedupe without resetsAtMs — account+window alone is not an episode key (fix 5)', () => {
    let m = openTurn();
    // Same account + window + severity, but NO reset time on either notice.
    // resetsAtMs is the episode discriminator; absent it we can't prove these are
    // the same episode, so both must show (hiding a real limit > a duplicate line).
    // The pre-fix `sameLimitEpisode` compared `resetsAtMs ?? 0`, collapsing both
    // to 0 and wrongly suppressing the second.
    const ep = { window: 'five_hour', accountId: 'a' } as const;
    m = applyBrainEvent(m, { type: 'limit', status: 'allowed_warning', ...ep });
    m = applyBrainEvent(m, { type: 'limit', status: 'allowed_warning', ...ep });
    expect(m[1].limitNotices).toHaveLength(2);
  });

  it('REGRESSION: an unknown event type still hits default (no crash)', () => {
    const m = openTurn();
    expect(applyBrainEvent(m, { type: 'mystery' } as never)).toBe(m);
  });
});

describe('shortToolName', () => {
  it('strips the mcp server prefix', () => {
    expect(shortToolName('mcp__wmux__pane_split')).toBe('pane_split');
    expect(shortToolName('plainTool')).toBe('plainTool');
  });
});

describe('buildWorkspaceContextSummary', () => {
  const CLAUDE = { name: 'Claude Code', slug: 'claude' as const };

  function workspace(
    id = 'ws-1',
    name = 'Backend',
    ptyId = 'ptyA',
    wsOrdinal = 1,
  ): { ws: Workspace; pty: string } {
    const leaf = createLeafPane(createSurface(ptyId, 'pwsh', ''), 1);
    const root: Pane = leaf;
    const ws: Workspace = {
      id, name, wsOrdinal, nextPaneOrdinal: 2, rootPane: root, activePaneId: leaf.id,
    };
    return { ws, pty: ptyId };
  }

  it('details OWN panes, names the workspace, and lists active channels', () => {
    const { ws, pty } = workspace();
    const channels: Record<string, Channel> = {
      c1: { id: 'c1', name: 'commander', status: 'active' } as Channel,
      c2: { id: 'c2', name: 'old', status: 'archived' } as Channel,
    };
    const summary = buildWorkspaceContextSummary({
      workspaces: [ws],
      activeWorkspaceId: 'ws-1',
      surfaceAgent: { [pty]: CLAUDE },
      paneLabel: {},
      channels,
    });
    expect(summary).toContain('orchestrator for workspace "Backend"');
    expect(summary).toContain('w1-1(claude)');
    expect(summary).toContain('#commander');
    expect(summary).not.toContain('#old'); // archived excluded
    expect(summary).not.toContain('Other workspaces'); // there are none
  });

  it('rosters OTHER workspaces as existence-only lines (no pane detail)', () => {
    const a = workspace('ws-1', 'Backend', 'ptyA', 1);
    const b = workspace('ws-2', 'Frontend', 'ptyB', 2);
    const c = workspace('ws-3', 'Idle Land', 'ptyC', 3);
    const summary = buildWorkspaceContextSummary({
      workspaces: [a.ws, b.ws, c.ws],
      activeWorkspaceId: 'ws-1',
      surfaceAgent: { [a.pty]: CLAUDE, [b.pty]: CLAUDE }, // ws-3 has no agent
      paneLabel: {},
      channels: {},
    });
    expect(summary).toContain('Other workspaces');
    expect(summary).toContain('"Frontend" (1 agent pane(s))');
    expect(summary).toContain('"Idle Land" (idle)');
    // No pane coordinates from the other workspaces leak into the summary.
    expect(summary).not.toContain('w2-1');
    expect(summary).not.toContain('w3-1');
  });

  it('injects an operator-assigned role onto the matching pane line, and only when set', () => {
    const { ws, pty } = workspace();
    const paneId = ws.activePaneId; // single-leaf workspace → activePaneId is the leaf
    const withRole = buildWorkspaceContextSummary({
      workspaces: [ws],
      activeWorkspaceId: 'ws-1',
      surfaceAgent: { [pty]: CLAUDE },
      paneLabel: {},
      paneRole: { [paneId]: 'Reviewer' },
      channels: {},
    });
    // Role rides on the same pane line as its autoName, as a "— role: X" suffix.
    expect(withRole).toContain('w1-1(claude) [Claude Code] — role: Reviewer');

    const withoutRole = buildWorkspaceContextSummary({
      workspaces: [ws],
      activeWorkspaceId: 'ws-1',
      surfaceAgent: { [pty]: CLAUDE },
      paneLabel: {},
      channels: {},
    });
    expect(withoutRole).toContain('w1-1(claude)');
    expect(withoutRole).not.toContain('role:'); // no dangling suffix when unset

    // Empty-string sentinel (unassigned) must NOT emit a role suffix.
    const emptyRole = buildWorkspaceContextSummary({
      workspaces: [ws],
      activeWorkspaceId: 'ws-1',
      surfaceAgent: { [pty]: CLAUDE },
      paneLabel: {},
      paneRole: { [paneId]: '' },
      channels: {},
    });
    expect(emptyRole).not.toContain('role:');
  });

  it('reports no panes when the workspace has none, and honors the char cap', () => {
    const summary = buildWorkspaceContextSummary({
      workspaces: [], activeWorkspaceId: 'ws-x', surfaceAgent: {}, paneLabel: {}, channels: {},
    });
    expect(summary).toContain('No agent panes');

    const { ws, pty } = workspace();
    const capped = buildWorkspaceContextSummary({
      workspaces: [ws],
      activeWorkspaceId: 'ws-1',
      surfaceAgent: { [pty]: CLAUDE },
      paneLabel: {},
      channels: {},
      maxChars: 20,
    });
    expect(capped.length).toBeLessThanOrEqual(20 + '\n…(truncated)'.length);
    expect(capped.endsWith('…(truncated)')).toBe(true);
  });
});
