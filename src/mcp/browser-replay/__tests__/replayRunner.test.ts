import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeRefEntry {
  role: string;
  name: string;
  sameNameIndex: number;
  sameNameTotal: number;
  frameKey: string;
  ref: number;
}

/** What the page's "last snapshot" currently holds. Mutated per case. */
let refEntries: FakeRefEntry[] = [];
let snapshotText = 'button "Sign in" [ref=1]';
const resolved = new Set<string>();

vi.mock('../../playwright/snapshot', () => ({
  generateSnapshot: async () => snapshotText,
  listRefEntries: () => refEntries,
  resolveRef: async (_page: unknown, ref: string) =>
    resolved.has(ref) ? ({ click: async () => undefined, fill: async () => undefined } as never) : null,
}));

import { replayBlockedReason, replayTrace } from '../replayRunner';
import { refMapShapeHash, type TraceRecord, type TraceStep } from '../../../shared/browserReplay/actionTrace';

const clicks: string[] = [];
const pressed: string[] = [];
const goneTo: string[] = [];

const page = {
  url: () => 'https://example.com/app',
  goto: async (url: string) => { goneTo.push(url); },
  keyboard: { press: async (key: string) => { pressed.push(key); } },
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
  clicks.length = 0;
  pressed.length = 0;
  goneTo.length = 0;
  resolved.clear();
  snapshotText = 'button "Sign in" [ref=1]';
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
    expect(spy).toHaveBeenCalledWith(page, '904');
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

  it('warns but continues when the population grew AROUND the recorded first element', async () => {
    // Index 0: nothing can have been inserted above it, so it is still itself.
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 2, frameKey: '', ref: 1 },
      { role: 'button', name: 'Sign in', sameNameIndex: 1, sameNameTotal: 2, frameKey: '', ref: 2 },
    ];
    const mod = await import('../../playwright/snapshot');
    vi.spyOn(mod, 'resolveRef').mockResolvedValue(element('a'));

    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(' ')).toContain('the recording had 1');
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

  it('refuses when the recorded position no longer exists in the population', async () => {
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '', ref: 1 },
    ];
    const step = refStep({
      axis: { kind: 'ref', role: 'button', name: 'Sign in', sameNameIndex: 2, sameNameTotal: 3, frameKey: '' },
    });
    const result = await replayTrace(page, trace([step]), undefined);
    expect(result.ok).toBe(false);
    expect(result.steps[0].detail).toContain('none at position 3');
  });

  it('does not match an entry in a different frame', async () => {
    refEntries = [
      { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: 'f1', ref: 1 },
    ];
    const result = await replayTrace(page, trace([refStep()]), undefined);
    expect(result.ok).toBe(false);
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
