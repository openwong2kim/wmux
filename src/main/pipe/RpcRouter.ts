import type {
  RpcContext,
  RpcMethod,
  RpcRequest,
  RpcResponse,
} from '../../shared/rpc';

// Handlers receive a per-request context as an optional second argument.
// Existing handlers `(params) => ...` keep compiling because the extra
// argument is simply ignored at the call site.
type RpcHandler = (
  params: Record<string, unknown>,
  ctx?: RpcContext,
) => Promise<unknown>;

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

    // Lift the optional identity envelope into the per-request context so
    // handlers don't reach back into PipeServer internals.
    const ctx: RpcContext = {
      clientName:
        typeof request.clientName === 'string' && request.clientName.trim().length > 0
          ? request.clientName.trim()
          : undefined,
      clientVersion:
        typeof request.clientVersion === 'string' && request.clientVersion.trim().length > 0
          ? request.clientVersion.trim()
          : undefined,
    };

    try {
      const result = await handler(request.params ?? {}, ctx);
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
