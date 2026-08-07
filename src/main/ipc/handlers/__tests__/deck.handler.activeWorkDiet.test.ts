// The [active-work] injection diet (terminal brain only): the full block —
// objective, every follow-up, every A2A row, the ownership imperatives — used
// to be re-typed onto the visible TUI on EVERY turn. Unchanged content now
// collapses to a one-line reminder (renderActiveDeckWorkReminderLine); any
// change to the rendered block re-sends it in full. Same changed-only contract
// as the ambient autonomy/policy blocks, settled only by a clean turn.
//
// Stores are mocked in-memory (the handler's CONTRACT is under test); the real
// render functions come through importOriginal so the strings asserted here are
// the strings the brain actually reads.

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

// In-memory active-work store with the REAL render functions. The fake
// beginOrContinueDeckWork mirrors the real dedupe contract: a repeated message
// only bumps updatedAt (which the block does not render), a new message lands
// as a follow-up (which it does).
interface FakeWork {
  id: string;
  workspaceId: string;
  objective: string;
  followUps: string[];
  startedAt: number;
  updatedAt: number;
  a2aTasks: Record<string, never>;
  bootId: string;
}
const works = new Map<string, FakeWork>();
vi.mock('../../../deck/deckWorkStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckWorkStore')>();
  return {
    ...actual,
    loadActiveDeckWork: vi.fn((ws: string) => works.get(ws) ?? null),
    loadActiveDeckWorks: vi.fn(() => Object.fromEntries(works.entries())),
    loadLiveDeckWork: vi.fn((ws: string) => works.get(ws) ?? null),
    loadLiveDeckWorks: vi.fn(() => Object.fromEntries(works.entries())),
    // isDeckWorkParked and setDeckWorkBootId stay REAL (via the spread): the
    // real renderActiveDeckWorkBlock consults the real parked predicate
    // internally, so the fake records must be live the real way — stamped with
    // the boot id the beforeEach installs.
    unparkDeckWork: vi.fn(() => undefined),
    beginOrContinueDeckWork: vi.fn((ws: string, text: string) => {
      const cur = works.get(ws);
      if (cur) {
        if (text !== cur.objective && !cur.followUps.includes(text)) {
          cur.followUps = [...cur.followUps, text];
        }
        cur.updatedAt += 1;
        return { work: cur };
      }
      const work: FakeWork = {
        id: 'work-diet-1',
        workspaceId: ws,
        objective: text,
        followUps: [],
        startedAt: 1,
        updatedAt: 1,
        a2aTasks: {},
        bootId: 'boot-diet-test',
      };
      works.set(ws, work);
      return { work };
    }),
    recordDeckWorkA2aTask: vi.fn(() => null),
    completeActiveDeckWork: vi.fn(() => null),
    clearActiveDeckWork: vi.fn(() => null),
    hasPendingDeckWorkA2aTasks: vi.fn(() => false),
  };
});

vi.mock('../../../deck/deckLoopStateStore', () => ({
  LOOP_STATE_LIMITS: { MIN_ITERATIONS: 1, MAX_ITERATIONS: 100, DEFAULT_ITERATIONS: 25 },
  loadWorkspaceLoopState: vi.fn(() => null),
  renderLoopStateBlock: vi.fn(() => ''),
  startLoop: vi.fn(async () => null),
  clearLoop: vi.fn(async () => undefined),
  setLoopStatus: vi.fn(async () => null),
  setTaskPasses: vi.fn(async () => null),
}));

vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: 'assist', ...actual.modeToCaps('assist') })),
    loadWorkspaceMode: vi.fn(() => 'assist' as const),
    setWorkspaceAutonomy: vi.fn(async () => ({})),
    setWorkspaceMode: vi.fn(async () => ({})),
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

vi.mock('../../../deck/deckDecisionStore', () => ({
  loadWorkspaceDecision: vi.fn(() => null),
  loadDeckDecisions: vi.fn(() => ({})),
  hasPendingDecision: vi.fn(() => false),
  resolveDecision: vi.fn(async () => null),
  clearResolvedDecision: vi.fn(async () => undefined),
  clearDecision: vi.fn(async () => undefined),
  renderDecisionBlock: vi.fn(() => ''),
  renderStaleDecisionBlock: vi.fn(() => ''),
  isDecisionStale: vi.fn(() => false),
  raiseDecision: vi.fn(async () => null),
}));

vi.mock('../../../deck/deckPolicy', () => ({
  loadDeckPolicyBlock: vi.fn(() => null),
  ensureDeckPolicySeed: vi.fn(() => undefined),
  getDeckPolicyPath: vi.fn(() => '/fake/deck-policy.md'),
}));

import { registerDeckHandler } from '../deck.handler';
import { setDeckWorkBootId } from '../../../deck/deckWorkStore';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

/** Fake adapter recording the exact text each turn was sent with. */
class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  sentTexts: string[] = [];
  constructor(public readonly workspaceId: string) {}
  start(opts: BrainStartOptions): void {
    void opts;
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

const send = (text: string) => invoke(IPC.DECK_SEND, { workspaceId: 'ws-1', text });

/** All texts every fake adapter has been sent, in order. */
const sentTexts = (): string[] => adapters.flatMap((a) => a.sentTexts);

beforeEach(() => {
  captured.clear();
  works.clear();
  adapters = [];
  cleanup?.();
  // The vendor defaults to claude-pty and no getDaemonClient means "daemon
  // available", so the injected adapter is recorded as the terminal brain —
  // the vendor the diet applies to. Reconcile is deferred out of the test.
  cleanup = registerDeckHandler(() => fakeWindow, {
    reconcileDelayMs: 600_000,
    createAdapter: (opts) => {
      const a = new FakeAdapter(opts.workspaceId);
      adapters.push(a);
      return a;
    },
  });
  // AFTER register (which stamps the EventBus boot id): make the fake records'
  // stamp the current boot, so the real parked predicate reads them as LIVE.
  setDeckWorkBootId('boot-diet-test');
});

describe('[active-work] changed-only injection (terminal brain)', () => {
  it('sends the full block on the first turn', async () => {
    const res = await send('ship the roster');
    expect(res.ok).toBe(true);
    expect(sentTexts()).toHaveLength(1);
    expect(sentTexts()[0]).toContain('[active-work] id: work-diet-1');
    expect(sentTexts()[0]).toContain('objective: ship the roster');
    expect(sentTexts()[0]).toContain('You OWN this request');
  });

  it('collapses an UNCHANGED block to the one-line reminder on the next turn', async () => {
    await send('ship the roster');
    // The repeat only bumps updatedAt (the real store dedupes the text), so
    // the rendered block is byte-identical to what the conversation has seen.
    await send('ship the roster');
    const second = sentTexts()[1];
    expect(second).toContain('[active-work] id: work-diet-1');
    expect(second).toContain('unchanged since your last turn');
    // The contract's imperatives survive in the reminder…
    expect(second).toMatch(/still ACTIVE/i);
    expect(second).toContain('deck_complete_work');
    // …but the full block does not re-send.
    expect(second).not.toContain('You OWN this request');
    expect(second).not.toContain('objective: ship the roster');
  });

  it('re-sends the full block as soon as the record changes (a new follow-up)', async () => {
    await send('ship the roster');
    await send('ship the roster');
    await send('also add tests');
    const third = sentTexts()[2];
    expect(third).toContain('You OWN this request');
    expect(third).toContain('objective: ship the roster');
    expect(third).toContain('- also add tests');
    expect(third).not.toContain('unchanged since your last turn');
  });

  it('a changed block re-arms the reminder for the turn after it', async () => {
    await send('ship the roster');
    await send('also add tests');
    await send('also add tests');
    const third = sentTexts()[2];
    expect(third).toContain('unchanged since your last turn');
    expect(third).not.toContain('You OWN this request');
  });
});
