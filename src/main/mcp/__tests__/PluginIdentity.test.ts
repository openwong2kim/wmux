// Trust-status invariant tests for the PluginIdentity transition helpers.
//
// These are the load-bearing assertions of Phase 2.1: once the user has
// approved or rejected a plugin, no automated path may regress that
// decision. The spec (docs/api/mcp-plugin-spec.md §4.3) lists the four
// allowed transitions and forbids the rest; this suite exercises every
// row in that table directly so the enforcement PR can rely on it.

import { describe, expect, it } from 'vitest';
import {
  applyContact,
  applyDeclaration,
  legacyIdentity,
  unconfirmedIdentity,
} from '../PluginIdentity';
import type { PluginIdentityRecord } from '../../../shared/rpc';

function makeRecord(
  overrides: Partial<PluginIdentityRecord> & { status: PluginIdentityRecord['status'] },
): PluginIdentityRecord {
  return {
    name: 'demo',
    firstSeen: 1_000,
    lastSeen: 1_000,
    ...overrides,
  };
}

describe('PluginIdentity trust-status invariant', () => {
  it('applyContact preserves trusted', () => {
    const trusted = makeRecord({ status: 'trusted', version: '1.0' });
    const next = applyContact(trusted, '1.1');
    expect(next.status).toBe('trusted');
    expect(next.version).toBe('1.1');
    expect(next.lastSeen).toBeGreaterThanOrEqual(trusted.lastSeen);
  });

  it('applyContact preserves denied', () => {
    const denied = makeRecord({ status: 'denied' });
    const next = applyContact(denied, undefined);
    expect(next.status).toBe('denied');
  });

  it('applyContact upgrades legacy to unconfirmed', () => {
    const legacy = makeRecord({ status: 'legacy' });
    const next = applyContact(legacy, '0.1');
    expect(next.status).toBe('unconfirmed');
  });

  it('applyContact keeps unconfirmed as unconfirmed', () => {
    const fresh = makeRecord({ status: 'unconfirmed' });
    expect(applyContact(fresh, undefined).status).toBe('unconfirmed');
  });

  it('applyDeclaration preserves trusted but replaces capabilities', () => {
    // Escalation trap: this is the documented hazard for the enforcement PR.
    // The trust-status invariant is preserved (status stays 'trusted'); the
    // PR-level decision to also DEMOTE on widening lives in the follow-up.
    const trusted = makeRecord({
      status: 'trusted',
      declaredCapabilities: ['pane.read'],
    });
    const next = applyDeclaration(trusted, ['pane.read', 'meta.write']);
    expect(next.status).toBe('trusted');
    expect(next.declaredCapabilities).toEqual(['pane.read', 'meta.write']);
  });

  it('applyDeclaration preserves denied', () => {
    const denied = makeRecord({ status: 'denied' });
    expect(applyDeclaration(denied, ['pane.read']).status).toBe('denied');
  });

  it('applyDeclaration upgrades legacy to unconfirmed', () => {
    const legacy = makeRecord({ status: 'legacy' });
    expect(applyDeclaration(legacy, ['pane.read']).status).toBe('unconfirmed');
  });

  it('coerces unknown status values to unconfirmed (forward-compat guard)', () => {
    // A future schema version (or a hand-edited file) could write a status
    // value outside the union. Without the guard, applyContact would copy
    // the bogus status through unchanged and break downstream branching.
    const weird = {
      name: 'demo',
      firstSeen: 1_000,
      lastSeen: 1_000,
      status: 'future-state' as unknown as PluginIdentityRecord['status'],
    } satisfies PluginIdentityRecord;
    expect(applyContact(weird, undefined).status).toBe('unconfirmed');
    expect(applyDeclaration(weird, []).status).toBe('unconfirmed');
  });

  it('unconfirmedIdentity and legacyIdentity build records with the documented statuses', () => {
    expect(unconfirmedIdentity('a').status).toBe('unconfirmed');
    expect(legacyIdentity('b').status).toBe('legacy');
  });

  it('applyDeclaration clears rationale when omitted on re-declare', () => {
    // Spec §4.2: rationale is part of the most-recent declaration, not a
    // cumulative history.
    const withRationale = makeRecord({
      status: 'unconfirmed',
      declaredCapabilities: ['pane.read'],
      rationale: 'first',
    });
    expect(
      applyDeclaration(withRationale, ['pane.read']).rationale,
    ).toBeUndefined();
  });
});
