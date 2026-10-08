// The phone's `moa.wake` through the real deck handler: answered on accept
// (a cold start outlives the 15 s bridge timeout), one turn for two racing
// ids, and failures after the accept reported for the receipt.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: 'danger', ...actual.modeToCaps('danger') })),
    loadWorkspaceMode: vi.fn(() => 'danger'),
  };
});
vi.mock('../../../deck/DeckHeartbeat', () => ({
  DeckHeartbeat: class {
    start(): void { /* no timers */ }
    stop(): void { /* no timers */ }
  },
}));
vi.mock('../../../deck/DeckScheduler', () => ({
  DeckScheduler: class {
    start(): void { /* no timers */ }
    stop(): void { /* no timers */ }
  },
}));

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent } from '../../../deck/BrainAdapter';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import { __resetHqMemoryForTest, setHqWorkspaceId, setMoaEnabled } from '../../../deck/deckHqStore';
import { __resetStartupDeckReconcileForTest } from '../../../deck/deckOrphanReconcile';
import { handlePhoneMoaWake, type MoaWakeReport } from '../../../deck/moaWake';

/** What the next adapter turn does. */
let script: (prompt: string) => AsyncIterable<BrainEvent>;
const sentPrompts: string[] = [];
class ScriptedAdapter implements BrainAdapter {
  sessionId: string | null = null;
  start(): void { /* nothing to start */ }
  send(prompt: string): AsyncIterable<BrainEvent> {
    sentPrompts.push(prompt);
    return script(prompt);
  }
  interrupt(): void { /* no in-flight turn */ }
  dispose(): void { /* nothing held */ }
}

let cleanup: (() => void) | null = null;
const pushed: { channel: string; data: unknown }[] = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, data: unknown) => { pushed.push({ channel, data }); } },
} as unknown as import('electron').BrowserWindow;
const reports: MoaWakeReport[] = [];
const wake = (clientMessageId: string, actor = 'device:d1') =>
  handlePhoneMoaWake({ clientMessageId, text: 'hello Moa', actor }, (r) => reports.push(r));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  cleanup?.();
  cleanup = null;
  captured.clear();
  sentPrompts.length = 0;
  pushed.length = 0;
  reports.length = 0;
  __resetWorkspaceMirrorForTest();
  __resetHqMemoryForTest();
  __resetStartupDeckReconcileForTest();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  getWorkspaceMirror().setSnapshot({ ts: Date.now(), entries: [{ id: 'ws-hq', name: 'HQ' }], fleets: [], sessionRestored: true });
  await setMoaEnabled(true);
  await setHqWorkspaceId('ws-hq');
  script = async function* () { yield { type: 'turn-end', sessionId: null } as BrainEvent; };
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: () => new ScriptedAdapter(),
  } as Parameters<typeof registerDeckHandler>[1]);
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('moa.wake through the deck handler', () => {
  it('answers accepted at once while a cold start takes longer than 20 s, and a racing id reads busy', async () => {
    vi.useFakeTimers();
    let finished = false;
    script = async function* () {
      await delay(25_000); // slower than the adapter's 20 s SessionStart wait
      finished = true;
      yield { type: 'turn-end', sessionId: 's1' } as BrainEvent;
    };
    // Synchronous answer: no timer has to fire for the accept.
    expect(wake('id-1')).toEqual({ ok: true, accepted: true });
    expect(wake('id-2')).toEqual({ ok: false, code: 'busy' });
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain('hello Moa');
    // The desktop deck opens the phone's turn (it has no optimistic bubble there).
    expect(pushed.some((p) => p.channel === IPC.DECK_STREAM &&
      (p.data as { event: BrainEvent }).event.type === 'turn-start')).toBe(true);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(finished).toBe(true);
    expect(reports).toEqual([]);
    // The same id again is one main already ran; a busy id was never
    // remembered, so it may come back.
    expect(wake('id-1')).toEqual({ ok: false, code: 'duplicate' });
    await vi.advanceTimersByTimeAsync(1);
    expect(wake('id-2')).toEqual({ ok: true, accepted: true });
  });

  it('reports tui-dialog when the cold brain stopped on a startup screen', async () => {
    script = async function* () {
      yield { type: 'error', message: 'waiting on a prompt', tuiDialog: { excerpt: 'Do you trust this folder?' } } as BrainEvent;
    };
    expect(wake('id-1')).toEqual({ ok: true, accepted: true });
    await delay(0);
    await delay(0);
    expect(reports).toEqual([{ actor: 'device:d1', clientMessageId: 'id-1', failure: 'tui-dialog' }]);
  });

  it('reports spawn-failed when the brain never came up, and nothing for an error mid-turn', async () => {
    script = async function* () {
      yield { type: 'error', message: 'could not start the terminal brain', spawnFailed: true } as BrainEvent;
    };
    expect(wake('id-1')).toEqual({ ok: true, accepted: true });
    await delay(0);
    await delay(0);
    expect(reports).toEqual([{ actor: 'device:d1', clientMessageId: 'id-1', failure: 'spawn-failed' }]);
    reports.length = 0;
    script = async function* () {
      yield { type: 'text-delta', text: 'working' } as BrainEvent;
      yield { type: 'error', message: 'the turn timed out' } as BrainEvent;
    };
    expect(wake('id-2')).toEqual({ ok: true, accepted: true });
    await delay(0);
    await delay(0);
    expect(reports).toEqual([]);
  });

  it('refuses with typed codes, never throws', async () => {
    await setMoaEnabled(false);
    expect(wake('id-1')).toEqual({ ok: false, code: 'moa_off' });
    await setMoaEnabled(true);
    await setHqWorkspaceId(null);
    expect(wake('id-1')).toEqual({ ok: false, code: 'not_hq' });
    await setHqWorkspaceId('ws-gone');
    expect(wake('id-1')).toEqual({ ok: false, code: 'hq_missing' });
    await setHqWorkspaceId('ws-hq');
    await captured.get(IPC.DECK_BRAIN_VENDOR_SET)!({}, { vendor: 'claude' });
    expect(wake('id-1')).toEqual({ ok: false, code: 'unsupported_vendor' });
    expect(sentPrompts).toHaveLength(0);
  });

  it('answers moa_off with no deck installed', () => {
    cleanup?.();
    cleanup = null;
    expect(wake('id-1')).toEqual({ ok: false, code: 'moa_off' });
  });
});
