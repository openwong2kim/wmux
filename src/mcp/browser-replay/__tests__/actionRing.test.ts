import { describe, it, expect, beforeEach, vi } from 'vitest';

const refEntries = new Map<string, { role: string; name: string; sameNameIndex: number; sameNameTotal: number; frameKey: string }>();

vi.mock('../../playwright/snapshot', () => ({
  getRefEntry: (_page: unknown, ref: string) => refEntries.get(ref),
}));

import {
  ActionRing,
  recordAction,
  resetModuleRing,
  ringFor,
} from '../actionRing';
import { ACTION_RING_CAPACITY, MAX_ARG_BYTES } from '../../../shared/browserReplay/actionTrace';

const deps = { resolveWorkspaceId: async () => 'ws-1' };
const fakePage = { url: () => 'https://example.com/app?q=1' } as never;

beforeEach(() => {
  resetModuleRing();
  refEntries.clear();
  refEntries.set('4', { role: 'button', name: 'Sign in', sameNameIndex: 0, sameNameTotal: 1, frameKey: '' });
});

describe('ActionRing', () => {
  it('holds at most ACTION_RING_CAPACITY actions, dropping the oldest', () => {
    const ring = new ActionRing();
    for (let i = 0; i < ACTION_RING_CAPACITY + 5; i++) {
      ring.push({ step: { tool: 'browser_click', axis: { kind: 'none' }, args: { i } }, urlKey: 'u', at: i });
    }
    const all = ring.all();
    expect(all).toHaveLength(ACTION_RING_CAPACITY);
    expect(all[0].step.args.i).toBe(5);
  });

  it('cuts the tail from the most recent navigate when no count is given', () => {
    const ring = new ActionRing();
    const push = (tool: 'browser_navigate' | 'browser_click', tag: number) =>
      ring.push({ step: { tool, axis: { kind: 'none' }, args: { tag } }, urlKey: 'u', at: tag });
    push('browser_click', 1);
    push('browser_navigate', 2);
    push('browser_click', 3);
    push('browser_click', 4);
    expect(ring.tail().map((a) => a.step.args.tag)).toEqual([2, 3, 4]);
  });

  it('takes the whole ring when no navigate was recorded', () => {
    const ring = new ActionRing();
    ring.push({ step: { tool: 'browser_click', axis: { kind: 'none' }, args: {} }, urlKey: 'u', at: 1 });
    expect(ring.tail()).toHaveLength(1);
  });

  it('honours an explicit step count', () => {
    const ring = new ActionRing();
    for (let i = 0; i < 6; i++) {
      ring.push({ step: { tool: 'browser_click', axis: { kind: 'none' }, args: { i } }, urlKey: 'u', at: i });
    }
    expect(ring.tail(2).map((a) => a.step.args.i)).toEqual([4, 5]);
  });

  it('gives a connection its own ring when deps carry one', () => {
    const own = new ActionRing();
    expect(ringFor({ ...deps, actionRing: own } as never)).toBe(own);
    expect(ringFor(deps)).not.toBe(own);
  });
});

describe('recordAction', () => {
  it('records a ref action on the snapshot 4-tuple axis', () => {
    recordAction(deps, { tool: 'browser_click', page: fakePage, ref: '4' });
    const [entry] = ringFor(deps).all();
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
    recordAction(deps, { tool: 'browser_click', page: null, ref: '4' });
    expect(ringFor(deps).all()[0].step.unrecordable).toBe('rpc-transport');
  });

  it('marks a ref the current snapshot does not know as unreplayable', () => {
    recordAction(deps, { tool: 'browser_click', page: fakePage, ref: '999' });
    expect(ringFor(deps).all()[0].step.unrecordable).toBe('unresolved-axis');
  });

  it('never lets a password value into the ring', () => {
    recordAction(deps, {
      tool: 'browser_type',
      page: fakePage,
      ref: '4',
      args: {},
      unrecordable: 'password',
    });
    const [entry] = ringFor(deps).all();
    expect(entry.step.unrecordable).toBe('password');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(Object.keys(entry.step.args)).toEqual([]);
  });

  it('marks a step whose argument had to be truncated', () => {
    recordAction(deps, {
      tool: 'browser_type',
      page: fakePage,
      ref: '4',
      args: { text: 'x'.repeat(MAX_ARG_BYTES + 1) },
    });
    expect(ringFor(deps).all()[0].step.unrecordable).toBe('unresolved-axis');
  });

  it('strips a credential out of a recorded navigate URL and holes the step', () => {
    recordAction(deps, {
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://alice:hunter2@example.com/app' },
      url: 'https://example.com/app',
    });
    const [entry] = ringFor(deps).all();
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    // Changed URL cannot replay what worked, so it is an honest hole.
    expect(entry.step.unrecordable).toBe('redacted-url');
  });

  it('masks a password-family query parameter and holes the step', () => {
    recordAction(deps, {
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://example.com/login?user=a&password=hunter2' },
      url: 'https://example.com/login',
    });
    const [entry] = ringFor(deps).all();
    expect(JSON.stringify(entry)).not.toContain('hunter2');
    expect(entry.step.unrecordable).toBe('redacted-url');
  });

  it('leaves a clean navigate URL replayable', () => {
    recordAction(deps, {
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://example.com/app?q=cats' },
      url: 'https://example.com/app',
    });
    const [entry] = ringFor(deps).all();
    expect(entry.step.args.url).toBe('https://example.com/app?q=cats');
    expect(entry.step.unrecordable).toBeUndefined();
  });

  it('records a css axis for a smart-snapshot click', () => {
    recordAction(deps, { tool: 'browser_click', page: fakePage, selector: '#go' });
    expect(ringFor(deps).all()[0].step.axis).toEqual({ kind: 'css', selector: '#go' });
  });

  it('records both ends of a drag', () => {
    refEntries.set('5', { role: 'listitem', name: 'Card', sameNameIndex: 1, sameNameTotal: 3, frameKey: '' });
    recordAction(deps, { tool: 'browser_drag', page: fakePage, ref: '4', targetRef: '5' });
    const [entry] = ringFor(deps).all();
    expect(entry.step.target2).toMatchObject({ kind: 'ref', role: 'listitem', sameNameIndex: 1 });
  });

  it('marks a drag whose target ref is unknown', () => {
    recordAction(deps, { tool: 'browser_drag', page: fakePage, ref: '4', targetRef: 'gone' });
    expect(ringFor(deps).all()[0].step.unrecordable).toBe('unresolved-axis');
  });

  it('prefers an explicit url over the page url (the navigate case)', () => {
    recordAction(deps, {
      tool: 'browser_navigate',
      page: null,
      args: { url: 'https://example.com/a' },
      url: 'https://example.com/final?x=1',
    });
    expect(ringFor(deps).all()[0].urlKey).toBe('https://example.com/final');
  });

  it('swallows a page that throws rather than failing the action it observed', () => {
    const hostile = { url: () => { throw new Error('detached'); } } as never;
    expect(() => recordAction(deps, { tool: 'browser_click', page: hostile, ref: '4' })).not.toThrow();
    expect(ringFor(deps).all()).toHaveLength(1);
  });
});
