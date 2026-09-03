import { describe, expect, it, vi } from 'vitest';
import { dispatchTouchDrag, dispatchTouchTap } from '../touchInput';
import { MAX_STEPS } from '../pointerPath';

// The gesture a device preset with a touchscreen produces. What matters here is
// the shape on the wire: a page reading TouchEvent.touches, or Blink deriving
// pointer/mouse/click events from the sequence, sees exactly these.

function sender() {
  const sent: Array<{ method: string; params: { type?: string; touchPoints?: Array<Record<string, number>> } }> = [];
  return {
    sent,
    session: {
      send: vi.fn(async (method: string, params?: unknown) => {
        sent.push({ method, params: (params ?? {}) as { type?: string } });
        return {};
      }),
    },
  };
}

describe('dispatchTouchTap', () => {
  it('sends touchStart then touchEnd, and no mouse event at all', async () => {
    const { sent, session } = sender();

    await dispatchTouchTap(session, { x: 120, y: 240 }, () => 0);

    expect(sent.map((s) => s.method)).toEqual([
      'Input.dispatchTouchEvent',
      'Input.dispatchTouchEvent',
    ]);
    expect(sent.map((s) => s.params.type)).toEqual(['touchStart', 'touchEnd']);
    expect(sent.some((s) => s.method.includes('Mouse'))).toBe(false);
  });

  it('puts one contact at the point, with a fingertip-sized radius', async () => {
    const { sent, session } = sender();

    await dispatchTouchTap(session, { x: 120, y: 240 }, () => 0);

    const start = sent[0].params.touchPoints;
    if (!start) throw new Error('expected touchStart to carry a contact');
    expect(start).toHaveLength(1);
    expect(start[0].x).toBe(120);
    expect(start[0].y).toBe(240);
    // A 1px default radius is a stylus; a finger is an order of magnitude wider.
    expect(start[0].radiusX).toBeGreaterThan(5);
    expect(start[0].radiusY).toBeGreaterThan(5);
  });

  it('lifts with an empty touchPoints — nothing is left on the glass', async () => {
    const { sent, session } = sender();

    await dispatchTouchTap(session, { x: 10, y: 10 }, () => 0);

    expect(sent[1].params.touchPoints).toEqual([]);
  });

  it('holds between the press and the lift instead of tapping in zero time', async () => {
    const { session } = sender();
    const started = Date.now();

    await dispatchTouchTap(session, { x: 10, y: 10 }, () => 0);

    // The floor of the randomised hold, minus timer slack.
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});

describe('dispatchTouchDrag', () => {
  it('presses, moves along the path, and lifts', async () => {
    const { sent, session } = sender();

    await dispatchTouchDrag(session, { x: 100, y: 100 }, { x: 300, y: 400 });

    const types = sent.map((s) => s.params.type);
    expect(types[0]).toBe('touchStart');
    expect(types[types.length - 1]).toBe('touchEnd');
    expect(types.filter((t) => t === 'touchMove').length).toBeGreaterThan(0);
    expect(sent.every((s) => s.method === 'Input.dispatchTouchEvent')).toBe(true);
  });

  it('keeps one contact id across the whole gesture', async () => {
    const { sent, session } = sender();

    await dispatchTouchDrag(session, { x: 0, y: 0 }, { x: 200, y: 0 });

    const ids = sent
      .filter((s) => s.params.type !== 'touchEnd')
      .map((s) => s.params.touchPoints?.[0].id);
    expect(new Set(ids).size).toBe(1);
  });

  it('bounds the moves however far the drag runs', async () => {
    const { sent, session } = sender();

    await dispatchTouchDrag(session, { x: 0, y: 0 }, { x: 8000, y: 6000 });

    const moves = sent.filter((s) => s.params.type === 'touchMove').length;
    expect(moves).toBeLessThanOrEqual(MAX_STEPS + 1);
  });
});
