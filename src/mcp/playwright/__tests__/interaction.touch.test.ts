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
  const move = vi.fn(async (_x: number, _y: number) => undefined);
  return {
    // A fresh object each time, so the per-page pointer WeakMap starts empty.
    page: { mouse: { move }, viewportSize: () => ({ width: 1280, height: 720 }) },
    move,
  };
}

function makeEl(box: typeof BOX | null, opts: { trialThrows?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    el: {
      boundingBox: vi.fn(async () => box),
      scrollIntoViewIfNeeded: vi.fn(async () => { calls.push('scroll'); }),
      click: vi.fn(async (options?: { position?: { x: number; y: number }; trial?: boolean }) => {
        if (options?.trial) {
          calls.push('trial');
          if (opts.trialThrows) throw new Error('element is not visible');
          return;
        }
        calls.push(options?.position ? 'click:positioned' : 'click:plain');
      }),
      dblclick: vi.fn(async (options?: { position?: { x: number; y: number } }) => {
        calls.push(options?.position ? 'dblclick:positioned' : 'dblclick:plain');
      }),
    },
  };
}

// A device preset with a touchscreen changes what a click IS. These check that
// the touch path replaces the mouse rather than joining it, and that everything
// without a preset is byte-for-byte the behaviour it had before.

describe('clickWithApproach under a touchscreen preset', () => {
  it('taps at the target point and sends no mouse move at all', async () => {
    const { page, move } = makePage();
    const { el, calls } = makeEl(BOX);
    const tap = vi.fn(async (_p: { x: number; y: number }) => undefined);

    const dispatch = await clickWithApproach(page, el, false, tap);

    expect(dispatch).toBe('touch');
    expect(tap).toHaveBeenCalledTimes(1);
    // A touchscreen has nothing resting on the page between gestures, so the
    // approach path is skipped outright.
    expect(move).not.toHaveBeenCalled();
    expect(calls).not.toContain('click:positioned');
    expect(calls).not.toContain('click:plain');
    // The tap lands where the mouse would have: inside the box, off-centre.
    const point = tap.mock.calls[0][0];
    expect(point.x).toBeGreaterThan(BOX.x);
    expect(point.x).toBeLessThan(BOX.x + BOX.width);
    expect(point.y).toBeGreaterThan(BOX.y);
    expect(point.y).toBeLessThan(BOX.y + BOX.height);
  });

  it('runs the actionability checks first, as a trial that dispatches nothing', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX);
    const order: string[] = [];
    el.click.mockImplementation(async () => { order.push('trial'); });
    const tap = vi.fn(async () => { order.push('tap'); });

    await clickWithApproach(page, el, false, tap);

    expect(order).toEqual(['trial', 'tap']);
    expect(el.click.mock.calls[0]?.[0]?.trial).toBe(true);
    expect(calls).toContain('scroll');
  });

  it('leaves the click to the mouse when the element is not actionable', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX, { trialThrows: true });
    const tap = vi.fn(async () => undefined);

    const dispatch = await clickWithApproach(page, el, false, tap);

    expect(dispatch).toBe('mouse');
    expect(tap).not.toHaveBeenCalled();
    expect(calls).toContain('click:plain');
  });

  it('falls back to the mouse when touch dispatch itself refuses', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX);
    const tap = vi.fn(async () => { throw new Error('touch not supported'); });

    const dispatch = await clickWithApproach(page, el, false, tap);

    // A click that lands is worth more than one that matches the hardware.
    expect(dispatch).toBe('mouse');
    expect(calls).toContain('click:plain');
  });

  it('keeps a double click on the mouse — a touchscreen has no such gesture', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(BOX);
    const tap = vi.fn(async () => undefined);

    const dispatch = await clickWithApproach(page, el, true, tap);

    expect(dispatch).toBe('mouse');
    expect(tap).not.toHaveBeenCalled();
    expect(calls).toContain('dblclick:positioned');
  });

  it('falls back to the mouse for an element with no box', async () => {
    const { page } = makePage();
    const { el, calls } = makeEl(null);
    const tap = vi.fn(async () => undefined);

    const dispatch = await clickWithApproach(page, el, false, tap);

    expect(dispatch).toBe('mouse');
    expect(tap).not.toHaveBeenCalled();
    expect(calls).toContain('click:plain');
  });
});

describe('clickWithApproach without a preset', () => {
  it('is the mouse path it always was', async () => {
    const { page, move } = makePage();
    const { el, calls } = makeEl(BOX);

    const dispatch = await clickWithApproach(page, el, false);

    expect(dispatch).toBe('mouse');
    expect(move).toHaveBeenCalled();
    expect(calls).toContain('click:positioned');
    expect(calls).not.toContain('trial');
  });
});
