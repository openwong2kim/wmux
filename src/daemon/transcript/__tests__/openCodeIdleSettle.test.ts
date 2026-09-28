import { describe, expect, it, vi } from 'vitest';
import type { AgentStatus } from '../../../shared/types';
import { OPENCODE_IDLE_SETTLE_EVENT, settleOpenCodeOnIdle, type OpenCodeIdleBridge } from '../openCodeIdleSettle';

function bridge(status: AgentStatus = 'idle') {
  const b = {
    status,
    startedAt: 100,
    getAgentStatus: () => b.status,
    getLastTurnStartedAt: () => b.startedAt,
    noteAgentStatus: vi.fn((next: 'complete') => { b.status = next; }),
  };
  return b satisfies OpenCodeIdleBridge;
}

function read(agentStatus: AgentStatus, ids: string[] = ['u1', 'a1']) {
  return vi.fn(async () => ({
    status: { available: true, reason: 'ok' as const, agentStatus },
    page: {
      events: ids.map(id => ({ id, kind: 'assistant_text', text: 'x' })),
      cursor: { historyEpoch: 'e', headOffset: 0, tailOffset: ids.length, fileSize: ids.length, mtimeMs: 0 },
      hasMore: false,
      truncatedHead: false,
    },
  })) as never;
}

describe('settleOpenCodeOnIdle (#1621)', () => {
  it('settles a finished or interrupted OpenCode turn to complete', async () => {
    const b = bridge();
    const emit = vi.fn();
    expect(await settleOpenCodeOnIdle('p', 'opencode', b, read('complete'), emit, new Map())).toBe(true);
    expect(b.noteAgentStatus).toHaveBeenCalledWith('complete');
    expect(emit).toHaveBeenCalledWith(OPENCODE_IDLE_SETTLE_EVENT);
    // Status only: main treats `internal` as a trace, never a toast.
    expect(OPENCODE_IDLE_SETTLE_EVENT.decision).toBe('internal');
  });

  it('leaves a turn the plugin still reports running', async () => {
    const b = bridge();
    const emit = vi.fn();
    expect(await settleOpenCodeOnIdle('p', 'opencode', b, read('running'), emit, new Map())).toBe(false);
    expect(await settleOpenCodeOnIdle('p', 'opencode', b, read('awaiting_input'), emit, new Map())).toBe(false);
    expect(b.noteAgentStatus).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('never probes a pane running another agent, or one already settled', async () => {
    for (const [slug, b] of [['claude', bridge()], [undefined, bridge()], ['opencode', bridge('complete')]] as const) {
      const r = read('complete');
      expect(await settleOpenCodeOnIdle('p', slug, b, r, vi.fn(), new Map())).toBe(false);
      expect(r).not.toHaveBeenCalled();
      expect(b.noteAgentStatus).not.toHaveBeenCalled();
    }
  });

  it('drops the settle when a new turn or another settle landed during the read', async () => {
    const b = bridge();
    const restarted = vi.fn(async () => { b.startedAt = 200; return (read('complete') as unknown as () => Promise<unknown>)(); }) as never;
    expect(await settleOpenCodeOnIdle('p', 'opencode', b, restarted, vi.fn(), new Map())).toBe(false);
    const c = bridge();
    const settled = vi.fn(async () => { c.status = 'complete'; return (read('complete') as unknown as () => Promise<unknown>)(); }) as never;
    expect(await settleOpenCodeOnIdle('p', 'opencode', c, settled, vi.fn(), new Map())).toBe(false);
    expect(b.noteAgentStatus).not.toHaveBeenCalled();
    expect(c.noteAgentStatus).not.toHaveBeenCalled();
  });

  it('emits nothing for a boot (empty transcript) and once per transcript tail', async () => {
    const seen = new Map<string, string>();
    const emit = vi.fn();
    expect(await settleOpenCodeOnIdle('p', 'opencode', bridge(), read('complete', []), emit, seen)).toBe(false);
    expect(await settleOpenCodeOnIdle('p', 'opencode', bridge(), read('complete'), emit, seen)).toBe(true);
    expect(await settleOpenCodeOnIdle('p', 'opencode', bridge(), read('complete'), emit, seen)).toBe(false);
    expect(await settleOpenCodeOnIdle('p', 'opencode', bridge(), read('complete', ['u1', 'a1', 'u2']), emit, seen)).toBe(true);
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the plugin is unreachable', async () => {
    const emit = vi.fn();
    expect(await settleOpenCodeOnIdle('p', 'opencode', bridge(), vi.fn(async () => null), emit, new Map())).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });
});
