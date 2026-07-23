// Integration tests for the `agent.lifecycle` event tee emitted from
// `hooks.signal`. Mocks `_bridge.sendToRenderer` (for workspace.list) and
// `sendNotification` (so we don't need a real BrowserWindow). The
// HookSignalRouter is a hand-rolled stub so we can control `recordHook`
// return values per test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { RpcRouter } from '../../RpcRouter';
import { eventBus } from '../../../events/EventBus';
import type { HookSignalRouter } from '../../../hooks/HookSignalRouter';
import type { AgentSignal } from '../../../../../integrations/shared/signal-types';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { sendToRendererMock, sendNotificationMock, broadcastMetadataUpdateMock } = vi.hoisted(() => ({
  sendToRendererMock: vi.fn(),
  sendNotificationMock: vi.fn(),
  broadcastMetadataUpdateMock: vi.fn(),
}));

vi.mock('../_bridge', () => ({
  sendToRenderer: sendToRendererMock,
}));

vi.mock('../../../notification/sendNotification', () => ({
  sendNotification: sendNotificationMock,
}));

vi.mock('../../../ipc/handlers/metadata.handler', () => ({
  broadcastMetadataUpdate: broadcastMetadataUpdateMock,
}));

// hooks.signal calls dispatchNotification (real implementation) for its
// hook-sourced notifications; without this, the renderer-readiness gate
// defaults to false and every call falls to the unmocked ToastManager
// fallback (which needs a real Electron process — not mockable here, and
// not what this file is testing; see dispatchNotification.test.ts for gate
// coverage).
vi.mock('../../../notification/rendererNotificationReadiness', () => ({
  isRendererNotificationListenerReady: () => true,
}));

// Static import — vi.mock declarations are hoisted, so the module-under-test
// still picks up the mocked _bridge and sendNotification at evaluation time.
import { registerHooksRpc } from '../hooks.rpc';

function fakeWindow(): BrowserWindow {
  // Minimal stub — the handler only calls webContents.send for token usage
  // (not exercised in these tests) and isDestroyed checks.
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() },
  } as unknown as BrowserWindow;
}

interface StubRouter {
  router: HookSignalRouter;
  setDecision: (d: 'emit' | 'dedup') => void;
  recordHookCalls: { signal: AgentSignal; ptyId: string }[];
}

function stubHookRouter(): StubRouter {
  let decision: 'emit' | 'dedup' = 'emit';
  const recordHookCalls: { signal: AgentSignal; ptyId: string }[] = [];
  const router = {
    recordHook: (signal: AgentSignal, ptyId: string) => {
      recordHookCalls.push({ signal, ptyId });
      return decision;
    },
    recordDetector: vi.fn(),
    touchAuthority: vi.fn(),
    isGovernedFor: vi.fn().mockReturnValue(false),
    getLatencyMeter: () => ({
      recordSignal: vi.fn(),
      recordWorkspaceMatch: vi.fn(),
      onStatsChange: () => vi.fn(),
      getStats: () => ({}),
    }),
  } as unknown as HookSignalRouter;
  return {
    router,
    setDecision: (d) => { decision = d; },
    recordHookCalls,
  };
}

function signal(overrides: Partial<AgentSignal>): AgentSignal {
  return {
    kind: 'agent.stop',
    agent: 'claude',
    cwd: '/repo',
    payload: {},
    ts: 1_700_000_000_000,
    ...overrides,
  };
}

function workspaces() {
  return [{
    id: 'ws-1',
    name: 'one',
    metadata: { cwd: '/repo' },
    activePtyId: 'pty-1',
    ptyIds: ['pty-1'],
  }];
}

interface PollResult {
  events: { type: string; ptyId?: string; source?: string; kind?: string; decision?: string; agent?: string; workspaceId?: string }[];
}

function pollLifecycle(): PollResult['events'] {
  const { events } = eventBus.poll(0, { types: ['agent.lifecycle'] });
  return events as PollResult['events'];
}

describe('hooks.signal — agent.lifecycle event tee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    eventBus.reset();
    sendToRendererMock.mockResolvedValue(workspaces());
  });

  it('emits agent.lifecycle on agent.stop hook with decision=emit', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '1',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'agent.lifecycle',
      ptyId: 'pty-1',
      workspaceId: 'ws-1',
      kind: 'agent.stop',
      source: 'hook',
      agent: 'claude',
      decision: 'emit',
    });
    // Regression: sendNotification still fires when decision=emit.
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it('emits and lights the sidebar dot for agent.awaiting_input', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '8',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.awaiting_input' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.awaiting_input');
    // Sound/toast fires…
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // …and the sidebar dot is set to awaiting_input for the resolved pty.
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'awaiting_input' }),
    );
  });

  it('agent.stop marks the pane complete (hook-authoritative turn end for a TUI agent)', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    // OpenCode is a long-lived foreground TUI: the byte-silence heuristic never
    // flips it to idle, so before this the pane reported 'running' forever
    // between turns. The Stop hook now broadcasts an attention 'complete'.
    const res = await router.dispatch({
      id: 'oc1',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop', agent: 'opencode' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'complete', activity: '' }),
    );
  });

  it('agent.session_start clears activity but does NOT mark the pane complete (a turn beginning is not an end)', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: 'ss1',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.session_start', agent: 'opencode' }) as unknown as Record<string, unknown>,
    });

    expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    const call = broadcastMetadataUpdateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(call).toMatchObject({ ptyId: 'pty-1', activity: '' });
    expect(call).not.toHaveProperty('agentStatus');
  });

  it('emits agent.lifecycle on dedup decision but skips sendNotification', async () => {
    const stub = stubHookRouter();
    stub.setDecision('dedup');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '2',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].decision).toBe('dedup');
    // Regression: dedup must NOT fire a duplicate toast.
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('emits agent.lifecycle for agent.subagent_stop kind', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '3',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.subagent_stop' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.subagent_stop');
  });

  it('does NOT emit for agent.activity (kept off the ring to avoid overflow)', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '4',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.activity' }) as unknown as Record<string, unknown>,
    });

    expect(pollLifecycle()).toHaveLength(0);
    // recordHook is dedup-gated to emit-kinds only — should NOT be called
    // for activity.
    expect(stub.recordHookCalls).toHaveLength(0);
  });

  it('does NOT emit for agent.session_start', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '5',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.session_start' }) as unknown as Record<string, unknown>,
    });

    expect(pollLifecycle()).toHaveLength(0);
  });

  it('does NOT emit when workspace match fails (signal from outside any wmux dir)', async () => {
    const stub = stubHookRouter();
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'ws-other', name: 'other', metadata: { cwd: '/not-repo' }, activePtyId: 'p-x', ptyIds: ['p-x'] },
    ]);
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: '6',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop', cwd: '/repo' }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    expect(pollLifecycle()).toHaveLength(0);
  });

  it('carries the agent slug through unchanged', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: '7',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.stop', agent: 'codex' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].agent).toBe('codex');
  });

  // ─── Fleet View activity line (fleet-activity-line-hook.md) ────────────────
  // agent.activity (PostToolUse) is surfaced via broadcastMetadataUpdate but is
  // purely additive: NO EventBus tee, NO recordHook, NO sendNotification.

  it('agent.activity with a ptyId broadcasts { ptyId, activity }', async () => {
    const stub = stubHookRouter();
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: 'a1',
      method: 'hooks.signal',
      params: signal({
        kind: 'agent.activity',
        payload: { tool_name: 'Edit', tool_input: { file_path: '/repo/fleet.ts' } },
      }) as unknown as Record<string, unknown>,
    });

    expect(res.ok).toBe(true);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      { ptyId: 'pty-1', activity: '✎ fleet.ts' },
    );
    // Additive only: activity must NOT tee to the EventBus, call recordHook,
    // or fire a notification.
    expect(pollLifecycle()).toHaveLength(0);
    expect(stub.recordHookCalls).toHaveLength(0);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it('agent.activity with NO resolvable ptyId does NOT broadcast', async () => {
    const stub = stubHookRouter();
    // workspace.list has no workspace owning '/elsewhere' → ptyId unresolved.
    sendToRendererMock.mockResolvedValueOnce([
      { id: 'ws-x', name: 'x', metadata: { cwd: '/somewhere-else' }, activePtyId: 'p-x', ptyIds: ['p-x'] },
    ]);
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    const res = await router.dispatch({
      id: 'a2',
      method: 'hooks.signal',
      params: signal({
        kind: 'agent.activity',
        cwd: '/elsewhere',
        payload: { tool_name: 'Bash', tool_input: { command: 'ls' } },
      }) as unknown as Record<string, unknown>,
    });

    // Unresolvable ptyId → the handler returns no-workspace-match BEFORE the
    // activity branch (dispatch still reports RPC-level ok:true, as the existing
    // workspace-match-fail test asserts), so nothing is broadcast.
    expect(res.ok).toBe(true);
    expect(broadcastMetadataUpdateMock).not.toHaveBeenCalled();
  });

  describe('agent.activity leading-edge throttle (ACTIVITY_THROTTLE_MS = 3s)', () => {
    // Base the clock well past 0 so the FIRST activity always clears the leading
    // edge (lastSent defaults to 0; in production Date.now() is ~1.7e12 so the
    // first call always fires — mirror that here instead of starting at epoch).
    const T0 = 1_000_000_000;
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(T0);
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    async function fireActivity(router: RpcRouter, id: string): Promise<void> {
      await router.dispatch({
        id,
        method: 'hooks.signal',
        params: signal({
          kind: 'agent.activity',
          payload: { tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } },
        }) as unknown as Record<string, unknown>,
      });
    }

    it('two activities <3s apart for the same ptyId → ONE broadcast', async () => {
      const stub = stubHookRouter();
      const router = new RpcRouter();
      registerHooksRpc(router, () => fakeWindow(), stub.router);

      vi.setSystemTime(T0);
      await fireActivity(router, 't1');
      vi.setSystemTime(T0 + 1_500); // 1.5s later — inside the 3s window
      await fireActivity(router, 't2');

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    });

    it('two activities >3s apart for the same ptyId → TWO broadcasts', async () => {
      const stub = stubHookRouter();
      const router = new RpcRouter();
      registerHooksRpc(router, () => fakeWindow(), stub.router);

      vi.setSystemTime(T0);
      await fireActivity(router, 't1');
      vi.setSystemTime(T0 + 3_500); // 3.5s later — past the 3s window
      await fireActivity(router, 't2');

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(2);
    });

    it('throttle is PER-ptyId — two different panes each broadcast immediately', async () => {
      const stub = stubHookRouter();
      // Two workspaces / two panes, each owning its own cwd.
      sendToRendererMock.mockResolvedValue([
        { id: 'ws-1', name: 'one', metadata: { cwd: '/repo-a' }, activePtyId: 'pty-a', ptyIds: ['pty-a'] },
        { id: 'ws-2', name: 'two', metadata: { cwd: '/repo-b' }, activePtyId: 'pty-b', ptyIds: ['pty-b'] },
      ]);
      const router = new RpcRouter();
      registerHooksRpc(router, () => fakeWindow(), stub.router);

      vi.setSystemTime(T0);
      await router.dispatch({
        id: 'p-a',
        method: 'hooks.signal',
        params: signal({ kind: 'agent.activity', cwd: '/repo-a', payload: { tool_name: 'Read', tool_input: { file_path: '/repo-a/x.ts' } } }) as unknown as Record<string, unknown>,
      });
      // Same instant, different pane — the other pane's lastSent is still 0.
      await router.dispatch({
        id: 'p-b',
        method: 'hooks.signal',
        params: signal({ kind: 'agent.activity', cwd: '/repo-b', payload: { tool_name: 'Read', tool_input: { file_path: '/repo-b/y.ts' } } }) as unknown as Record<string, unknown>,
      });

      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(2);
      expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(expect.anything(), { ptyId: 'pty-a', activity: '→ x.ts' });
      expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(expect.anything(), { ptyId: 'pty-b', activity: '→ y.ts' });
    });
  });

  // ─── [REGRESSION] activity branch must not alter the emit-kind path ────────

  it('[regression] agent.stop still emits + tees + notifies (the agent.activity summarization funnel is inert for stop)', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: 'r1',
      method: 'hooks.signal',
      // Even with a tool payload present, a stop signal must behave exactly as
      // before — no *summarized-activity* broadcast, full emit path.
      params: signal({ kind: 'agent.stop', payload: { tool_name: 'Edit', tool_input: { file_path: '/x.ts' } } }) as unknown as Record<string, unknown>,
    });

    // Lifecycle tee + recordHook + notification all fire as before.
    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'agent.stop', decision: 'emit' });
    expect(stub.recordHookCalls).toHaveLength(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // The tool_name/tool_input payload is NOT summarized into an activity
    // string for a stop kind (that's the agent.activity-only funnel) — but
    // codex review added a SEPARATE, deliberate broadcast clearing any
    // stale activity left over from this turn's tool calls (PostToolUse
    // never had its own "turn ended" signal before). Exactly one call,
    // clearing (not summarizing).
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activity: '' }),
    );
  });

  it('[regression] agent.session_start also clears any stale activity from a previous session on this ptyId', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: 'r2',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.session_start' }) as unknown as Record<string, unknown>,
    });

    expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ activity: '' }),
    );
    // session_start is not an emit-kind — no notification, no lifecycle tee.
    expect(sendNotificationMock).not.toHaveBeenCalled();
    expect(pollLifecycle()).toHaveLength(0);
  });

  // A stop used to reach observers as bare "pane stopped", so "finished" and
  // "blocked on a question" were indistinguishable without scraping the
  // terminal — where a printed question looks exactly like pending input.
  it('a stop whose transcript ends in a question publishes it as pendingQuestion + tees it on the event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hooks-'));
    const transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '머지할까?' }] } })}\n`,
    );
    try {
      const stub = stubHookRouter();
      stub.setDecision('emit');
      const router = new RpcRouter();
      registerHooksRpc(router, () => fakeWindow(), stub.router);

      await router.dispatch({
        id: 'rq',
        method: 'hooks.signal',
        params: signal({ payload: { transcript_path: transcript } }) as unknown as Record<string, unknown>,
      });

      // Both fields ride ONE broadcast — a stop is a single state transition.
      expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
      expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ activity: '', pendingQuestion: '머지할까?' }),
      );
      expect(pollLifecycle()[0]).toMatchObject({
        lastMessage: { text: '머지할까?', endsWithQuestion: true },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stop that asks nothing CLEARS a question left by an earlier turn', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-hooks-'));
    const transcript = path.join(dir, 't.jsonl');
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Merged as 08be43f.' }] } })}\n`,
    );
    try {
      const stub = stubHookRouter();
      stub.setDecision('emit');
      const router = new RpcRouter();
      registerHooksRpc(router, () => fakeWindow(), stub.router);

      await router.dispatch({
        id: 'rq2',
        method: 'hooks.signal',
        params: signal({ payload: { transcript_path: transcript } }) as unknown as Record<string, unknown>,
      });

      // Empty string is the clear signal; without it a pane that once asked
      // something would read as blocked forever.
      expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ pendingQuestion: '' }),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unreadable transcript degrades to the old contentless stop', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: 'rq3',
      method: 'hooks.signal',
      params: signal({ payload: { transcript_path: '/nope/missing.jsonl' } }) as unknown as Record<string, unknown>,
    });

    expect(pollLifecycle()[0]).not.toHaveProperty('lastMessage');
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ pendingQuestion: '' }),
    );
  });

  it('[regression] agent.subagent_stop does NOT clear activity (a Task-tool subagent finishing is mid-parent-turn, not turn-end)', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: 'r3',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.subagent_stop' }) as unknown as Record<string, unknown>,
    });

    expect(broadcastMetadataUpdateMock).not.toHaveBeenCalled();
  });

  it('[regression] agent.awaiting_input still emits + sets the sidebar dot (no activity funnel)', async () => {
    const stub = stubHookRouter();
    stub.setDecision('emit');
    const router = new RpcRouter();
    registerHooksRpc(router, () => fakeWindow(), stub.router);

    await router.dispatch({
      id: 'r2',
      method: 'hooks.signal',
      params: signal({ kind: 'agent.awaiting_input' }) as unknown as Record<string, unknown>,
    });

    const events = pollLifecycle();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('agent.awaiting_input');
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    // awaiting_input sets agentStatus via the SAME funnel, but NOT an activity.
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledTimes(1);
    expect(broadcastMetadataUpdateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ptyId: 'pty-1', agentStatus: 'awaiting_input' }),
    );
    // The awaiting_input broadcast must not carry an activity field.
    const call = broadcastMetadataUpdateMock.mock.calls[0][1] as Record<string, unknown>;
    expect(call).not.toHaveProperty('activity');
  });
});
