// @wmux-lane unit
// Pure functions: "win32" is only the helper OS passed to foregroundCertain,
// never process.platform, so the machine running it cannot change the result.
import { describe, expect, it } from 'vitest';
import { ComputerError } from '../../../shared/computer/errors';
import { ForegroundLease, INPUT_LOCK_IDLE_MS, PidLanes, foregroundCertain, textMovesFocus } from '../inputLanes';

/** Runs every queued microtask and promise reaction. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('ForegroundLease', () => {
  it('is held by one agent until it goes idle, and never waits', () => {
    const lease = new ForegroundLease();
    const a = { key: 'a', label: 'agent A' };
    const b = { key: 'b', label: 'agent B' };
    lease.touch(lease.take(a, 0), 0);
    expect(() => lease.take(b, INPUT_LOCK_IDLE_MS)).toThrow(ComputerError);
    try {
      lease.take(b, 1);
    } catch (err) {
      expect((err as ComputerError).code).toBe('input_busy');
      expect((err as ComputerError).message).toContain('agent A');
    }
    lease.touch(lease.take(a, 10), 10); // the holder refreshes it
    expect(lease.label(10 + INPUT_LOCK_IDLE_MS)).toBe('agent A');
    lease.take(b, 10 + INPUT_LOCK_IDLE_MS + 1);
    expect(lease.label(10 + INPUT_LOCK_IDLE_MS + 1)).toBe('agent B');
    lease.clear();
    expect(lease.label(0)).toBeNull();
  });

  it('never expires while its real-input request is still in flight; idle time counts from touch', () => {
    const lease = new ForegroundLease();
    const a = { key: 'a', label: 'agent A' };
    const d = { key: 'd', label: 'agent D' };
    const ticket = lease.take(a, 0);
    // A's request waits in the helper's queue for 20 s.
    expect(() => lease.take(d, 16_000)).toThrow(/agent A/);
    expect(lease.label(20_000)).toBe('agent A');
    lease.touch(ticket, 20_000);
    expect(() => lease.take(d, 20_000 + INPUT_LOCK_IDLE_MS)).toThrow(/agent A/);
    lease.take(d, 20_000 + INPUT_LOCK_IDLE_MS + 1);
    expect(lease.label(20_000 + INPUT_LOCK_IDLE_MS + 1)).toBe('agent D');
  });

  it('a touch after a stop cleared the lease, or by another agent, changes nothing', () => {
    const lease = new ForegroundLease();
    const a = { key: 'a', label: 'agent A' };
    const ticket = lease.take(a, 0);
    lease.touch({ ...ticket, agentKey: 'b' }, 1);
    expect(lease.label(INPUT_LOCK_IDLE_MS + 5)).toBe('agent A'); // still busy
    lease.clear();
    lease.touch(ticket, 2);
    expect(lease.label(2)).toBeNull();
  });

  it('a request taken before a stop cannot release the same agent\'s lease taken after it', () => {
    const lease = new ForegroundLease();
    const a = { key: 'a', label: 'agent A' };
    const b = { key: 'b', label: 'agent B' };
    const old = lease.take(a, 0);
    lease.clear(); // the stop key
    lease.take(a, 5_000); // A's next real input, still on its way
    lease.touch(old, 6_000); // the request from before the stop settles
    expect(() => lease.take(b, 6_000 + INPUT_LOCK_IDLE_MS + 1)).toThrow(/agent A/);
  });
});

describe('PidLanes', () => {
  it('runs one pid in arrival order and never makes another pid wait', async () => {
    const lanes = new PidLanes();
    const order: string[] = [];
    const first = await lanes.acquire(10);
    let secondGot = false;
    const second = lanes.acquire(10).then((release) => { secondGot = true; order.push('10b'); return release; });
    const other = await lanes.acquire(12); // not blocked by pid 10
    order.push('12');
    await settle();
    expect(secondGot).toBe(false);
    other();
    order.push('10a done');
    first();
    (await second)();
    expect(order).toEqual(['12', '10a done', '10b']);
    await settle();
    expect(lanes.busyPids()).toEqual([]);
  });

  it('ends every waiter aborted on a stop, and keeps the chain usable', async () => {
    const lanes = new PidLanes();
    const holder = await lanes.acquire(10);
    const waiters = [lanes.acquire(10), lanes.acquire(10)];
    lanes.abortWaiting();
    for (const w of waiters) {
      await expect(w).rejects.toMatchObject({ code: 'aborted' });
    }
    holder();
    // A new action after the stop gets the slot once the old holder is gone.
    const next = await lanes.acquire(10);
    next();
  });

  it('retains no waiter after many acquire/release cycles without a stop', async () => {
    const lanes = new PidLanes();
    for (let i = 0; i < 200; i++) {
      const pid = 10 + (i % 3);
      const held = await lanes.acquire(pid);
      const queued = lanes.acquire(pid);
      expect(lanes.waitingCount()).toBe(1);
      held();
      (await queued)();
    }
    await settle();
    expect(lanes.waitingCount()).toBe(0);
    expect(lanes.busyPids()).toEqual([]);
  });

  it('drops an aborted waiter from the waiting set', async () => {
    const lanes = new PidLanes();
    const held = await lanes.acquire(10);
    const queued = lanes.acquire(10);
    expect(lanes.waitingCount()).toBe(1);
    lanes.abortWaiting();
    await expect(queued).rejects.toMatchObject({ code: 'aborted' });
    expect(lanes.waitingCount()).toBe(0);
    held();
  });

  it('a release called twice is harmless', async () => {
    const lanes = new PidLanes();
    const release = await lanes.acquire(10);
    release();
    release();
    (await lanes.acquire(10))();
  });
});

describe('foregroundCertain', () => {
  // Windows: one row per row of Core Background.ActionRefusal, plus openApp (main only).
  it.each([
    ['scroll: always', { action: 'scroll' as const }, true],
    ['click: right button', { action: 'click' as const, button: 'right' as const }, true],
    ['click: middle button', { action: 'click' as const, button: 'middle' as const }, true],
    ['click: modifiers', { action: 'click' as const, modifiers: ['ctrl' as const] }, true],
    ['click: double', { action: 'click' as const, clickCount: 2 }, true],
    ['click: triple', { action: 'click' as const, clickCount: 3 }, true],
    ['click: plain left', { action: 'click' as const }, false],
    ['click: explicit plain left', { action: 'click' as const, button: 'left' as const, clickCount: 1, modifiers: [] }, false],
    ['hotkey: with modifiers (a chord)', { action: 'hotkey' as const, modifiers: ['ctrl' as const] }, true],
    ['hotkey: without modifiers (a plain key)', { action: 'hotkey' as const, modifiers: [] }, false],
    ['hotkey: modifiers left out', { action: 'hotkey' as const }, false],
    ['type: plain text', { action: 'type' as const, text: 'hello' }, false],
    ['type: one trailing newline', { action: 'type' as const, text: 'hello\n' }, false],
    ['type: a Tab', { action: 'type' as const, text: 'user\tpass' }, true],
    ['type: an inner newline', { action: 'type' as const, text: 'a\nb' }, true],
    ['pressKey: never', { action: 'pressKey' as const }, false],
    ['setValue: never (a UIA call)', { action: 'setValue' as const }, false],
    ['openApp: always (main only)', { action: 'openApp' as const }, true],
  ])('win32 %s', (_row, req, expected) => {
    expect(foregroundCertain(req, 'win32')).toBe(expected);
  });

  // macOS: the rows of the helper's foregroundReason that depend on the
  // action alone, plus openApp (main only). Everything else goes with
  // `refuse`; the helper answers needs_foreground when the target needs it.
  it.each([
    ['openApp: always (main only)', { action: 'openApp' as const }, true],
    ['click: right button', { action: 'click' as const, button: 'right' as const }, true],
    ['click: middle button', { action: 'click' as const, button: 'middle' as const }, true],
    ['click: triple', { action: 'click' as const, clickCount: 3 }, true],
    ['click: plain left', { action: 'click' as const }, false],
    ['click: double', { action: 'click' as const, clickCount: 2 }, false],
    ['click: modifiers', { action: 'click' as const, modifiers: ['meta' as const] }, false],
    ['scroll: the helper decides', { action: 'scroll' as const }, false],
    ['hotkey: with modifiers', { action: 'hotkey' as const, modifiers: ['meta' as const] }, false],
    ['hotkey: without modifiers', { action: 'hotkey' as const, modifiers: [] }, false],
    ['type: plain text', { action: 'type' as const, text: 'hello' }, false],
    ['type: a Tab', { action: 'type' as const, text: 'user\tpass' }, false],
    ['type: an inner newline', { action: 'type' as const, text: 'a\nb' }, false],
    ['pressKey: never', { action: 'pressKey' as const }, false],
    ['setValue: never (an AX call)', { action: 'setValue' as const }, false],
  ])('darwin %s', (_row, req, expected) => {
    expect(foregroundCertain(req, 'darwin')).toBe(expected);
  });

  it.each([
    ['hello', false],
    ['hello\n', false],
    ['hello\r\n', false],
    ['hello\r', false],
    ['café \u{1F600}', false],
    ['a\tb', true],
    ['hello\n\n', true],
    ['a\u001bb', true],
    ['a\u0085b', true],
    ['a\u007fb', true],
  ])('textMovesFocus(%j) is %s', (text, expected) => {
    expect(textMovesFocus(text)).toBe(expected);
  });
});
