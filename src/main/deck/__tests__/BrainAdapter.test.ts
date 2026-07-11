// Unit tests for the SDK → normalized-event mapping (Command Deck P2a). Pure —
// no SDK, no Electron: hand-built raw frames drive the whole coupling surface.

import { describe, it, expect } from 'vitest';
import {
  normalizeSdkMessage,
  createNormalizeState,
  summarizeToolInput,
  extractToolTarget,
  type RawSdkMessage,
} from '../BrainAdapter';

describe('normalizeSdkMessage', () => {
  it('captures session id from system/init and emits nothing', () => {
    const state = createNormalizeState();
    const events = normalizeSdkMessage(
      { type: 'system', subtype: 'init', session_id: 'sess-1', apiKeySource: 'none' },
      state,
    );
    expect(events).toEqual([]);
    expect(state.sessionId).toBe('sess-1');
  });

  it('maps assistant text blocks to text-delta and tool_use to tool-start', () => {
    const state = createNormalizeState();
    const msg: RawSdkMessage = {
      type: 'assistant',
      session_id: 'sess-1',
      message: {
        content: [
          { type: 'text', text: 'Spawning a worker' },
          { type: 'tool_use', id: 'tu-1', name: 'mcp__wmux__pane_split', input: { workspaceId: 'ws-1' } },
        ],
      },
    };
    const events = normalizeSdkMessage(msg, state);
    expect(events[0]).toEqual({ type: 'text-delta', text: 'Spawning a worker' });
    expect(events[1]).toMatchObject({
      type: 'tool-start',
      name: 'mcp__wmux__pane_split',
      toolId: 'tu-1',
      workspaceId: 'ws-1',
    });
    // The id→name mapping is recorded for the later tool_result.
    expect(state.toolNames.get('tu-1')).toBe('mcp__wmux__pane_split');
  });

  it('extracts a pane target onto tool-start when present', () => {
    const state = createNormalizeState();
    const events = normalizeSdkMessage(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu-2', name: 'mcp__wmux__terminal_send', input: { paneId: 'pane-9', text: 'ls' } }],
        },
      },
      state,
    );
    expect(events[0]).toMatchObject({ type: 'tool-start', paneId: 'pane-9' });
  });

  it('maps a user tool_result to tool-end with ok reflecting is_error', () => {
    const state = createNormalizeState();
    state.toolNames.set('tu-1', 'mcp__wmux__pane_split');
    const ok = normalizeSdkMessage(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1' }] } },
      state,
    );
    expect(ok[0]).toEqual({ type: 'tool-end', name: 'mcp__wmux__pane_split', ok: true, toolId: 'tu-1' });

    const failed = normalizeSdkMessage(
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: true }] } },
      state,
    );
    expect(failed[0]).toMatchObject({ type: 'tool-end', ok: false });
  });

  it('maps result success to a single turn-end carrying the session id + usage', () => {
    const state = createNormalizeState();
    state.sessionId = 'sess-1';
    const events = normalizeSdkMessage(
      {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        num_turns: 3,
        total_cost_usd: 0.02,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      state,
    );
    expect(events).toEqual([
      {
        type: 'turn-end',
        sessionId: 'sess-1',
        usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.02, numTurns: 3 },
      },
    ]);
  });

  it('maps an error result to an error event (no turn-end)', () => {
    const state = createNormalizeState();
    const events = normalizeSdkMessage(
      { type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['hit the turn cap'] },
      state,
    );
    expect(events).toEqual([{ type: 'error', message: 'hit the turn cap' }]);
  });

  it('ignores unknown frame types', () => {
    const state = createNormalizeState();
    expect(normalizeSdkMessage({ type: 'stream_event' }, state)).toEqual([]);
  });
});

describe('summarizeToolInput', () => {
  it('summarizes a pane command compactly', () => {
    expect(summarizeToolInput('mcp__wmux__terminal_send', { paneId: 'pane-9', text: 'npm test' })).toBe(
      'pane-9 · npm test',
    );
  });
  it('truncates long text', () => {
    const long = 'x'.repeat(200);
    const s = summarizeToolInput('mcp__wmux__terminal_send', { text: long });
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('…')).toBe(true);
  });
  it('returns empty for a non-object input', () => {
    expect(summarizeToolInput('x', undefined)).toBe('');
  });
});

describe('extractToolTarget', () => {
  it('reads camelCase and snake_case coordinates', () => {
    expect(extractToolTarget({ paneId: 'p1', workspaceId: 'w1' })).toEqual({ paneId: 'p1', workspaceId: 'w1' });
    expect(extractToolTarget({ pane_id: 'p2', workspace_id: 'w2' })).toEqual({ paneId: 'p2', workspaceId: 'w2' });
  });
  it('returns empty when no coordinate is present', () => {
    expect(extractToolTarget({ text: 'hi' })).toEqual({});
    expect(extractToolTarget(null)).toEqual({});
  });
});
