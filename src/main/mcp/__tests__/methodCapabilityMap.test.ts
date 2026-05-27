import { describe, expect, it } from 'vitest';
import { ALL_RPC_METHODS, type RpcMethod } from '../../../shared/rpc';
import { METHOD_CAPABILITY } from '../methodCapabilityMap';
import { listKnownCapabilities } from '../permissionGrammar';

describe('methodCapabilityMap totality', () => {
  it('has an entry for every RpcMethod', () => {
    for (const method of ALL_RPC_METHODS) {
      expect(METHOD_CAPABILITY[method]).toBeDefined();
    }
  });

  it('has no entries for unknown methods (no over-declaration)', () => {
    const declared = new Set(Object.keys(METHOD_CAPABILITY));
    const known = new Set<string>(ALL_RPC_METHODS as readonly string[]);
    for (const k of declared) {
      expect(known.has(k)).toBe(true);
    }
  });
});

describe('methodCapabilityMap capability validity', () => {
  it('every non-null, non-internal capability appears in KNOWN_CAPABILITIES', () => {
    const known = new Set(listKnownCapabilities());
    for (const method of ALL_RPC_METHODS) {
      const cap = METHOD_CAPABILITY[method].capability;
      if (cap === null) continue;
      if (cap === 'wmux.internal') continue;
      expect(known.has(cap), `method=${method} capability=${cap}`).toBe(true);
    }
  });

  it('identity bootstrap methods declare capability: null', () => {
    expect(METHOD_CAPABILITY['mcp.identify'].capability).toBeNull();
    expect(METHOD_CAPABILITY['mcp.declarePermissions'].capability).toBeNull();
    expect(METHOD_CAPABILITY['system.identify'].capability).toBeNull();
    expect(METHOD_CAPABILITY['system.capabilities'].capability).toBeNull();
  });
});

describe('methodCapabilityMap risk class wiring', () => {
  const expectations: Array<[RpcMethod, string]> = [
    ['input.send', 'terminal-input'],
    ['input.sendKey', 'terminal-input'],
    ['input.readScreen', 'terminal-content'],
    ['terminal.readEvents', 'terminal-content'],
    ['pane.search', 'terminal-content'],
    ['pane.setMetadata', 'metadata'],
    ['pane.getMetadata', 'metadata'],
    ['pane.clearMetadata', 'metadata'],
    ['events.poll', 'events'],
    ['browser.screenshot', 'browser'],
    ['a2a.task.send', 'a2a'],
  ];
  for (const [method, klass] of expectations) {
    it(`${method} → ${klass}`, () => {
      expect(METHOD_CAPABILITY[method].riskClass).toBe(klass);
    });
  }
});

describe('methodCapabilityMap path extractor behavior', () => {
  it('pane.setMetadata extracts label/role/status + custom.* paths', () => {
    const ext = METHOD_CAPABILITY['pane.setMetadata'].pathFromParams;
    if (typeof ext !== 'function') throw new Error('expected function');
    expect(ext({ label: 'foo' })).toEqual(['label']);
    expect(ext({ label: 'a', role: 'b', status: 'c' })).toEqual(['label', 'role', 'status']);
    expect(ext({ custom: { dashboard: 'on', counter: '42' } })).toEqual([
      'custom.dashboard',
      'custom.counter',
    ]);
    expect(ext({ label: 'x', custom: { foo: 'y' } })).toEqual(['label', 'custom.foo']);
    expect(ext({})).toBeUndefined();
    // Non-object custom is ignored, not crashed
    expect(ext({ custom: 'oops' })).toBeUndefined();
  });

  it('pane.clearMetadata enumerates shared paths regardless of params', () => {
    const ext = METHOD_CAPABILITY['pane.clearMetadata'].pathFromParams;
    if (typeof ext !== 'function') throw new Error('expected function');
    expect(ext({})).toEqual(['label', 'role', 'status']);
    expect(ext({ paneId: 'p1' })).toEqual(['label', 'role', 'status']);
  });

  it('events.poll returns ** for undefined types (full subscription)', () => {
    const ext = METHOD_CAPABILITY['events.poll'].pathFromParams;
    if (typeof ext !== 'function') throw new Error('expected function');
    expect(ext({})).toBe('**');
    expect(ext({ types: [] })).toBe('**');
  });

  it('events.poll passes through string array of types', () => {
    const ext = METHOD_CAPABILITY['events.poll'].pathFromParams;
    if (typeof ext !== 'function') throw new Error('expected function');
    expect(ext({ types: ['pane.created', 'agent.lifecycle'] })).toEqual([
      'pane.created',
      'agent.lifecycle',
    ]);
  });
});

describe('methodCapabilityMap multi-path mode', () => {
  it('pane.setMetadata is all-or-nothing (writes shouldn\'t silently drop fields)', () => {
    expect(METHOD_CAPABILITY['pane.setMetadata'].multiPathMode).toBe('all-or-nothing');
  });
  it('pane.clearMetadata is all-or-nothing (can\'t partially-clear)', () => {
    expect(METHOD_CAPABILITY['pane.clearMetadata'].multiPathMode).toBe('all-or-nothing');
  });
  it('events.poll is partial (filter to allowed topics is fine)', () => {
    expect(METHOD_CAPABILITY['events.poll'].multiPathMode).toBe('partial');
  });
});
