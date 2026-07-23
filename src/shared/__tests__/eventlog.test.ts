import { describe, it, expect } from 'vitest';
import { makeEnvelope } from '../eventlog';

describe('makeEnvelope', () => {
  const base = {
    domain: 'channel' as const,
    payload: { text: 'hi' },
    origin: { machineId: 'm1', daemonEpoch: 1 },
    authContext: {
      principalId: 'p',
      verifiedWorkspaceId: 'ws',
      trustTier: 'trusted' as const,
    },
  };

  it('assembles business fields only; all issuance fields (eventId·wallClock·lamport·origin.seq) empty', () => {
    const d = makeEnvelope(base);
    expect(d.origin).toEqual({ machineId: 'm1', daemonEpoch: 1 });
    // All four issuance fields are append-owned — absent from the draft
    // (so a draft-reuse retry cannot commit the same eventId twice).
    expect('eventId' in d).toBe(false);
    expect('wallClock' in d).toBe(false);
    expect('lamport' in d).toBe(false);
    expect('seq' in d.origin).toBe(false);
    expect(d.domain).toBe('channel');
    expect(d.payload).toEqual({ text: 'hi' });
  });

  it('optional (idempotencyKey·causalRefs) included only when provided', () => {
    const without = makeEnvelope(base);
    expect('idempotencyKey' in without).toBe(false);
    expect('causalRefs' in without).toBe(false);

    const withOpt = makeEnvelope({
      ...base,
      idempotencyKey: 'k1',
      causalRefs: ['e1', 'e2'],
    });
    expect(withOpt.idempotencyKey).toBe('k1');
    expect(withOpt.causalRefs).toEqual(['e1', 'e2']);
  });

  it('does not mutate input origin object (defensive copy)', () => {
    const origin = { machineId: 'm1', daemonEpoch: 1 };
    const d = makeEnvelope({ ...base, origin });
    expect(d.origin).not.toBe(origin);
    expect(origin).toEqual({ machineId: 'm1', daemonEpoch: 1 });
  });
});
