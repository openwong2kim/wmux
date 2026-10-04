// Moa's memory lane in the deck handler: which brain gets the proposal gate
// and first-turn memory, how a "Remember this?" card is answered (never a brain
// turn), and the precedent offer after the operator answers a Moa decision.

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
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: 'assist', ...actual.modeToCaps('assist') })),
    loadWorkspaceMode: vi.fn(() => 'assist'),
  };
});

vi.mock('../../../deck/DeckHeartbeat', () => ({
  DeckHeartbeat: class {
    start(): void { /* timers off */ }
    stop(): void { /* timers off */ }
  },
}));
vi.mock('../../../deck/DeckScheduler', () => ({
  DeckScheduler: class {
    start(): void { /* timers off */ }
    stop(): void { /* timers off */ }
  },
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import { MOA_MEMORY_DECISION_KEY } from '../../../../shared/moa';
import type { BrainAdapter, BrainEvent } from '../../../deck/BrainAdapter';
import { getWorkspaceMirror, __resetWorkspaceMirrorForTest } from '../../../workspace/WorkspaceMirror';
import { __resetHqMemoryForTest, setHqWorkspaceId, setMoaConfig, setMoaEnabled } from '../../../deck/deckHqStore';
import { clearDecision, loadWorkspaceDecision, raiseDecision } from '../../../deck/deckDecisionStore';
import { __resetStartupDeckReconcileForTest } from '../../../deck/deckOrphanReconcile';
import { getMemoryRootDir } from '../../../deck/commanderMemory';
import { getWmuxDir } from '../../../../daemon/config';

interface AdapterOpts {
  workspaceId: string;
  vendor?: string;
  loadMemory?: () => string;
  moaProposalsDir?: string;
}

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  systemPrompt = '';
  constructor(public readonly opts: AdapterOpts) {}
  start(o: { systemPrompt?: string } = {}): void { this.systemPrompt = o.systemPrompt ?? ''; }
  async *send(text: string): AsyncIterable<BrainEvent> {
    prompts.push({ ws: this.opts.workspaceId, text });
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void { /* no in-flight turn */ }
  dispose(): void { /* nothing to free */ }
}

let adapters: FakeAdapter[] = [];
let prompts: { ws: string; text: string }[] = [];
let cleanup: (() => void) | null = null;
const fakeWindow = {
  isDestroyed: () => false,
  webContents: { send: () => undefined },
} as unknown as import('electron').BrowserWindow;

const invoke = (channel: string, payload?: unknown) =>
  captured.get(channel)!({}, payload) as Promise<Record<string, unknown>>;
const send = (workspaceId: string) => invoke(IPC.DECK_SEND, { workspaceId, text: 'hi' });
const proposalsDir = () => path.join(getMemoryRootDir(), '_proposals');
const card = () => loadWorkspaceDecision(MOA_MEMORY_DECISION_KEY);
const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(async () => {
  cleanup?.();
  captured.clear();
  adapters = [];
  prompts = [];
  __resetWorkspaceMirrorForTest();
  __resetHqMemoryForTest();
  __resetStartupDeckReconcileForTest();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await setHqWorkspaceId(null);
  await setMoaEnabled(true);
  await setMoaConfig({ memoryProposals: true });
  await clearDecision(MOA_MEMORY_DECISION_KEY);
  await clearDecision('ws-hq');
  fs.rmSync(proposalsDir(), { recursive: true, force: true });
  fs.rmSync(path.join(getWmuxDir(), 'moa-memory-card.json'), { force: true });
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: (o: AdapterOpts) => {
      const a = new FakeAdapter(o);
      adapters.push(a);
      return a;
    },
    reconcileDelayMs: 60_000,
  } as Parameters<typeof registerDeckHandler>[1]);
  await invoke(IPC.DECK_BRAIN_VENDOR_SET, { vendor: 'claude-pty' });
  getWorkspaceMirror().setSnapshot({
    ts: Date.now(),
    entries: [{ id: 'ws-hq', name: 'Moa' }, { id: 'ws-a', name: 'a' }],
    fleets: [],
    sessionRestored: true,
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = null;
  vi.restoreAllMocks();
});

describe('which brain gets the gate and the memory', () => {
  it('the HQ terminal brain with Moa and proposals on gets both', async () => {
    await setHqWorkspaceId('ws-hq');
    expect(await send('ws-hq')).toMatchObject({ ok: true });
    const hq = adapters.find((a) => a.opts.workspaceId === 'ws-hq')!;
    expect(hq.opts.moaProposalsDir).toBe(proposalsDir());
    expect(typeof hq.opts.loadMemory).toBe('function');
    // The system prompt tells Moa how to propose.
    expect(hq.systemPrompt).toContain(proposalsDir());
    expect(hq.systemPrompt).toContain('Remember this?');
  });

  it('proposals off: memory still reaches the HQ, the gate does not', async () => {
    await setMoaConfig({ memoryProposals: false });
    await setHqWorkspaceId('ws-hq');
    await send('ws-hq');
    const hq = adapters.find((a) => a.opts.workspaceId === 'ws-hq')!;
    expect(hq.opts.moaProposalsDir).toBeUndefined();
    expect(typeof hq.opts.loadMemory).toBe('function');
    expect(hq.systemPrompt).not.toContain('_proposals');
  });

  it('no HQ: an ordinary workspace brain gets neither', async () => {
    await send('ws-a');
    const a = adapters.find((x) => x.opts.workspaceId === 'ws-a')!;
    expect(a.opts.moaProposalsDir).toBeUndefined();
    expect(a.opts.loadMemory).toBeUndefined();
  });

  it('Moa off: no brain, so no gate, and no card', async () => {
    await setHqWorkspaceId('ws-hq');
    await invoke(IPC.DECK_MOA_SET, { enabled: false });
    fs.mkdirSync(proposalsDir(), { recursive: true });
    fs.writeFileSync(path.join(proposalsDir(), 'x.md'), '---\nname: x\ndescription: d\n---\nbody\n');
    expect((await send('ws-hq')).ok).toBe(false);
    expect(adapters).toHaveLength(0);
    await invoke(IPC.DECK_MOA_CONFIG_SET, { memoryProposals: true });
    await new Promise((r) => setTimeout(r, 400));
    expect(card()).toBeNull();
  });
});

describe('answering cards', () => {
  it('a "Remember this?" card resolves through the lane and never starts a brain turn', async () => {
    await setHqWorkspaceId('ws-hq');
    fs.mkdirSync(proposalsDir(), { recursive: true });
    fs.writeFileSync(path.join(proposalsDir(), 'x.md'), '---\nname: triage-ci\ndescription: d\n---\nbody\n');
    await invoke(IPC.DECK_MOA_CONFIG_SET, { memoryProposals: true });
    await vi.waitFor(() => expect(card()).not.toBeNull(), { timeout: 2000 });
    const r = await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: MOA_MEMORY_DECISION_KEY, id: card()!.id, resolution: 'Save' });
    expect(r).toEqual({ ok: true });
    await settle();
    expect(adapters).toHaveLength(0);
    expect(prompts).toHaveLength(0);
    expect(card()).toBeNull();
    expect(fs.existsSync(path.join(getWmuxDir(), 'brains', 'ws-hq', '.claude', 'skills', 'triage-ci', 'SKILL.md'))).toBe(true);
    expect((await invoke(IPC.DECK_MOA_MEMORY_LIST)).items).toEqual([
      expect.objectContaining({ kind: 'skill', name: 'triage-ci' }),
    ]);
    expect(await invoke(IPC.DECK_MOA_MEMORY_DELETE, { kind: 'skill', name: 'triage-ci' })).toEqual({ ok: true });
  });

  it('the deck card reads the full text and answers with Save/Discard only', async () => {
    await setHqWorkspaceId('ws-hq');
    fs.mkdirSync(proposalsDir(), { recursive: true });
    fs.writeFileSync(path.join(proposalsDir(), 'x.md'), `---\nname: triage-ci\ndescription: d\n---\n${'step\n'.repeat(300)}END\n`);
    await invoke(IPC.DECK_MOA_CONFIG_SET, { memoryProposals: true });
    await vi.waitFor(() => expect(card()).not.toBeNull(), { timeout: 2000 });
    const view = (await invoke(IPC.DECK_MOA_MEMORY_CARD)).card as { id: string; fullText: string };
    expect(view.fullText).toContain('END');
    // Free text is not an answer; a context-only Save of a long text is refused.
    expect(await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: MOA_MEMORY_DECISION_KEY, id: view.id, resolution: 'save it' }))
      .toMatchObject({ ok: false, code: 'unknown_answer' });
    expect(await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: MOA_MEMORY_DECISION_KEY, id: view.id, resolution: 'Save' }))
      .toMatchObject({ ok: false, code: 'open_full_text' });
    expect(await invoke(IPC.DECK_MOA_MEMORY_RESOLVE, { id: view.id, answer: 'maybe', fullTextShown: true }))
      .toMatchObject({ ok: false, code: 'invalid' });
    expect(await invoke(IPC.DECK_MOA_MEMORY_RESOLVE, { id: view.id, answer: 'save', fullTextShown: true })).toEqual({ ok: true });
    expect((await invoke(IPC.DECK_MOA_MEMORY_CARD)).card).toBeNull();
    expect(adapters).toHaveLength(0);
  });

  it('the operator answering a Moa decision offers it as a precedent', async () => {
    await setHqWorkspaceId('ws-hq');
    const d = (await raiseDecision('ws-hq', { question: 'Ship on Friday?', options: ['Yes', 'No'] }))!;
    expect(await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-hq', id: d.id, resolution: 'No' }))
      .toMatchObject({ ok: true });
    await vi.waitFor(() => expect(card()?.question).toContain('precedent'), { timeout: 2000 });
    expect(card()!.context).toContain('Ship on Friday?');
  });

  it('startup never resumes a brain for a resolved record under the card key', async () => {
    const d = (await raiseDecision(MOA_MEMORY_DECISION_KEY, { question: 'Remember this?', options: ['Save'] }))!;
    const { resolveDecision } = await import('../../../deck/deckDecisionStore');
    await resolveDecision(MOA_MEMORY_DECISION_KEY, d.id, 'Save');
    cleanup?.();
    cleanup = registerDeckHandler(() => fakeWindow, {
      createAdapter: (o: AdapterOpts) => {
        const a = new FakeAdapter(o);
        adapters.push(a);
        return a;
      },
      reconcileDelayMs: 1,
    } as Parameters<typeof registerDeckHandler>[1]);
    await new Promise((r) => setTimeout(r, 100));
    expect(adapters.map((a) => a.opts.workspaceId)).not.toContain(MOA_MEMORY_DECISION_KEY);
  });

  it('answering a non-HQ decision offers nothing', async () => {
    const d = (await raiseDecision('ws-a', { question: 'Q?', options: ['Yes'] }))!;
    await invoke(IPC.DECK_DECISION_RESOLVE, { workspaceId: 'ws-a', id: d.id, resolution: 'Yes' });
    await new Promise((r) => setTimeout(r, 400));
    expect(card()).toBeNull();
  });
});
