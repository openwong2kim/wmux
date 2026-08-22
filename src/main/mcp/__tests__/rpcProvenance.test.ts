// Two other tests hold the externalWire boundary, and they hold different
// halves of it (#958):
//   • WHICH production files may write the marker at all —
//     src/main/pipe/__tests__/RpcDispatchProvenance.sourceInvariant.test.ts,
//     which pins the file set (PipeServer + RpcRouter) over every property
//     assignment and shorthand, whatever the initializer.
//   • THAT RpcRouter's write stays conditional — RpcRouter.dispatchProvenance
//     .test.ts ('does not inherit external-wire provenance into an unmarked
//     nested dispatch'), which is the test that fails if that ternary is ever
//     widened to a bare `true`. The source invariant would not: the file set
//     is unchanged by that edit.
// This file stays a unit test of the predicate itself.

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
