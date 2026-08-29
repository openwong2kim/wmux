import { describe, expect, it, vi, afterEach } from 'vitest';
import { OVERLAY_PROBE_JS, collectOcclusion } from '../occlusion';

// The overlay gate decides what it decides from LAYOUT — rects, stacking order,
// computed position — none of which jsdom produces and none of which a mocked
// CDP session exercises. So the probe source is run here against a stub DOM
// that models exactly the four APIs it uses: getBoundingClientRect,
// getComputedStyle, elementFromPoint (topmost hit, skipping pointer-events:none
// the way the real one does) and contains. That is enough to pin the
// distinction the gate exists to make — an app shell is not a backdrop — which
// is otherwise only observable against a live browser.

const VW = 1280;
const VH = 800;

interface ElSpec {
  tag: string;
  id?: string;
  role?: string;
  rect: [number, number, number, number]; // left, top, width, height
  position?: string;
  pointerEvents?: string;
  visible?: boolean;
  /** Matches the probe's control selector. */
  control?: boolean;
  /** Paint order; the highest one at a point wins the hit test. */
  z?: number;
  children?: ElSpec[];
}

interface StubEl {
  tagName: string;
  id: string;
  parentElement: StubEl | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number };
  checkVisibility(): boolean;
  contains(other: StubEl): boolean;
  _spec: ElSpec;
  _kids: StubEl[];
}

function buildPage(specs: ElSpec[]) {
  const all: StubEl[] = [];

  function make(spec: ElSpec, parent: StubEl | null): StubEl {
    const [left, top, width, height] = spec.rect;
    const el: StubEl = {
      tagName: spec.tag.toUpperCase(),
      id: spec.id ?? '',
      parentElement: parent,
      getAttribute: (name) => (name === 'role' ? spec.role ?? null : null),
      getBoundingClientRect: () => ({ left, top, width, height, right: left + width, bottom: top + height }),
      checkVisibility: () => spec.visible !== false,
      contains(other) {
        for (let n: StubEl | null = other; n; n = n.parentElement) if (n === this) return true;
        return false;
      },
      _spec: spec,
      _kids: [],
    };
    all.push(el);
    for (const child of spec.children ?? []) el._kids.push(make(child, el));
    return el;
  }

  const documentElement = make({ tag: 'html', rect: [0, 0, VW, VH] }, null);
  const body = make({ tag: 'body', rect: [0, 0, VW, VH] }, documentElement);
  for (const spec of specs) body._kids.push(make(spec, body));

  const hitAt = (x: number, y: number): StubEl | null => {
    let best: StubEl | null = null;
    for (const el of all) {
      if (el === documentElement || el === body) continue;
      // The real elementFromPoint hands back the ancestor when the topmost
      // element opts out of hit testing — modelled so the probe's explicit
      // pointer-events check is actually under test.
      if (el._spec.pointerEvents === 'none') continue;
      if (el._spec.visible === false) continue;
      const r = el.getBoundingClientRect();
      if (x < r.left || x >= r.right || y < r.top || y >= r.bottom) continue;
      if (!best || (el._spec.z ?? 0) >= (best._spec.z ?? 0)) best = el;
    }
    return best;
  };

  const document = {
    body,
    documentElement,
    querySelector: () => null, // no :modal, no [inert]
    querySelectorAll: () => all.filter((el) => el._spec.control),
    elementFromPoint: hitAt,
  };

  const getComputedStyle = (el: StubEl) => ({
    position: el._spec.position ?? 'static',
    pointerEvents: el._spec.pointerEvents ?? 'auto',
  });

  return { document, getComputedStyle };
}

interface ProbeResult {
  label: string | null;
  blockedCount?: number;
  reachable?: StubEl[];
  reachableCount?: number;
}

function runProbe(specs: ElSpec[]): ProbeResult {
  const { document, getComputedStyle } = buildPage(specs);
  const fn = new Function(
    'document',
    'getComputedStyle',
    'innerWidth',
    'innerHeight',
    `return ${OVERLAY_PROBE_JS};`,
  );
  return fn(document, getComputedStyle, VW, VH) as ProbeResult;
}

/** N page controls laid out down the left column, behind everything. */
function pageControls(n: number, opts: Partial<ElSpec> = {}): ElSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    tag: 'button',
    id: 'c' + i,
    rect: [20, 60 + i * 40, 160, 24] as [number, number, number, number],
    control: true,
    z: 1,
    ...opts,
  }));
}

describe('overlay gate: app shells are not overlays', () => {
  it('does not fire for a position:fixed inset:0 layout root', () => {
    // A dashboard / map / canvas app: everything lives inside one fixed,
    // full-viewport wrapper, so the wrapper is the outermost viewport-scale
    // positioned ancestor at every grid point — exactly like a backdrop.
    const result = runProbe([
      { tag: 'div', id: 'app', rect: [0, 0, VW, VH], position: 'fixed', z: 1, children: pageControls(8) },
    ]);
    expect(result.label).toBeNull();
  });

  it('still does not fire when a stray hit-test misfire blocks one control', () => {
    // The failure the structural test exists to stop: one misfire used to be
    // enough to declare the whole page unclickable.
    const controls = pageControls(8);
    const result = runProbe([
      {
        tag: 'div',
        id: 'app',
        rect: [0, 0, VW, VH],
        position: 'fixed',
        z: 1,
        children: [
          ...controls,
          // A sliver painted over exactly one control, as a tooltip or a
          // sticky element would be.
          { tag: 'span', id: 'sliver', rect: [20, 60, 160, 24], z: 9 },
        ],
      },
    ]);
    expect(result.label).toBeNull();
  });
});

describe('overlay gate: real backdrops still fire', () => {
  const MODAL_PAGE: ElSpec[] = [
    ...pageControls(6),
    { tag: 'div', id: 'backdrop', rect: [0, 0, VW, VH], position: 'fixed', z: 50 },
    {
      tag: 'div',
      id: 'dialog',
      role: 'dialog',
      rect: [400, 200, 400, 300],
      position: 'fixed',
      z: 60,
      children: [
        { tag: 'button', id: 'ok', rect: [420, 420, 80, 30], control: true, z: 61 },
        { tag: 'button', id: 'cancel', rect: [520, 420, 80, 30], control: true, z: 61 },
      ],
    },
  ];

  it('names the backdrop and reports only the dialog controls as reachable', () => {
    const result = runProbe(MODAL_PAGE);
    expect(result.label).toBe('div#backdrop');
    expect(result.blockedCount).toBe(6);
    expect(result.reachable?.map((el) => el.id)).toEqual(['ok', 'cancel']);
  });

  it('treats a pointer-events:none control as blocked, not reachable', () => {
    // elementFromPoint skips such an element and returns its ancestor, which
    // would otherwise read as "reached".
    const withInert = MODAL_PAGE.map((spec) =>
      spec.id === 'dialog'
        ? { ...spec, children: spec.children?.map((c) => (c.id === 'ok' ? { ...c, pointerEvents: 'none' } : c)) }
        : spec,
    );
    const result = runProbe(withInert);
    expect(result.reachable?.map((el) => el.id)).toEqual(['cancel']);
    expect(result.blockedCount).toBe(7);
  });
});

describe('overlay gate: the other bail-outs', () => {
  it('does not fire when there is no viewport-scale layer at all', () => {
    expect(runProbe(pageControls(6)).label).toBeNull();
  });

  it('does not fire when a full-viewport layer blocks only a minority', () => {
    // A decorative full-viewport element that lets most clicks through is not
    // a modal, whatever the grid test says.
    const result = runProbe([
      ...pageControls(8, { z: 80 }), // painted above the layer, so reachable
      { tag: 'div', id: 'wash', rect: [0, 0, VW, VH], position: 'fixed', z: 50 },
      { tag: 'button', id: 'buried', rect: [900, 600, 100, 30], control: true, z: 1 },
    ]);
    expect(result.label).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CDP-side behaviour: budgets, and not trusting what the page reports.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.useRealTimers();
});

/** A client where the named methods never settle. */
function makeClient(handlers: Record<string, (params?: never) => Promise<unknown>>, never: string[] = []) {
  const send = vi.fn((method: string, params?: never) => {
    if (never.includes(method)) return new Promise<never>(() => { /* never settles */ });
    const handler = handlers[method];
    return handler ? handler(params) : Promise.resolve({});
  });
  return { client: { send }, send };
}

describe('collectOcclusion: time budgets', () => {
  it('gives up when Runtime.evaluate never answers, and releases nothing', async () => {
    vi.useFakeTimers();
    const { client, send } = makeClient({}, ['Runtime.evaluate']);

    const pending = collectOcclusion(client as never);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeNull();
    // No handle was ever obtained, so the wedged renderer is not asked to
    // release one — the finally block must not reintroduce an unbounded wait.
    expect(send.mock.calls.map((c) => c[0])).not.toContain('Runtime.releaseObjectGroup');
  });

  it('finishes even when both the follow-up call and the cleanup hang', async () => {
    vi.useFakeTimers();
    const { client, send } = makeClient(
      { 'Runtime.evaluate': async () => ({ result: { objectId: 'root' } }) },
      ['Runtime.getProperties', 'Runtime.releaseObjectGroup'],
    );

    const pending = collectOcclusion(client as never);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(pending).resolves.toBeNull();
    expect(send.mock.calls.map((c) => c[0])).toContain('Runtime.releaseObjectGroup');
  });
});

describe('collectOcclusion: does not trust the page', () => {
  it('caps element resolution even when the page under-reports its array length', async () => {
    // The probe runs in the page's main world, so `reachableCount` (and
    // `length`) are attacker-controlled: a page can claim 2 and hand back
    // thousands of index slots.
    const bigArray = Array.from({ length: 5000 }, (_, i) => ({
      name: String(i),
      value: { objectId: 'el-' + i },
    }));
    const { client, send } = makeClient({
      'Runtime.evaluate': async () => ({ result: { objectId: 'root' } }),
      'Runtime.getProperties': async (params?: never) => {
        const objectId = (params as unknown as { objectId: string }).objectId;
        if (objectId === 'root') {
          return {
            result: [
              { name: 'label', value: { value: 'div#veil' } },
              { name: 'blockedCount', value: { value: 900 } },
              { name: 'reachableCount', value: { value: 2 } },
              { name: 'reachable', value: { objectId: 'arr' } },
            ],
          };
        }
        return { result: [...bigArray, { name: 'length', value: { value: 2 } }] };
      },
      'DOM.describeNode': async (params?: never) => ({
        node: { backendNodeId: Number((params as unknown as { objectId: string }).objectId.slice(3)) },
      }),
    });

    const info = await collectOcclusion(client as never);

    const describeCalls = send.mock.calls.filter((c) => c[0] === 'DOM.describeNode');
    expect(describeCalls.length).toBeLessThanOrEqual(50);
    expect(info?.reachable.size).toBeLessThanOrEqual(50);
  });

  it('truncates a page-controlled overlay label', async () => {
    const { client } = makeClient({
      'Runtime.evaluate': async () => ({ result: { objectId: 'root' } }),
      'Runtime.getProperties': async () => ({
        result: [
          { name: 'label', value: { value: 'div#' + 'A'.repeat(100_000) } },
          { name: 'blockedCount', value: { value: 4 } },
          { name: 'reachableCount', value: { value: 0 } },
        ],
      }),
    });

    const info = await collectOcclusion(client as never);
    expect(info?.layer.length).toBeLessThanOrEqual(120);
  });
});
