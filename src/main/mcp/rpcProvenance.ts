import type { RpcContext } from '../../shared/rpc';

/**
 * True only for a positively-marked request from the authenticated local
 * PipeServer dispatch path. `origin: 'local'` and `!firstParty` are not enough:
 * in-process and nested dispatches are untrusted/unknown unless their caller
 * supplies the non-envelope marker explicitly.
 *
 * `operator` is excluded defensively rather than because it can fire today: an
 * operator dispatch already carries `firstParty: true`, and the dispatch-options
 * union makes `operator` together with `externalWire` unrepresentable. The check
 * is here so a future dispatch source cannot reach this lane by supplying only
 * `operator`.
 */
export function isLocalExternalWireContext(ctx: RpcContext): boolean {
  return (
    ctx.externalWire === true &&
    ctx.origin === 'local' &&
    ctx.firstParty !== true &&
    ctx.operator !== true
  );
}
