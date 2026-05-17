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

// Optional sink for legacy-contact bookkeeping — wired in main/index.ts
// to PluginTrustStore.upsertLegacyContact so an envelope-less RPC ends up
// in plugin-trust.json as a `legacy` record. RpcRouter does not import
// the trust store directly: it stays storage-agnostic, tests opt in by
// passing their own recorder, and unit tests stay isolated from the
// real ~/.wmux state.
type LegacyContactRecorder = (method: RpcMethod) => void;

// Methods that handle plugin identity themselves — they must NOT trigger
// a parallel legacy write because their own handlers do the right thing
// (record an `unconfirmed` contact via the resolved name).
const IDENTITY_OWN_METHODS: ReadonlySet<RpcMethod> = new Set<RpcMethod>([
  'mcp.identify',
  'mcp.declarePermissions',
]);

export class RpcRouter {
  private readonly handlers = new Map<RpcMethod, RpcHandler>();
  private legacyRecorder: LegacyContactRecorder | undefined;
  // Process-once flag — the legacy bucket is a single audit entry, not a
  // per-request log. After the first envelope-less RPC reaches the wire,
  // subsequent calls don't re-touch the trust DB until the process restarts.
  // Sufficient to satisfy spec §2.2 ("recorded as legacy") without producing
  // hot-path disk writes on every legacy RPC.
  private legacyContactPersisted = false;

  register(method: RpcMethod, handler: RpcHandler): void {
    this.handlers.set(method, handler);
  }

  // Wire the trust-store side. main/index.ts injects a recorder backed by
  // PluginTrustStore.upsertLegacyContact; tests leave it unset for isolation.
  setLegacyContactRecorder(recorder: LegacyContactRecorder | undefined): void {
    this.legacyRecorder = recorder;
    this.legacyContactPersisted = false;
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

    // Spec §2.2: requests without `clientName` are recorded as `legacy` so
    // the enforcement PR can grandfather pre-v2.10 callers. Fire-and-forget
    // and gated on a process-once flag (see comment on the field) — the
    // recorder failing must never affect the actual RPC response.
    if (
      !ctx.clientName &&
      !this.legacyContactPersisted &&
      this.legacyRecorder &&
      !IDENTITY_OWN_METHODS.has(request.method)
    ) {
      this.legacyContactPersisted = true;
      try {
        this.legacyRecorder(request.method);
      } catch {
        /* swallow — trust-store writes are best-effort */
      }
    }

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
