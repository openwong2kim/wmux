// Unit tests for the deck IPC handler: the orchestrator model override (rides
// on deck:send, adapter created with it, swap between turns only, sanitized)
// and the M1.5 per-workspace manager map (one brain per workspace, parallel
// turns, workspace-enveloped streams, per-workspace token binding).

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

// No persisted session in these tests — resume is P3a's concern, not model's.
vi.mock('../../../deck/commanderSessionStore', () => ({
  loadCommanderSession: vi.fn(() => null),
  saveCommanderSession: vi.fn(async () => undefined),
}));

// Keep the handler hermetic: no policy file read, and — critically — the init
// seed must not write deck-policy.md into the real wmux dir during unit tests.
vi.mock('../../../deck/deckPolicy', () => ({
  loadDeckPolicyBlock: vi.fn(() => null),
  ensureDeckPolicySeed: vi.fn(() => undefined),
  getDeckPolicyPath: vi.fn(() => '/fake/deck-policy.md'),
}));

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';

/** Fake adapter: replies with one turn-end per send; records its model +
 *  workspace binding. */
class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  started: BrainStartOptions | null = null;
  disposed = false;
  constructor(
    public readonly model: string | undefined,
    public readonly workspaceId: string,
    public readonly fullPower: boolean | undefined = undefined,
  ) {}
  start(opts: BrainStartOptions): void {
    this.started = opts;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *send(_text: string): AsyncIterable<BrainEvent> {
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void {}
  dispose(): void {
    this.disposed = true;
  }
}

let adapters: FakeAdapter[];
let cleanup: (() => void) | null = null;
let emitted: { workspaceId: string; event: BrainEvent }[];

const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (_channel: string, envelope: { workspaceId: string; event: BrainEvent }) => {
      emitted.push(envelope);
    },
  },
} as unknown as import('electron').BrowserWindow;

function register(
  createAdapter?: (opts: { model?: string; workspaceId: string; fullPower?: boolean }) => BrainAdapter,
): void {
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter:
      createAdapter ??
      ((opts) => {
        const a = new FakeAdapter(opts.model, opts.workspaceId, opts.fullPower);
        adapters.push(a);
        return a;
      }),
  });
}

const send = (payload: Record<string, unknown>) =>
  captured.get(IPC.DECK_SEND)!({}, { workspaceId: 'ws-1', ...payload }) as Promise<{
    ok: boolean;
    code?: string;
  }>;

beforeEach(() => {
  captured.clear();
  adapters = [];
  emitted = [];
  cleanup?.();
  register();
});

describe('deck:send — orchestrator model override', () => {
  it('creates the adapter with the requested model and reuses it while unchanged', async () => {
    await send({ text: 'hi', model: 'opus' });
    await send({ text: 'again', model: 'opus' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].model).toBe('opus');
  });

  it('no model → adapter created with undefined model (SDK default)', async () => {
    await send({ text: 'hi' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].model).toBeUndefined();
  });

  it('model change between turns disposes the old brain and builds a new one', async () => {
    await send({ text: 'hi', model: 'opus' });
    await send({ text: 'switch', model: 'sonnet' });
    expect(adapters).toHaveLength(2);
    expect(adapters[0].disposed).toBe(true);
    expect(adapters[1].model).toBe('sonnet');
  });

  it('switching back to default is also a swap', async () => {
    await send({ text: 'hi', model: 'opus' });
    await send({ text: 'back', model: '' });
    expect(adapters).toHaveLength(2);
    expect(adapters[1].model).toBeUndefined();
  });

  it('never swaps mid-turn: a model change while busy keeps the running brain', async () => {
    // An adapter whose turn we control, so the manager stays busy.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowAdapter extends FakeAdapter {
      async *send(): AsyncIterable<BrainEvent> {
        await gate;
        yield { type: 'turn-end', sessionId: 'sess-slow' } as BrainEvent;
      }
    }
    captured.clear();
    cleanup?.();
    adapters = [];
    register((opts) => {
      const a =
        adapters.length === 0
          ? new SlowAdapter(opts.model, opts.workspaceId)
          : new FakeAdapter(opts.model, opts.workspaceId);
      adapters.push(a);
      return a;
    });

    const first = send({ text: 'long turn', model: 'opus' });
    // Racing send with a DIFFERENT model while busy: must NOT dispose the
    // running brain — it gets the normal busy reject.
    const second = await send({ text: 'switch', model: 'sonnet' });
    expect(second).toEqual({ ok: false, code: 'busy' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].disposed).toBe(false);
    release();
    await expect(first).resolves.toEqual({ ok: true });
  });

  it('sanitizes a hostile model string to the default (never reaches the CLI)', async () => {
    await send({ text: 'hi', model: 'opus; rm -rf /' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].model).toBeUndefined();
  });
});

describe('deck full-power mode (BYOB approach A) — MAIN-side authority', () => {
  const setFullPower = (enabled: unknown) =>
    captured.get(IPC.DECK_FULLPOWER_SET)!({}, { enabled }) as Promise<{
      ok: true;
      enabled: boolean;
    }>;

  it('applies to sends after the set, reused while unchanged', async () => {
    await setFullPower(true);
    await send({ text: 'hi' });
    await send({ text: 'again' });
    expect(adapters).toHaveLength(1);
    expect(adapters[0].fullPower).toBe(true);
  });

  it('defaults to raw mode, and only a strict boolean true enables it', async () => {
    await send({ text: 'hi' });
    expect(adapters[0].fullPower).toBeUndefined();
    // Fail closed: a truthy-but-not-true value must NOT enable full power.
    expect((await setFullPower('yes')).enabled).toBe(false);
    await send({ text: 'again' });
    expect(adapters).toHaveLength(1);
  });

  it('toggling retires the IDLE stale-mode brain immediately (both directions)', async () => {
    await send({ text: 'hi' });
    // ON: the idle raw-mode manager is disposed by the set itself, so even an
    // autonomous turn (no deck:send) would spawn on the new mode.
    await setFullPower(true);
    expect(adapters[0].disposed).toBe(true);
    await send({ text: 'on' });
    expect(adapters).toHaveLength(2);
    expect(adapters[1].fullPower).toBe(true);
    // OFF: hooks must stop running on the very next turn of any path.
    await setFullPower(false);
    expect(adapters[1].disposed).toBe(true);
    await send({ text: 'off' });
    expect(adapters).toHaveLength(3);
    expect(adapters[2].fullPower).toBeUndefined();
  });

  it('never retires a BUSY brain mid-turn; it swaps on its next turn', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowAdapter extends FakeAdapter {
      async *send(): AsyncIterable<BrainEvent> {
        await gate;
        yield { type: 'turn-end', sessionId: 'sess-slow' } as BrainEvent;
      }
    }
    captured.clear();
    cleanup?.();
    adapters = [];
    register((opts) => {
      const a =
        adapters.length === 0
          ? new SlowAdapter(opts.model, opts.workspaceId, opts.fullPower)
          : new FakeAdapter(opts.model, opts.workspaceId, opts.fullPower);
      adapters.push(a);
      return a;
    });

    const turn = send({ text: 'long turn' });
    await setFullPower(true);
    expect(adapters[0].disposed).toBe(false); // in-flight turn survives
    release();
    await expect(turn).resolves.toEqual({ ok: true });
    // Next turn spawns on the new mode.
    await send({ text: 'after' });
    expect(adapters).toHaveLength(2);
    expect(adapters[1].fullPower).toBe(true);
  });
});

describe('deck:send — per-workspace orchestrators (M1.5)', () => {
  it('rejects a send with no / malformed workspaceId', async () => {
    const raw = captured.get(IPC.DECK_SEND)!;
    expect(await raw({}, { text: 'hi' })).toEqual({ ok: false, code: 'invalid_workspace' });
    expect(await raw({}, { text: 'hi', workspaceId: 'bad id!' })).toEqual({
      ok: false,
      code: 'invalid_workspace',
    });
    expect(adapters).toHaveLength(0);
  });

  it('one adapter per workspace, each bound to ITS workspaceId', async () => {
    await send({ text: 'a', workspaceId: 'ws-1' });
    await send({ text: 'b', workspaceId: 'ws-2' });
    await send({ text: 'a2', workspaceId: 'ws-1' });
    expect(adapters).toHaveLength(2);
    expect(adapters.map((a) => a.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('a busy workspace does not block another workspace (parallel turns)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    class SlowAdapter extends FakeAdapter {
      async *send(): AsyncIterable<BrainEvent> {
        await gate;
        yield { type: 'turn-end', sessionId: 'sess-slow' } as BrainEvent;
      }
    }
    captured.clear();
    cleanup?.();
    adapters = [];
    register((opts) => {
      const a =
        opts.workspaceId === 'ws-slow'
          ? new SlowAdapter(opts.model, opts.workspaceId)
          : new FakeAdapter(opts.model, opts.workspaceId);
      adapters.push(a);
      return a;
    });

    const slow = send({ text: 'long', workspaceId: 'ws-slow' });
    // While ws-slow streams, ws-2 sends immediately — no busy reject.
    const fast = await send({ text: 'quick', workspaceId: 'ws-2' });
    expect(fast).toEqual({ ok: true });
    // The SAME workspace racing itself still gets the busy reject.
    const sameWs = await send({ text: 'racing', workspaceId: 'ws-slow' });
    expect(sameWs).toEqual({ ok: false, code: 'busy' });
    release();
    await expect(slow).resolves.toEqual({ ok: true });
  });

  it('envelopes every stream event with its workspaceId', async () => {
    await send({ text: 'a', workspaceId: 'ws-1' });
    await send({ text: 'b', workspaceId: 'ws-2' });
    expect(emitted.length).toBeGreaterThanOrEqual(2);
    expect(emitted.every((e) => e.workspaceId === 'ws-1' || e.workspaceId === 'ws-2')).toBe(true);
    expect(emitted.some((e) => e.workspaceId === 'ws-1')).toBe(true);
    expect(emitted.some((e) => e.workspaceId === 'ws-2')).toBe(true);
  });

  it('model swap in one workspace leaves the other workspace’s brain alone', async () => {
    await send({ text: 'a', workspaceId: 'ws-1', model: 'opus' });
    await send({ text: 'b', workspaceId: 'ws-2', model: 'opus' });
    await send({ text: 'switch', workspaceId: 'ws-1', model: 'sonnet' });
    const ws1 = adapters.filter((a) => a.workspaceId === 'ws-1');
    const ws2 = adapters.filter((a) => a.workspaceId === 'ws-2');
    expect(ws1).toHaveLength(2);
    expect(ws1[0].disposed).toBe(true);
    expect(ws2).toHaveLength(1);
    expect(ws2[0].disposed).toBe(false);
  });
});
