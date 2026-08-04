import { describe, it, expect } from 'vitest';
import type { AgentSignal, AgentSignalKind } from '../../../shared/hooks/signal-types';
import type { HookAgentEventData } from '../HookIngest';
import { deriveAgentLiveness, isTerminalLiveness } from '../agentLiveness';

const signal = (kind: AgentSignalKind, payload: Record<string, unknown> = {}): AgentSignal => ({
  kind,
  agent: 'claude',
  cwd: '/repo',
  payload,
  ts: 1000,
});

const data = (over: Partial<HookAgentEventData>): HookAgentEventData => ({
  agent: 'Claude Code',
  status: 'running',
  message: '',
  source: 'hook',
  signal: signal('agent.activity'),
  ...over,
});

describe('deriveAgentLiveness', () => {
  it('maps each hook shape onto the header state the phone renders', () => {
    const cases: Array<[HookAgentEventData, string, string | undefined]> = [
      // A settled pane: status wins regardless of which stop hook produced it.
      [data({ status: 'complete', signal: signal('agent.stop') }), 'idle', undefined],
      [data({ status: 'awaiting_input', signal: signal('agent.awaiting_input') }), 'awaiting_input', undefined],
      // Metadata kinds all carry status:'running' and only refine the busy case.
      [
        data({
          hookKind: 'agent.tool_started',
          decision: 'activity',
          signal: signal('agent.tool_started', { tool_name: 'Bash' }),
        }),
        'tool',
        'Bash',
      ],
      [
        data({
          hookKind: 'agent.awaiting_permission',
          decision: 'activity',
          signal: signal('agent.awaiting_permission', { tool_name: 'Write' }),
        }),
        'awaiting_permission',
        'Write',
      ],
      [data({ hookKind: 'agent.activity', decision: 'activity' }), 'busy', undefined],
    ];
    for (const [input, state, tool] of cases) {
      const body = deriveAgentLiveness('s1', input, 4242);
      expect(body).toMatchObject({ sessionId: 's1', state, agent: 'Claude Code', at: 4242 });
      expect(body.tool).toBe(tool);
    }
  });

  it('a stop hook that still names a tool settles the pane instead of showing the tool', () => {
    // PostToolUse-shaped payloads carry `tool_name` too. Reading the tool name
    // ahead of the status would leave the header saying "Bash running" on a pane
    // that has already finished — the exact lie the header exists to prevent.
    const body = deriveAgentLiveness(
      's1',
      data({ status: 'complete', signal: signal('agent.stop', { tool_name: 'Bash' }) }),
      1,
    );
    expect(body.state).toBe('idle');
    expect(body.tool).toBeUndefined();
    expect(isTerminalLiveness(body.state)).toBe(true);
  });

  it('busy states are the only ones that may wait out a coalescing window', () => {
    expect(isTerminalLiveness('busy')).toBe(false);
    expect(isTerminalLiveness('tool')).toBe(false);
    expect(isTerminalLiveness('idle')).toBe(true);
    expect(isTerminalLiveness('awaiting_input')).toBe(true);
    expect(isTerminalLiveness('awaiting_permission')).toBe(true);
  });
});
