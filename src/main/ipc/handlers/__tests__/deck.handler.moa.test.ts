// Moa's right panel in the deck handler: DECK_MOA_DECISIONS (every
// workspace's pending decision, named, newest first, with DECK_MOA_CHANGED on
// raise/resolve) and the DECK_MOA_TRANSCRIPT_* channels bound to the HQ brain.

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

// Every workspace may take a turn (mode 'off' refuses DECK_SEND).
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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent } from '../../../deck/BrainAdapter';
import type { MoaTranscriptHint } from '../../../deck/moaTranscript';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import { __resetHqMemoryForTest, setHqWorkspaceId, setMoaEnabled } from '../../../deck/deckHqStore';
import { clearDecision, raiseDecision, resolveDecision } from '../../../deck/deckDecisionStore';
import { __resetStartupDeckReconcileForTest } from '../../../deck/deckOrphanReconcile';
import { MOA_MEMORY_DECISION_KEY, type MoaPendingDecision } from '../../../../shared/moa';

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  start(): void { /* nothing to start */ }
  async *send(): AsyncIterable<BrainEvent> {
    yield { type: 'turn-end', sessionId: null } as BrainEvent;
  }
  interrupt(): void { /* no in-flight turn */ }
  dispose(): void { /* nothing held */ }
}

type AdapterOpts = { workspaceId: string; onTranscriptHint?: (hint: MoaTranscriptHint) => void };
let adapterOpts: AdapterOpts[];
let cleanup: (() => void) | null = null;
const pushed: { channel: string; data: unknown }[] = [];
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: (channel: string, data: unknown) => { pushed.push({ channel, data }); } },
} as unknown as import('electron').BrowserWindow;

const invoke = (channel: string, payload?: unknown) => captured.get(channel)!({}, payload) as Promise<unknown>;
const decisions = async () =>
  ((await invoke(IPC.DECK_MOA_DECISIONS)) as { decisions: MoaPendingDecision[] }).decisions;
const mirror = (entries: { id: string; name: string }[]) => getWorkspaceMirror().setSnapshot({
  ts: Date.now(),
  entries,
  fleets: [],
  sessionRestored: true,
});
const changedPushes = () => pushed.filter((p) => p.channel === IPC.DECK_MOA_CHANGED).length;
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  cleanup?.();
  cleanup = null;
  captured.clear();
  adapterOpts = [];
  pushed.length = 0;
  __resetWorkspaceMirrorForTest();
  __resetHqMemoryForTest();
  __resetStartupDeckReconcileForTest();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const ws of ['ws-a', 'ws-b', 'ws-c', 'ws-hq', MOA_MEMORY_DECISION_KEY]) await clearDecision(ws);
  await setHqWorkspaceId(null);
  await setMoaEnabled(true);
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: (o: AdapterOpts) => {
      adapterOpts.push(o);
      return new FakeAdapter();
    },
  } as Parameters<typeof registerDeckHandler>[1]);
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DECK_MOA_DECISIONS', () => {
  it('lists every workspace\'s pending decision, named when known, newest first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    mirror([{ id: 'ws-a', name: 'Alpha' }, { id: 'ws-b', name: 'Beta' }]);
    vi.setSystemTime(1_000);
    await raiseDecision('ws-a', { question: 'ship it?', options: ['yes', 'no'], context: 'ctx' });
    vi.setSystemTime(3_000);
    await raiseDecision('ws-c', { question: 'which branch?' });
    vi.setSystemTime(2_000);
    const b = await raiseDecision('ws-b', { question: 'resolved soon' });
    await resolveDecision('ws-b', b!.id, 'done');

    const list = await decisions();
    expect(list.map((d) => d.workspaceId)).toEqual(['ws-c', 'ws-a']);
    expect(list[0]).toEqual({
      workspaceId: 'ws-c',
      decision: { id: expect.any(String), question: 'which branch?', options: [], context: '', raisedAt: 3_000 },
    });
    expect(list[1]).toMatchObject({
      workspaceId: 'ws-a',
      workspaceName: 'Alpha',
      decision: { question: 'ship it?', options: ['yes', 'no'], context: 'ctx', raisedAt: 1_000 },
    });
    // Only the panel's fields cross the wire — no status or resolution.
    expect(Object.keys(list[1].decision).sort()).toEqual(['context', 'id', 'options', 'question', 'raisedAt']);
  });

  it('skips Moa\'s "Remember this?" card: it has its own row in Waiting on you', async () => {
    expect(await raiseDecision(MOA_MEMORY_DECISION_KEY, { question: 'Remember this?', options: ['Save', 'Discard'] })).not.toBeNull();
    await raiseDecision('ws-a', { question: 'ship it?' });
    const list = await decisions();
    expect(list.map((d) => d.workspaceId)).toEqual(['ws-a']);
    await clearDecision(MOA_MEMORY_DECISION_KEY);
  });

  it('pushes DECK_MOA_CHANGED when a decision is raised and when it is resolved', async () => {
    const before = changedPushes();
    const d = await raiseDecision('ws-a', { question: 'go?' });
    expect(changedPushes()).toBe(before + 1);
    expect(await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-a', id: d!.id, resolution: 'yes' }))
      .toMatchObject({ ok: true });
    expect(changedPushes()).toBeGreaterThanOrEqual(before + 2);
    expect(await decisions()).toEqual([]);
  });

  it('stops pushing after the handler is disposed', async () => {
    cleanup?.();
    cleanup = null;
    const before = changedPushes();
    await raiseDecision('ws-a', { question: 'after dispose?' });
    expect(changedPushes()).toBe(before);
  });
});

describe('DECK_MOA_TRANSCRIPT_*', () => {
  const SESSION = '920b9112-1111-4222-8333-444455556666';
  let file: string;

  beforeEach(async () => {
    await setHqWorkspaceId('ws-hq');
    mirror([{ id: 'ws-hq', name: 'Moa' }, { id: 'ws-a', name: 'Alpha' }]);
    // HOME is a per-run temp dir (isolateDataDir), so this is the default
    // Claude projects root the containment check accepts.
    const folder = path.join(os.homedir(), '.claude', 'projects', '-moa-handler-test');
    fs.mkdirSync(folder, { recursive: true });
    file = path.join(folder, `${SESSION}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({
      type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-10-04T09:00:00.000Z', sessionId: SESSION,
      cwd: '/brains/ws-hq', userType: 'external', message: { role: 'user', content: 'hello moa' },
    }) + '\n');
  });

  it('is empty until the HQ brain reports its transcript, then serves and pushes it', async () => {
    expect(await invoke(IPC.DECK_MOA_TRANSCRIPT_STATUS)).toEqual({ available: false, reason: 'no-brain' });
    expect(await invoke(IPC.DECK_MOA_TRANSCRIPT_SNAPSHOT, {})).toBeNull();

    expect(await invoke(IPC.DECK_SEND, { workspaceId: 'ws-hq', text: 'hi' })).toMatchObject({ ok: true });
    const hqOpts = adapterOpts.find((o) => o.workspaceId === 'ws-hq')!;
    expect(hqOpts.onTranscriptHint).toBeTypeOf('function');
    hqOpts.onTranscriptHint!({ kind: 'agent.stop', agentSessionId: SESSION, transcriptPath: file });

    expect(await invoke(IPC.DECK_MOA_TRANSCRIPT_STATUS)).toMatchObject({ available: true, agentSessionId: SESSION });
    const page = (await invoke(IPC.DECK_MOA_TRANSCRIPT_SNAPSHOT, { before: 'junk' })) as { events: unknown[] };
    expect(page.events).toHaveLength(1);

    await invoke(IPC.DECK_MOA_TRANSCRIPT_SUBSCRIBE);
    await vi.waitFor(() =>
      expect(pushed.some((p) => p.channel === IPC.DECK_MOA_TRANSCRIPT_APPEND)).toBe(true),
    );

    // Moa off: the binding and the subscription go, and the status says why.
    await invoke(IPC.DECK_MOA_SET, { enabled: false });
    await flush();
    expect(await invoke(IPC.DECK_MOA_TRANSCRIPT_STATUS)).toEqual({ available: false, reason: 'moa-off' });
    expect(await invoke(IPC.DECK_MOA_TRANSCRIPT_SNAPSHOT, {})).toBeNull();
  });

  it('ignores a non-HQ workspace\'s brain', async () => {
    await setHqWorkspaceId(null);
    expect(await invoke(IPC.DECK_SEND, { workspaceId: 'ws-a', text: 'hi' })).toMatchObject({ ok: true });
    await setHqWorkspaceId('ws-hq');
    adapterOpts.find((o) => o.workspaceId === 'ws-a')!
      .onTranscriptHint!({ kind: 'agent.stop', agentSessionId: SESSION, transcriptPath: file });
    expect(await invoke(IPC.DECK_MOA_TRANSCRIPT_STATUS)).toEqual({ available: false, reason: 'no-brain' });
  });
});
