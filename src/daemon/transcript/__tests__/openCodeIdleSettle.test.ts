import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import type { AgentStatus } from '../../../shared/types';
import { DaemonPTYBridge } from '../../DaemonPTYBridge';
import { PromptEventLog } from '../../PromptEventLog';
import { RingBuffer } from '../../RingBuffer';
import {
  OPENCODE_UNREACHABLE_BACKOFF_MS,
  OpenCodeIdleSettler,
  type OpenCodeIdleBridge,
  type OpenCodePluginRead,
} from '../openCodeIdleSettle';

type Phase = 'complete' | 'running' | 'awaiting_input';

function fakeBridge(over: Partial<{ status: AgentStatus; open: boolean; hooks: boolean; evidenceAt: number }> = {}) {
  const b = {
    status: over.status ?? 'idle' as AgentStatus,
    open: over.open ?? true,
    hooks: over.hooks ?? false,
    evidenceAt: over.evidenceAt ?? 1_000,
    getAgentStatus: () => b.status,
    isTurnOpen: () => b.open,
    hasHookReports: () => b.hooks,
    getTurnEvidenceStartedAt: () => b.evidenceAt,
    noteAgentStatus: vi.fn((next: 'complete' | 'awaiting_input') => { b.status = next; }),
    noteTranscriptTurnEnd: vi.fn(() => { b.open = false; }),
  };
  return b satisfies OpenCodeIdleBridge;
}

function pluginRead(phase: Phase, turn?: { id?: string; startedAt?: number; state?: 'running' | 'idle' }, epoch = 'e1', session = 'ses_a'): OpenCodePluginRead {
  return {
    status: { available: true, reason: 'ok', agentSessionId: session, agentStatus: phase },
    page: { events: [], cursor: { historyEpoch: epoch, headOffset: 0, tailOffset: 0, fileSize: 0, mtimeMs: 0 }, hasMore: false, truncatedHead: false },
    ...(turn ? { turn: { id: turn.id ?? 't1:oc.a', state: turn.state ?? (phase === 'complete' ? 'idle' : 'running'), ...(turn.startedAt !== undefined ? { startedAt: turn.startedAt } : {}) } } : {}),
  };
}

function setup(bridge: OpenCodeIdleBridge, reads: Array<OpenCodePluginRead | null | undefined | (() => OpenCodePluginRead | null)>, slug = 'opencode') {
  let sends = 0;
  let now = 5_000;
  const queue = [...reads];
  const read = vi.fn(async () => { const next = queue.length > 1 ? queue.shift() : queue[0]; return typeof next === 'function' ? next() : next; });
  const emit = vi.fn();
  const settler = new OpenCodeIdleSettler({
    bridge: () => bridge, agentSlug: () => slug, read, sendCount: () => sends, emit, now: () => now,
  });
  return { settler, read, emit, send: () => { sends += 1; }, advance: (ms: number) => { now += ms; } };
}

describe('OpenCodeIdleSettler (#1621)', () => {
  it('settles a turn the plugin saw start in this episode and then end (normal or interrupted)', async () => {
    const b = fakeBridge();
    const { settler, emit } = setup(b, [pluginRead('complete', { startedAt: 1_200 })]);
    expect(await settler.onIdle('p')).toBe('complete');
    expect(emit).toHaveBeenCalledWith('p', expect.objectContaining({ status: 'complete', source: 'detector', decision: 'internal' }));
    expect(b.noteAgentStatus).toHaveBeenCalledWith('complete');
    // A plugin-confirmed end is final.
    expect(b.noteTranscriptTurnEnd).toHaveBeenCalled();
  });

  it('settles a turn stopped on the agent\'s own question as awaiting_input, without ending it', async () => {
    const b = fakeBridge();
    const { settler, emit } = setup(b, [pluginRead('awaiting_input', { startedAt: 1_200 })]);
    expect(await settler.onIdle('p')).toBe('awaiting_input');
    expect(emit).toHaveBeenCalledWith('p', expect.objectContaining({ status: 'awaiting_input' }));
    expect(b.noteTranscriptTurnEnd).not.toHaveBeenCalled();
  });

  it('boot, resume (`opencode -c`), a session switch or a reattach: no turn evidence, no settle', async () => {
    // No open episode (a reattached bridge, or the shell handed the pane over).
    const closed = setup(fakeBridge({ open: false }), [pluginRead('complete', { startedAt: 1_200 })]);
    expect(await closed.settler.onIdle('p')).toBeUndefined();
    expect(closed.read).not.toHaveBeenCalled();
    // The plugin never saw this session busy: its turn has no start.
    const resumed = setup(fakeBridge(), [pluginRead('complete', {})]);
    expect(await resumed.settler.onIdle('p')).toBeUndefined();
    // Switched to a session whose turn ended before this episode began.
    const switched = setup(fakeBridge({ evidenceAt: 1_000 }), [pluginRead('complete', { startedAt: 400 }, 'e1', 'ses_b')]);
    expect(await switched.settler.onIdle('p')).toBeUndefined();
    for (const s of [closed, resumed, switched]) expect(s.emit).not.toHaveBeenCalled();
  });

  it('a stale complete read spanning a phone/queue send does not settle the new turn', async () => {
    const b = fakeBridge();
    let fire = () => undefined as void;
    const ctx = setup(b, [() => { fire(); return pluginRead('complete', { startedAt: 1_200 }); }]);
    fire = ctx.send;
    expect(await ctx.settler.onIdle('p')).toBeUndefined();
    // And the send marked the bridge as a submit: a newer episode start refuses the old turn.
    const marked = fakeBridge({ evidenceAt: 2_000 });
    const after = setup(marked, [pluginRead('complete', { startedAt: 1_200 })]);
    expect(await after.settler.onIdle('p')).toBeUndefined();
    expect(ctx.emit).not.toHaveBeenCalled();
    expect(after.emit).not.toHaveBeenCalled();
  });

  it('leaves a running turn and the admission fence alone', async () => {
    const { settler, emit } = setup(fakeBridge(), [pluginRead('running', { startedAt: 1_200 })]);
    expect(await settler.onIdle('p')).toBeUndefined();
    const fence = setup(fakeBridge(), [pluginRead('complete', { startedAt: 1_200, state: 'running' })]);
    expect(await fence.settler.onIdle('p')).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('never double-settles a pane the lifecycle plugin reports on, nor probes other agents', async () => {
    const hooked = setup(fakeBridge({ hooks: true }), [pluginRead('complete', { startedAt: 1_200 })]);
    expect(await hooked.settler.onIdle('p')).toBeUndefined();
    expect(hooked.read).not.toHaveBeenCalled();
    const claude = setup(fakeBridge(), [pluginRead('complete', { startedAt: 1_200 })], 'claude');
    expect(await claude.settler.onIdle('p')).toBeUndefined();
    expect(claude.read).not.toHaveBeenCalled();
    // A hook stop landing during the read wins.
    const b = fakeBridge();
    const racing = setup(b, [() => { b.hooks = true; b.status = 'complete'; return pluginRead('complete', { startedAt: 1_200 }); }]);
    expect(await racing.settler.onIdle('p')).toBeUndefined();
    expect(racing.emit).not.toHaveBeenCalled();
  });

  it('retries after a failed emit, and settles each turn once (keyed by epoch and turn)', async () => {
    const b = fakeBridge();
    const ctx = setup(b, [pluginRead('complete', { startedAt: 1_200 })]);
    ctx.emit.mockImplementationOnce(() => { throw new Error('pipe gone'); });
    await expect(ctx.settler.onIdle('p')).rejects.toThrow('pipe gone');
    expect(b.noteAgentStatus).not.toHaveBeenCalled();
    expect(await ctx.settler.onIdle('p')).toBe('complete');
    b.status = 'idle'; b.open = true;
    expect(await ctx.settler.onIdle('p')).toBeUndefined();
    // Same turn id under a new history epoch (a /clear or a new session) is a different turn.
    const other = setup(b, [pluginRead('complete', { startedAt: 1_200 }, 'e2')]);
    expect(await other.settler.onIdle('p')).toBe('complete');
  });

  it('backs off an unreachable plugin and merges concurrent reads', async () => {
    const ctx = setup(fakeBridge(), [null, pluginRead('complete', { startedAt: 1_200 })]);
    expect(await ctx.settler.onIdle('p')).toBeUndefined();
    expect(await ctx.settler.onIdle('p')).toBeUndefined();
    expect(ctx.read).toHaveBeenCalledTimes(1);
    ctx.advance(OPENCODE_UNREACHABLE_BACKOFF_MS + 1);
    const both = await Promise.all([ctx.settler.onIdle('p'), ctx.settler.onIdle('p')]);
    expect(ctx.read).toHaveBeenCalledTimes(2);
    expect(both.filter(Boolean)).toEqual(['complete']);
  });

  it('does not back off a transient miss (the owner check catching up after launch)', async () => {
    const ctx = setup(fakeBridge(), [undefined, pluginRead('complete', { startedAt: 1_200 })]);
    expect(await ctx.settler.onIdle('p')).toBeUndefined();
    expect(await ctx.settler.onIdle('p')).toBe('complete');
  });

  it('the running probe reads once, and once more if the plugin had not gone busy yet', async () => {
    const b = fakeBridge({ status: 'running' });
    const ctx = setup(b, [pluginRead('complete', {}), pluginRead('running', { startedAt: 1_200 })]);
    await ctx.settler.onActive('p', async () => undefined);
    expect(ctx.read).toHaveBeenCalledTimes(2);
    const busy = setup(fakeBridge({ status: 'running' }), [pluginRead('running', { startedAt: 1_200 })]);
    await busy.settler.onActive('p', async () => undefined);
    expect(busy.read).toHaveBeenCalledTimes(1);
  });
});

describe('OpenCodeIdleSettler with the real bridge (#1615 episode rules)', () => {
  let bridge: DaemonPTYBridge;
  let feed: (data: string) => void = () => undefined;
  beforeEach(() => {
    vi.useFakeTimers();
    bridge = new DaemonPTYBridge();
    const pty = {
      onData: (cb: (data: string) => void) => { feed = cb; return { dispose: () => undefined }; },
      onExit: () => ({ dispose: () => undefined }),
    } as unknown as IPty;
    bridge.setupDataForwarding(pty, new RingBuffer(65536), 'sess-1', new PromptEventLog());
  });
  afterEach(() => { bridge.cleanup(); vi.useRealTimers(); });

  it('a plugin-confirmed end closes the episode for good: the next submit gets a new turn id', async () => {
    bridge.noteInput('hello\r');
    const first = bridge.getTurn(bridge.getAgentStatus());
    vi.advanceTimersByTime(100);
    feed('x'.repeat(3000)); // the reply
    vi.advanceTimersByTime(30_000); // byte silence: the idle edge
    expect(bridge.getAgentStatus()).toBe('idle');
    const settler = new OpenCodeIdleSettler({
      bridge: () => bridge, agentSlug: () => 'opencode', sendCount: () => 0, emit: vi.fn(),
      read: async () => pluginRead('complete', { startedAt: Date.now() }),
    });
    expect(await settler.onIdle('sess-1')).toBe('complete');
    expect(bridge.getAgentStatus()).toBe('complete');
    expect(bridge.isTurnOpen()).toBe(false);
    // An autonomous byte-promoted burst must not resume the settled episode
    // (a detector soft close would have let it keep the old id).
    vi.advanceTimersByTime(6_000);
    feed('y'.repeat(3000));
    expect(bridge.isTurnOpen()).toBe(true);
    expect(bridge.getTurn('running').id).not.toBe(first.id);
    vi.advanceTimersByTime(30_000);
    bridge.noteInput('again\r');
    expect(bridge.getTurn(bridge.getAgentStatus()).id).not.toBe(first.id);
  });

  it('a plugin send marks a submit, so an older plugin turn cannot settle the new episode', async () => {
    bridge.noteInput('hello\r');
    vi.advanceTimersByTime(500);
    const oldStart = Date.now();
    vi.advanceTimersByTime(500);
    bridge.noteInput('', true); // TerminalChatService onSent
    vi.advanceTimersByTime(100);
    feed('x'.repeat(3000));
    vi.advanceTimersByTime(30_000);
    const emit = vi.fn();
    const settler = new OpenCodeIdleSettler({
      bridge: () => bridge, agentSlug: () => 'opencode', sendCount: () => 0, emit,
      read: async () => pluginRead('complete', { startedAt: oldStart }),
    });
    expect(await settler.onIdle('sess-1')).toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });
});
