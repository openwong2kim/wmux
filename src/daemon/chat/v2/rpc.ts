import {
  CHATV2_RPC,
  chatV2Error,
  parseChatV2Params,
  type ChatV2Method,
} from '../../../shared/chatv2/ipc';
import type { ChatV2Host } from './types';

type RpcRegistrar = (
  method: string,
  handler: (params: Record<string, unknown>, ctx: { clientId: string }) => Promise<unknown>,
) => void;

/**
 * Register every `daemon.chatv2.*` method. Each one is first-party only,
 * validates its params with the shared parser, and hands them to the host.
 * The table is complete here; a host decides what each call does.
 */
export function registerChatV2Rpc(
  onRpc: RpcRegistrar,
  host: ChatV2Host | null,
  firstPartyOnly: (clientId: string, method: string) => boolean,
): void {
  for (const method of Object.keys(CHATV2_RPC) as ChatV2Method[]) {
    onRpc(CHATV2_RPC[method], async (params, ctx) => {
      if (!firstPartyOnly(ctx.clientId, CHATV2_RPC[method]) || !host) {
        return chatV2Error('unavailable', 'Chat is unavailable.');
      }
      const parsed = parseChatV2Params(method, params);
      if (!parsed) return chatV2Error('invalid-params', `Invalid ${method} request.`);
      return host.call(method, parsed, ctx.clientId);
    });
  }
}
