// A human turn that never reached the brain (claude not found, or Claude's
// first-run / trust dialog refused the send) must not leave a request record
// behind. If it did, the next launch would park it and raise "A request from
// before this wmux session is still on the books" — a decision that blocks the
// composer for something Moa never saw (dogfood, 2026-10-11).

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
    withdrawUndeliveredDeckWork: (ws: string, id: string, text: string) =>
      actual.withdrawUndeliveredDeckWork(ws, id, text, dir()),
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
    hasBrainBlockingDecision: vi.fn(() => pendingRef.current),
    raiseDecision: vi.fn(async (workspaceId: string, args: Omit<RaisedDecision, 'workspaceId'>) => {
      raised.push({ workspaceId, ...args });
      return null;
    }),
  };
});

import { registerDeckHandler } from '../deck.handler';
import { setMoaEnabled } from '../../../deck/deckHqStore';
import { IPC } from '../../../../shared/constants';
import {
  beginOrContinueDeckWork,
  loadActiveDeckWork,
  setDeckWorkBootId,
} from '../../../deck/deckWorkStore';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

const outcome: { current: 'ok' | 'spawn-failed' | 'first-run' | 'error' } = { current: 'ok' };

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  start(_opts: BrainStartOptions): void {
    /* nothing to start in the fake */
  }
  async *send(_text: string): AsyncIterable<BrainEvent> {
    if (outcome.current === 'spawn-failed') {
      yield { type: 'error', message: 'Claude Code not found', spawnFailed: true } as BrainEvent;
      return;
    }
    if (outcome.current === 'first-run') {
      yield { type: 'error', message: 'waiting on a prompt', tuiDialog: { excerpt: 'Syntax theme: Monokai' } } as BrainEvent;
      return;
    }
    if (outcome.current === 'error') {
      yield { type: 'error', message: 'rate limited' } as BrainEvent;
      return;
    }
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
// These suites exercise the deck brain itself: start with Moa's master
// switch on (a fresh data dir would otherwise read as a new install, off).
beforeEach(async () => {
  await setMoaEnabled(true);
});

beforeEach(() => {
  captured.clear();
  raised.length = 0;
  outcome.current = 'ok';
  pendingRef.current = false;
  workDirRef.current = mkdtempSync(path.join(tmpdir(), 'wmux-undelivered-'));
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

describe('deck handler — a turn the brain never received', () => {
  for (const kind of ['spawn-failed', 'first-run'] as const) {
    it(`${kind}: leaves no record, so the next launch raises nothing`, { timeout: 30_000 }, async () => {
      outcome.current = kind;
      await send('add a usage section to README');
      expect(loadActiveDeckWork(WS)).toBeNull();
      setDeckWorkBootId('boot-next');
      expect(loadActiveDeckWork(WS)).toBeNull();
      expect(raised).toHaveLength(0);
    });
  }

  it('a turn that started and then failed keeps its record', { timeout: 30_000 }, async () => {
    outcome.current = 'error';
    await send('add a usage section to README');
    expect(loadActiveDeckWork(WS)?.objective).toBe('add a usage section to README');
  });

  it('an undelivered follow-up is popped, the live request stays', { timeout: 30_000 }, async () => {
    await send('build the page');
    outcome.current = 'first-run';
    await send('also add tests');
    const after = loadActiveDeckWork(WS)!;
    expect(after.objective).toBe('build the page');
    expect(after.followUps).toEqual([]);
  });
});
