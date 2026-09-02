import { describe, expect, it, vi } from 'vitest';
// vi.mock is hoisted above the imports, so the mocks below are in place by the
// time interaction.ts is evaluated.
import { clickWithApproach } from '../tools/interaction';

// interaction.ts pulls in the whole tool-registration graph; the module mocks
// below keep this focused on clickWithApproach alone.
vi.mock('../PlaywrightEngine', () => ({
  PlaywrightEngine: { getInstance: () => ({}) },
}));
vi.mock('../automationLease', () => ({ withAutomationLease: vi.fn() }));
vi.mock('../snapshot', () => ({
  browserScopeKey: vi.fn(),
  frameRefFallbackMessage: vi.fn(),
  isOutstandingFrameRef: () => false,
  resolveRef: vi.fn(),
}));
vi.mock('../dom-intelligence', () => ({ getLocatorByRef: vi.fn() }));
vi.mock('../human-typing', () => ({ typeHumanlike: vi.fn() }));
vi.mock('../browserScope', () => ({
  allowScopedRpcFallback: vi.fn(),
  sendScopedBrowserRpc: vi.fn(),
}));
vi.mock('../../browser-replay/actionRing', () => ({ recordAction: vi.fn() }));

const BOX = { x: 400, y: 300, width: 200, height: 60 };

function makePage() {
  // Params are declared so mock.calls is typed as the [x, y] pairs below read it.
  const move = vi.fn(async (_x: number, _y: number) => undefined);
  return {
    // A fresh object each time, so the per-page pointer WeakMap starts empty.
    page: { mouse: { move }, viewportSize: () => ({ width: 1280, height: 720 }) },
    move,
  };
}

function makeEl(box: typeof BOX | null, opts: { clickThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    el: {
      boundingBox: vi.fn(async () => box),
      scrollIntoViewIfNeeded: vi.fn(async () => { calls.push('scroll'); }),
      click: vi.fn(async (options?: { position?: { x: number; y: number } }) => {
        calls.push(options?.position ? 'click:positioned' : 'click:plain');
        if (options?.position && opts.clickThrows) {
          throw new Error('element is not visible');
        }
      }),
      dblclick: vi.fn(async (options?: { position?: { x: number; y: number } }) => {
        calls.push(options?.position ? 'dblclick:positioned' : 'dblclick:plain');
      }),
    },
  };
}

describe('clickWithApproach', () => {
  it('moves the pointer before clicking, and lands inside the box', async () => {
    const { page, move } = makePage();
    const { el } = makeEl(BOX);

    await clickWithApproach(page, el, false);

    expect(move).toHaveBeenCalled();
    const position = el.click.mock.calls[0]?.[0]?.position;
    if (!position) throw new Error('expected the click to carry a position');
    // Position is relative to the box origin and inside the inner 60%.
    expect(position.x).toBeGreaterThan(BOX.width * 0.2);
    expect(position.x).toBeLessThan(BOX.width * 0.8);
    expect(position.y).toBeGreaterThan(BOX.height * 0.2);
    expect(position.y).toBeLessThan(BOX.height * 0.8);
  });

  it('scrolls the element into view before measuring it', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX);
    const order: string[] = [];
    el.scrollIntoViewIfNeeded.mockImplementation(async () => { order.push('scroll'); });
    el.boundingBox.mockImplementation(async () => { order.push('measure'); return BOX; });

    await clickWithApproach(page, el, false);

    expect(order).toEqual(['scroll', 'measure']);
    expect(calls).toContain('click:positioned');
  });

  it('moves before it clicks, never after', async () => {
    const { page, move } = makePage();
    const { el } = makeEl(BOX);
    const order: string[] = [];
    move.mockImplementation(async () => { order.push('move'); });
    el.click.mockImplementation(async () => { order.push('click'); });

    await clickWithApproach(page, el, false);

    expect(order[order.length - 1]).toBe('click');
    expect(order.filter((s) => s === 'move').length).toBeGreaterThan(0);
    expect(order.indexOf('move')).toBeLessThan(order.indexOf('click'));
  });

  it('falls back to a plain click when the element has no box', async () => {
    const { page, move } = makePage();
    const { el, calls } = makeEl(null);

    await clickWithApproach(page, el, false);

    expect(move).not.toHaveBeenCalled();
    expect(calls).toContain('click:plain');
  });

  it('falls back to a plain click for a zero-area box', async () => {
    const { page, move } = makePage();
    const { el, calls } = makeEl({ x: 10, y: 10, width: 0, height: 20 });

    await clickWithApproach(page, el, false);

    expect(move).not.toHaveBeenCalled();
    expect(calls).toContain('click:plain');
  });

  it('aims at the centre of a small control instead of offsetting', async () => {
    const { page } = makePage();
    const small = { x: 100, y: 100, width: 16, height: 16 };
    const { el } = makeEl(small);

    await clickWithApproach(page, el, false);

    expect(el.click.mock.calls[0]?.[0]?.position).toEqual({ x: 8, y: 8 });
  });

  it('skips the approach when the target is outside the viewport', async () => {
    const { page, move } = makePage();
    const { el, calls } = makeEl({ x: 5000, y: 4000, width: 100, height: 40 });

    await clickWithApproach(page, el, false);

    expect(move).not.toHaveBeenCalled();
    expect(calls).toContain('click:plain');
  });

  it('retries once without the approach when the positioned click fails', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX, { clickThrows: true });

    await clickWithApproach(page, el, false);

    expect(calls).toEqual(['scroll', 'click:positioned', 'click:plain']);
  });

  it('routes a double click through dblclick', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX);

    await clickWithApproach(page, el, true);

    expect(calls).toContain('dblclick:positioned');
    expect(el.click).not.toHaveBeenCalled();
  });

  it('continues the next approach from where the last one ended', async () => {
    const { page, move } = makePage();
    const first = makeEl(BOX);
    await clickWithApproach(page, first.el, false);
    const endOfFirst = move.mock.calls.at(-1);

    move.mockClear();
    const second = makeEl({ x: 800, y: 500, width: 120, height: 40 });
    await clickWithApproach(page, second.el, false);

    // The second walk starts where the first one finished, not from the
    // default start point.
    const startOfSecond = move.mock.calls[0];
    if (!endOfFirst || !startOfSecond) throw new Error('expected pointer moves on both clicks');
    expect(startOfSecond).not.toEqual(endOfFirst);
    const dx = Math.abs(startOfSecond[0] - endOfFirst[0]);
    const dy = Math.abs(startOfSecond[1] - endOfFirst[1]);
    // One step's worth of travel, not a jump back across the viewport.
    expect(Math.hypot(dx, dy)).toBeLessThan(Math.hypot(800 - 400, 500 - 300));
  });
});
