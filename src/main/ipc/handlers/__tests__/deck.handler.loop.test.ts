// Unit tests for the one-click loop surface (loop engineering v1):
//   - START = ONE action writing loop-state + autonomy caps + cadence schedule
//   - STOP/PAUSE = the fail-closed OFF contract (caps → DEFAULT, schedule
//     deleted/disabled) — the "authority with no objective" residue guard
//   - the loop-state block prepends on the brain wire for human + scheduled
//     turns (event-woken turns route through the same runTurnForWorkspace)
//   - Full-auto is unreachable from this surface (tier coerces to report)
// Stores are mocked in-memory: the handler's CONTRACT with them is under test;
// the stores' file behavior is covered by their own suites.

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

// In-memory loop-state store. Mirrors the real signatures the handler uses.
interface FakeLoop {
  objective: string;
  tasks: { id: string; text: string; passes: boolean }[];
  progressLog: { ts: number; note: string }[];
  status: string;
  tier: 'report' | 'continue';
  iterations: number;
  scheduleId?: string;
  updatedAt: number;
}
const loops = new Map<string, FakeLoop>();
vi.mock('../../../deck/deckLoopStateStore', () => ({
  LOOP_STATE_LIMITS: {
    MIN_ITERATIONS: 1,
    MAX_ITERATIONS: 100,
    DEFAULT_ITERATIONS: 25,
  },
  loadWorkspaceLoopState: vi.fn((ws: string) => loops.get(ws) ?? null),
  renderLoopStateBlock: vi.fn((s: FakeLoop) => `[loop] objective: ${s.objective}`),
  startLoop: vi.fn(async (ws: string, args: { objective: string; taskTexts?: string[]; tier?: 'report' | 'continue'; scheduleId?: string; iterations?: number }) => {
    if (!args.objective.trim()) return null;
    const loop: FakeLoop = {
      objective: args.objective,
      tasks: (args.taskTexts ?? []).map((text, i) => ({ id: `t${i}`, text, passes: false })),
      progressLog: [],
      status: 'running',
      tier: args.tier === 'continue' ? 'continue' : 'report',
      iterations: typeof args.iterations === 'number' ? args.iterations : 25,
      ...(args.scheduleId ? { scheduleId: args.scheduleId } : {}),
      updatedAt: 1,
    };
    loops.set(ws, loop);
    return loop;
  }),
  clearLoop: vi.fn(async (ws: string) => {
    loops.delete(ws);
  }),
  setLoopStatus: vi.fn(async (ws: string, status: string) => {
    const l = loops.get(ws);
    if (!l) return null;
    l.status = status;
    return l;
  }),
  setLoopScheduleId: vi.fn(async () => null),
  setTaskPasses: vi.fn(async (ws: string, taskId: string, passes: boolean) => {
    const l = loops.get(ws);
    if (!l) return null;
    l.tasks = l.tasks.map((task) => (task.id === taskId ? { ...task, passes } : task));
    return l;
  }),
}));

// Autonomy store: record every cap write. Pure functions (modeToCaps /
// modeToWakePolicy / deriveMode) use the REAL implementation via importOriginal
// — only the IO reads/writes are stubbed. The workspace's resting mode is
// 'assist' (explicit, not the default — default is now off), so loop-stop restores to assist caps.
const capWrites: { ws: string; patch: Record<string, unknown> }[] = [];
// The workspace's resting MODE, mutable so tests can dial the trust ceiling
// (loop caps compose as min(modeCeiling, tier); default 'assist' — the historic
// resting mode these suites were written against). setWorkspaceMode updates it
// so a mode switch mid-loop re-derives caps the way the real store does.
let mockMode: import('../../../deck/deckAutonomyStore').AgentMode = 'assist';
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: mockMode, ...actual.modeToCaps(mockMode) })),
    loadWorkspaceMode: vi.fn(() => mockMode),
    setWorkspaceAutonomy: vi.fn(async (ws: string, patch: Record<string, unknown>) => {
      capWrites.push({ ws, patch });
      return patch;
    }),
    setWorkspaceMode: vi.fn(async (ws: string, mode: string) => {
      mockMode = mode as import('../../../deck/deckAutonomyStore').AgentMode;
      capWrites.push({ ws, patch: { mode } });
      return { mode, ...actual.modeToCaps(mode as import('../../../deck/deckAutonomyStore').AgentMode) };
    }),
  };
});

// Schedule store: in-memory array; scheduler stays inert (nothing due).
interface FakeSchedule {
  id: string;
  workspaceId?: string;
  prompt: string;
  nextRunAt: number;
  intervalMinutes?: number;
  enabled: boolean;
  createdAt: number;
}
let schedules: FakeSchedule[] = [];
let scheduleSeq = 0;
vi.mock('../../../deck/deckScheduleStore', () => ({
  loadDeckSchedules: vi.fn(() => [...schedules]),
  saveDeckSchedules: vi.fn(async (next: FakeSchedule[]) => {
    schedules = [...next];
  }),
  createSchedule: vi.fn((args: { workspaceId: string; prompt: string; nextRunAt: number; intervalMinutes?: number }) => {
    if (!args.prompt.trim() || !args.workspaceId) return null;
    const s: FakeSchedule = {
      id: `sched-${++scheduleSeq}`,
      workspaceId: args.workspaceId,
      prompt: args.prompt,
      nextRunAt: args.nextRunAt,
      ...(args.intervalMinutes ? { intervalMinutes: args.intervalMinutes } : {}),
      enabled: true,
      createdAt: 0,
    };
    return s;
  }),
  dueSchedules: vi.fn(() => []),
  advanceAfterRun: vi.fn((s: FakeSchedule) => s),
  DECK_SCHEDULE_LIMITS: { MAX_SCHEDULES: 50, MAX_PROMPT_CHARS: 4000 },
}));

// In-memory decision-gate store. Mirrors the real signatures the handler uses
// (the store's own file/atomic/serialize behavior is covered by its own suite).
interface FakeDecision {
  id: string;
  question: string;
  options: string[];
  context: string;
  status: 'pending' | 'resolved';
  resolution?: string;
  raisedAt: number;
  resolvedAt?: number;
}
const decisions = new Map<string, FakeDecision>();
vi.mock('../../../deck/deckDecisionStore', () => ({
  loadWorkspaceDecision: vi.fn((ws: string) => decisions.get(ws) ?? null),
  loadDeckDecisions: vi.fn(() => Object.fromEntries(decisions.entries())),
  hasPendingDecision: vi.fn((ws: string) => decisions.get(ws)?.status === 'pending'),
  resolveDecision: vi.fn(async (ws: string, id: string, resolution: string) => {
    const d = decisions.get(ws);
    if (!d || d.id !== id || d.status !== 'pending' || !resolution.trim()) return null;
    d.status = 'resolved';
    d.resolution = resolution.trim();
    d.resolvedAt = 2;
    return d;
  }),
  clearResolvedDecision: vi.fn(async (ws: string, expectedId?: string) => {
    const d = decisions.get(ws);
    if (d && d.status === 'resolved' && (expectedId === undefined || d.id === expectedId)) {
      decisions.delete(ws);
    }
  }),
  clearDecision: vi.fn(async (ws: string) => {
    decisions.delete(ws);
  }),
  renderDecisionBlock: vi.fn((d: FakeDecision) =>
    d.status === 'resolved'
      ? `[decision] RESOLVED — ${d.question} — decided: ${d.resolution ?? ''}`
      : `[decision] BLOCKED — ${d.question}`,
  ),
}));

import { registerDeckHandler, buildFleetTailLine } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { FleetSnapshot } from '../../../workspace/WorkspaceMirror';
import { eventBus } from '../../../events/EventBus';
import { createGlobalTurnGate } from '../../../deck/globalTurnGate';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

/** Fake adapter recording the exact text each turn was sent with. */
class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  sentTexts: string[] = [];
  constructor(public readonly workspaceId: string) {}
  start(opts: BrainStartOptions): void {
    void opts; // no-op fake
  }
  async *send(text: string): AsyncIterable<BrainEvent> {
    this.sentTexts.push(text);
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void {
    /* no-op fake */
  }
  dispose(): void {
    /* no-op fake */
  }
}

let adapters: FakeAdapter[];
let cleanup: (() => void) | null = null;

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as import('electron').BrowserWindow;

const invoke = (channel: string, payload: Record<string, unknown>) =>
  captured.get(channel)!({}, payload) as Promise<Record<string, unknown>>;

beforeEach(() => {
  captured.clear();
  loops.clear();
  decisions.clear();
  capWrites.length = 0;
  mockMode = 'assist';
  schedules = [];
  scheduleSeq = 0;
  adapters = [];
  cleanup?.();
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: (opts) => {
      const a = new FakeAdapter(opts.workspaceId);
      adapters.push(a);
      return a;
    },
  });
});

describe('buildFleetTailLine — the one-line fleet summary', () => {
  const snap = (statuses: string[]): FleetSnapshot => ({
    workspaceId: 'ws-1',
    ts: 1,
    panes: statuses.map((s, i) => ({
      ptyId: `p${i}`,
      agentName: 'claude',
      agentStatus: s as FleetSnapshot['panes'][number]['agentStatus'],
      isActivePane: false,
    })),
  });

  it('counts awaiting/stopped/errored panes with no misleading heartbeat clause', () => {
    const line = buildFleetTailLine(snap(['awaiting_input', 'complete', 'error']));
    // Accurate regardless of whether the heartbeat is enabled — just the counts.
    expect(line).toBe('(fleet: 1 awaiting, 1 stopped, 1 error)');
    expect(line).not.toContain('heartbeat');
  });

  it('returns undefined when the mirror is empty or the fleet is all quiescent', () => {
    expect(buildFleetTailLine(null)).toBeUndefined();
    expect(buildFleetTailLine(snap([]))).toBeUndefined();
    expect(buildFleetTailLine(snap(['running', 'idle']))).toBeUndefined();
  });
});

describe('deck:loop:start — the one click', () => {
  it('writes loop + Continue caps + cadence schedule in one action', async () => {
    const res = await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'keep CI green',
      taskTexts: ['tests pass'],
      tier: 'continue',
      intervalMinutes: 30,
    });
    expect(res.ok).toBe(true);
    expect(loops.get('ws-1')).toMatchObject({ objective: 'keep CI green', tier: 'continue' });
    // Caps applied per tier.
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });
    // Cadence schedule created and linked.
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ workspaceId: 'ws-1', intervalMinutes: 30, enabled: true });
    expect(loops.get('ws-1')!.scheduleId).toBe(schedules[0].id);
  });

  it('report tier keeps continueInstruction off', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'report' });
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: false, approvalPress: false },
    });
  });

  it('CRITICAL: Full-auto is unreachable — any non-continue tier coerces to report', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'full-auto' });
    expect(loops.get('ws-1')!.tier).toBe('report');
    // approvalPress is NEVER set true by this surface.
    expect(capWrites.every((w) => w.patch.approvalPress === false)).toBe(true);
  });

  it('rejects an out-of-range cadence instead of clamping silently', async () => {
    const low = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', intervalMinutes: 1 });
    expect(low).toMatchObject({ ok: false, code: 'invalid_interval' });
    expect(loops.has('ws-1')).toBe(false);
    expect(schedules).toHaveLength(0);
  });

  it('passes the iteration budget through; out-of-range is rejected', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', iterations: 40 });
    expect(loops.get('ws-1')!.iterations).toBe(40);
    const bad = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-2', objective: 'o', iterations: 9999 });
    expect(bad).toMatchObject({ ok: false, code: 'invalid_iterations' });
    expect(loops.has('ws-2')).toBe(false);
  });

  it('replacing a loop deletes the prior cadence schedule (no orphans)', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'a', intervalMinutes: 30 });
    const firstId = schedules[0].id;
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'b', intervalMinutes: 60 });
    expect(schedules).toHaveLength(1);
    expect(schedules[0].id).not.toBe(firstId);
  });
});

describe('deck:loop:start × mode ceiling — caps compose as min(modeCeiling, tier)', () => {
  it('FLAGSHIP: auto + continue loop UNLOCKS approval-press (the unattended supervisor)', async () => {
    mockMode = 'auto';
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'ship it', tier: 'continue' });
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: true },
    });
  });

  it('auto + report loop stays observe-only — the tier narrows the ceiling back down', async () => {
    mockMode = 'auto';
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'watch', tier: 'report' });
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: false, approvalPress: false },
    });
  });

  it('assist + continue loop drives but NEVER presses (assist ceiling has no press)', async () => {
    mockMode = 'assist';
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'continue' });
    expect(capWrites).toContainEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });
  });
});

describe('deck:mode:set × a running loop — the ceiling moves, the mission stays capped', () => {
  it('raising assist→auto mid-continue-loop re-overlays the tier and grants press', async () => {
    mockMode = 'assist';
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'continue' });
    capWrites.length = 0;
    const res = await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-1', mode: 'auto' });
    expect(res.ok).toBe(true);
    // Last write is the tier re-overlay under the new auto ceiling: press ON.
    expect(capWrites.at(-1)).toEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: true },
    });
  });

  it('raising assist→auto mid-REPORT-loop does NOT grant drive/press (report stays observe-only)', async () => {
    mockMode = 'assist';
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', tier: 'report' });
    capWrites.length = 0;
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-1', mode: 'auto' });
    expect(capWrites.at(-1)).toEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: false, approvalPress: false },
    });
  });

  it('switching to off tears the loop down (kill switch) — no tier overlay survives', async () => {
    mockMode = 'assist';
    await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'o',
      tier: 'continue',
      intervalMinutes: 30,
    });
    await invoke(IPC.DECK_MODE_SET, { workspaceId: 'ws-1', mode: 'off' });
    expect(loops.has('ws-1')).toBe(false);
    expect(schedules).toHaveLength(0);
  });
});

describe('deck:decision — the gate (handler wiring)', () => {
  const seedPending = (ws: string, id = 'd1', options: string[] = ['A', 'B']) =>
    decisions.set(ws, {
      id,
      question: 'A or B?',
      options,
      context: '',
      status: 'pending',
      raisedAt: 1,
    });

  it('GET hydrates a pending decision', async () => {
    seedPending('ws-1');
    const got = await invoke(IPC.DECK_DECISION_GET, { workspaceId: 'ws-1' });
    expect(got.decision).toMatchObject({ id: 'd1', status: 'pending' });
  });

  it('RESOLVE resumes the loop with the resolution injected, then consumes it once', async () => {
    seedPending('ws-1');
    const res = await invoke(IPC.DECK_DECISION_RESOLVE, {
      workspaceId: 'ws-1',
      id: 'd1',
      resolution: 'go with A',
    });
    expect(res.ok).toBe(true);
    // A resume turn fired on ws-1's brain, carrying the resolved decision block.
    await vi.waitFor(() => {
      const a = adapters.find((x) => x.workspaceId === 'ws-1');
      expect(a?.sentTexts.some((t) => t.includes('RESOLVED') && t.includes('go with A'))).toBe(true);
    });
    // Consumed once the turn carried it (id-scoped clear).
    await vi.waitFor(() => expect(decisions.has('ws-1')).toBe(false));
  });

  it('a stale/second RESOLVE is rejected and kicks NO extra turn', async () => {
    seedPending('ws-1');
    await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-1', id: 'd1', resolution: 'ans' });
    await vi.waitFor(() => expect(decisions.has('ws-1')).toBe(false)); // first resume consumed it
    const a = adapters.find((x) => x.workspaceId === 'ws-1')!;
    const turns = a.sentTexts.length;
    const res2 = await invoke(IPC.DECK_DECISION_RESOLVE, {
      workspaceId: 'ws-1',
      id: 'd1',
      resolution: 'again',
    });
    expect(res2.ok).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(a.sentTexts.length).toBe(turns);
  });

  it('GET resumes a resolved-but-unconsumed decision (reboot-stranding guard)', async () => {
    decisions.set('ws-1', {
      id: 'd1',
      question: 'Q?',
      options: [],
      context: '',
      status: 'resolved',
      resolution: 'answered',
      raisedAt: 1,
      resolvedAt: 2,
    });
    await invoke(IPC.DECK_DECISION_GET, { workspaceId: 'ws-1' });
    await vi.waitFor(() => {
      const a = adapters.find((x) => x.workspaceId === 'ws-1');
      expect(a?.sentTexts.some((t) => t.includes('RESOLVED') && t.includes('answered'))).toBe(true);
    });
  });

  it('M2: startup reconcile resumes a resolved decision headlessly — no GET needed', async () => {
    // Simulate the app relaunching with a resolution that was persisted but never
    // consumed (resolved then closed before the resume kick), and the deck never
    // reopened. The deferred startup reconcile must resume it on its own.
    cleanup?.();
    decisions.set('ws-1', {
      id: 'd1',
      question: 'Q?',
      options: [],
      context: '',
      status: 'resolved',
      resolution: 'reconciled',
      raisedAt: 1,
      resolvedAt: 2,
    });
    cleanup = registerDeckHandler(() => fakeWindow, {
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts.workspaceId);
        adapters.push(a);
        return a;
      },
      reconcileDelayMs: 5,
    });
    // No DECK_DECISION_GET / RESOLVE invoked — the reconcile timer alone drives it.
    await vi.waitFor(() => {
      const a = adapters.find((x) => x.workspaceId === 'ws-1');
      expect(a?.sentTexts.some((t) => t.includes('RESOLVED') && t.includes('reconciled'))).toBe(true);
    });
  });

  it('M2: startup reconcile processes MORE than the gate cap of resolved decisions (queued + serial)', async () => {
    // Three resolved-but-unconsumed decisions on relaunch. The old fire-and-forget
    // loop only got `cap` (2) past the gate and silently dropped the third; the
    // queued+serial reconcile must resume ALL three.
    cleanup?.();
    for (const ws of ['ws-a', 'ws-b', 'ws-c']) {
      decisions.set(ws, {
        id: `${ws}-d`, question: 'Q?', options: [], context: '',
        status: 'resolved', resolution: `ans-${ws}`, raisedAt: 1, resolvedAt: 2,
      });
    }
    cleanup = registerDeckHandler(() => fakeWindow, {
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts.workspaceId);
        adapters.push(a);
        return a;
      },
      reconcileDelayMs: 5,
    });
    // Each workspace's brain gets its resume turn (FakeAdapter completes instantly,
    // freeing its slot for the next serial resume).
    for (const ws of ['ws-a', 'ws-b', 'ws-c']) {
      await vi.waitFor(() => {
        const a = adapters.find((x) => x.workspaceId === ws);
        expect(a?.sentTexts.some((t) => t.includes('RESOLVED') && t.includes(`ans-${ws}`))).toBe(true);
      });
    }
  });
});

describe('deck:loop:stop / pause / resume — the OFF contract', () => {
  it('CRITICAL: stop clears the loop, deletes the schedule, and resets caps to DEFAULT', async () => {
    await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'o',
      tier: 'continue',
      intervalMinutes: 30,
    });
    capWrites.length = 0;
    const res = await invoke(IPC.DECK_LOOP_STOP, { workspaceId: 'ws-1' });
    expect(res.ok).toBe(true);
    expect(loops.has('ws-1')).toBe(false);
    expect(schedules).toHaveLength(0); // pending cadence never fires post-stop
    // Loop-stop restores caps to the workspace's MODE (assist), not a hardcoded
    // fail-closed floor — the mode is the resting autonomy the user chose.
    expect(capWrites).toEqual([
      { ws: 'ws-1', patch: { summarize: true, continueInstruction: true, approvalPress: false } },
    ]);
  });

  it('pause drops caps + disables the schedule; resume restores tier + re-enables', async () => {
    await invoke(IPC.DECK_LOOP_START, {
      workspaceId: 'ws-1',
      objective: 'o',
      tier: 'continue',
      intervalMinutes: 30,
    });
    capWrites.length = 0;

    await invoke(IPC.DECK_LOOP_PAUSE, { workspaceId: 'ws-1' });
    expect(loops.get('ws-1')!.status).toBe('paused');
    expect(schedules[0].enabled).toBe(false);
    // pause restores to mode (assist) caps — the loop-state 'paused' + removed
    // override is what stops the driving, not a cap floor.
    expect(capWrites.pop()).toEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });

    await invoke(IPC.DECK_LOOP_RESUME, { workspaceId: 'ws-1' });
    expect(loops.get('ws-1')!.status).toBe('running');
    expect(schedules[0].enabled).toBe(true);
    expect(capWrites.pop()).toEqual({
      ws: 'ws-1',
      patch: { summarize: true, continueInstruction: true, approvalPress: false },
    });
  });

  it('the human ticks a done-when item via deck:loop:task (the only passes writer)', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', taskTexts: ['a', 'b'] });
    const res = await invoke(IPC.DECK_LOOP_TASK, { workspaceId: 'ws-1', taskId: 't0', passes: true });
    expect(res.ok).toBe(true);
    expect(loops.get('ws-1')!.tasks[0].passes).toBe(true);
    // Missing taskId / workspace → safe reject.
    expect((await invoke(IPC.DECK_LOOP_TASK, { workspaceId: 'ws-1' })).ok).toBe(false);
    expect((await invoke(IPC.DECK_LOOP_TASK, { taskId: 't0', passes: true })).ok).toBe(false);
  });

  it('get returns the loop AND the live wake budget (ambient default without a loop)', async () => {
    const bare = await invoke(IPC.DECK_LOOP_GET, { workspaceId: 'ws-1' });
    expect(bare.loop).toBeNull();
    // No loop → the coalescer's ambient budget (5/5, nothing consumed).
    expect(bare.wakeBudget).toEqual({ remaining: 5, total: 5 });
    // A running loop's iterations take over as the total.
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', iterations: 12 });
    const withLoop = await invoke(IPC.DECK_LOOP_GET, { workspaceId: 'ws-1' });
    expect(withLoop.wakeBudget).toEqual({ remaining: 12, total: 12 });
  });

  it('stop/pause on a loopless workspace is a safe no-op', async () => {
    expect((await invoke(IPC.DECK_LOOP_GET, { workspaceId: 'ws-1' })).loop).toBeNull();
    expect((await invoke(IPC.DECK_LOOP_PAUSE, { workspaceId: 'ws-1' })).ok).toBe(false);
    const stop = await invoke(IPC.DECK_LOOP_STOP, { workspaceId: 'ws-1' });
    expect(stop.ok).toBe(true); // idempotent
  });
});

describe('deck:send × auto-wake race — the loop-stall guard (dogfood finding 2026-07-12)', () => {
  it('a human send rejected busy does NOT consume buffered pane events; the wake still fires', async () => {
    // An adapter whose FIRST turn stays open until released — the brain is busy.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowFirstAdapter extends FakeAdapter {
      async *send(text: string): AsyncIterable<BrainEvent> {
        this.sentTexts.push(text);
        if (this.sentTexts.length === 1) await gate;
        yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
      }
    }
    captured.clear();
    cleanup?.();
    adapters = [];
    cleanup = registerDeckHandler(() => fakeWindow, {
      createAdapter: (opts) => {
        const a = new SlowFirstAdapter(opts.workspaceId);
        adapters.push(a);
        return a;
      },
    });

    // Turn 1: an accepted human send holds the brain busy.
    const first = invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'long turn' });
    await Promise.resolve(); // let it enter busy

    // A worker pane stops while the brain is busy — the coalescer buffers it.
    // awaiting_input (not a plain stop) so the default assist mode's value
    // filter wakes on it — this test exercises the busy-reject plumbing, not
    // the wake filter.
    eventBus.emit({
      type: 'agent.lifecycle',
      workspaceId: 'ws-1',
      ptyId: 'p1',
      kind: 'agent.awaiting_input',
      source: 'hook',
      agent: 'claude',
      decision: 'emit',
    });

    // Racing human send → busy reject. Pre-fix this called notifyHumanSend
    // unconditionally, subsuming the buffered stop on a turn that never ran —
    // the loop chain silently stalled.
    const rejected = await invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'racing' });
    expect(rejected).toMatchObject({ ok: false, code: 'busy' });

    // Turn 1 ends → deferred onIdle → coalescer flush → the auto-wake fires
    // with the buffered event intact.
    release();
    await first;
    await new Promise((r) => setTimeout(r, 30)); // deferIdle tick + flush
    const texts = adapters[0].sentTexts;
    expect(
      texts.some((t) => t.includes('[pane-events]') && t.includes('p1')),
    ).toBe(true);
  });
});

describe('loop-state block on the brain wire', () => {
  it('human DECK_SEND carries the loop block when a loop exists — and not otherwise', async () => {
    await invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'no loop yet' });
    expect(adapters[0].sentTexts[0]).toBe('no loop yet');

    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'keep green' });
    // START now fires a fire-and-forget kickoff turn — let it settle so the
    // manager is idle before the human send (else the send is busy-rejected).
    await new Promise((r) => setTimeout(r, 20));
    await invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'progress?' });
    const last = adapters[0].sentTexts.at(-1)!;
    expect(last.startsWith('[loop] objective: keep green')).toBe(true);
    expect(last.endsWith('progress?')).toBe(true);
  });
});

describe('deck:loop kickoff — the loop actually starts working (owner dogfood 2026-07-14)', () => {
  it('START fires an immediate orchestrator turn carrying the loop block', async () => {
    const res = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'keep CI green' });
    expect(res.ok).toBe(true);
    // The kick is fire-and-forget (START must return its verdict at once — the
    // modal awaits it), so let the streamed turn land on the fake adapter.
    await new Promise((r) => setTimeout(r, 20));
    const texts = adapters[0].sentTexts;
    expect(texts.length).toBeGreaterThanOrEqual(1);
    const kick = texts[texts.length - 1];
    // The loop-state block (mocked renderLoopStateBlock) rides in front, and the
    // prompt tells the brain to take the first iteration now.
    expect(kick).toContain('[loop] objective: keep CI green');
    expect(kick.toLowerCase()).toContain('first iteration');
  });

  it('RESUME re-engages the orchestrator too (a paused loop should not sit idle)', async () => {
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o' });
    await new Promise((r) => setTimeout(r, 20));
    const afterStart = adapters[0].sentTexts.length;
    await invoke(IPC.DECK_LOOP_PAUSE, { workspaceId: 'ws-1' });
    await invoke(IPC.DECK_LOOP_RESUME, { workspaceId: 'ws-1' });
    await new Promise((r) => setTimeout(r, 20));
    expect(adapters[0].sentTexts.length).toBeGreaterThan(afterStart);
  });

  it('a rejected START (bad interval) fires no kickoff turn', async () => {
    const res = await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'o', intervalMinutes: 1 });
    expect(res).toMatchObject({ ok: false, code: 'invalid_interval' });
    await new Promise((r) => setTimeout(r, 20));
    // No loop was created ⇒ no manager, no turn.
    expect(adapters).toHaveLength(0);
  });
});

describe('global concurrent-turn gate — the fleet-wide cap on autonomous turns', () => {
  // An adapter whose turn stays OPEN until its releaser is called, so the gate
  // slot it acquired stays held (each autonomous turn holds a slot for its whole
  // life — the loop kickoff routes through runTurnForWorkspace, the gated path).
  const releasers: (() => void)[] = [];
  class HoldingAdapter extends FakeAdapter {
    async *send(text: string): AsyncIterable<BrainEvent> {
      this.sentTexts.push(text);
      await new Promise<void>((r) => releasers.push(r));
      yield { type: 'turn-end', sessionId: 'sess' } as BrainEvent;
    }
  }
  const started = (ws: string): number =>
    adapters.find((a) => a.workspaceId === ws)?.sentTexts.length ?? 0;

  const reRegisterHolding = (
    extra: Parameters<typeof registerDeckHandler>[1] = {},
  ) => {
    captured.clear();
    cleanup?.();
    adapters = [];
    releasers.length = 0;
    cleanup = registerDeckHandler(() => fakeWindow, {
      createAdapter: (opts) => {
        const a = new HoldingAdapter(opts.workspaceId);
        adapters.push(a);
        return a;
      },
      ...extra,
    });
  };

  it('a one-shot loop kickoff AWAITS a slot and proceeds when one frees (queued acquire)', async () => {
    reRegisterHolding();
    // Two loop kickoffs take the two slots and hold them open.
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'a' });
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-2', objective: 'b' });
    await new Promise((r) => setTimeout(r, 15));
    expect(started('ws-1')).toBe(1);
    expect(started('ws-2')).toBe(1);

    // A THIRD loop kickoff hits the full gate. As a one-shot caller it QUEUES for
    // a slot rather than dropping its turn — so ws-3 has NOT sent yet.
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-3', objective: 'c' });
    await new Promise((r) => setTimeout(r, 15));
    expect(started('ws-3')).toBe(0);

    // Release turn 1 → its slot frees; the queued ws-3 kickoff acquires it and
    // finally runs (pre-fix it would have been rejected and the loop sat idle).
    releasers[0]?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(started('ws-3')).toBe(1);

    releasers.forEach((r) => r()); // let the held turns finish
    await new Promise((r) => setTimeout(r, 15));
  });

  it('a busy workspace never touches the fleet gate (P3 acquire ordering)', async () => {
    // Inject the gate so we can watch its acquire methods.
    const gate = createGlobalTurnGate(2);
    const tryAcq = vi.spyOn(gate, 'tryAcquire');
    const queuedAcq = vi.spyOn(gate, 'acquireWhenAvailable');
    reRegisterHolding({ turnGate: gate });

    // ws-1 is held BUSY by an (ungated) human send.
    const human = invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text: 'long human turn' });
    await new Promise((r) => setTimeout(r, 15));
    expect(started('ws-1')).toBe(1);
    tryAcq.mockClear();
    queuedAcq.mockClear();

    // A resume for the BUSY ws-1 must reject on the pre-acquire busy check —
    // never consuming (or queuing on) a fleet slot.
    decisions.set('ws-1', {
      id: 'd1', question: 'Q?', options: [], context: '',
      status: 'pending', raisedAt: 1,
    });
    await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-1', id: 'd1', resolution: 'go' });
    await new Promise((r) => setTimeout(r, 20));
    expect(queuedAcq).not.toHaveBeenCalled();
    expect(tryAcq).not.toHaveBeenCalled();

    // Contrast: a resume for an IDLE workspace DOES reach the gate (queued path).
    decisions.set('ws-2', {
      id: 'd2', question: 'Q?', options: [], context: '',
      status: 'pending', raisedAt: 1,
    });
    await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-2', id: 'd2', resolution: 'ok' });
    await new Promise((r) => setTimeout(r, 20));
    expect(queuedAcq).toHaveBeenCalledWith(expect.any(Number), 'ws-2');

    releasers.forEach((r) => r());
    await human;
  });

  it('the fast reject-and-requeue path rejects a 3rd concurrent turn while the gate is full', async () => {
    // The coalescer (event-woken wakes) uses the FAST tryAcquire path. Pre-fill
    // the injected gate to its cap of 2 to stand in for two in-flight turns.
    const gate = createGlobalTurnGate(2);
    reRegisterHolding({ turnGate: gate });
    const held1 = gate.tryAcquire('other-1');
    const held2 = gate.tryAcquire('other-2');
    expect(held1).toBeTruthy();
    expect(held2).toBeTruthy();

    // An awaiting_input edge for an IDLE ws-3 (assist mode wakes on it). The
    // coalescer debounces, flushes → runTurn fast path → gate full → busy reject.
    eventBus.emit({
      type: 'agent.lifecycle', workspaceId: 'ws-3', ptyId: 'p1',
      kind: 'agent.awaiting_input', source: 'hook', agent: 'claude', decision: 'emit',
    });
    await new Promise((r) => setTimeout(r, 1700)); // > coalescer debounce (1500ms)
    expect(started('ws-3')).toBe(0); // rejected on the full gate, no send

    // Free the gate and re-edge: the same wake now gets a slot and fires — proof
    // it was only the full gate blocking it.
    gate.release(held1!);
    gate.release(held2!);
    eventBus.emit({
      type: 'agent.lifecycle', workspaceId: 'ws-3', ptyId: 'p2',
      kind: 'agent.awaiting_input', source: 'hook', agent: 'claude', decision: 'emit',
    });
    await new Promise((r) => setTimeout(r, 1700));
    expect(started('ws-3')).toBe(1);

    releasers.forEach((r) => r());
    await new Promise((r) => setTimeout(r, 15));
  }, 10_000);

  it('DECK_SEND (human) is NOT gated — it proceeds even while both slots are held', async () => {
    reRegisterHolding();
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-1', objective: 'a' });
    await invoke(IPC.DECK_LOOP_START, { workspaceId: 'ws-2', objective: 'b' });
    await new Promise((r) => setTimeout(r, 15));
    expect(started('ws-1')).toBe(1);
    expect(started('ws-2')).toBe(1);

    // A human types into a THIRD workspace while the gate is full. DECK_SEND
    // bypasses the gate entirely — the turn reaches its brain. (Don't await the
    // send: the HoldingAdapter keeps it open until released below.)
    const humanSend = invoke(IPC.DECK_SEND, { workspaceId: 'ws-3', text: 'hello from the human' });
    await new Promise((r) => setTimeout(r, 15));
    const ws3 = adapters.find((a) => a.workspaceId === 'ws-3');
    expect(ws3?.sentTexts).toContain('hello from the human');

    releasers.forEach((r) => r());
    await humanSend;
  });
});
