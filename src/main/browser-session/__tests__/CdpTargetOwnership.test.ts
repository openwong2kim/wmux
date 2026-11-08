// Which targets an external client of the pipe may see (C3b): the precedence
// table, each grant beside the denial it must not turn into.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CdpTargetOwnership, cdpTargetGrantEnabled, NEVER_GRANTED_TYPES, OPENER_DEPTH, recordVisibleTo, type TargetRegistry } from '../CdpTargetOwnership';

const A = { workspaceId: 'ws-a' };
const B = { workspaceId: 'ws-b' };
const NONE = {};
const clientA = { name: 'a' };
const clientB = { name: 'b' };

function ownership(records: Record<string, { workspaceId?: string }> = {}) {
  const registry: TargetRegistry = (id) => records[id] ?? null;
  return new CdpTargetOwnership(registry);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('cdpTargetGrantEnabled', () => {
  it('is off unless WMUX_CDP_TARGET_GRANT=1', () => {
    expect(cdpTargetGrantEnabled()).toBe(false);
    vi.stubEnv('WMUX_CDP_TARGET_GRANT', 'true');
    expect(cdpTargetGrantEnabled()).toBe(false);
    vi.stubEnv('WMUX_CDP_TARGET_GRANT', '1');
    expect(cdpTargetGrantEnabled()).toBe(true);
  });
});

describe('recordVisibleTo (main\'s target lists and the pipe)', () => {
  it('shows a record only to its own workspace; a record or a caller with none sees nothing', () => {
    expect(recordVisibleTo('ws-a', 'ws-a')).toBe(true);
    expect(recordVisibleTo('ws-a', 'ws-b')).toBe(false);
    expect(recordVisibleTo(undefined, 'ws-a')).toBe(false);
    expect(recordVisibleTo('ws-a', undefined)).toBe(false);
    expect(recordVisibleTo(undefined, undefined)).toBe(false);
  });
});

describe("main's target lists and the pipe give the same answers", () => {
  it('for every record and caller, the registry rule grants exactly what recordVisibleTo shows', () => {
    for (const recordWs of ['ws-a', 'ws-b', undefined]) {
      for (const callerWs of ['ws-a', 'ws-b', undefined]) {
        const o = ownership({ t: recordWs === undefined ? {} : { workspaceId: recordWs } });
        o.learn({ targetId: 't', type: 'page' });
        const pipe = o.decide(clientA, callerWs === undefined ? {} : { workspaceId: callerWs }, 't') === 'grant';
        expect(pipe, `${recordWs}/${callerWs}`).toBe(recordVisibleTo(recordWs, callerWs));
      }
    }
  });
});

describe('CdpTargetOwnership.decide', () => {
  it('registry: the record\'s own workspace only', () => {
    const o = ownership({ p1: { workspaceId: 'ws-a' } });
    o.learn({ targetId: 'p1', type: 'page' });
    expect(o.decide(clientA, A, 'p1')).toBe('grant');
    expect(o.decide(clientB, B, 'p1')).toBe('deny');
    expect(o.decide(clientB, NONE, 'p1')).toBe('deny');
  });

  it('a record under another workspace denies even what the client created or opened', () => {
    const o = ownership({ p2: { workspaceId: 'ws-b' }, pop: { workspaceId: 'ws-b' } });
    o.learn({ targetId: 'p2', type: 'page' });
    o.created(clientA, 'p2');
    expect(o.decide(clientA, A, 'p2')).toBe('deny');
    o.learn({ targetId: 'mine', type: 'page' });
    o.created(clientA, 'mine');
    o.learn({ targetId: 'pop', type: 'page', openerId: 'mine' });
    expect(o.decide(clientA, A, 'pop')).toBe('deny');
    expect(o.decide(clientB, B, 'pop')).toBe('grant');
  });

  it('a record without a workspace grants nothing and takes nothing away', () => {
    const o = ownership({ nows: {}, nows2: {} });
    o.learn({ targetId: 'nows', type: 'page' });
    expect(o.decide(clientA, A, 'nows')).toBe('deny');
    o.learn({ targetId: 'nows2', type: 'page' });
    o.created(clientA, 'nows2');
    expect(o.decide(clientA, A, 'nows2')).toBe('grant');
    expect(o.decide(clientB, B, 'nows2')).toBe('deny');
  });

  it('created: the creating client only, whatever its workspace', () => {
    const o = ownership();
    o.learn({ targetId: 't', type: 'page' });
    o.created(clientA, 't');
    expect(o.decide(clientA, A, 't')).toBe('grant');
    expect(o.decide(clientA, NONE, 't')).toBe('grant');
    expect(o.decide(clientB, A, 't')).toBe('deny');
    // The first creator keeps it.
    o.created(clientB, 't');
    expect(o.decide(clientB, B, 't')).toBe('deny');
  });

  it('a page in a browser context the client created is the client\'s; one in another\'s context is not', () => {
    const o = ownership();
    o.createdContext(clientA, 'ctx-a');
    o.learn({ targetId: 'c1', type: 'page', browserContextId: 'ctx-a' });
    expect(o.decide(clientA, A, 'c1')).toBe('grant');
    expect(o.decide(clientB, A, 'c1')).toBe('deny');
    expect(o.ownsContext(clientA, 'ctx-a')).toBe(true);
    expect(o.ownsContext(clientB, 'ctx-a')).toBe(false);
    o.disposedContext('ctx-a');
    expect(o.decide(clientA, A, 'c1')).toBe('deny');
  });

  it('opened: through the opener chain, for the popup\'s life, even once the opener is gone', () => {
    const o = ownership({ root: { workspaceId: 'ws-a' } });
    o.learn({ targetId: 'root', type: 'page' });
    o.learn({ targetId: 'p1', type: 'page', openerId: 'root' });
    o.learn({ targetId: 'p2', type: 'page', openerId: 'p1' });
    expect(o.decide(clientA, A, 'p2')).toBe('grant');
    expect(o.decide(clientB, B, 'p2')).toBe('deny');
    // The openers close: the popups keep their grant, to the same workspace only.
    o.destroyed('p1');
    o.destroyed('root');
    expect(o.decide(clientA, A, 'p2')).toBe('grant');
    expect(o.decide(clientB, B, 'p2')).toBe('deny');
  });

  it('a popup of a page the client created keeps its grant when that page closes', () => {
    const o = ownership();
    o.learn({ targetId: 'mine', type: 'page' });
    o.created(clientA, 'mine');
    o.learn({ targetId: 'pop', type: 'page', openerId: 'mine' });
    o.destroyed('mine');
    expect(o.decide(clientA, NONE, 'pop')).toBe('grant');
    expect(o.decide(clientB, A, 'pop')).toBe('deny');
  });

  it('an opener, once known, is never replaced by a later targetInfo', () => {
    const o = ownership({ root: { workspaceId: 'ws-a' } });
    o.learn({ targetId: 'root', type: 'page' });
    o.learn({ targetId: 'pop', type: 'page', openerId: 'root' });
    o.learn({ targetId: 'pop', type: 'page', openerId: 'elsewhere' });
    expect(o.decide(clientA, A, 'pop')).toBe('grant');
  });

  it(`follows at most ${OPENER_DEPTH} openers, and a cycle denies`, () => {
    // Main files the first page only after the popups were found, so nothing
    // was inherited and the chain is walked live.
    const records: Record<string, { workspaceId?: string }> = {};
    const o = ownership(records);
    o.learn({ targetId: 't0', type: 'page' });
    for (let i = 1; i <= OPENER_DEPTH + 1; i++) o.learn({ targetId: `t${i}`, type: 'page', openerId: `t${i - 1}` });
    records.t0 = { workspaceId: 'ws-a' };
    expect(o.decide(clientA, A, `t${OPENER_DEPTH}`)).toBe('grant');
    expect(o.decide(clientA, A, `t${OPENER_DEPTH + 1}`)).toBe('deny');
    const c = ownership();
    c.learn({ targetId: 'x', type: 'page', openerId: 'y' });
    c.learn({ targetId: 'y', type: 'page', openerId: 'x' });
    expect(c.decide(clientA, A, 'x')).toBe('deny');
  });

  it("the browser target is every client's (it is what Target.attachToBrowserTarget gives)", () => {
    const o = ownership();
    o.learn({ targetId: 'br', type: 'browser' });
    expect(o.decide(clientA, A, 'br')).toBe('grant');
    expect(o.decide(clientB, NONE, 'br')).toBe('grant');
  });

  it('never grants a tab, browser UI, a background page, a service or shared worker, or a prerender', () => {
    const records: Record<string, { workspaceId?: string }> = {};
    for (const type of NEVER_GRANTED_TYPES) records[type] = { workspaceId: 'ws-a' };
    records.pre = { workspaceId: 'ws-a' };
    const o = ownership(records);
    for (const type of NEVER_GRANTED_TYPES) {
      o.learn({ targetId: type, type });
      o.created(clientA, type);
      expect(o.decide(clientA, A, type), type).toBe('deny');
    }
    o.learn({ targetId: 'pre', type: 'page', subtype: 'prerender' });
    expect(o.decide(clientA, A, 'pre')).toBe('deny');
    // Activated: the subtype goes, the record stays.
    o.learn({ targetId: 'pre', type: 'page' });
    expect(o.decide(clientA, A, 'pre')).toBe('grant');
  });

  it('an operator is granted every target', () => {
    const o = ownership({ p: { workspaceId: 'ws-b' } });
    o.learn({ targetId: 'p', type: 'page' });
    o.learn({ targetId: 't', type: 'tab' });
    expect(o.decide(clientA, { operator: true }, 'p')).toBe('grant');
    expect(o.decide(clientA, { operator: true }, 't')).toBe('grant');
    expect(o.decide(clientA, { operator: false, workspaceId: 'ws-a' }, 'p')).toBe('deny');
  });

  it('a registry that throws denies', () => {
    const o = new CdpTargetOwnership(() => { throw new Error('registry down'); });
    o.learn({ targetId: 'p', type: 'page' });
    o.created(clientA, 'p');
    expect(o.decide(clientA, A, 'p')).toBe('deny');
    expect(o.decide(clientA, A, 'p', true)).toBe('deny');
  });

  it('unknown only while the client is creating, and only for a target nothing attributes', () => {
    const o = ownership({ rec: { workspaceId: 'ws-b' } });
    o.learn({ targetId: 'fresh', type: 'page' });
    expect(o.decide(clientA, A, 'fresh', true)).toBe('unknown');
    expect(o.decide(clientA, A, 'fresh', false)).toBe('deny');
    // A popup is decided at once, never held.
    o.learn({ targetId: 'pop', type: 'page', openerId: 'fresh' });
    expect(o.hasOpener('pop')).toBe(true);
    expect(o.decide(clientA, A, 'pop', true)).toBe('deny');
    // A record, another's creation, a never-granted type: decided, not held.
    o.learn({ targetId: 'rec', type: 'page' });
    expect(o.decide(clientA, A, 'rec', true)).toBe('deny');
    o.learn({ targetId: 'bs', type: 'page' });
    o.created(clientB, 'bs');
    expect(o.decide(clientA, A, 'bs', true)).toBe('deny');
    o.learn({ targetId: 'tab1', type: 'tab' });
    expect(o.decide(clientA, A, 'tab1', true)).toBe('deny');
    // Then the reply names it.
    o.created(clientA, 'fresh');
    expect(o.decide(clientA, A, 'fresh', true)).toBe('grant');
    expect(o.decide(clientA, A, 'pop', true)).toBe('grant');
  });

  it('a client that leaves takes its creations and contexts with it', () => {
    const o = ownership();
    o.learn({ targetId: 't', type: 'page', browserContextId: 'ctx' });
    o.created(clientA, 't');
    o.createdContext(clientA, 'ctx');
    o.forget(clientA);
    expect(o.decide(clientA, A, 't')).toBe('deny');
    expect(o.ownsContext(clientA, 'ctx')).toBe(false);
  });
});
