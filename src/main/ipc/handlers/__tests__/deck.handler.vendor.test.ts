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

import { registerDeckHandler } from '../deck.handler';
import { IPC } from '../../../../shared/constants';
import type { BrainAdapter, BrainEvent, BrainStartOptions } from '../../../deck/BrainAdapter';
import type { BrainVendor } from '../../../../shared/types';

class FakeAdapter implements BrainAdapter {
  sessionId: string | null = null;
  disposed = false;
  constructor(public readonly vendor: BrainVendor | undefined, public readonly workspaceId: string) {}
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  start(_opts: BrainStartOptions): void {
    /* nothing to prime in the fake */
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async *send(_text: string): AsyncIterable<BrainEvent> {
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
      const a = new FakeAdapter(opts.vendor, opts.workspaceId);
      adapters.push(a);
      return a;
    },
  });
}

const setVendor = (vendor: unknown) =>
  captured.get(IPC.DECK_BRAIN_VENDOR_SET)!({}, { vendor }) as Promise<{ vendor: BrainVendor }>;
const send = (workspaceId: string) =>
  captured.get(IPC.DECK_SEND)!({}, { workspaceId, text: 'hi' }) as Promise<{ ok: boolean }>;

beforeEach(() => {
  captured.clear();
  adapters = [];
  sent = [];
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

  it('fails closed to claude for anything unknown', async () => {
    for (const bad of ['gpt', '', null, 42, { vendor: 'claude-pty' }]) {
      expect((await setVendor(bad)).vendor).toBe('claude');
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
