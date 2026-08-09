import type { RpcContext } from '../../shared/rpc';

/**
 * True only for a positively-marked request from the authenticated local
 * PipeServer dispatch path. `origin: 'local'` and `!firstParty` are not enough:
 * in-process and nested dispatches are untrusted/unknown unless their caller
 * supplies the non-envelope marker explicitly.
 */
export function isLocalExternalWireContext(ctx: RpcContext): boolean {
  return ctx.externalWire === true && ctx.origin === 'local' && ctx.firstParty !== true;
}
