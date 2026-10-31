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
    lease.take(a, 0);
    expect(() => lease.take(b, INPUT_LOCK_IDLE_MS)).toThrow(ComputerError);
    try {
      lease.take(b, 1);
    } catch (err) {
      expect((err as ComputerError).code).toBe('input_busy');
      expect((err as ComputerError).message).toContain('agent A');
    }
    lease.take(a, 10); // the holder refreshes it
    expect(lease.label(10 + INPUT_LOCK_IDLE_MS)).toBe('agent A');
    lease.take(b, 10 + INPUT_LOCK_IDLE_MS + 1);
    expect(lease.label(10 + INPUT_LOCK_IDLE_MS + 1)).toBe('agent B');
    lease.clear();
    expect(lease.label(0)).toBeNull();
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

  it('a release called twice is harmless', async () => {
    const lanes = new PidLanes();
    const release = await lanes.acquire(10);
    release();
    release();
    (await lanes.acquire(10))();
  });
});

describe('foregroundCertain (mirrors Core Background.ActionRefusal)', () => {
  it.each([
    [{ action: 'openApp' as const }, true],
    [{ action: 'hotkey' as const }, true],
    [{ action: 'scroll' as const }, true],
    [{ action: 'click' as const, modifiers: ['ctrl' as const] }, true],
    [{ action: 'click' as const, button: 'right' as const }, true],
    [{ action: 'click' as const, button: 'middle' as const }, true],
    [{ action: 'click' as const, clickCount: 2 }, true],
    [{ action: 'click' as const }, false],
    [{ action: 'click' as const, button: 'left' as const, clickCount: 1, modifiers: [] }, false],
    [{ action: 'type' as const, text: 'hello' }, false],
    [{ action: 'type' as const, text: 'hello\n' }, false],
    [{ action: 'type' as const, text: 'user\tpass' }, true],
    [{ action: 'type' as const, text: 'a\nb' }, true],
    [{ action: 'pressKey' as const }, false],
    [{ action: 'setValue' as const }, false],
  ])('%o -> %s', (req, expected) => {
    expect(foregroundCertain(req)).toBe(expected);
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
