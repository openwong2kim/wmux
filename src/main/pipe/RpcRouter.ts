import type {
  PluginIdentityRecord,
  RpcContext,
  RpcMethod,
  RpcRejection,
  RpcRequest,
  RpcResponse,
} from '../../shared/rpc';
import { check as enforcerCheck } from '../mcp/PermissionEnforcer';
import type { EnforcementMode } from '../mcp/enforcementMode';
import type { ApprovalQueue } from '../mcp/ApprovalQueue';

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

/**
 * Counter for per-method legacy traffic (Phase 2.2 pre-commit 4). Lifts
 * the process-once trust-DB write to a per-(envelope-less-method)
 * counter so v3.1 can surface accurate "your old integrations are
 * calling these RPCs" data. Best-effort: failures must never affect
 * dispatch. Wired in main/index.ts to LegacyTrafficCounter; unit tests
 * stub with a vi.fn(). When unset, the router behaves as if no counter
 * is configured (no record, no log).
 */
type LegacyTrafficCounter = { record(method: RpcMethod): void };

/**
 * Async lookup that resolves a clientName to the caller's current trust
 * record (or undefined if none exists). Wired by main/index.ts to
 * PluginTrustStore.get(); tests inject a synchronous stub. RpcRouter
 * deliberately does NOT import PluginTrustStore directly — the trust
 * store has FS side effects and the router must stay unit-testable
 * without touching ~/.wmux state.
 */
type TrustLookup = (clientName: string) => Promise<PluginIdentityRecord | undefined>;

/**
 * Side-channel sink for would-be rejections during shadow mode. Wired by
 * main/index.ts to ShadowRejectionLogger.append; the router calls it for
 * every non-allow enforcer outcome regardless of whether dispatch ends up
 * delivering the handler's result.
 */
type ShadowRejectionSink = (input: {
  clientName: string | undefined;
  method: RpcMethod;
  rejection: RpcRejection;
}) => void;

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
  private legacyTrafficCounter: LegacyTrafficCounter | undefined;
  private trustLookup: TrustLookup | undefined;
  private shadowSink: ShadowRejectionSink | undefined;
  /**
   * Phase 2.2 pre-commit 6: enforcement mode. Default is `shadow` so a
   * router that was never explicitly set up (unit tests, transitional
   * code paths) preserves pre-Phase-2.2 behavior. main/index.ts calls
   * `setEnforcementMode` after reading `~/.wmux/config.json`.
   */
  private enforcementMode: EnforcementMode = 'shadow';
  /**
   * Phase 2.2 pre-commit 6: approval queue. When set AND mode === 'enforce'
   * AND the enforcer rejects with identity-status:unconfirmed for a plugin
   * that has declared capabilities, dispatch fires a prompt and threads
   * the synchronously-available promptId into rejection.pendingApproval.
   */
  private approvalQueue: ApprovalQueue | undefined;
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

  /**
   * Wire the per-method legacy traffic counter (Phase 2.2 pre-commit 4).
   * Called for EVERY envelope-less RPC (not process-once like the trust-DB
   * recorder above). main/index.ts injects LegacyTrafficCounter pointed at
   * the shadow audit log; unset is a no-op for tests that don't care.
   */
  setLegacyTrafficCounter(counter: LegacyTrafficCounter | undefined): void {
    this.legacyTrafficCounter = counter;
  }

  /**
   * Phase 2.2 enforcer wiring (shadow mode). main/index.ts injects a lookup
   * backed by PluginTrustStore.get; tests inject synchronous stubs. When
   * unset, the enforcer runs with trust=undefined for every request (which
   * is treated as legacy/grandfather → allow), making the router behave
   * identically to pre-Phase-2.2 dispatch.
   */
  setTrustLookup(lookup: TrustLookup | undefined): void {
    this.trustLookup = lookup;
  }

  /**
   * Phase 2.2 shadow-mode sink. main/index.ts injects ShadowRejectionLogger;
   * tests pass a vi.fn() to assert calls. When unset, would-be rejections
   * are not recorded — useful for unit tests that don't care about the side
   * channel.
   */
  setShadowRejectionSink(sink: ShadowRejectionSink | undefined): void {
    this.shadowSink = sink;
  }

  /**
   * Phase 2.2 pre-commit 6: switch between shadow (log + proceed) and
   * enforce (log + return rejection). The mode is read from
   * `~/.wmux/config.json` at main/index.ts boot time.
   */
  setEnforcementMode(mode: EnforcementMode): void {
    this.enforcementMode = mode;
  }

  /**
   * Phase 2.2 pre-commit 6: inject the approval queue. main/index.ts wires
   * this with a renderer-IPC opener. When the enforcer rejects an
   * unconfirmed plugin that has declared a capability set, the dispatcher
   * fires `requestApproval` to surface the prompt and threads the
   * synchronously-available promptId into the rejection.
   */
  setApprovalQueue(queue: ApprovalQueue | undefined): void {
    this.approvalQueue = queue;
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

    // Spec §2.2: requests without `clientName` are recorded as `legacy`.
    // Two side-channels fire here:
    //
    //   1. Process-once trust-DB write (`legacyRecorder`) — one row per
    //      process in `~/.wmux/plugin-trust.json`. Enough to signal "this
    //      process saw legacy traffic" without disk-pounding on every RPC.
    //
    //   2. Per-method counter (`legacyTrafficCounter`, Phase 2.2 pre-commit
    //      4) — every call ticks a counter; threshold milestones flush a
    //      summary entry to the shadow audit log so v3.1 can surface
    //      accurate per-method legacy traffic data.
    //
    // Both are gated on `!IDENTITY_OWN_METHODS` so the identity bootstrap
    // handlers (which own their own recording) don't double-count. Both
    // are fire-and-forget and wrapped in try/catch — they MUST NOT
    // affect dispatch latency or response.
    if (!ctx.clientName && !IDENTITY_OWN_METHODS.has(request.method)) {
      if (!this.legacyContactPersisted && this.legacyRecorder) {
        this.legacyContactPersisted = true;
        try {
          this.legacyRecorder(request.method);
        } catch {
          /* swallow — trust-store writes are best-effort */
        }
      }
      if (this.legacyTrafficCounter) {
        try {
          this.legacyTrafficCounter.record(request.method);
        } catch {
          /* swallow — counter is best-effort telemetry */
        }
      }
    }

    // Phase 2.2 enforcement (shadow mode in this commit).
    //
    // Trust lookup is awaited only when a clientName is present — the
    // enforcer's first-line branches (identity bootstrap, no-clientName
    // legacy path) don't need a record, so we save a microtask hop on
    // every legacy / pre-handshake RPC.
    //
    // Behaviour in this commit (pre-commit 3, shadow only): we call the
    // enforcer, record any non-allow outcome to the shadow sink, and THEN
    // proceed to invoke the handler regardless. This populates the shadow
    // log with would-be rejections during the v3.0 dogfood window. The
    // enforce-mode flip (pre-commit 6) will gate handler invocation on
    // the outcome and convert rejections into RpcResponse failures.
    let trust: PluginIdentityRecord | undefined;
    let trustLookupFailed = false;
    if (ctx.clientName && this.trustLookup) {
      try {
        trust = await this.trustLookup(ctx.clientName);
      } catch {
        // Trust DB read error (corrupt file / I/O). This is NOT the same as a
        // clean "no record" miss: flag it so the enforcer can distinguish them.
        // For a normal plugin the outcome is identical (unconfirmed → reject in
        // enforce mode), but for the first-party bypass it matters — an operator
        // `denied` row that simply couldn't be read must not be silently
        // bypassed. The enforcer declines the first-party bypass on this unknown
        // state and falls through to the fail-closed ladder.
        trust = undefined;
        trustLookupFailed = true;
      }
    }
    const outcome = enforcerCheck({
      method: request.method,
      params: request.params ?? {},
      ctx,
      trust,
      trustLookupFailed,
    });
    if (outcome.kind !== 'allow' && this.shadowSink) {
      try {
        this.shadowSink({
          clientName: ctx.clientName,
          method: request.method,
          rejection: outcome.rejection,
        });
      } catch {
        /* shadow logging must never affect dispatch */
      }
    }

    // Pre-commit 6: enforce-mode short-circuit. When mode is 'enforce',
    // a non-allow outcome turns into an RPC failure response — the handler
    // is NOT invoked. In 'shadow' mode (dogfood default), we still call
    // the handler after logging, preserving pre-2.2 behavior.
    if (outcome.kind !== 'allow' && this.enforcementMode === 'enforce') {
      let rejection: RpcRejection = outcome.rejection;
      // For unconfirmed identity with a non-empty declaration, surface an
      // approval prompt and thread the synchronously-minted promptId into
      // the rejection so the client can correlate its retry. The resolution
      // promise is NOT awaited — clients poll/retry on their own cadence
      // (OAuth `authorization_pending` precedent, plan D4).
      if (
        rejection.reason === 'identity-status' &&
        rejection.status === 'unconfirmed' &&
        trust?.declaredCapabilities &&
        trust.declaredCapabilities.length > 0 &&
        this.approvalQueue
      ) {
        try {
          const handle = this.approvalQueue.requestApproval({
            clientName: ctx.clientName ?? trust.name,
            declaredCapabilities: trust.declaredCapabilities,
            rationale: trust.rationale,
          });
          rejection = {
            ...rejection,
            pendingApproval: { promptId: handle.promptId },
          };
          // Intentionally not awaiting handle.resolution — dispatch returns
          // immediately and the user's eventual decision is consumed by
          // the next RPC the plugin makes.
          handle.resolution.catch(() => {
            /* swallow cancellations; downstream IPC error handlers cover the rest */
          });
        } catch {
          /* approval queue failure must not block dispatch */
        }
      }
      const errorMessage = renderRejectionMessage(rejection);
      return {
        id: request.id,
        ok: false,
        error: errorMessage,
        rejection,
      };
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

/**
 * Human-readable error message for an RpcRejection. Composed inline at
 * dispatch time so external clients reading only `error` (without the
 * structured `rejection`) still see something useful. The structured
 * variant has the full per-path detail.
 */
function renderRejectionMessage(r: RpcRejection): string {
  switch (r.reason) {
    case 'capability-not-declared':
      return `${r.method}: capability "${r.capability}" was not declared by this plugin`;
    case 'path-not-allowed':
      return `${r.method}: path "${r.path}" not allowed by declared ${r.capability} globs [${r.declared.join(', ')}]`;
    case 'paths-partially-allowed':
      return `${r.method}: ${r.rejected.length} of ${r.allowed.length + r.rejected.length} paths not covered by declared ${r.capability} globs`;
    case 'identity-status':
      if (r.status === 'denied') {
        return `${r.method}: plugin is denied; edit ~/.wmux/plugin-trust.json to restore`;
      }
      if (r.pendingApproval) {
        return `${r.method}: awaiting user approval (promptId=${r.pendingApproval.promptId})`;
      }
      return `${r.method}: plugin is unconfirmed; call mcp.identify + mcp.declarePermissions first`;
  }
}
