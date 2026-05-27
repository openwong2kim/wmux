import { describe, expect, it } from 'vitest';
import type { PluginIdentityRecord, RpcContext } from '../../../shared/rpc';
import { check, checkPath } from '../PermissionEnforcer';

function trust(
  overrides: Partial<PluginIdentityRecord> & Pick<PluginIdentityRecord, 'name' | 'status'>,
): PluginIdentityRecord {
  return {
    firstSeen: 1000,
    lastSeen: 2000,
    ...overrides,
  };
}

function ctx(clientName?: string): RpcContext {
  return clientName ? { clientName } : {};
}

describe('PermissionEnforcer.check — identity bootstrap', () => {
  it('allows mcp.identify with no trust record', () => {
    const out = check({ method: 'mcp.identify', params: {}, ctx: ctx('p1'), trust: undefined });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows mcp.declarePermissions even when status=denied', () => {
    const out = check({
      method: 'mcp.declarePermissions',
      params: {},
      ctx: ctx('p1'),
      trust: trust({ name: 'p1', status: 'denied' }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows system.identify and system.capabilities unconditionally', () => {
    for (const method of ['system.identify', 'system.capabilities'] as const) {
      const out = check({ method, params: {}, ctx: ctx('p1'), trust: undefined });
      expect(out).toEqual({ kind: 'allow' });
    }
  });
});

describe('PermissionEnforcer.check — legacy (no clientName)', () => {
  it('allows when ctx.clientName is missing', () => {
    const out = check({ method: 'pane.list', params: {}, ctx: ctx(), trust: undefined });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('allows when trust.status === legacy', () => {
    const out = check({
      method: 'pane.list',
      params: {},
      ctx: ctx('p1'),
      trust: trust({ name: 'p1', status: 'legacy' }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });
});

describe('PermissionEnforcer.check — denied trust', () => {
  it('rejects with identity-status:denied and no pendingApproval', () => {
    const out = check({
      method: 'pane.list',
      params: {},
      ctx: ctx('p1'),
      trust: trust({ name: 'p1', status: 'denied', declaredCapabilities: ['pane.read'] }),
    });
    expect(out.kind).toBe('reject');
    if (out.kind !== 'reject') throw new Error('expected reject');
    expect(out.rejection.reason).toBe('identity-status');
    if (out.rejection.reason !== 'identity-status') throw new Error('narrow');
    expect(out.rejection.status).toBe('denied');
    expect(out.rejection.pendingApproval).toBeUndefined();
  });
});

describe('PermissionEnforcer.check — unconfirmed', () => {
  it('rejects with identity-status:unconfirmed (enforcer leaves promptId for dispatcher)', () => {
    const out = check({
      method: 'pane.list',
      params: {},
      ctx: ctx('p1'),
      trust: trust({ name: 'p1', status: 'unconfirmed', declaredCapabilities: ['pane.read'] }),
    });
    if (out.kind !== 'reject' || out.rejection.reason !== 'identity-status') {
      throw new Error('expected identity-status rejection');
    }
    expect(out.rejection.status).toBe('unconfirmed');
    expect(out.rejection.pendingApproval).toBeUndefined();
  });

  it('rejects clientName-stamped requests with no trust record as unconfirmed', () => {
    const out = check({ method: 'pane.list', params: {}, ctx: ctx('p1'), trust: undefined });
    if (out.kind !== 'reject' || out.rejection.reason !== 'identity-status') {
      throw new Error('expected identity-status rejection');
    }
    expect(out.rejection.status).toBe('unconfirmed');
  });
});

describe('PermissionEnforcer.check — trusted: capability check', () => {
  it('rejects when capability not declared', () => {
    const out = check({
      method: 'pane.list',
      params: {},
      ctx: ctx('p1'),
      trust: trust({ name: 'p1', status: 'trusted', declaredCapabilities: ['meta.read'] }),
    });
    if (out.kind !== 'reject' || out.rejection.reason !== 'capability-not-declared') {
      throw new Error('expected capability-not-declared');
    }
    expect(out.rejection.capability).toBe('pane.read');
  });

  it('allows when capability declared unrestricted (no glob)', () => {
    const out = check({
      method: 'pane.list',
      params: {},
      ctx: ctx('p1'),
      trust: trust({ name: 'p1', status: 'trusted', declaredCapabilities: ['pane.read'] }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('always rejects wmux.internal methods (capability is reserved-prefix, never declared)', () => {
    // A plugin can't even successfully declare 'wmux.internal' (RESERVED_PREFIXES),
    // so any declaration list always misses the capability. The map entry for
    // daemon.shutdown points to wmux.internal, so trusted plugins with a
    // legitimate-looking declaration still bounce.
    const out = check({
      method: 'daemon.shutdown',
      params: {},
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['pane.read', 'meta.write'],
      }),
    });
    if (out.kind !== 'reject' || out.rejection.reason !== 'capability-not-declared') {
      throw new Error('expected capability-not-declared');
    }
    expect(out.rejection.capability).toBe('wmux.internal');
  });
});

describe('PermissionEnforcer.check — trusted: path check (single-path)', () => {
  it('allows pane.setMetadata when declared meta.write covers all touched fields', () => {
    const out = check({
      method: 'pane.setMetadata',
      params: { label: 'foo', custom: { dash: 'on' } },
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['meta.write'],
      }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });

  it('rejects pane.setMetadata when scoped declaration misses a field (all-or-nothing)', () => {
    const out = check({
      method: 'pane.setMetadata',
      params: { label: 'foo', custom: { dash: 'on' } },
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['meta.write:custom.*'],
      }),
    });
    // setMetadata is all-or-nothing; mixed result becomes a wholesale reject
    // with the paths-partially-allowed variant (so per-path detail surfaces).
    if (out.kind !== 'reject' || out.rejection.reason !== 'paths-partially-allowed') {
      throw new Error('expected paths-partially-allowed');
    }
    expect(out.rejection.allowed).toEqual(['custom.dash']);
    expect(out.rejection.rejected.map((r) => r.path)).toEqual(['label']);
  });

  it('uses path-not-allowed (single-path variant) when extractor returns a bare string', () => {
    // events.poll with undefined types yields the literal path '**' (not an
    // array), so a scoped declaration that doesn't match triggers the
    // single-path rejection shape — distinct from the multi-path
    // paths-partially-allowed variant exercised by array-returning extractors.
    const out = check({
      method: 'events.poll',
      params: {},
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['events.subscribe:pane.*'],
      }),
    });
    if (out.kind !== 'reject' || out.rejection.reason !== 'path-not-allowed') {
      throw new Error('expected path-not-allowed');
    }
    expect(out.rejection.path).toBe('**');
    expect(out.rejection.declared).toEqual(['pane.*']);
  });

  it('respects spec §3.4 single-* vs double-** semantics', () => {
    // `meta.write:custom.foo.*` does NOT cover `custom.foo.bar.baz`.
    const out = check({
      method: 'pane.setMetadata',
      params: { custom: { 'foo.bar.baz': 'x' } },
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['meta.write:custom.foo.*'],
      }),
    });
    // The custom key 'foo.bar.baz' is rendered as path 'custom.foo.bar.baz'
    // which contains internal dots; the glob's single-* stops at dots →
    // no match → rejected. (Plugin should declare meta.write:custom.foo.**)
    expect(out.kind).toBe('reject');
  });
});

describe('PermissionEnforcer.check — trusted: multi-path partial mode (events.poll)', () => {
  it('returns partial when some topics match the events.subscribe glob', () => {
    const out = check({
      method: 'events.poll',
      params: { types: ['pane.created', 'agent.lifecycle'] },
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['events.subscribe:pane.*'],
      }),
    });
    if (out.kind !== 'partial') throw new Error('expected partial outcome');
    expect(out.allowedPaths).toEqual(['pane.created']);
    expect(out.rejection.allowed).toEqual(['pane.created']);
    expect(out.rejection.rejected.map((r) => r.path)).toEqual(['agent.lifecycle']);
  });

  it('rejects wholesale when no topic matches', () => {
    const out = check({
      method: 'events.poll',
      params: { types: ['process.started', 'process.exited'] },
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['events.subscribe:pane.*'],
      }),
    });
    if (out.kind !== 'reject' || out.rejection.reason !== 'paths-partially-allowed') {
      throw new Error('expected paths-partially-allowed reject');
    }
    expect(out.rejection.allowed).toEqual([]);
    expect(out.rejection.rejected).toHaveLength(2);
  });

  it('rejects wildcard poll against scoped declaration', () => {
    // Empty types → `**` path → only unrestricted events.subscribe matches.
    const out = check({
      method: 'events.poll',
      params: {},
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['events.subscribe:pane.*'],
      }),
    });
    expect(out.kind).toBe('reject');
  });

  it('allows wildcard poll against unrestricted events.subscribe', () => {
    const out = check({
      method: 'events.poll',
      params: {},
      ctx: ctx('p1'),
      trust: trust({
        name: 'p1',
        status: 'trusted',
        declaredCapabilities: ['events.subscribe'],
      }),
    });
    expect(out).toEqual({ kind: 'allow' });
  });
});

describe('PermissionEnforcer.checkPath — handler-resolved path', () => {
  it('allows when declaration matches the resolved path', () => {
    const t = trust({
      name: 'p1',
      status: 'trusted',
      declaredCapabilities: ['meta.write:custom.dashboard.*'],
    });
    const out = checkPath(t, 'pane.setMetadata', 'meta.write', 'custom.dashboard.label');
    expect(out).toEqual({ kind: 'allow' });
  });

  it('rejects when declaration does not match', () => {
    const t = trust({
      name: 'p1',
      status: 'trusted',
      declaredCapabilities: ['meta.write:custom.dashboard.*'],
    });
    const out = checkPath(t, 'pane.setMetadata', 'meta.write', 'label');
    if (out.kind !== 'reject' || out.rejection.reason !== 'path-not-allowed') {
      throw new Error('expected path-not-allowed');
    }
    expect(out.rejection.path).toBe('label');
  });

  it('rejects when capability not declared at all', () => {
    const t = trust({
      name: 'p1',
      status: 'trusted',
      declaredCapabilities: ['meta.read'],
    });
    const out = checkPath(t, 'pane.setMetadata', 'meta.write', 'label');
    if (out.kind !== 'reject' || out.rejection.reason !== 'capability-not-declared') {
      throw new Error('expected capability-not-declared');
    }
  });
});
