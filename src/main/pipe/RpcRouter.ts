import type { RpcMethod, RpcRequest, RpcResponse } from '../../shared/rpc';

type RpcHandler = (params: Record<string, unknown>) => Promise<unknown>;

export class RpcRouter {
  private readonly handlers = new Map<RpcMethod, RpcHandler>();

  register(method: RpcMethod, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  async dispatch(request: RpcRequest): Promise<RpcResponse> {
    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') {
      return { id: (request as RpcRequest)?.id || '', ok: false, error: 'Invalid RPC request: missing id or method' };
    }
    if (request.params !== undefined && (typeof request.params !== 'object' || request.params === null)) {
      return { id: request.id, ok: false, error: 'Invalid RPC request: params must be an object' };
    }

    const handler = this.handlers.get(request.method);

    if (!handler) {
      return {
        id: request.id,
        ok: false,
        error: `Unknown method: ${request.method}`,
      };
    }

    try {
      const result = await handler(request.params ?? {});
      return {
        id: request.id,
        ok: true,
        result,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        id: request.id,
        ok: false,
        error: message,
      };
    }
  }
}
