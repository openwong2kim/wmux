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
vi.mock('../../../deck/deckBriefingStore', () => ({
  loadDeckBriefingConfig: vi.fn(() => briefingConfig),
  saveDeckBriefingConfig: vi.fn(async (patch: Partial<typeof briefingConfig>) => {
    briefingConfig = { ...briefingConfig, ...patch };
    return briefingConfig;
  }),
  loadBriefedSnapshot: vi.fn((ws: string) => briefedSnapshots.get(ws) ?? null),
  saveBriefedSnapshot: vi.fn(async (ws: string, snap: unknown) => {
    briefedSnapshots.set(ws, snap);
  }),
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
    expect(r.briefing!.panes.map((p) => p.ptyId)).toEqual(['p-block', 'p-run']);
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

  it('persists the last-viewed snapshot after building (delta seed)', async () => {
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'running' }]);
    decisions.set('ws-1', { id: 'dec-1', question: 'q', options: [], context: '', status: 'pending', raisedAt: 1 });
    // First view: null prior ⇒ no delta.
    const first = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(first.briefing.changed).toBeNull();
    // The snapshot was persisted; flip a pane to complete and re-view — the delta
    // is now computed against what we last saw.
    await Promise.resolve(); // let the fire-and-forget save settle
    seedMirror('ws-1', [{ ptyId: 'p1', agentStatus: 'complete' }]);
    const second = (await invoke(IPC.DECK_BRIEFING_GET, { workspaceId: 'ws-1' })) as unknown as {
      briefing: WorkspaceBriefing;
    };
    expect(second.briefing.changed?.finished).toEqual(['p1']);
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
