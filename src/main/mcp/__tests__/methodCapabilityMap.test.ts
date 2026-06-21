import { describe, expect, it } from 'vitest';
import { ALL_RPC_METHODS, type RpcMethod } from '../../../shared/rpc';
import {
  CAPABILITY_RISK_CLASS,
  METHOD_CAPABILITY,
  RISK_CLASS_COPY,
  resolveRequiredCapability,
  type RiskClass,
} from '../methodCapabilityMap';
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
      const caps = new Set([
        resolveRequiredCapability(METHOD_CAPABILITY[method], {}),
        resolveRequiredCapability(METHOD_CAPABILITY[method], { execute: true }),
      ]);
      for (const cap of caps) {
        if (cap === null) continue;
        if (cap === 'wmux.internal') continue;
        expect(known.has(cap), `method=${method} capability=${cap}`).toBe(true);
      }
    }
  });

  it('identity bootstrap methods declare capability: null', () => {
    expect(resolveRequiredCapability(METHOD_CAPABILITY['mcp.identify'], {})).toBeNull();
    expect(resolveRequiredCapability(METHOD_CAPABILITY['mcp.declarePermissions'], {})).toBeNull();
    expect(resolveRequiredCapability(METHOD_CAPABILITY['system.identify'], {})).toBeNull();
    expect(resolveRequiredCapability(METHOD_CAPABILITY['system.capabilities'], {})).toBeNull();
  });

  it('a2a.task.send requires a2a.execute only for execute:true', () => {
    expect(resolveRequiredCapability(METHOD_CAPABILITY['a2a.task.send'], {})).toBe('a2a.send');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['a2a.task.send'], { execute: false })).toBe('a2a.send');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['a2a.task.send'], { execute: 'false' })).toBe('a2a.send');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['a2a.task.send'], { execute: true })).toBe('a2a.execute');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['a2a.task.cancel'], {})).toBe('a2a.send');
  });

  // Drift lock (LanLink PR-3): the control-plane RPCs must stay daemon-internal.
  // wmux.internal is a reserved prefix no plugin can declare and never an external
  // MCP surface — this pins them against an accidental downgrade to a
  // plugin-grantable capability that would expose the host's NICs / LAN toggle.
  it('lanlink.* control-plane RPCs are wmux.internal (never plugin-declarable)', () => {
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.status'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.configure'], {})).toBe('wmux.internal');
    // PR-5 pairing/peer control plane — same daemon-internal posture.
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.pair.begin'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.pair.status'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.pair.cancel'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.pair.join'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.send'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.peers.list'], {})).toBe('wmux.internal');
    expect(resolveRequiredCapability(METHOD_CAPABILITY['lanlink.peers.remove'], {})).toBe('wmux.internal');
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

describe('CAPABILITY_RISK_CLASS — wording table coverage (Phase 2.2 pre-commit 5)', () => {
  it('classifies every grantable capability from KNOWN_CAPABILITIES', () => {
    const known = listKnownCapabilities();
    for (const cap of known) {
      expect(
        CAPABILITY_RISK_CLASS[cap],
        `capability ${cap} has no risk class — approval dialog would render fallback copy`,
      ).toBeDefined();
    }
  });

  it('uses only well-defined risk classes from RISK_CLASS_COPY', () => {
    for (const [cap, klass] of Object.entries(CAPABILITY_RISK_CLASS)) {
      expect(
        RISK_CLASS_COPY[klass],
        `capability ${cap} → risk class ${klass} has no copy entry`,
      ).toBeDefined();
    }
  });

  it('flags terminal.read and pane.search as terminal-content (spec §3.6)', () => {
    expect(CAPABILITY_RISK_CLASS['terminal.read']).toBe('terminal-content');
    expect(CAPABILITY_RISK_CLASS['pane.search']).toBe('terminal-content');
  });

  it('flags terminal.send as terminal-input (spec §3.6)', () => {
    expect(CAPABILITY_RISK_CLASS['terminal.send']).toBe('terminal-input');
  });
});

describe('RISK_CLASS_COPY — wording asymmetry (plan D5)', () => {
  it('rates terminal-content and terminal-input as critical severity', () => {
    expect(RISK_CLASS_COPY['terminal-content'].severity).toBe('critical');
    expect(RISK_CLASS_COPY['terminal-input'].severity).toBe('critical');
  });

  it('rates metadata, events, pane-lifecycle, and workspace as neutral', () => {
    const neutrals: RiskClass[] = ['metadata', 'events', 'pane-lifecycle', 'workspace'];
    for (const r of neutrals) {
      expect(RISK_CLASS_COPY[r].severity).toBe('neutral');
    }
  });

  it('rates browser and a2a as caution', () => {
    expect(RISK_CLASS_COPY['browser'].severity).toBe('caution');
    expect(RISK_CLASS_COPY['a2a'].severity).toBe('caution');
  });

  it('uses concrete user-facing language for terminal-content (no euphemisms)', () => {
    // The copy must name the concrete privilege, not soften it. This pins
    // the asymmetry against future "let's be friendlier" refactors.
    const detail = RISK_CLASS_COPY['terminal-content'].detail;
    expect(detail).toMatch(/secrets|read|screen/i);
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
