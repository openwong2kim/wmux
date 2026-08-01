// What happens to a request record that LEAVES the store while the work it
// delegated is still running (#733 follow-up).
//
// Two ways out: a fresh human turn supersedes a PARKED record, and "New
// session" clears whatever is there. Neither may refuse, and neither may drop
// pending A2A tasks quietly — nothing will ever call deck_complete_work on a
// record that is gone, so the tasks it owned have no owner left. The handler
// puts that in front of the human as a decision.
//
// The work store here is the REAL file-backed one, pointed at a temp dir: the
// four unit tests that shipped with the original #733 bug all mocked the
// culprit and passed straight over it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  clearCommanderSession: vi.fn(async () => undefined),
}));

vi.mock('../../../deck/deckPolicy', () => ({
  loadDeckPolicyBlock: vi.fn(() => null),
  ensureDeckPolicySeed: vi.fn(() => undefined),
  getDeckPolicyPath: vi.fn(() => '/fake/deck-policy.md'),
}));

// DECK_SEND refuses outright on an `off` workspace, which would never reach the
// ownership record at all.
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: 'danger', ...actual.modeToCaps('danger') })),
    loadWorkspaceMode: vi.fn(() => 'danger'),
  };
});

// Real store, temp dir — every call the handler makes goes through the same
// files these tests read back.
const { workDirRef } = vi.hoisted(() => ({ workDirRef: { current: '' } }));
vi.mock('../../../deck/deckWorkStore', async (orig) => {
  const actual = await orig<typeof import('../../../deck/deckWorkStore')>();
  const dir = (): string => workDirRef.current;
  return {
    ...actual,
    loadActiveDeckWork: (ws: string) => actual.loadActiveDeckWork(ws, dir()),
    loadActiveDeckWorks: () => actual.loadActiveDeckWorks(dir()),
    loadLiveDeckWork: (ws: string) => actual.loadLiveDeckWork(ws, dir()),
    loadLiveDeckWorks: () => actual.loadLiveDeckWorks(dir()),
    beginOrContinueDeckWork: (ws: string, text: string) =>
      actual.beginOrContinueDeckWork(ws, text, dir()),
    clearActiveDeckWork: (ws: string) => actual.clearActiveDeckWork(ws, dir()),
    unparkDeckWork: (ws: string) => actual.unparkDeckWork(ws, dir()),
    completeActiveDeckWork: (ws: string, expected: Parameters<typeof actual.completeActiveDeckWork>[1]) =>
      actual.completeActiveDeckWork(ws, expected, dir()),
    recordDeckWorkA2aTask: (ws: string, input: Parameters<typeof actual.recordDeckWorkA2aTask>[1]) =>
      actual.recordDeckWorkA2aTask(ws, input, dir()),
  };
});

// The surface under test. Kept in memory so no test touches the real decision
// file, and so `hasPendingDecision` can be steered (the clobber guard).
interface RaisedDecision {
  workspaceId: string;
  question: string;
  options?: string[];
  context?: string;
}
const { raised, pendingRef } = vi.hoisted(() => ({
  raised: [] as RaisedDecision[],
  pendingRef: { current: false },
}));
vi.mock('../../../deck/deckDecisionStore', async (orig) => {
  const actual = await orig<typeof import('../../../deck/deckDecisionStore')>();
  return {
    ...actual,
    loadDeckDecisions: vi.fn(() => ({})),
    loadWorkspaceDecision: vi.fn(() => null),
    hasPendingDecision: vi.fn(() => pendingRef.current),
    raiseDecision: vi.fn(async (workspaceId: string, args: Omit<RaisedDecision, 'workspaceId'>) => {
      raised.push({ workspaceId, ...args });
      return null;
    }),
  };
});

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import {
  beginOrContinueDeckWork,
  clearActiveDeckWork,
  loadActiveDeckWork,
  recordDeckWorkA2aTask,
  setDeckWorkBootId,
} from '../../../deck/deckWorkStore';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  start(_opts: BrainStartOptions): void {
    /* nothing to start in the fake */
  }
  async *send(_text: string): AsyncIterable<BrainEvent> {
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void {
    /* no in-flight turn in the fake */
  }
  dispose(): void {
    /* nothing to dispose */
  }
}

const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as import('electron').BrowserWindow;

const WS = 'ws-1';
let cleanup: (() => void) | null = null;

const send = (text: string) =>
  captured.get(IPC.DECK_SEND)!({}, { workspaceId: WS, text }) as Promise<{ ok: boolean }>;
const newSession = () =>
  captured.get(IPC.DECK_CONVERSATION_CLEAR)!({}, { workspaceId: WS }) as Promise<{
    ok: boolean;
    code?: string;
  }>;

/** Delegate a task under whatever record currently owns the workspace. */
const delegate = (taskId: string, state: 'working' | 'completed' = 'working'): void => {
  recordDeckWorkA2aTask(WS, { taskId, to: 'ws-worker', state, ts: Date.now() + 1_000 });
};

beforeEach(() => {
  captured.clear();
  raised.length = 0;
  pendingRef.current = false;
  workDirRef.current = mkdtempSync(path.join(tmpdir(), 'wmux-stranded-'));
  setDeckWorkBootId('boot-current');
  cleanup?.();
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: () => new FakeAdapter(),
    // The startup reconcile raises decisions of its own for parked records;
    // push it far past the end of the suite so it cannot pollute `raised`.
    reconcileDelayMs: 600_000,
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  rmSync(workDirRef.current, { recursive: true, force: true });
});

describe('deck handler — a human turn against a PARKED record', () => {
  it('starts a NEW record and surfaces the one it superseded', async () => {
    beginOrContinueDeckWork(WS, 'Recover my agents after the reboot');
    delegate('task-orphan');
    const before = loadActiveDeckWork(WS)!;
    setDeckWorkBootId('boot-next'); // the app restarted; the record is parked

    await send('reply X, do nothing else');

    const after = loadActiveDeckWork(WS)!;
    expect(after.id).not.toBe(before.id);
    expect(after.objective).toBe('reply X, do nothing else');
    expect(after.followUps).toEqual([]);

    // The dropped record reached the human, with the task nobody owns now.
    expect(raised).toHaveLength(1);
    expect(raised[0].workspaceId).toBe(WS);
    expect(raised[0].question).toMatch(/delegated tasks running/i);
    expect(raised[0].context).toContain('Recover my agents after the reboot');
    expect(raised[0].context).toContain('task-orphan');
    // The quoted record must not read as an order — it no longer exists.
    expect(raised[0].context).not.toContain('You OWN');
  });

  it('does not raise for a superseded record with nothing outstanding', async () => {
    // A decision blocks autonomous follow-through on the request the human JUST
    // made, so it is charged only where delegated work would be orphaned.
    beginOrContinueDeckWork(WS, 'yesterday, and it finished');
    delegate('task-done', 'completed');
    setDeckWorkBootId('boot-next');

    await send('something else entirely');

    expect(loadActiveDeckWork(WS)!.objective).toBe('something else entirely');
    expect(raised).toEqual([]);
  });

  it('never clobbers a decision the human is already looking at', async () => {
    beginOrContinueDeckWork(WS, 'the old request');
    delegate('task-orphan');
    setDeckWorkBootId('boot-next');
    pendingRef.current = true;

    await send('a new request');

    expect(raised).toEqual([]);
    expect(loadActiveDeckWork(WS)!.objective).toBe('a new request');
  });

  it('APPENDS to a live record and raises nothing', async () => {
    beginOrContinueDeckWork(WS, 'build it');
    delegate('task-running');
    const before = loadActiveDeckWork(WS)!;

    await send('also add tests');

    const after = loadActiveDeckWork(WS)!;
    expect(after.id).toBe(before.id);
    expect(after.objective).toBe('build it');
    expect(after.followUps).toEqual(['also add tests']);
    // Running workers keep their owner, so nothing is stranded.
    expect(raised).toEqual([]);
  });
});

describe('deck handler — New session with delegated work outstanding', () => {
  it('still clears, and surfaces the tasks the cleared record owned', async () => {
    beginOrContinueDeckWork(WS, 'the cleared request');
    delegate('task-orphan');

    const verdict = await newSession();

    // The escape hatch must never start refusing.
    expect(verdict).toEqual({ ok: true });
    expect(loadActiveDeckWork(WS)).toBeNull();
    expect(raised).toHaveLength(1);
    expect(raised[0].question).toMatch(/new session/i);
    expect(raised[0].context).toContain('the cleared request');
    expect(raised[0].context).toContain('task-orphan');
  });

  it('is quiet when there was nothing outstanding to strand', async () => {
    beginOrContinueDeckWork(WS, 'nothing delegated');
    expect(await newSession()).toEqual({ ok: true });
    expect(raised).toEqual([]);

    // …and with no record at all it is a plain no-op.
    clearActiveDeckWork(WS);
    expect(await newSession()).toEqual({ ok: true });
    expect(raised).toEqual([]);
  });
});
