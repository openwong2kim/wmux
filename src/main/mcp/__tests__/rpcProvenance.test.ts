// The source-level invariant — which production files may write the
// externalWire marker at all — is pinned by
// src/main/pipe/__tests__/RpcDispatchProvenance.sourceInvariant.test.ts. This
// file stays a unit test of the predicate itself (#958).

import { describe, expect, it } from 'vitest';
import { isLocalExternalWireContext } from '../rpcProvenance';

describe('local external-wire provenance', () => {
  it('requires the positive PipeServer marker and excludes other sources', () => {
    expect(
      isLocalExternalWireContext({ origin: 'local', externalWire: true }),
    ).toBe(true);
    expect(isLocalExternalWireContext({ origin: 'local' })).toBe(false);
    expect(
      isLocalExternalWireContext({ origin: 'remote', externalWire: true }),
    ).toBe(false);
    expect(
      isLocalExternalWireContext({
        origin: 'local',
        externalWire: true,
        firstParty: true,
      }),
    ).toBe(false);
    expect(
      isLocalExternalWireContext({
        origin: 'local',
        externalWire: true,
        operator: true,
      }),
    ).toBe(false);
  });
});
