// Provenance gate for client identities that are meaningful only on wmux's
// machine-local external RPC wire (named pipe / Unix socket / loopback TCP).

import type { RpcContext } from '../../shared/rpc';

export type LocalExternalWireContext = RpcContext & {
  origin: 'local';
  externalWire: true;
  firstParty?: false;
  operator?: false;
};

/**
 * True only when PipeServer positively classified this request as external and
 * local. `externalWire` is a dispatch option rather than a request-envelope
 * field, so a wire caller cannot forge it. Requiring the literal `true` is
 * deliberately fail-closed for every in-process or future dispatch source;
 * `firstParty` is also excluded defensively if contradictory options appear.
 */
export function isLocalExternalWireContext(
  ctx: RpcContext | undefined,
): ctx is LocalExternalWireContext {
  return (
    ctx?.origin === 'local' &&
    ctx.externalWire === true &&
    ctx.firstParty !== true &&
    ctx.operator !== true
  );
}
