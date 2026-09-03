import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeRefEntry {
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  frameKey: string;
  ref: number;
  context?: string;
  own?: string;
}

/** What the page's "last snapshot" currently holds. Mutated per case. */
let refEntries: FakeRefEntry[] = [];
let snapshotText = 'button "Sign in" [ref=1]';
const resolved = new Set<string>();

/** The runner narrows on this class, so the mock has to hand out the same one. */
const { StaleRefError } = vi.hoisted(() => ({
  StaleRefError: class StaleRefError extends Error {},
}));

vi.mock('../../playwright/snapshot', () => ({
  generateSnapshot: async () => snapshotText,
  listRefEntries: () => refEntries,
  resolveRef: async (_page: unknown, ref: string) =>
    resolved.has(ref) ? ({ click: async () => undefined, fill: async () => undefined } as never) : null,
  StaleRefError,
}));

/** What the smart lane says its own walk currently counts. Scripted per case. */
let smartCount: number | null = null;
const smartCountCalls: Array<[string, string]> = [];

const isolatedWaits: string[] = [];
vi.mock('../../playwright/isolated-eval', () => ({
  waitForIsolated: async (_page: unknown, _fn: unknown, arg: string) => { isolatedWaits.push(arg); },
}));

vi.mock('../../playwright/dom-intelligence', () => ({
  countSmartNamedPopulation: async (_page: unknown, role: string, name: string) => {
    smartCountCalls.push([role, name]);
    return smartCount;
  },
}));

import { replayBlockedReason, replayTrace } from '../replayRunner';
import { refMapShapeHash, type TraceRecord, type TraceStep } from '../../../shared/browserReplay/actionTrace';

const clicks: string[] = [];
const pressed: string[] = [];
const goneTo: string[] = [];
/** Every page-level wait the runner asked for, in order. */
const waits: string[] = [];
const navListeners = new Set<(frame: unknown) => void>();
/** Simulate the main frame navigating (a Turbo click, a pushState). */
function fireNavigation(): void {
  for (const fn of navListeners) fn({ parentFrame: () => null });
}

const page = {
  url: () => 'https://example.com/app',
  goto: async (url: string) => { goneTo.push(url); },
  keyboard: { press: async (key: string) => { pressed.push(key); } },
  waitForLoadState: async (state: string) => { waits.push(`load:${state}`); },
  on: (_event: string, fn: (frame: unknown) => void) => { navListeners.add(fn); },
  off: (_event: string, fn: (frame: unknown) => void) => { navListeners.delete(fn); },
  waitForURL: async (url: string) => { waits.push(`url:${url}`); },
  waitForSelector: async (selector: string) => { waits.push(`selector:${selector}`); },
  locator: () => ({ count: async () => 0, elementHandle: async () => null }),
  evaluate: async () => undefined,
  mouse: {
    move: async () => undefined,
    down: async () => undefined,
    up: async () => undefined,
  },
} as never;

function element(tag: string) {
  return {
    click: async () => { clicks.push(tag); },
    dblclick: async () => { clicks.push(`${tag}:double`); },
    fill: async (value: string) => { clicks.push(`${tag}:fill=${value}`); },
    hover: async () => { clicks.push(`${tag}:hover`); },
    selectOption: async () => { clicks.push(`${tag}:select`); },
    scrollIntoViewIfNeeded: async () => undefined,
    evaluate: async () => undefined,
    boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
  } as never;
}

function refStep(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    tool: 'browser_click',
    axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
    args: {},
    ...overrides,
  };
}

function trace(steps: TraceStep[], surfaceShape = refMapShapeHash(refEntries)): TraceRecord {
  return {
    id: 'tr_1',
    name: 'flow',
    urlKey: 'https://example.com/app',
    surfaceShape,
    steps,
    observedCount: 1,
    successCount: 1,
    failCount: 0,
    createdAt: 0,
    lastUsedAt: 0,
  };
}

beforeEach(() => {
  // Cases spy on the snapshot module to script what the page holds; without a
  // restore the last one's script leaks into the next.
  vi.restoreAllMocks();
  clicks.length = 0;
  pressed.length = 0;
  goneTo.length = 0;
  waits.length = 0;
  isolatedWaits.length = 0;
  navListeners.clear();
  resolved.clear();
  snapshotText = 'button "Sign in" [ref=1]';
  smartCount = null;
  smartCountCalls.length = 0;
  refEntries = [
    { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1 },
  ];
  resolved.add('1');
});

describe('replayBlockedReason', () => {
  it('refuses a trace that contains a password step, naming the step', () => {
    const reason = replayBlockedReason(trace([refStep({ unrecordable: 'password' })]));
    expect(reason).toContain('step 1 (password)');
    expect(reason).toContain('never stored');
  });

  it('refuses a trace with an RPC-lane hole', () => {
    expect(replayBlockedReason(trace([refStep({ unrecordable: 'rpc-transport' })]))).toContain('rpc-transport');
  });

  it('allows a clean trace', () => {
    expect(replayBlockedReason(trace([refStep()]))).toBeNull();
  });
});

describe('replayTrace — resolution on the 4-tuple axis', () => {
  it('re-resolves a step through the snapshot ref map and never returns the snapshot', async () => {
    const handle = element('sign-in');
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(handle);

    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['sign-in']);
    expect(JSON.stringify(result)).not.toContain('Sign in" [ref=');
  });

  it('re-resolves after the element was renumbered (the restart case)', async () => {
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 904 },
    ];
    const mod = await import('../../playwright/snapshot');
    const spy = vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('sign-in'));

    await replayTrace(page, trace([refStep()]), undefined);
    expect(spy).toHaveBeenCalledWith(page, '904', { strictCount: true });
  });

  it('stops at the step whose element is gone and says which and why', async () => {
    refEntries = [];
    const result = await replayTrace(page, trace([refStep(), refStep()]), undefined);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps[0].detail).toContain('no button "Sign in" on the page any more');
  });

  it('stops at step 2 when step 1 worked and step 2 vanished', async () => {
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));
    const missing = refStep({
      axis: { kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
    });
    const result = await replayTrace(page, trace([refStep(), missing]), undefined);
    expect(result.failedStep).toBe(2);
    expect(result.steps[0].ok).toBe(true);
  });

  it('REFUSES when a decoy was inserted BEFORE the recorded first element', async () => {
    // The dogfood defect: one `button "Submit order"` was recorded at index 0,
    // then a decoy with the same name was inserted above it. Index 0 now names
    // the decoy. The run used to warn "the first one cannot have been
    // displaced" and click it, reporting the step ok.
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Sign in', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('decoy'));

    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps[0].detail).toContain('can no longer be identified');
    expect(result.steps[0].detail).toContain('the recording had 1');
    expect(result.steps[0].detail).toContain('were added');
    expect(result.inconclusive).toBe(true);
    expect(clicks).toEqual([]);
  });

  it('runs the recorded first element while its population is unchanged', async () => {
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Sign in', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('first-sign-in'));

    const step = refStep({
      axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 2, frameKey: '' },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(clicks).toEqual(['first-sign-in']);
  });

  it('stops when the element was renamed out of the population', async () => {
    // The name changed, so the recorded axis matches nothing at all — the
    // oldest stop, still the right one.
    refEntries = [
      { role: 'button', name: 'Log in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('log-in'));

    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps[0].detail).toContain('no button "Sign in" on the page any more');
    // A vanished element IS evidence about the flow — it must still quarantine.
    expect(result.inconclusive).toBeUndefined();
    expect(clicks).toEqual([]);
  });

  it('REFUSES when the population changed and the recorded element was not first', async () => {
    // Index 1 of 2 recorded; the page now holds 3. A row inserted above shifts
    // the tail, so "position 2" may well be a different row now — acting on it
    // would be a successful-looking run against the wrong element.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 3, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 3, frameKey: '', ref: 2 },
      { role: 'button', name: 'Delete', sameNameIndex: 2, sameNameTotal: 3, frameKey: '', ref: 3 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));

    const displaced = refStep({
      axis: { kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '' },
    });
    const result = await replayTrace(page, trace([displaced]), undefined);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps[0].detail).toContain('can no longer be identified');
    expect(clicks).toEqual([]);
  });

  it('still runs a non-first element when the population is unchanged', async () => {
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('second-delete'));
    const step = refStep({
      axis: { kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '' },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['second-delete']);
  });

  it('reports the COUNT when the population shrank past the recorded position', async () => {
    // The count comparison runs before the index lookup (panel ④). Ordered the
    // other way, this reported only "nothing at position 3" and never said that
    // the population is what changed.
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1 },
    ];
    const step = refStep({
      axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 2, sameNameTotal: 3, frameKey: '' },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('the recording had 3');
    expect(result.steps[0].detail).toContain('were removed');
    expect(result.inconclusive).toBe(true);
  });

  it('stops when the population grew AFTER the internal snapshot was taken', async () => {
    // The population compared in matchRefAxis was counted before the step ran.
    // A decoy that appears in the window between that snapshot and the click is
    // invisible to it, and is caught by resolveRef's strict count instead.
    const mod = await import('../../playwright/snapshot');
    const spy = vi
      .spyOn(mod, 'resolveRef')
      .mockRejectedValue(new StaleRefError('ref=1 is stale — the page now has 2 button element(s) named "Sign in"'));

    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(spy).toHaveBeenCalledWith(page, '1', { strictCount: true });
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps[0].detail).toContain('the page now has 2');
    expect(result.inconclusive).toBe(true);
    expect(clicks).toEqual([]);
  });

  it('does not count-check an UNNAMED axis, whose stored total is a role count', async () => {
    // smartRefAxisEntry stores roleIndex/roleTotal in the sameName fields for an
    // element with no accessible name, measured over a different walk from the
    // snapshot ref map counted here. Demanding equality would stop flows on
    // pages that never changed.
    refEntries = [
      { role: 'button', name: '', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 7 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('unnamed'));

    const step = refStep({
      axis: { kind: 'ref', role: 'button', name: '', sameNameIndex: 0, sameNameTotal: 4, frameKey: '' },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['unnamed']);
  });

  it('does not match an entry in a different frame', async () => {
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: 'f1', ref: 1 },
    ];
    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(false);
  });
});

describe('replayTrace — the context verifier (#1182)', () => {
  // #1179 stops on a CHANGED same-name count. These are the cases where the
  // count is a liar: it stays put while the elements underneath it are swapped.

  it('STOPS the same-count swap that the population count cannot see', async () => {
    // Recorded against the one and only "Submit order", in the express
    // checkout panel. Since then that panel's button was removed and a
    // look-alike appeared in another panel: still exactly one, still index 0,
    // so every count and position check passes.
    refEntries = [
      {
        role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 1,
        frameKey: '', ref: 7, context: 'region "Saved carts"',
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('decoy'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 1,
        frameKey: '', context: 'region "Express checkout"',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(1);
    expect(result.steps[0].detail).toContain('region "Express checkout"');
    expect(clicks).toEqual([]);
  });

  it('STOPS when the recorded element is still there but the population shifted under it', async () => {
    // A row inserted above: "Delete" for Alice moved from position 1 to 2 with
    // the count unchanged, so the index now names Zoe's row.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1, context: 'row "Zoe"' },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2, context: 'row "Alice"' },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('zoe-delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', context: 'row "Alice"',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('sits at position 2');
    // Never followed to its new index — that would be resolving by position.
    expect(clicks).toEqual([]);
  });

  it('confirms a count change that #1179 alone would have refused', async () => {
    // Index 1 of 2 recorded, the page now holds 3 — the #1179 refusal case.
    // Alice's row is still the only one under that context and still at the
    // recorded position, so the context outranks the count.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 3, frameKey: '', ref: 1, context: 'row "Zoe"' },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 3, frameKey: '', ref: 2, context: 'row "Alice"' },
      { role: 'button', name: 'Delete', sameNameIndex: 2, sameNameTotal: 3, frameKey: '', ref: 3, context: 'row "Bob"' },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('alice-delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2,
        frameKey: '', context: 'row "Alice"',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['alice-delete']);
    // #1179 removed the step-level warning channel along with the "replay
    // against it anyway" path it annotated, so a confirmed step reports
    // nothing extra — the click on the right element is the result.
    expect(result.warnings.filter((w) => w.includes('such element(s)'))).toEqual([]);
  });

  it('gives no verdict when the siblings are genuinely identical', async () => {
    // Two buttons in the same container: the context cannot tell them apart,
    // so the pre-#1182 population rules decide and the step runs as before.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1, context: 'row "Alice"' },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2, context: 'row "Alice"' },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('second-delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2,
        frameKey: '', context: 'row "Alice"',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['second-delete']);
  });

  it('gives no verdict when the live page mints no context at all', async () => {
    // A recording made after this field existed, replayed against a snapshot
    // that carries none: the verifier stays silent instead of stopping every
    // step it cannot check.
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('sign-in'));
    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1,
        frameKey: '', context: 'region "Express checkout"',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['sign-in']);
  });

  it('replays a trace recorded before the field existed exactly as before', async () => {
    // The live page now carries contexts; the stored axis does not. Additive
    // means the old trace must not start stopping.
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1, context: 'region "Anything"' },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('sign-in'));
    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['sign-in']);
  });
});

describe('replayTrace — the own-attribute verifier', () => {
  // Where the context verifier gives up: two siblings in the SAME container,
  // same role, same name. The page tells them apart with an attribute on the
  // element itself, so the replay can too.

  it('resolves identical siblings by data-testid after they were swapped', async () => {
    // Recorded position 0 = the primary submit. The two were then reordered:
    // same container, same count, same names — nothing positional can see it.
    refEntries = [
      {
        role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', ref: 1, context: 'region "Checkout"', own: 'data-testid=submit-secondary',
      },
      {
        role: 'button', name: 'Submit order', sameNameIndex: 1, sameNameTotal: 2,
        frameKey: '', ref: 2, context: 'region "Checkout"', own: 'data-testid=submit-primary',
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('primary'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', context: 'region "Checkout"', own: 'data-testid=submit-primary',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    // It MOVED, so the run stops rather than following it to index 1 — which
    // is the same refusal the context verifier makes, one signal deeper.
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('sits at position 2');
    expect(clicks).toEqual([]);
  });

  it('confirms the recorded sibling when its own attribute still sits there', async () => {
    // The other half of the swap case: the page grew a third look-alike, so
    // #1179 alone would refuse, but the recorded element is still at index 0
    // and still carries its own testid.
    refEntries = [
      {
        role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 3,
        frameKey: '', ref: 1, context: 'region "Checkout"', own: 'data-testid=submit-primary',
      },
      {
        role: 'button', name: 'Submit order', sameNameIndex: 1, sameNameTotal: 3,
        frameKey: '', ref: 2, context: 'region "Checkout"', own: 'data-testid=submit-secondary',
      },
      {
        role: 'button', name: 'Submit order', sameNameIndex: 2, sameNameTotal: 3,
        frameKey: '', ref: 3, context: 'region "Checkout"', own: 'data-testid=submit-tertiary',
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('primary'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', context: 'region "Checkout"', own: 'data-testid=submit-primary',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['primary']);
  });

  it('STOPS when no sibling carries the recorded attribute any more', async () => {
    refEntries = [
      {
        role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', ref: 1, context: 'region "Checkout"', own: 'data-testid=submit-a',
      },
      {
        role: 'button', name: 'Submit order', sameNameIndex: 1, sameNameTotal: 2,
        frameKey: '', ref: 2, context: 'region "Checkout"', own: 'data-testid=submit-b',
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('stranger'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Submit order', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', context: 'region "Checkout"', own: 'data-testid=submit-primary',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('data-testid=submit-primary');
    expect(clicks).toEqual([]);
  });

  it('ABSTAINS on identical siblings that carry no attributes — the irreducible case', async () => {
    // Nothing recorded can separate these. The verifier must stay silent and
    // let the count rules decide, exactly as before the field existed.
    refEntries = [
      {
        role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', ref: 1, context: 'row "Alice"',
      },
      {
        role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2,
        frameKey: '', ref: 2, context: 'row "Alice"',
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('second-delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2,
        frameKey: '', context: 'row "Alice"',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['second-delete']);
  });

  it('ABSTAINS when the recording has an attribute and the live page mints none', async () => {
    // A recording made where the labels could be read, replayed where the DOM
    // pass could not run. Absence is not a mismatch.
    refEntries = [
      {
        role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1,
      },
      {
        role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2,
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('first-delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2,
        frameKey: '', own: 'id=delete-alice',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['first-delete']);
  });

  it('never runs when the CONTEXT already decided — the context outranks it', async () => {
    // One element under the recorded context, at the recorded index: settled
    // there, whatever the own labels say.
    refEntries = [
      {
        role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1,
        context: 'row "Alice"', own: 'id=something-else',
      },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('alice-delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 1,
        frameKey: '', context: 'row "Alice"', own: 'id=delete-alice',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['alice-delete']);
  });
});

describe('replayTrace — provenance, so the count compares like with like', () => {
  // The smart lane walks the whole accessibility tree; this module counts from
  // browser_snapshot's ref map, which is depth-capped and filtered on
  // overflow. A named axis minted over there used to be compared against a
  // number measured over here, and stopped replays on unchanged pages.

  it('does not STOP a smart-recorded step when only the ENUMERATIONS differ', async () => {
    // The ref map lists two; the smart walk that recorded the step saw three.
    // Nothing about the page changed — the two walks simply see different sets.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    smartCount = 3;
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 3,
        frameKey: '', via: 'smart',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['delete']);
    // Asked the lane that minted the number, not a second guess at it.
    expect(smartCountCalls).toEqual([['button', 'Delete']]);
  });

  it('still STOPS a smart-recorded step when that lane\u2019s OWN count changed', async () => {
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    // The smart walk saw three at record time and sees two now: a real change.
    smartCount = 2;
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('delete'));

    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 3,
        frameKey: '', via: 'smart',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.inconclusive).toBe(true);
    expect(result.steps[0].detail).toContain('element(s) with that role and name');
    expect(clicks).toEqual([]);
  });

  it('keeps the stop when the smart walk cannot answer', async () => {
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    smartCount = null;
    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 3,
        frameKey: '', via: 'smart',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(clicks).toEqual([]);
  });

  it('does not consult the smart lane for an axis that did not come from it', async () => {
    // Absent `via` means the accessibility lane, which is the enumeration this
    // module already counts — there is nothing to reconcile, and an old trace
    // must keep the exact behaviour it had.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    smartCount = 3;
    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 3, frameKey: '',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(smartCountCalls).toEqual([]);
  });

  it('still refuses a position the live population does not have', async () => {
    // The enumerations reconcile, but the ref map has no index 2 to act on —
    // the reconciliation clears the COUNT, never the position.
    refEntries = [
      { role: 'button', name: 'Delete', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Delete', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    smartCount = 3;
    const step = refStep({
      axis: {
        kind: 'ref', role: 'button', name: 'Delete', sameNameIndex: 2, sameNameTotal: 3,
        frameKey: '', via: 'smart',
      },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('none at position 3');
    expect(clicks).toEqual([]);
  });
});

describe('replayTrace — flow control', () => {
  it('warns on a changed page shape but still runs', async () => {
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));
    const result = await replayTrace(page, trace([refStep()], 'a-different-shape'), undefined);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('page shape differs');
  });

  it('says nothing about shape when the trace carries no baseline', async () => {
    // A flow recorded starting from a navigate has no ref map to stamp on its
    // first action. A warning built on that empty baseline fired on every
    // replay of a page that had not changed at all (dogfood D1).
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));
    const result = await replayTrace(page, trace([refStep()], ''), undefined);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('measures the live shape AFTER a leading navigate, not before it', async () => {
    // Dogfood D2: the live hash used to be taken on whatever page the agent
    // was on when it called run, so one successful replay reported two
    // different "live" shapes purely from two different starting pages.
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));

    // Before the navigate the page holds something else entirely; after it,
    // the page the flow was recorded on.
    refEntries = [{ role: 'link', name: 'Somewhere else', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 9 }];
    const destination = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1 },
    ];
    const recorded = refMapShapeHash(destination);
    vi.spyOn(mod, 'generateSnapshot').mockImplementation(async () => {
      refEntries = destination;
      return '';
    });

    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: 'https://example.com/app' },
    };
    const result = await replayTrace(page, trace([nav, refStep()], recorded), undefined);

    expect(result.ok).toBe(true);
    // The destination matched the recording, so a correct measurement is silent.
    expect(result.warnings).toEqual([]);
    expect(result.liveShape).toBe(recorded);
  });

  it('still stops at the changed step even when the shape agrees', async () => {
    // The shape check is advisory; the per-step element resolution is what
    // actually protects the run (dogfood step 7).
    refEntries = [];
    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: 'https://example.com/app' },
    };
    const result = await replayTrace(page, trace([nav, refStep()], ''), undefined);
    expect(result.ok).toBe(false);
    expect(result.failedStep).toBe(2);
    expect(result.steps[1].detail).toContain('no button "Sign in" on the page any more');
  });

  it('treats a mid-flow navigate as the end of the replayable flow', async () => {
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));
    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: 'https://example.com/next' },
    };
    const result = await replayTrace(page, trace([refStep(), nav, refStep()]), undefined);
    expect(result.ok).toBe(true);
    expect(result.stoppedEarly).toContain('step 2 navigates away');
    expect(result.steps).toHaveLength(1);
  });

  it('performs a leading navigate', async () => {
    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: 'https://example.com/start' },
    };
    const result = await replayTrace(page, trace([nav]), undefined);
    expect(result.ok).toBe(true);
    expect(goneTo).toEqual(['https://example.com/start']);
  });

  it('refuses a recorded URL the live navigate tool would itself refuse', async () => {
    // The cache file is ordinary JSON in the user's home directory, so a
    // stored URL is untrusted input by the time it is replayed.
    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: 'javascript:alert(1)' },
    };
    const result = await replayTrace(page, trace([nav]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('not navigable');
    expect(goneTo).toEqual([]);
  });

  it('strips userinfo out of a recorded URL before navigating to it', async () => {
    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: 'https://alice:hunter2@example.com/app' },
    };
    await replayTrace(page, trace([nav]), undefined);
    expect(goneTo).toHaveLength(1);
    expect(goneTo[0]).not.toContain('hunter2');
  });

  it('refuses a URL smuggled in through a variable substitution', async () => {
    const nav: TraceStep = {
      tool: 'browser_navigate',
      axis: { kind: 'none' },
      args: { url: '{{target}}' },
    };
    const result = await replayTrace(page, trace([nav]), { target: 'javascript:alert(1)' });
    expect(result.ok).toBe(false);
    expect(goneTo).toEqual([]);
  });

  it('stops on a placeholder the caller did not supply', async () => {
    const typing = refStep({ tool: 'browser_type', args: { text: '{{email}}' } });
    const result = await replayTrace(page, trace([typing]), {});
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('missing variable(s): email');
  });

  it('substitutes a supplied placeholder into the typed value', async () => {
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('field'));
    const typing = refStep({ tool: 'browser_type', args: { text: '{{email}}' } });
    const result = await replayTrace(page, trace([typing]), { email: 'a@b.c' });
    expect(result.ok).toBe(true);
    expect(clicks).toEqual(['field:fill=a@b.c']);
  });

  it('presses a key without needing an element', async () => {
    const key: TraceStep = { tool: 'browser_press_key', axis: { kind: 'none' }, args: { key: 'Enter' } };
    const result = await replayTrace(page, trace([key]), undefined);
    expect(result.ok).toBe(true);
    expect(pressed).toEqual(['Enter']);
  });

  it('refuses a css axis that no longer matches exactly one element', async () => {
    const cssStep = refStep({ axis: { kind: 'css', selector: '#go' } });
    const result = await replayTrace(page, trace([cssStep]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('matched 0 elements');
  });

  it('turns a throwing step into a stop report rather than an exception', async () => {
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue({
      click: async () => { throw new Error('element is not visible'); },
    } as never);
    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('not visible');
  });
});

describe('settling after a step (#1193)', () => {
  it('does not wait after a step that did not navigate', async () => {
    const result = await replayTrace(page, trace([refStep(), refStep()]), undefined);
    expect(result.ok).toBe(true);
    expect(waits).toEqual([]);
    expect(navListeners.size).toBe(0);
  });

  it('after a step that navigated, waits until two consecutive page shapes agree before the next step', async () => {
    const mod = await import('../../playwright/snapshot');
    const destination: FakeRefEntry[] = [
      { role: 'link', name: 'Closed', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 2 },
    ];
    // Snapshot 1 (pre-flight), then the click navigates; the page is still
    // the OLD document on the next read and becomes the destination only
    // afterwards — which is exactly the window #1193 fell into.
    let reads = 0;
    vi.spyOn(mod, 'generateSnapshot').mockImplementation(async () => {
      reads++;
      if (reads >= 3) refEntries = destination;
      return '';
    });
    resolved.add('2');
    const clickSignIn = refStep();
    const clickClosed = refStep({
      axis: { kind: 'ref', role: 'link', name: 'Closed', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' },
    });
    const mockedResolve = vi.spyOn(mod, 'resolveRef').mockImplementation(async (_p, ref) => {
      if (ref === '1') fireNavigation();
      return resolved.has(ref) ? ({ click: async () => undefined } as never) : null;
    });

    const result = await replayTrace(page, trace([clickSignIn, clickClosed]), undefined);

    expect(result.steps.map((s) => s.ok)).toEqual([true, true]);
    expect(waits).toEqual(['load:domcontentloaded']);
    expect(navListeners.size).toBe(0);
    // pre-flight 1 + settle reads until two agree (old, new, new) = 4, with
    // no extra re-charge dump after the settle.
    expect(reads).toBe(4);
    mockedResolve.mockRestore();
  });

  it('replays a recorded browser_wait by its condition, text through the isolated poll', async () => {
    const waitText: TraceStep = { tool: 'browser_wait', axis: { kind: 'none' }, args: { text: 'Closed', timeout: 5000 } };
    const waitUrl: TraceStep = { tool: 'browser_wait', axis: { kind: 'none' }, args: { urlGlob: '**/pulls**' } };
    const waitIdle: TraceStep = { tool: 'browser_wait', axis: { kind: 'none' }, args: {} };

    const result = await replayTrace(page, trace([waitText, waitUrl, waitIdle]), undefined);

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.detail)).toEqual([
      'waited for text "Closed"',
      'waited for URL "**/pulls**"',
      'waited for network idle',
    ]);
    expect(isolatedWaits).toEqual(['Closed']);
    expect(waits).toContain('url:**/pulls**');
  });

  it('clamps a hostile wait timeout from the cache file instead of waiting for ever', async () => {
    const forever: TraceStep = { tool: 'browser_wait', axis: { kind: 'none' }, args: { urlGlob: '**/x', timeout: 0 } };
    const huge: TraceStep = { tool: 'browser_wait', axis: { kind: 'none' }, args: { urlGlob: '**/y', timeout: 1e9 } };
    const timeouts: number[] = [];
    const waitForURL = async (_url: string, opts: { timeout: number }) => { timeouts.push(opts.timeout); };
    const result = await replayTrace({ ...(page as object), waitForURL } as never, trace([forever, huge]), undefined);
    expect(result.ok).toBe(true);
    expect(timeouts).toEqual([30000, 60000]);
  });
});

describe('navigation watch (#1193)', () => {
  it('treats a main-frame navigation REQUEST as a navigation, so a slow origin is not missed', async () => {
    const mod = await import('../../playwright/snapshot');
    let reads = 0;
    vi.spyOn(mod, 'generateSnapshot').mockImplementation(async () => { reads++; return ''; });
    const mockedResolve = vi.spyOn(mod, 'resolveRef').mockImplementation(async (_p, ref) => {
      if (ref === '1') {
        for (const fn of navListeners) {
          (fn as (arg: unknown) => void)({ isNavigationRequest: () => true, frame: () => ({ parentFrame: () => null }) });
        }
      }
      return resolved.has(ref) ? ({ click: async () => undefined } as never) : null;
    });
    const result = await replayTrace(page, trace([refStep(), refStep()]), undefined);
    expect(result.ok).toBe(true);
    expect(waits).toEqual(['load:domcontentloaded']);
    // A settle ran: at least two reads after the pre-flight one.
    expect(reads).toBeGreaterThanOrEqual(3);
    mockedResolve.mockRestore();
  });
});
