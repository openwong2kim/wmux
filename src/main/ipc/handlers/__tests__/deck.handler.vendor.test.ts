// Unit tests for the deck handler's BRAIN VENDOR plumbing: fail-closed
// narrowing of DECK_BRAIN_VENDOR_SET, the per-vendor persisted-session key, and
// the `claude-pty` embed push (DECK_BRAIN_PTY).

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

const sessionKeys: string[] = [];
vi.mock('../../../deck/commanderSessionStore', () => ({
  loadCommanderSession: vi.fn((key: string) => {
    sessionKeys.push(key);
    return null;
  }),
  saveCommanderSession: vi.fn(async () => undefined),
}));

vi.mock('../../../deck/deckPolicy', () => ({
  loadDeckPolicyBlock: vi.fn(() => null),
  ensureDeckPolicySeed: vi.fn(() => undefined),
  getDeckPolicyPath: vi.fn(() => '/fake/deck-policy.md'),
}));

// The ambient [autonomy] block only exists for a non-off workspace, and the
// re-send test needs one. Everything else stays real.
vi.mock('../../../deck/deckAutonomyStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../deck/deckAutonomyStore')>();
  return {
    ...actual,
    loadWorkspaceAutonomy: vi.fn(() => ({ mode: 'auto', ...actual.modeToCaps('auto') })),
    loadWorkspaceMode: vi.fn(() => 'auto'),
  };
});

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';
import type { BrainVendor } from '../../../../shared/types';

function noop(): void {
  /* the default fake never announces a terminal */
}

/** Every wire prompt every fake adapter received, in order. */
let prompts: string[];
/** When true the NEXT turn yields an error event instead of a turn-end — what
 *  a TUI brain stopped on its own trust/sign-in dialog looks like from here. */
let failNextTurn = false;

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  disposed = false;
  startOptions: BrainStartOptions | null = null;
  constructor(
    public readonly vendor: BrainVendor | undefined,
    public readonly workspaceId: string,
    public readonly announcePty: (ptyId: string | null) => void = noop,
    public readonly model: string | undefined = undefined,
  ) {}
  start(opts: BrainStartOptions): void {
    this.startOptions = opts;
  }
  async *send(text: string): AsyncIterable<BrainEvent> {
    prompts.push(text);
    if (failNextTurn) {
      failNextTurn = false;
      yield { type: 'error', message: 'Claude Code is waiting on a prompt of its own' } as BrainEvent;
      return;
    }
    yield { type: 'turn-end', sessionId: 'sess-1' } as BrainEvent;
  }
  interrupt(): void {
    /* no in-flight turn in the fake */
  }
  dispose(): void {
    this.disposed = true;
  }
}

let adapters: FakeAdapter[];
let cleanup: (() => void) | null = null;
let sent: Array<{ channel: string; payload: unknown }>;

const fakeWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: unknown) => {
      sent.push({ channel, payload });
    },
  },
} as unknown as import('electron').BrowserWindow;

function register(): void {
  cleanup = registerDeckHandler(() => fakeWindow, {
    createAdapter: (opts) => {
      const a = new FakeAdapter(opts.vendor, opts.workspaceId, opts.onPtySpawned, opts.model);
      adapters.push(a);
      return a;
    },
  });
}

const setVendor = (vendor: unknown) =>
  captured.get(IPC.DECK_BRAIN_VENDOR_SET)!({}, { vendor }) as Promise<{ vendor: BrainVendor }>;
const listBrainPtys = () =>
  captured.get(IPC.DECK_BRAIN_PTY_LIST)!({}, undefined) as Promise<{
    ptyIds: Record<string, string>;
  }>;
const send = (workspaceId: string) =>
  captured.get(IPC.DECK_SEND)!({}, { workspaceId, text: 'hi' }) as Promise<{ ok: boolean }>;

beforeEach(() => {
  captured.clear();
  adapters = [];
  sent = [];
  prompts = [];
  failNextTurn = false;
  sessionKeys.length = 0;
  cleanup?.();
  cleanup = null;
  register();
});

describe('deck handler — brain vendor narrowing', () => {
  it('accepts the three known vendors', async () => {
    expect((await setVendor('claude-pty')).vendor).toBe('claude-pty');
    expect((await setVendor('hermes')).vendor).toBe('hermes');
    expect((await setVendor('claude')).vendor).toBe('claude');
  });

  it('fails closed to the terminal brain for anything unknown', async () => {
    // The fail-closed target follows the DEFAULT, which moved with the store's
    // (uiSlice / loadSession). Coercing to a different vendor than the renderer
    // would also split the commander session key for the same bad input.
    for (const bad of ['gpt', '', null, 42, { vendor: 'claude-pty' }]) {
      expect((await setVendor(bad)).vendor).toBe('claude-pty');
    }
  });

  it('creates the next adapter on the selected vendor', async () => {
    await setVendor('claude-pty');
    await send('ws-1');
    expect(adapters).toHaveLength(1);
    expect(adapters[0].vendor).toBe('claude-pty');
  });

  it('keys the persisted session per vendor, so switching does not cross threads', async () => {
    await setVendor('claude-pty');
    await send('ws-1');
    expect(sessionKeys).toContain('ws-1::claude-pty');
    expect(sessionKeys).not.toContain('ws-1');
  });

  it('retires an idle stale-vendor brain and retracts its embedded terminal', async () => {
    await setVendor('claude-pty');
    await send('ws-1');
    sent.length = 0;
    await setVendor('claude');
    expect(adapters[0].disposed).toBe(true);
    expect(sent).toContainEqual({
      channel: IPC.DECK_BRAIN_PTY,
      payload: { workspaceId: 'ws-1', ptyId: null },
    });
  });
});

describe('deck handler — ambient blocks on a terminal brain', () => {
  it('re-sends the ambient blocks after a turn that never reached the brain', async () => {
    // A first turn that dies on Claude's own trust/sign-in dialog showed the
    // brain NOTHING. Marking the blocks "shown" when the prompt was BUILT made
    // the retry — and every turn after it — silently skip the autonomy/policy
    // rules for the rest of the conversation.
    await setVendor('claude-pty');
    failNextTurn = true;
    await send('ws-1');
    expect(prompts[0]).toContain('[autonomy]');
    await send('ws-1');
    expect(prompts[1]).toContain('[autonomy]');
    // …and once a turn DID land, the unchanged block stops repeating (the
    // whole reason a visible TUI brain gates them in the first place).
    await send('ws-1');
    expect(prompts[2]).not.toContain('[autonomy]');
  });

});

describe('deck handler — embedded terminal hydration', () => {
  it('serves the current brain pty ids to a renderer that just mounted', async () => {
    // DECK_BRAIN_PTY is a one-way push: everything sent before the renderer
    // subscribed (app start, a reload) is gone, so main has to be askable.
    await setVendor('claude-pty');
    await send('ws-1');
    expect((await listBrainPtys()).ptyIds).toEqual({});
    adapters[0].announcePty('brain-abc');
    expect((await listBrainPtys()).ptyIds).toEqual({ 'ws-1': 'brain-abc' });
    // A retraction clears it — a reloaded renderer must not embed a dead pty.
    adapters[0].announcePty(null);
    expect((await listBrainPtys()).ptyIds).toEqual({});
  });
});

describe('deck handler — the commander system prompt per vendor', () => {
  it('tells a terminal brain that memory persistence is unavailable', async () => {
    // The pty profile hard-denies Write, so the SDK brain's "you have a
    // sandboxed Write tool" policy would only produce blocked calls.
    await setVendor('claude-pty');
    await send('ws-1');
    const prompt = adapters[0].startOptions?.systemPrompt ?? '';
    expect(prompt).toContain('You have NO durable memory in this mode');
    expect(prompt).not.toContain('You have a Write tool');
  });

  it('keeps the Write/memory policy for the SDK brain', async () => {
    // Explicit: the terminal brain is the DEFAULT vendor now, so this case has
    // to select the SDK brain rather than lean on whatever the default is.
    await setVendor('claude');
    await send('ws-2');
    const prompt = adapters[0].startOptions?.systemPrompt ?? '';
    expect(prompt).toContain('You have a Write tool');
  });

  it('no daemon → the terminal brain resolves to the SDK brain, key and policy together', async () => {
    // The terminal brain's pty IS a daemon session, so with no daemon the deck
    // serves an SDK brain instead. Everything derived from the vendor has to
    // follow that runtime, not the request: otherwise an SDK session id lands
    // under the `::claude-pty` key (leaving the real terminal conversation
    // unresumable) and an SDK brain that DOES have Write is told it has no
    // durable memory.
    captured.clear();
    cleanup?.();
    adapters = [];
    sessionKeys.length = 0;
    cleanup = registerDeckHandler(() => fakeWindow, {
      getDaemonClient: () => null,
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts.vendor, opts.workspaceId, opts.onPtySpawned, opts.model);
        adapters.push(a);
        return a;
      },
    });

    await setVendor('claude-pty');
    await send('ws-1');
    expect(adapters[0].vendor).toBe('claude');
    expect(sessionKeys).toContain('ws-1');
    expect(sessionKeys).not.toContain('ws-1::claude-pty');
    expect(adapters[0].startOptions?.systemPrompt ?? '').toContain('You have a Write tool');
  });

  it('promotes the fallback brain back to the terminal one once the daemon returns', async () => {
    // The fallback manager must be recorded as what it IS ('claude'), or the
    // swap check compares two REQUESTS ('claude-pty' vs 'claude-pty'), finds
    // them equal, and strands the workspace on the SDK brain until restart.
    captured.clear();
    cleanup?.();
    adapters = [];
    let daemon: unknown = null;
    cleanup = registerDeckHandler(() => fakeWindow, {
      getDaemonClient: () => daemon as never,
      createAdapter: (opts) => {
        const a = new FakeAdapter(opts.vendor, opts.workspaceId, opts.onPtySpawned, opts.model);
        adapters.push(a);
        return a;
      },
    });

    await setVendor('claude-pty');
    await send('ws-1');
    expect(adapters[0].vendor).toBe('claude');
    daemon = {};
    await send('ws-1');
    expect(adapters).toHaveLength(2);
    expect(adapters[0].disposed).toBe(true);
    expect(adapters[1].vendor).toBe('claude-pty');
  });

  it('defaults to the terminal brain before the renderer syncs a vendor', async () => {
    // The main-side vendor is authoritative for turns that beat the renderer's
    // first DECK_BRAIN_VENDOR_SET (a schedule or event wake at launch). It must
    // agree with the store default, or those turns silently run the SDK brain.
    await send('ws-1');
    const prompt = adapters[0].startOptions?.systemPrompt ?? '';
    expect(prompt).toContain('You have NO durable memory in this mode');
  });
});
