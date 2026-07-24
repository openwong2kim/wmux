// Unit tests for the D1 briefing handlers (deck.handler DECK_BRIEFING_*):
//   - GET builds a briefing from the mirror/decision/mode/loop feeds
//   - markColdStart returns true the FIRST time a workspace is briefed, then false
//   - disabled config ⇒ { briefing: null }
//   - the last-viewed snapshot is persisted after each build (delta seed)
//   - config get/set round-trip
//   - THE LOAD-BEARING GUARANTEE: a briefing is a pure READ — it never spawns a
//     brain (no adapter created) nor touches the global turn gate.
// Stores are mocked in-memory: the handler's CONTRACT with them is under test.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      captured.set(channel, fn);
    }),
    removeHandler: vi.fn((channel: string) => captured.delete(channel)),
  },
  app: { once: vi.fn(), removeListener: vi.fn() },
}));

vi.mock('../../../deck/commanderSessionStore', () => ({
  loadCommanderSession: vi.fn(() => null),
  saveCommanderSession: vi.fn(async () => undefined),
}));

// In-memory briefing store — config + snapshots, assertable.
let briefingConfig = { enabled: true, autoShow: true };
const briefedSnapshots = new Map<string, unknown>();
const saveOpts: { workspaceId: string; liveWorkspaceIds?: readonly string[] }[] = [];
vi.mock('../../../deck/deckBriefingStore', () => ({
  loadDeckBriefingConfig: vi.fn(() => briefingConfig),
  readDeckBriefingConfig: vi.fn(async () => briefingConfig),
  saveDeckBriefingConfig: vi.fn(async (patch: Partial<typeof briefingConfig>) => {
    briefingConfig = { ...briefingConfig, ...patch };
    return briefingConfig;
  }),
  loadBriefedSnapshot: vi.fn((ws: string) => briefedSnapshots.get(ws) ?? null),
  readBriefedSnapshot: vi.fn(async (ws: string) => briefedSnapshots.get(ws) ?? null),
  saveBriefedSnapshot: vi.fn(
    async (
      ws: string,
      snap: unknown,
      _dir?: string,
      opts?: { liveWorkspaceIds?: readonly string[] },
    ) => {
      briefedSnapshots.set(ws, snap);
      saveOpts.push({ workspaceId: ws, ...(opts ?? {}) });
      return true;
    },
  ),
}));

// Loop / autonomy / schedule / policy / decision — same lean fakes as the loop
// suite (the handler's stores; their file behavior is covered by their suites).
const loops = new Map<string, unknown>();
vi.mock('../../../deck/deckLoopStateStore', () => ({
  LOOP_STATE_LIMITS: { MIN_ITERATIONS: 1, MAX_ITERATIONS: 100, DEFAULT_ITERATIONS: 25 },
  loadWorkspaceLoopState: vi.fn((ws: string) => loops.get(ws) ?? null),
  renderLoopStateBlock: vi.fn(() => '[loop]'),
  startLoop: vi.fn(async () => null),
  clearLoop: vi.fn(async () => undefined),
  setLoopStatus: vi.fn(async () => null),
  setLoopScheduleId: vi.fn(async () => null),
  setTaskPasses: vi.fn(async () => null),
}));

let mockMode: 'off' | 'assist' | 'auto' = 'assist';
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: mockMode, ...actual.modeToCaps(mockMode) })),
    loadWorkspaceMode: vi.fn(() => mockMode),
    setWorkspaceAutonomy: vi.fn(async () => ({})),
    setWorkspaceMode: vi.fn(async (_ws: string, mode: string) => ({ mode })),
  };
});

vi.mock('../../../deck/deckScheduleStore', () => ({
  loadDeckSchedules: vi.fn(() => []),
  saveDeckSchedules: vi.fn(async () => undefined),
  createSchedule: vi.fn(() => null),
  dueSchedules: vi.fn(() => []),
  advanceAfterRun: vi.fn((s: unknown) => s),
  DECK_SCHEDULE_LIMITS: { MAX_SCHEDULES: 50, MAX_PROMPT_CHARS: 4000 },
}));

vi.mock('../../../deck/deckPolicy', () => ({
  loadDeckPolicyBlock: vi.fn(() => null),
  ensureDeckPolicySeed: vi.fn(() => undefined),
  getDeckPolicyPath: vi.fn(() => '/fake/deck-policy.md'),
}));

interface FakeDecision {
  id: string;
  question: string;
  options: string[];
  context: string;
  status: 'pending' | 'resolved';
  resolution?: string;
  raisedAt: number;
}
const decisions = new Map<string, FakeDecision>();
vi.mock('../../../deck/deckDecisionStore', () => ({
  loadWorkspaceDecision: vi.fn((ws: string) => decisions.get(ws) ?? null),
  loadDeckDecisions: vi.fn(() => Object.fromEntries(decisions.entries())),
  hasPendingDecision: vi.fn((ws: string) => decisions.get(ws)?.status === 'pending'),
  resolveDecision: vi.fn(async () => null),
  clearResolvedDecision: vi.fn(async () => undefined),
  clearDecision: vi.fn(async () => undefined),
  renderDecisionBlock: vi.fn(() => '[decision]'),
}));

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import type { WorkspaceMirrorPushPayload } from '../../../workspace/WorkspaceMirror';
import { createGlobalTurnGate } from '../../../deck/globalTurnGate';
import type { WorkspaceBriefing } from '../../../deck/deckBriefing';
import type { AgentStatus } from '../../../../shared/types';

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as import('electron').BrowserWindow;

const invoke = (channel: string, payload: Record<string, unknown> = {}) =>
  captured.get(channel)!({}, payload) as Promise<Record<string, unknown>>;

let cleanup: (() => void) | null = null;
let adapterCreated = 0;
let turnGate: ReturnType<typeof createGlobalTurnGate>;
let tryAcquireSpy: ReturnType<typeof vi.spyOn>;
let acquireWhenAvailableSpy: ReturnType<typeof vi.spyOn>;

function seedMirror(
  workspaceId: string,
  panes: { ptyId: string; agentStatus: AgentStatus; agentName?: string }[],
  entryName = 'Proj',
): void {
  const payload: WorkspaceMirrorPushPayload = {
    ts: 1,
    entries: [{ id: workspaceId, name: entryName }],
    fleets: [
      {
        workspaceId,
        ts: 1,
        panes: panes.map((p) => ({
          ptyId: p.ptyId,
          agentName: p.agentName ?? null,
          agentStatus: p.agentStatus,
          isActivePane: false,
        })),
      },
    ],
  };
  getWorkspaceMirror().setSnapshot(payload);
}

beforeEach(() => {
  captured.clear();
  __resetWorkspaceMirrorForTest();
  loops.clear();
  decisions.clear();
  briefedSnapshots.clear();
  saveOpts.length = 0;
  briefingConfig = { enabled: true, autoShow: true };
  mockMode = 'assist';
  adapterCreated = 0;
  turnGate = createGlobalTurnGate(2);
  tryAcquireSpy = vi.spyOn(turnGate, 'tryAcquire');
  acquireWhenAvailableSpy = vi.spyOn(turnGate, 'acquireWhenAvailable');
  cleanup?.();
  cleanup = registerDeckHandler(() => fakeWindow, {
    turnGate,
    createAdapter: () => {
      adapterCreated += 1;
      throw new Error('a briefing must never create a brain adapter');
    },
  });
});

describe('DECK_BRIEFING_GET', () => {
  it('builds a briefing from the mirror + decision + mode feeds, ordered by priority', async () => {
    seedMirror('ws-1', [
      { ptyId: 'p-run', agentStatus: 'running' },
      { ptyId: 'p-block', agentStatus: 'awaiting_input', agentName: 'claude' },
    ]);
    const r = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing | null;
      autoShow?: boolean;
    };
    expect(r.briefing).not.toBeNull();
    expect(r.briefing!.workspaceName).toBe('Proj');
    // The payload carries the ladder's conclusion + the counts, not a roster.
    expect(r.briefing!.topPane?.ptyId).toBe('p-block');
    expect(r.briefing!.counts).toEqual({
      total: 2,
      blocked: 1,
      errored: 0,
      running: 1,
      done: 0,
      idle: 0,
    });
    expect(r.briefing).not.toHaveProperty('panes');
    expect(r.autoShow).toBe(true);
  });

  it('markColdStart: true the first time a workspace is briefed, false thereafter', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const first = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(first.briefing.coldStart).toBe(true);
    const second = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(second.briefing.coldStart).toBe(false);
  });

  it('disabled config ⇒ { briefing: null }', async () => {
    briefingConfig = { enabled: false, autoShow: true };
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const r = await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' });
    expect(r.briefing).toBeNull();
  });

  it('invalid workspace id ⇒ { briefing: null }', async () => {
    const r = await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: '' });
    expect(r.briefing).toBeNull();
  });

  it('GET IS PURE: fetching never advances the last-viewed baseline', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' });
    await Promise.resolve();
    expect(briefedSnapshots.size).toBe(0);
    // The delta a collapsed card fetched must still be there on the next GET —
    // the bug was a "2 finished, 1 now blocked" consumed unread.
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'complete' }]);
    const second = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(second.briefing.changed).toBeNull(); // still no baseline stored
  });

  it('returns mirrorReady:false and consumes NOTHING before the mirror is populated', async () => {
    // No seedMirror: the renderer's push waits for the pane gate, so a deck
    // opened during startup can beat it.
    const early = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing | null;
      mirrorReady?: boolean;
    };
    expect(early.briefing).toBeNull();
    expect(early.mirrorReady).toBe(false);
    await Promise.resolve();
    expect(briefedSnapshots.size).toBe(0); // no empty baseline persisted
    // The one-shot cold-start flag was NOT burned — the real first briefing,
    // once the mirror arrives, still reads as a cold start.
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const real = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
      mirrorReady?: boolean;
    };
    expect(real.mirrorReady).toBe(true);
    expect(real.briefing.coldStart).toBe(true);
    expect(real.briefing.topPane?.ptyId).toBe('p1');
  });

  it('ships the currently-blocked ptyIds (the card\'s rising-edge input)', async () => {
    seedMirror('ws-1', [
      { ptyId: 'p-run', agentStatus: 'running' },
      { ptyId: 'p-b', agentStatus: 'awaiting_input' },
      { ptyId: 'p-a', agentStatus: 'waiting' },
    ]);
    const r = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    // Live state, sorted — no prior baseline exists, so a delta-derived list
    // would have been empty here.
    expect(r.briefing.changed).toBeNull();
    expect(r.briefing.blockedPtyIds).toEqual(['p-a', 'p-b']);
  });

  it('mirror rows with no PTY (empty leaves, browser/editor surfaces) are not agents', async () => {
    // A workspace holding only an unspawned leaf must brief NOTHING — it used
    // to render "The agent is idle.", the dead-chrome case.
    seedMirror('ws-1', [{ ptyId: '', agentStatus: 'idle' }]);
    const empty = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(empty.briefing.counts.total).toBe(0);
    expect(empty.briefing.topPane).toBeNull();

    seedMirror('ws-2', [
      { ptyId: '', agentStatus: 'idle' },
      { ptyId: 'p1', agentStatus: 'running' },
    ]);
    const mixed = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-2' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(mixed.briefing.counts).toEqual({
      total: 1,
      blocked: 0,
      errored: 0,
      running: 1,
      done: 0,
      idle: 0,
    });
  });

  it('THE READ GUARANTEE: no brain adapter is created and the turn gate is never touched', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' });
    await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' });
    expect(adapterCreated).toBe(0);
    expect(tryAcquireSpy).not.toHaveBeenCalled();
    expect(acquireWhenAvailableSpy).not.toHaveBeenCalled();
    expect(turnGate.inFlight).toBe(0);
  });
});

describe('DECK_BRIEFING_SEEN (acknowledge)', () => {
  const getBriefing = async (workspaceId: string): Promise<WorkspaceBriefing> =>
    (
      (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId })) as unknown as {
        briefing: WorkspaceBriefing;
      }
    ).briefing;

  it('acknowledging a build persists THAT build as the new baseline', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const first = await getBriefing('ws-1');
    expect(first.changed).toBeNull();
    expect(await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: first.builtAt })).toEqual({ ok: true });
    await Promise.resolve(); // fire-and-forget persist
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'complete' }]);
    const second = await getBriefing('ws-1');
    expect(second.changed?.finished).toEqual(['p1']);
  });

  it('a stale builtAt is a no-op (only the build the operator saw may commit)', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    // Pin the clock so the two builds are guaranteed distinct: the assertion is
    // "the EXACT previous build is rejected", which a third arbitrary number
    // would satisfy without proving anything.
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const first = await getBriefing('ws-1');
    // A newer build supersedes it; acknowledging the OLD one must not commit the
    // newer snapshot, which the operator never saw.
    nowSpy.mockReturnValue(2_000);
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'awaiting_input' }]);
    const second = await getBriefing('ws-1');
    nowSpy.mockRestore();
    expect(second.builtAt).not.toBe(first.builtAt);
    expect(await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: first.builtAt })).toEqual({ ok: false });
    await Promise.resolve();
    expect(briefedSnapshots.size).toBe(0);
  });

  it('a no-delta acknowledge still advances the baseline (blocked → running → blocked)', async () => {
    // The round-1 renderer skipped the ack when there was no delta, so a pane
    // that RECOVERED never re-baselined and the next genuine block diffed
    // against a stale "already blocked" record — reported as old news.
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'awaiting_input' }]);
    const blocked1 = await getBriefing('ws-1');
    await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: blocked1.builtAt });
    await Promise.resolve();

    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const recovered = await getBriefing('ws-1');
    expect(recovered.changed?.newlyBlocked).toEqual([]); // nothing to "consume"
    expect(
      await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: recovered.builtAt }),
    ).toEqual({ ok: true });
    await Promise.resolve();

    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'awaiting_input' }]);
    const blocked2 = await getBriefing('ws-1');
    expect(blocked2.changed?.newlyBlocked).toEqual(['p1']);
  });

  it('a repeated acknowledge of the same build does not write again', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const b = await getBriefing('ws-1');
    await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: b.builtAt });
    await Promise.resolve();
    expect(saveOpts.length).toBe(1);
    expect(await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: b.builtAt })).toEqual({ ok: false });
    await Promise.resolve();
    expect(saveOpts.length).toBe(1);
  });

  it('acknowledging without a preceding GET is a no-op', async () => {
    expect(await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: 123 })).toEqual({ ok: false });
    expect(await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: '' })).toEqual({ ok: false });
    await Promise.resolve();
    expect(briefedSnapshots.size).toBe(0);
  });

  it('passes the live workspace list so dead workspaces get pruned', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    const b = await getBriefing('ws-1');
    await invoke(IPC.DECK_BRIEFING_SEEN, { workspaceId: 'ws-1', builtAt: b.builtAt });
    await Promise.resolve();
    expect(saveOpts[0]).toEqual({ workspaceId: 'ws-1', liveWorkspaceIds: ['ws-1'] });
  });
});

describe('DECK_BRIEFING_CONFIG_GET / _SET', () => {
  it('round-trips the config through get/set', async () => {
    expect(await invoke(IPC.DECK_BRIEFING_CONFIG_GET)).toEqual({ enabled: true, autoShow: true });
    const set = await invoke(IPC.DECK_BRIEFING_CONFIG_SET, { autoShow: false });
    expect(set).toEqual({ enabled: true, autoShow: false });
    expect(await invoke(IPC.DECK_BRIEFING_CONFIG_GET)).toEqual({ enabled: true, autoShow: false });
  });

  it('ignores non-boolean patch fields', async () => {
    const set = await invoke(IPC.DECK_BRIEFING_CONFIG_SET, { enabled: 'nope' });
    expect(set).toEqual({ enabled: true, autoShow: true });
  });
});
