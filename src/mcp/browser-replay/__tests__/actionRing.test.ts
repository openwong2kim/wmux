import { describe, it, expect, beforeEach, vi } from 'vitest';

const refEntries = new Map<string, { role: string; name: string; sameNameIndex: number; sameNameTotal: number; frameKey: string }>();

vi.mock('../../playwright/snapshot', () => ({
  getRefEntry: (_page: unknown, ref: string) => refEntries.get(ref),
  listRefEntries: () => [...refEntries.values()],
  browserScopeKey: (scope: { workspaceId: string; surfaceId?: string }) =>
    `${scope.workspaceId}\u0000${scope.surfaceId ?? ''}`,
}));

import { ActionRing, recordAction, ringFor, type ActionRingDeps } from '../actionRing';
import { ACTION_RING_CAPACITY, MAX_ARG_BYTES } from '../../../shared/browserReplay/actionTrace';

const scope = { workspaceId: 'ws-1', surfaceId: 's1' };
const SCOPE_KEY = 'ws-1\u0000s1';
const otherScope = { workspaceId: 'ws-1', surfaceId: 's2' };
const OTHER_KEY = 'ws-1\u0000s2';

let ring: ActionRing;
let deps: ActionRingDeps;
const fakePage = { url: () => 'https://example.com/app?q=1' } as never;

beforeEach(() => {
  ring = new ActionRing();
  deps = { resolveWorkspaceId: async () => 'ws-1', actionRing: ring };
  refEntries.clear();
  refEntries.set('4', { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' });
});

function entry(
  tool: 'browser_navigate' | 'browser_click',
  tag: number,
  scopeKey = SCOPE_KEY,
) {
  return {
    step: { tool, axis: { kind: 'none' as const }, args: { tag } },
    urlKey: 'u',
    scopeKey,
    surfaceShape: '',
    at: tag,
  };
}

describe('ActionRing', () => {
  it('holds at most ACTION_RING_CAPACITY actions, dropping the oldest', () => {
    for (let i = 0; i < ACTION_RING_CAPACITY + 5; i++) ring.push(entry('browser_click', i));
    const all = ring.all();
    expect(all).toHaveLength(ACTION_RING_CAPACITY);
    expect(all[0].step.args.tag).toBe(5);
  });

  it('cuts the tail from the most recent navigate when no count is given', () => {
    ring.push(entry('browser_click', 1));
    ring.push(entry('browser_navigate', 2));
    ring.push(entry('browser_click', 3));
    ring.push(entry('browser_click', 4));
    expect(ring.tail(SCOPE_KEY).map((a) => a.step.args.tag)).toEqual([2, 3, 4]);
  });

  it('takes the whole scope run when no navigate was recorded', () => {
    ring.push(entry('browser_click', 1));
    expect(ring.tail(SCOPE_KEY)).toHaveLength(1);
  });

  it('honours an explicit step count', () => {
    for (let i = 0; i < 6; i++) ring.push(entry('browser_click', i));
    expect(ring.tail(SCOPE_KEY, 2).map((a) => a.step.args.tag)).toEqual([4, 5]);
  });

  it('returns nothing for a scope that has recorded nothing', () => {
    ring.push(entry('browser_click', 1));
    expect(ring.tail(OTHER_KEY)).toEqual([]);
  });

  it('cuts only the TRAILING run of the saving scope, never across a surface switch', () => {
    ring.push(entry('browser_click', 1));
    ring.push(entry('browser_navigate', 2));
    ring.push(entry('browser_click', 3, OTHER_KEY));
    ring.push(entry('browser_click', 4));
    ring.push(entry('browser_click', 5));
    // 1 and 2 are the SAME scope but sit on the far side of another surface's
    // action; splicing them in would invent a flow that never happened.
    expect(ring.tail(SCOPE_KEY).map((a) => a.step.args.tag)).toEqual([4, 5]);
  });

  it('an explicit count still cannot reach past the surface switch', () => {
    ring.push(entry('browser_click', 1));
    ring.push(entry('browser_click', 2, OTHER_KEY));
    ring.push(entry('browser_click', 3));
    expect(ring.tail(SCOPE_KEY, 10).map((a) => a.step.args.tag)).toEqual([3]);
  });

  it('a connection without a ring records nothing rather than sharing one', () => {
    const ringless = { resolveWorkspaceId: async () => 'ws-1' };
    expect(ringFor(ringless)).toBeNull();
    expect(() => recordAction(ringless, { scope, tool: 'browser_click', page: fakePage, ref: '4' }))
      .not.toThrow();
    expect(ring.all()).toEqual([]);
  });

  it('gives a connection its own ring when deps carry one', () => {
    const own = new ActionRing();
    expect(ringFor({ ...deps, actionRing: own } as ActionRingDeps)).toBe(own);
    expect(ringFor(deps)).toBe(ring);
  });
});

describe('recordAction', () => {
  it('records a ref action on the snapshot 4-tuple axis', () => {
    recordAction(deps, { scope, tool: 'browser_click', page: fakePage, ref: '4' });
    const [entry] = ring.all();
    expect(entry.step.axis).toEqual({
      kind: 'ref',
      role: 'button',
      name: 'Sign in',
      sameNameIndex: 0,
      sameNameTotal: 1,
      frameKey: '',
    });
    expect(entry.urlKey).toBe('https://example.com/app');
    expect(entry.step.unrecordable).toBeUndefined();
  });

  it('marks an action that went over the RPC lane as unreplayable', () => {
    recordAction(deps, { scope, tool: 'browser_click', page: null, ref: '4' });
    expect(ring.all()[0].step.unrecordable).toBe('rpc-transport');
  });

  it('marks a ref the current snapshot does not know as unreplayable', () => {
    recordAction(deps, { scope, tool: 'browser_click', page: fakePage, ref: '999' });
    expect(ring.all()[0].step.unrecordable).toBe('unresolved-axis');
  });

  it('never lets a password value into the ring', () => {
    recordAction(deps, {
      scope,
      tool: 'browser_type',
      page: fakePage,
      ref: '4',
      args: {},
      unrecordable: 'password',
    });
    const [entry] = ring.all();
    expect(entry.step.unrecordable).toBe('password');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(Object.keys(entry.step.args)).toEqual([]);
  });

  it('marks a step whose argument had to be truncated', () => {
    recordAction(deps, {
      scope,
      tool: 'browser_type',
      page: fakePage,
      ref: '4',
      args: { text: 'x'.repeat(MAX_ARG_BYTES + 1) },
    });
    expect(ring.all()[0].step.unrecordable).toBe('unresolved-axis');
  });

  it('strips a credential out of a recorded navigate URL and holes the step', () => {
    recordAction(deps, {
      scope,
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://alice:hunter2@example.com/app' },
      url: 'https://example.com/app',
    });
    const [entry] = ring.all();
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    // Changed URL cannot replay what worked, so it is an honest hole.
    expect(entry.step.unrecordable).toBe('redacted-url');
  });

  it('masks a password-family query parameter and holes the step', () => {
    recordAction(deps, {
      scope,
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://example.com/login?user=a&password=hunter2' },
      url: 'https://example.com/login',
    });
    const [entry] = ring.all();
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(entry.step.unrecordable).toBe('redacted-url');
  });

  it('leaves a clean navigate URL replayable', () => {
    recordAction(deps, {
      scope,
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://example.com/app?q=cats' },
      url: 'https://example.com/app',
    });
    const [entry] = ring.all();
    expect(entry.step.args.url).toBe('https://example.com/app?q=cats');
    expect(entry.step.unrecordable).toBeUndefined();
  });

  it('records a css axis for a smart-snapshot click', () => {
    recordAction(deps, { scope, tool: 'browser_click', page: fakePage, selector: '#go' });
    expect(ring.all()[0].step.axis).toEqual({ kind: 'css', selector: '#go' });
  });

  it('records both ends of a drag', () => {
    refEntries.set('5', { role: 'listitem', name: 'Card', sameNameIndex: 1, sameNameTotal: 3, frameKey: '' });
    recordAction(deps, { scope, tool: 'browser_drag', page: fakePage, ref: '4', targetRef: '5' });
    const [entry] = ring.all();
    expect(entry.step.target2).toMatchObject({ kind: 'ref', role: 'listitem', sameNameIndex: 1 });
  });

  it('marks a drag whose target ref is unknown', () => {
    recordAction(deps, { scope, tool: 'browser_drag', page: fakePage, ref: '4', targetRef: 'gone' });
    expect(ring.all()[0].step.unrecordable).toBe('unresolved-axis');
  });

  it('prefers an explicit url over the page url (the navigate case)', () => {
    recordAction(deps, {
      scope,
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://example.com/a' },
      url: 'https://example.com/final?x=1',
    });
    expect(ring.all()[0].urlKey).toBe('https://example.com/final');
  });

  it('swallows a page that throws rather than failing the action it observed', () => {
    const hostile = { url: () => { throw new Error('detached'); } } as never;
    expect(() => recordAction(deps, { scope, tool: 'browser_click', page: hostile, ref: '4' })).not.toThrow();
    expect(ring.all()).toHaveLength(1);
  });
});
