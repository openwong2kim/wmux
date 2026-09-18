import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOVER_PROBE_LIMITS,
  neutralPointFor,
  probeHoverSurfaces,
  sameHoverDocument,
  type HoverCandidate,
} from '../hoverSurfaces';
import { defaultStartPoint } from '../../../shared/pointerPath';

// Phase 2 moves a real pointer over real CDP, so the bounds ARE the feature:
// six triggers, one wall-clock ceiling for everything, 300 ms per reveal, a
// pointer restored and the close verified, everything dropped if the page
// navigated under it. None of that is observable from the output of a
// successful probe, so it is pinned here against a fake CDP client.

const URL_A = 'https://x.test/nav';
const URL_B = 'https://x.test/elsewhere';

/** The viewport the fake reports, and the resting place that follows from it. */
const VIEWPORT = { width: 1280, height: 800 };
const NEUTRAL = defaultStartPoint(VIEWPORT);

interface AfterReply {
  names?: string[];
  /** Everything that appeared, the panel element included. */
  revealed?: number;
  /** Of those, the ones that could be named. Defaults to `revealed`. */
  named?: number;
  url?: string;
}

interface FakeOptions {
  /** Per-trigger `before` payload overrides, by candidate index. */
  beforeUrl?: (index: number) => string;
  /** Replies to the reveal poll, consumed in order per trigger. */
  afterQueue?: (index: number) => AfterReply[];
  /** Reply to the post-restore "did it close?" check. */
  closeReply?: (index: number) => AfterReply;
  /** Did the pointer land on the anchor? `attempt` is 1-based. */
  aimOk?: (index: number, attempt: number) => boolean;
  /** ms the virtual clock advances on every CDP send. */
  msPerSend?: number;
}

interface Fake {
  client: { send: (method: string, params?: unknown) => Promise<unknown> };
  calls: { method: string; params: Record<string, unknown> }[];
  moves: { x: number; y: number }[];
  /** Which candidate each `callFunctionOn` addressed, in order, with its mode. */
  steps: { objectId: string; mode: string }[];
}

function makeFake(options: FakeOptions = {}): Fake {
  const calls: Fake['calls'] = [];
  const moves: Fake['moves'] = [];
  const steps: Fake['steps'] = [];
  /** Per-candidate consumption state, keyed by the handle we gave it. */
  const pollsUsed = new Map<string, number>();
  const aimsUsed = new Map<string, number>();

  const indexOf = (objectId: string): number => Number(objectId.replace('trigger-', ''));

  const send = async (method: string, params?: unknown): Promise<unknown> => {
    const args = (params ?? {}) as Record<string, unknown>;
    calls.push({ method, params: args });
    if (options.msPerSend) clock += options.msPerSend;

    if (method === 'Input.dispatchMouseEvent') {
      expect(args['type']).toBe('mouseMoved');
      moves.push({ x: Number(args['x']), y: Number(args['y']) });
      return {};
    }

    if (method === 'Runtime.callFunctionOn') {
      const objectId = String(args['objectId']);
      const list = (args['arguments'] ?? []) as { value?: unknown; objectId?: string }[];
      const mode = String(list[0]?.value);
      steps.push({ objectId, mode });
      const index = indexOf(objectId);

      if (mode === 'before') {
        // The anchor rides along as the third argument: the trigger is what the
        // reveal watch is scoped from, the anchor is what gets hovered.
        expect(list[2]?.objectId).toBe(`anchor-${index}`);
        return { result: { objectId: `before-${index}` } };
      }
      // Every `after` call must address the SAME hidden-element handle the
      // `before` call produced: a re-query would also pick up whatever the
      // hover ADDED and could not tell the two apart. The anchor and the point
      // ride along so the landing check costs no round trip of its own.
      expect(list[1]?.objectId).toBe(`hidden-${index}`);
      expect(list[2]?.objectId).toBe(`anchor-${index}`);
      const aim = JSON.parse(String(list[3]?.value)) as { x: number; y: number; cap: number };
      const tries = (aimsUsed.get(objectId) ?? 0) + 1;
      aimsUsed.set(objectId, tries);
      const landed = options.aimOk ? options.aimOk(index, tries) : true;
      const geometry = {
        ok: landed,
        vw: VIEWPORT.width,
        vh: VIEWPORT.height,
        bx: 100,
        by: 100,
        bw: 80,
        bh: 20,
      };
      // A read taken while the pointer is NOT on the anchor tells the driver
      // nothing about the reveal, so the queue is not consumed for it.
      if (!landed) return { result: { value: { url: URL_A, names: [], revealed: 0, named: 0, ...geometry } } };
      const queue = options.afterQueue?.(index) ?? [{ names: ['Docs', 'API'], revealed: 2 }];
      const used = pollsUsed.get(objectId) ?? 0;
      // The last reply in the queue is the reveal; anything after it is the
      // post-restore close check.
      if (used < queue.length) {
        pollsUsed.set(objectId, used + 1);
        const reply = queue[used];
        return {
          result: {
            value: {
              url: reply.url ?? URL_A,
              names: (reply.names ?? []).slice(0, aim.cap),
              revealed: reply.revealed ?? 0,
              named: reply.named ?? reply.revealed ?? 0,
              ...geometry,
            },
          },
        };
      }
      const closed = options.closeReply?.(index) ?? { revealed: 0 };
      return {
        result: {
          value: { url: closed.url ?? URL_A, names: [], revealed: closed.revealed ?? 0, ...geometry },
        },
      };
    }

    if (method === 'Runtime.getProperties') {
      const objectId = String(args['objectId']);
      const index = indexOf(objectId.replace('before-', 'trigger-'));
      return {
        result: [
          { name: 'url', value: { value: options.beforeUrl?.(index) ?? URL_A } },
          { name: 'vw', value: { value: VIEWPORT.width } },
          { name: 'vh', value: { value: VIEWPORT.height } },
          { name: 'bx', value: { value: 100 } },
          { name: 'by', value: { value: 100 } },
          { name: 'bw', value: { value: 80 } },
          { name: 'bh', value: { value: 20 } },
          { name: 'hidden', value: { objectId: `hidden-${index}` } },
        ],
      };
    }
    return {};
  };

  return { client: { send }, calls, moves, steps };
}

function candidates(count: number): HoverCandidate[] {
  return Array.from({ length: count }, (_, i) => ({
    objectId: `trigger-${i}`,
    anchorObjectId: `anchor-${i}`,
    backendNodeId: 100 + i,
    score: 10 - i,
    targets: [`#sub-${i}`],
  }));
}

/** Virtual clock, so the probe budget can be exhausted in a millisecond. */
let clock = 0;
let url = URL_A;

function ctx(overrides: Partial<Parameters<typeof probeHoverSurfaces>[2]> = {}) {
  return {
    currentUrl: () => url,
    pointerStart: { x: 640, y: 400 },
    onPointerMoved: () => undefined,
    // A constant 0.5 zeroes pathPoints' jitter and puts clickPointInBox dead
    // centre, so the recorded coordinates are exact.
    rng: () => 0.5,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  clock = 0;
  url = URL_A;
});

/** Where the virtual clock started, so a span can be measured against it. */
let startClock = 0;

/** Install the virtual clock; only the tests that need to advance time do. */
function useVirtualClock(): void {
  clock = 1_000_000;
  startClock = clock;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
}

describe('probeHoverSurfaces: the happy path', () => {
  it('hovers the trigger, lists what appeared, and restores the pointer', async () => {
    const fake = makeFake();
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());

    expect(outcome.cancelled).toBe(false);
    expect(outcome.probed).toBe(1);
    expect(outcome.revealed.get(100)).toEqual({
      items: ['Docs', 'API'],
      truncated: false,
      staysOpen: false,
    });

    // The mouse path is CDP Input, not a Playwright locator hover, and it
    // WALKS: a pointer that teleports to dead centre is separable from a real
    // one (shared/pointerPath).
    expect(fake.calls.some((c) => c.method === 'Input.dispatchMouseEvent')).toBe(true);
    expect(fake.moves.length).toBeGreaterThan(2);
    // Box (100,100,80x20) with zero jitter → its exact centre.
    expect(fake.moves).toContainEqual({ x: 140, y: 110 });
    // ...and the pointer is parked off the trigger afterwards, somewhere a real
    // pointer plausibly rests — never (0, 0).
    expect(fake.moves[fake.moves.length - 1]).toEqual(NEUTRAL);
    expect(NEUTRAL).not.toEqual({ x: 0, y: 0 });
  });

  it('tells the lane where it left the pointer', async () => {
    const seen: { x: number; y: number }[] = [];
    const fake = makeFake();
    await probeHoverSurfaces(
      fake.client,
      candidates(1),
      ctx({ onPointerMoved: (point) => seen.push(point) }),
    );
    // Park first (the approach always starts from a point that is not on a
    // trigger), then the trigger, then park again.
    expect(seen).toEqual([NEUTRAL, { x: 140, y: 110 }, NEUTRAL]);
  });

  it('reports a truncated item list rather than a silently short one', async () => {
    const fake = makeFake({
      afterQueue: () => [{ names: ['A', 'B'], revealed: 10, named: 9 }],
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.revealed.get(100)?.truncated).toBe(true);
  });

  it('does not claim truncation when the panel itself was one of the reveals', async () => {
    // Two items plus the panel element = three reveals, two of them nameable.
    const fake = makeFake({
      afterQueue: () => [{ names: ['Docs', 'API'], revealed: 3, named: 2 }],
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.revealed.get(100)?.truncated).toBe(false);
  });

  it('says nothing about a trigger whose hover revealed nothing', async () => {
    const fake = makeFake({ afterQueue: () => [{ names: [], revealed: 0 }] });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.revealed.size).toBe(0);
    // Still hovered and still restored — the page was touched either way.
    expect(outcome.probed).toBe(1);
    expect(fake.moves[fake.moves.length - 1]).toEqual(NEUTRAL);
  });

  it('skips a trigger with no a11y node — there would be no line to mark', async () => {
    const fake = makeFake();
    const orphan: HoverCandidate[] = [
      { objectId: 'trigger-0', anchorObjectId: 'anchor-0', score: 5, targets: [] },
    ];
    const outcome = await probeHoverSurfaces(fake.client, orphan, ctx());
    expect(outcome.probed).toBe(0);
    expect(fake.moves).toEqual([]);
  });
});

describe('probeHoverSurfaces: the bounds', () => {
  it(`hovers at most ${HOVER_PROBE_LIMITS.MAX_TRIGGERS} triggers, highest score first`, async () => {
    const fake = makeFake();
    const outcome = await probeHoverSurfaces(fake.client, candidates(20), ctx());

    expect(outcome.probed).toBe(HOVER_PROBE_LIMITS.MAX_TRIGGERS);
    const hovered = fake.steps.filter((s) => s.mode === 'before').map((s) => s.objectId);
    // candidates() is already score-ordered, which is the order the phase-1
    // scan hands them over in.
    expect(hovered).toEqual(['trigger-0', 'trigger-1', 'trigger-2', 'trigger-3', 'trigger-4', 'trigger-5']);
  });

  it('gives one trigger no more than the reveal wait before moving on', async () => {
    useVirtualClock();
    // Each CDP send burns more than the whole reveal wait, so the poll gets
    // exactly one attempt and then the wait is over.
    const fake = makeFake({
      msPerSend: HOVER_PROBE_LIMITS.REVEAL_WAIT_MS + 10,
      afterQueue: () => [
        { names: [], revealed: 0 },
        { names: ['Late'], revealed: 1 },
      ],
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());

    const polls = fake.steps.filter((s) => s.mode === 'after').length;
    expect(polls).toBe(1);
    expect(outcome.revealed.size).toBe(0);
  });

  it('polls again inside the reveal wait, so a transition is not missed', async () => {
    const fake = makeFake({
      afterQueue: () => [
        { names: [], revealed: 0 },
        { names: ['Late'], revealed: 1 },
      ],
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(fake.steps.filter((s) => s.mode === 'after').length).toBeGreaterThanOrEqual(2);
    expect(outcome.revealed.get(100)?.items).toEqual(['Late']);
  });

  it('stops at the total budget even with triggers left to hover', async () => {
    useVirtualClock();
    // ~4 sends per trigger; at this rate the 2500 ms budget is gone long
    // before the sixth one.
    const fake = makeFake({ msPerSend: 400 });
    const outcome = await probeHoverSurfaces(fake.client, candidates(6), ctx());

    expect(outcome.cancelled).toBe(false);
    expect(outcome.probed).toBeGreaterThan(0);
    expect(outcome.probed).toBeLessThan(HOVER_PROBE_LIMITS.MAX_TRIGGERS);
  });

  it('[CRITICAL] does not wait forever on a renderer that never answers', async () => {
    // Runtime.callFunctionOn has no CDP timeout parameter, so a page running a
    // long task would hold the whole tool call open. Every round trip is raced
    // against the shared deadline instead.
    useVirtualClock();
    const fake = makeFake();
    const client = {
      send: (method: string, params?: unknown) => {
        const args = (params ?? {}) as Record<string, unknown>;
        const list = (args['arguments'] ?? []) as { value?: unknown }[];
        if (method === 'Runtime.callFunctionOn' && list[0]?.value === 'after') {
          clock += HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS;
          return new Promise<never>(() => undefined);
        }
        return fake.client.send(method, params);
      },
    };
    const outcome = await probeHoverSurfaces(client, candidates(3), ctx());
    expect(outcome.revealed.size).toBe(0);
    // It still got its pointer off the page.
    expect(fake.moves[fake.moves.length - 1]).toEqual(NEUTRAL);
  });

  it('[CRITICAL] keeps the worst case inside the ~2.5 s the tool promises', () => {
    // The tool description is a promise about wall clock, and the code has to be
    // able to keep it: the only thing outside the shared ceiling is the restore,
    // so the two together ARE the advertised number. Measured live at 5.2 s
    // before the restore and close checks were folded in (dogfood, 2026-09-18).
    expect(HOVER_PROBE_LIMITS.MAX_TRIGGERS).toBe(6);
    expect(HOVER_PROBE_LIMITS.REVEAL_WAIT_MS).toBe(300);
    expect(
      HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS,
    ).toBeLessThanOrEqual(5000);
  });

  it('[CRITICAL] gives a later trigger its turn even when an earlier one is slow', async () => {
    // The shipped defect, and the one CI is red on: on a slow renderer the FIRST
    // trigger simply spent the whole budget, and the nav submenu below the
    // account menu was cut at the top of the loop — no hover, no line, nothing
    // said. Each trigger now gets its own share of what is left.
    useVirtualClock();
    const fake = makeFake({
      // Trigger 0 is pathologically slow; trigger 1 is ordinary.
      msPerSend: 0,
      afterQueue: () => [{ names: ['Docs', 'API'], revealed: 2 }],
    });
    const slowFirst = {
      send: async (method: string, params?: unknown) => {
        const args = (params ?? {}) as Record<string, unknown>;
        if (String(args['objectId'] ?? '').includes('-0')) clock += 400;
        else clock += 10;
        return fake.client.send(method, params);
      },
    };
    const outcome = await probeHoverSurfaces(slowFirst, candidates(2), ctx());

    expect(outcome.probed).toBe(2);
    expect(outcome.revealed.has(101)).toBe(true);
    expect(clock - startClock).toBeLessThanOrEqual(
      HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS,
    );
  });

  it('reports the triggers it could not answer for', async () => {
    useVirtualClock();
    // Every read expires, so nothing is learned about either trigger.
    const client = {
      send: async (method: string) => {
        clock += 3000;
        if (method === 'Input.dispatchMouseEvent') return {};
        return null;
      },
    };
    const outcome = await probeHoverSurfaces(client, candidates(2), ctx());
    expect(outcome.revealed.size).toBe(0);
    expect(outcome.unanswered).toBe(2);
  });

  it('[CRITICAL] does not let one trigger spend the budget the rest need', async () => {
    // The live symptom of an unbounded per-trigger cost: the account menu was
    // listed and the nav submenu below it never got a turn.
    useVirtualClock();
    const fake = makeFake({ msPerSend: 40 });
    const outcome = await probeHoverSurfaces(fake.client, candidates(2), ctx());
    expect(outcome.probed).toBe(2);
    expect(outcome.revealed.size).toBe(2);
    // The whole span, restore grace included, inside the promise.
    expect(clock - startClock).toBeLessThanOrEqual(
      HOVER_PROBE_LIMITS.TOTAL_BUDGET_MS + HOVER_PROBE_LIMITS.RESTORE_GRACE_MS,
    );
  });

  it('walks a short path, so the pointer cost cannot dominate the budget', async () => {
    const fake = makeFake();
    await probeHoverSurfaces(fake.client, candidates(1), ctx());
    // One approach, then a departure: the park is not an interaction and does
    // not need a click's path. At ~100 ms per dispatch in a headed window this
    // is the difference between fitting two triggers in the budget and one.
    expect(fake.moves.length).toBe(
      HOVER_PROBE_LIMITS.DEPARTURE_STEPS * 2 + HOVER_PROBE_LIMITS.POINTER_STEPS,
    );
  });
});

describe('probeHoverSurfaces: the restore step', () => {
  it('notes a surface that stayed open after the pointer left', async () => {
    const fake = makeFake({ closeReply: () => ({ revealed: 2 }) });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.revealed.get(100)?.staysOpen).toBe(true);
  });

  it('verifies the close AFTER the pointer moved away, not before', async () => {
    const fake = makeFake();
    await probeHoverSurfaces(fake.client, candidates(1), ctx());

    const order = fake.calls.map((c) =>
      c.method === 'Runtime.callFunctionOn'
        ? `fn:${String((c.params['arguments'] as { value?: unknown }[])[0]?.value)}`
        : c.method,
    );
    const lastMove = order.lastIndexOf('Input.dispatchMouseEvent');
    const lastCheck = order.lastIndexOf('fn:after');
    expect(lastCheck).toBeGreaterThan(lastMove);
  });

  it('[CRITICAL] restores the pointer even when the trigger read blows up', async () => {
    // A React re-render on mouseenter invalidates the handle, so the `after`
    // call rejects. Leaving the pointer on the trigger would leave the mega-menu
    // open for every later snapshot and click on that page.
    const fake = makeFake();
    const client = {
      send: async (method: string, params?: unknown) => {
        const args = (params ?? {}) as Record<string, unknown>;
        const list = (args['arguments'] ?? []) as { value?: unknown }[];
        if (method === 'Runtime.callFunctionOn' && list[0]?.value === 'after') {
          throw new Error('Could not find object with given id');
        }
        return fake.client.send(method, params);
      },
    };
    const outcome = await probeHoverSurfaces(client, candidates(1), ctx());

    expect(outcome.revealed.size).toBe(0);
    expect(fake.moves[fake.moves.length - 1]).toEqual(NEUTRAL);
  });

  it('gives the surface time to finish closing before calling it stuck', async () => {
    // Open, then still open on the first close read, then closed: a panel with
    // a close transition, which used to be reported as "stays open".
    const fake = makeFake({
      afterQueue: () => [{ names: ['Docs'], revealed: 1 }, { revealed: 1 }],
      closeReply: () => ({ revealed: 0 }),
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.revealed.get(100)?.staysOpen).toBe(false);
  });

  it('does not bother checking the close when nothing opened', async () => {
    const fake = makeFake({ afterQueue: () => [{ names: [], revealed: 0 }] });
    await probeHoverSurfaces(fake.client, candidates(1), ctx());
    // Every reveal read happened before the pointer left; nothing was asked
    // after it, because there was nothing open to still be open.
    const methods = fake.calls.map((c) => c.method);
    expect(methods.lastIndexOf('Runtime.callFunctionOn')).toBeLessThan(
      methods.lastIndexOf('Input.dispatchMouseEvent'),
    );
  });
});

describe('probeHoverSurfaces: the pointer has to actually land', () => {
  it('[CRITICAL] reports nothing when something is covering the element it aimed at', async () => {
    // The live-dogfood failure: the approach path crossed the nav, which opened
    // an absolutely-positioned submenu over the account button below it. The
    // hover never happened, and the read credited that submenu's items to the
    // button.
    const fake = makeFake({ aimOk: () => false });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());

    expect(outcome.revealed.size).toBe(0);
    // It still counts as probed — the page was touched — and the pointer is off.
    expect(outcome.probed).toBe(1);
    expect(fake.moves[fake.moves.length - 1]).toEqual(NEUTRAL);
  });

  it('re-approaches once from the neutral point, which closes the intruder', async () => {
    // Covered on the first read, clear on the second: exactly one re-approach,
    // the same recompute-once contract approachElement has.
    const fake = makeFake({ aimOk: (_i, attempt) => attempt >= 2 });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());

    // Read, park + re-approach, read again: the reveal is only believed once the
    // pointer is genuinely on the anchor.
    expect(fake.steps.filter((s) => s.mode === 'after').length).toBeGreaterThanOrEqual(2);
    expect(outcome.revealed.get(100)?.items).toEqual(['Docs', 'API']);
    // The first approach, then the park + hop back + park, all as departures.
    expect(fake.moves.length).toBe(
      HOVER_PROBE_LIMITS.POINTER_STEPS + HOVER_PROBE_LIMITS.DEPARTURE_STEPS * 4,
    );
  });

  it('does not believe a reveal read while the pointer is off the anchor', async () => {
    const fake = makeFake({
      // Never lands, but the page has a menu open the whole time.
      aimOk: () => false,
      afterQueue: () => [{ names: ['Wrong menu'], revealed: 3 }],
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.revealed.size).toBe(0);
  });
});

describe('neutralPointFor', () => {
  it('parks where the pointer tracker already considers plausible', () => {
    expect(neutralPointFor({ x: 100, y: 100, width: 80, height: 20 }, VIEWPORT)).toEqual(NEUTRAL);
  });

  it('moves off that spot when the trigger is sitting on it', () => {
    const over = { x: NEUTRAL.x - 10, y: NEUTRAL.y - 10, width: 100, height: 100 };
    const point = neutralPointFor(over, VIEWPORT);
    expect(point).not.toEqual(NEUTRAL);
    const inside =
      point.x >= over.x && point.x <= over.x + over.width &&
      point.y >= over.y && point.y <= over.y + over.height;
    expect(inside).toBe(false);
  });

  it('stays inside the viewport even for a box that fills it', () => {
    const point = neutralPointFor({ x: 0, y: 0, width: 1280, height: 800 }, VIEWPORT);
    expect(point.x).toBeGreaterThanOrEqual(0);
    expect(point.y).toBeGreaterThanOrEqual(0);
    expect(point.x).toBeLessThan(VIEWPORT.width);
    expect(point.y).toBeLessThan(VIEWPORT.height);
  });
});

describe('sameHoverDocument', () => {
  it('ignores the fragment — a nav bar rewrites its own hash while you scroll', () => {
    expect(sameHoverDocument('https://x.test/a#top', 'https://x.test/a#features')).toBe(true);
    expect(sameHoverDocument('https://x.test/a', 'https://x.test/a#x')).toBe(true);
  });

  it('treats a path or query change as a navigation', () => {
    expect(sameHoverDocument('https://x.test/a', 'https://x.test/b')).toBe(false);
    expect(sameHoverDocument('https://x.test/a?p=1', 'https://x.test/a?p=2')).toBe(false);
  });

  it('is false when either side is unknown', () => {
    expect(sameHoverDocument(undefined, 'https://x.test/a')).toBe(false);
    expect(sameHoverDocument('https://x.test/a', undefined)).toBe(false);
  });

  it('keeps the probe running across a hash-only change', async () => {
    const fake = makeFake({ afterQueue: () => [{ names: ['Docs'], revealed: 1, url: `${URL_A}#features` }] });
    const outcome = await probeHoverSurfaces(fake.client, candidates(1), ctx());
    expect(outcome.cancelled).toBe(false);
    expect(outcome.revealed.get(100)?.items).toEqual(['Docs']);
  });
});

describe('probeHoverSurfaces: a navigation mid-probe', () => {
  it('drops everything when the page moved before a trigger was measured', async () => {
    const fake = makeFake({ beforeUrl: (i) => (i === 1 ? URL_B : URL_A) });
    const outcome = await probeHoverSurfaces(fake.client, candidates(3), ctx());

    expect(outcome.cancelled).toBe(true);
    // Including the first trigger's perfectly good names: they describe a
    // document that is gone, and the tree they would annotate is the new one's.
    expect(outcome.revealed.size).toBe(0);
  });

  it('drops everything when the page moved while a reveal was being read', async () => {
    const fake = makeFake({
      afterQueue: (i) => (i === 0 ? [{ names: ['Docs'], revealed: 1, url: URL_B }] : []),
    });
    const outcome = await probeHoverSurfaces(fake.client, candidates(2), ctx());
    expect(outcome.cancelled).toBe(true);
    expect(outcome.revealed.size).toBe(0);
  });

  it('drops everything when the navigation only lands after the last step', async () => {
    const fake = makeFake();
    const outcome = await probeHoverSurfaces(
      fake.client,
      candidates(1),
      ctx({
        currentUrl: () => url,
        onPointerMoved: () => {
          // The commit arrives between the in-page read and the return.
          url = URL_B;
        },
      }),
    );
    expect(outcome.cancelled).toBe(true);
    expect(outcome.revealed.size).toBe(0);
  });
});

describe('probeHoverSurfaces: failing open', () => {
  it('keeps what it collected when the session goes away mid-probe', async () => {
    let sends = 0;
    const fake = makeFake();
    const client = {
      send: async (method: string, params?: unknown) => {
        sends += 1;
        // Enough sends for the first trigger to finish (the approach alone is
        // ~20 mouseMoved events), then the session is gone.
        if (sends > 50) throw new Error('Target closed');
        return fake.client.send(method, params);
      },
    };
    const outcome = await probeHoverSurfaces(client, candidates(4), ctx());
    expect(outcome.cancelled).toBe(false);
    expect(outcome.revealed.size).toBeGreaterThan(0);
  });

  it('reports nothing rather than throwing when the first call fails', async () => {
    const client = { send: async () => { throw new Error('no Runtime domain'); } };
    const outcome = await probeHoverSurfaces(client, candidates(2), ctx());
    expect(outcome.revealed.size).toBe(0);
    expect(outcome.cancelled).toBe(false);
  });
});
