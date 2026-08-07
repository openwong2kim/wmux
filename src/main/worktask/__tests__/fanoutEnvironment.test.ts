// ─── T2 fan-out environment: port assignment + setup-hook trust gate ─────────
//
// Both units are the ones a bug would be invisible in: a port collision only
// shows up as "task 3's dev server died", and a trust-gate hole only shows up
// as a command from an unreviewed wmux.json having already run.

import { describe, it, expect } from 'vitest';
import { assignFanoutPorts, resolveFanoutSetup } from '../fanoutEnvironment';
import { parseFanoutPortRange } from '../../../shared/wmuxProjectConfig';
import type { ProjectConfigState, ProjectTrustState } from '../../../shared/wmuxProjectConfig';

describe('assignFanoutPorts', () => {
  it('gives every task a distinct free port and skips busy ones', async () => {
    const busy = new Set([3001, 3002]);
    const ports = await assignFanoutPorts({ min: 3000, max: 3010 }, 3, async (p) => !busy.has(p));
    expect(ports).toEqual([3000, 3003, 3004]);
    expect(new Set(ports).size).toBe(ports.length);
  });

  it('leaves later tasks unassigned when the window runs out instead of reusing ports', async () => {
    const ports = await assignFanoutPorts({ min: 4000, max: 4001 }, 4, async () => true);
    expect(ports).toEqual([4000, 4001, undefined, undefined]);
  });
});

describe('parseFanoutPortRange', () => {
  it('accepts "3000-3010" and rejects malformed / privileged / inverted windows', () => {
    expect(parseFanoutPortRange('3000-3010')).toEqual({ min: 3000, max: 3010 });
    expect(parseFanoutPortRange('3000')).toBeNull();
    expect(parseFanoutPortRange('80-90')).toBeNull();
    expect(parseFanoutPortRange('3010-3000')).toBeNull();
    expect(parseFanoutPortRange(3000)).toBeNull();
  });
});

function stateWithSetup(trust: ProjectTrustState | undefined, setup?: string): ProjectConfigState {
  return {
    found: true,
    root: '/repo',
    configPath: '/repo/wmux.json',
    config: { version: 1, fanout: setup === undefined ? {} : { setup } },
    trust,
  };
}

describe('resolveFanoutSetup', () => {
  it('runs the hook only for currently-trusted bytes', () => {
    expect(resolveFanoutSetup(stateWithSetup('trusted', 'npm ci'))).toEqual({ run: true, command: 'npm ci' });
  });

  it('refuses to run a hook from untrusted, edited-since-approval, or denied config', () => {
    expect(resolveFanoutSetup(stateWithSetup('untrusted', 'npm ci'))).toEqual({ run: false, reason: 'untrusted' });
    expect(resolveFanoutSetup(stateWithSetup('stale', 'npm ci'))).toEqual({ run: false, reason: 'stale' });
    expect(resolveFanoutSetup(stateWithSetup('denied', 'npm ci'))).toEqual({ run: false, reason: 'denied' });
    // No trust verdict at all (config never evaluated) must fail closed too.
    expect(resolveFanoutSetup(stateWithSetup(undefined, 'npm ci'))).toEqual({ run: false, reason: 'untrusted' });
  });

  it('reports "none-declared" when there is no hook or no config', () => {
    expect(resolveFanoutSetup(stateWithSetup('trusted'))).toEqual({ run: false, reason: 'none-declared' });
    expect(resolveFanoutSetup({ found: false })).toEqual({ run: false, reason: 'none-declared' });
    expect(resolveFanoutSetup(null)).toEqual({ run: false, reason: 'none-declared' });
  });
});
