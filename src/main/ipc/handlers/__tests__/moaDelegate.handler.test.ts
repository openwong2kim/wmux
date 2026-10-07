/**
 * moaDelegate.handler — the owner's renderer IPC for Moa's delegate.
 *
 * Off (no service registered) must be inert: LIST answers the empty off shape
 * and RESOLVE / AUTO_SET refuse without reaching anything. Every request is
 * validated with the contract's parsers before the service sees it, and the
 * service's events reach the window exactly once per event, also across a
 * service swap and a handler teardown.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((c: string, fn: (...args: unknown[]) => unknown) => { handlers.set(c, fn); }),
      removeHandler: vi.fn((c: string) => { handlers.delete(c); }),
    },
    __handlers: handlers,
  };
});

import type { BrowserWindow } from 'electron';
import { IPC } from '../../../../shared/constants';
import type { MoaDelegateEvents, MoaDelegateServicePort } from '../../../deck/moaDelegatePorts';
import { createMoaDelegateHandlers, registerMoaDelegateHandlers } from '../moaDelegate.handler';

const DECISION_ID = 'moa-d-00000000-0000-4000-8000-000000000001';
const HEAD = 'a'.repeat(40);

function fakeWindow() {
  const send = vi.fn();
  const win = { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow;
  return { win, send };
}

function fakeService() {
  const listeners: MoaDelegateEvents[] = [];
  const unsubscribe = vi.fn();
  const svc: MoaDelegateServicePort = {
    ask: vi.fn(),
    status: vi.fn(),
    list: vi.fn(async () => ({ mode: 'suggest' as const, decisions: [], effects: [], rules: [] })),
    resolveByOwner: vi.fn(async () => ({ ok: false as const, code: 'stale' as const, message: 'moved' })),
    setAutoRule: vi.fn(async () => ({ ok: true as const, autoRules: ['R-merge-green'] })),
    subscribe: vi.fn((l: MoaDelegateEvents) => { listeners.push(l); return unsubscribe; }),
  };
  return { svc, listeners, unsubscribe };
}

describe('moaDelegate handler — off (no service)', () => {
  it('lists the empty off shape and refuses resolve / auto-set', async () => {
    const { win, send } = fakeWindow();
    const h = createMoaDelegateHandlers(() => win, { getService: () => null });
    expect(await h.list()).toEqual({ mode: 'off', decisions: [], effects: [], rules: [] });
    const r = await h.resolve({ decisionId: DECISION_ID, answer: { type: 'dismiss' } });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    const a = await h.autoSet({ ruleId: 'R-merge-green', auto: true });
    expect(a).toMatchObject({ ok: false, code: 'invalid' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('moaDelegate handler — validation', () => {
  it('rejects malformed requests before the service sees them', async () => {
    const { svc } = fakeService();
    const h = createMoaDelegateHandlers(() => null, { getService: () => svc });
    const bad: unknown[] = [
      null,
      { decisionId: 'nope', answer: { type: 'dismiss' } },
      { decisionId: DECISION_ID, answer: { type: 'merge', approve: true, expectHead: 'abc' } },
      { decisionId: DECISION_ID, answer: { type: 'merge', approve: 'yes', expectHead: HEAD } },
      { decisionId: DECISION_ID, answer: { type: 'choice', choiceKey: 'a', extra: 1 } },
      { decisionId: DECISION_ID, answer: { type: 'approval.press' } },
      { decisionId: DECISION_ID, answer: { type: 'dismiss' }, by: 'owner' },
    ];
    for (const raw of bad) expect(await h.resolve(raw)).toMatchObject({ ok: false, code: 'invalid' });
    expect(await h.autoSet({ ruleId: 'merge-green', auto: true })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await h.autoSet({ ruleId: 'R-x', auto: 'true' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(svc.resolveByOwner).not.toHaveBeenCalled();
    expect(svc.setAutoRule).not.toHaveBeenCalled();
  });

  it('passes only the parsed request through', async () => {
    const { svc } = fakeService();
    const h = createMoaDelegateHandlers(() => null, { getService: () => svc });
    const r = await h.resolve({ decisionId: DECISION_ID, answer: { type: 'merge', approve: true, expectHead: HEAD } });
    expect(r).toEqual({ ok: false, code: 'stale', message: 'moved' });
    expect(svc.resolveByOwner).toHaveBeenCalledWith({ decisionId: DECISION_ID, answer: { type: 'merge', approve: true, expectHead: HEAD } });
    expect(await h.autoSet({ ruleId: 'R-merge-green', auto: true })).toEqual({ ok: true, autoRules: ['R-merge-green'] });
  });
});

describe('moaDelegate handler — events', () => {
  it('subscribes once per service, forwards both events, re-subscribes on a swap', async () => {
    const { win, send } = fakeWindow();
    const a = fakeService();
    const b = fakeService();
    let current: MoaDelegateServicePort | null = null;
    const h = createMoaDelegateHandlers(() => win, { getService: () => current });
    await h.list();
    expect(a.svc.subscribe).not.toHaveBeenCalled();

    current = a.svc;
    await h.list();
    await h.list();
    expect(a.svc.subscribe).toHaveBeenCalledTimes(1);
    a.listeners[0].effect({ effect: { id: 'e' } as never });
    expect(send).toHaveBeenCalledWith(IPC.DECK_MOA_DELEGATE_EFFECT_EVENT, { effect: { id: 'e' } });

    current = b.svc;
    await h.list();
    expect(a.unsubscribe).toHaveBeenCalledTimes(1);
    b.listeners[0].decision({ type: 'created', decision: { id: 'd' } as never });
    expect(send).toHaveBeenCalledWith(IPC.DECK_MOA_DELEGATE_DECISION_EVENT, { type: 'created', decision: { id: 'd' } });

    current = null;
    await h.list();
    expect(b.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('registers the three channels and detaches on cleanup', async () => {
    const s = fakeService();
    const cleanup = registerMoaDelegateHandlers(() => null, { getService: () => s.svc });
    const electron = (await import('electron')) as unknown as { __handlers: Map<string, (...args: unknown[]) => unknown> };
    expect(s.svc.subscribe).toHaveBeenCalledTimes(1);
    const list = electron.__handlers.get(IPC.DECK_MOA_DELEGATE_LIST);
    expect(await list!({})).toMatchObject({ mode: 'suggest' });
    cleanup();
    expect(s.unsubscribe).toHaveBeenCalledTimes(1);
    expect(electron.__handlers.has(IPC.DECK_MOA_DELEGATE_LIST)).toBe(false);
  });
});
