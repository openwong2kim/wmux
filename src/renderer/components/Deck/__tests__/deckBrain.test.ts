// Unit tests for the Commander brain thread reducer + fleet-context builder
// (Command Deck P2d). Pure — no store, no Electron.

import { describe, it, expect } from 'vitest';
import {
  applyBrainEvent,
  buildFleetContextSummary,
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
});

describe('shortToolName', () => {
  it('strips the mcp server prefix', () => {
    expect(shortToolName('mcp__wmux__pane_split')).toBe('pane_split');
    expect(shortToolName('plainTool')).toBe('plainTool');
  });
});

describe('buildFleetContextSummary', () => {
  const CLAUDE = { name: 'Claude Code', slug: 'claude' as const };

  function workspace(): { ws: Workspace; ptyA: string } {
    const ptyA = 'ptyA';
    const leafA = createLeafPane(createSurface(ptyA, 'pwsh', ''), 1);
    const root: Pane = leafA;
    const ws: Workspace = {
      id: 'ws-1', name: 'Backend', wsOrdinal: 1, nextPaneOrdinal: 2, rootPane: root, activePaneId: leafA.id,
    };
    return { ws, ptyA };
  }

  it('lists live agent panes and active channels', () => {
    const { ws, ptyA } = workspace();
    const channels: Record<string, Channel> = {
      c1: { id: 'c1', name: 'commander', status: 'active' } as Channel,
      c2: { id: 'c2', name: 'old', status: 'archived' } as Channel,
    };
    const summary = buildFleetContextSummary({
      workspaces: [ws],
      surfaceAgent: { [ptyA]: CLAUDE },
      paneLabel: {},
      channels,
    });
    expect(summary).toContain('w1-1(claude)');
    expect(summary).toContain('Backend');
    expect(summary).toContain('#commander');
    expect(summary).not.toContain('#old'); // archived excluded
  });

  it('reports no panes when the fleet has none, and honors the char cap', () => {
    const summary = buildFleetContextSummary({
      workspaces: [], surfaceAgent: {}, paneLabel: {}, channels: {},
    });
    expect(summary).toContain('No agent panes');

    const { ws, ptyA } = workspace();
    const capped = buildFleetContextSummary({
      workspaces: [ws], surfaceAgent: { [ptyA]: CLAUDE }, paneLabel: {}, channels: {}, maxChars: 20,
    });
    expect(capped.length).toBeLessThanOrEqual(20 + '\n…(truncated)'.length);
    expect(capped.endsWith('…(truncated)')).toBe(true);
  });
});
