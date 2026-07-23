/**
 * Per-connection state scope for the shared MCP broker (Option A,
 * plans/mcp-broker-design-2026-07-16.md).
 *
 * The single-child MCP server keeps identity and engine state in module
 * globals (wmux-client CLIENT_NAME, paneResolver pinned route, the
 * PlaywrightEngine singleton) under a one-pane-per-process assumption. The
 * broker hosts N server instances in ONE process, so that state must become
 * per-connection — but eight modules import `sendRpc` and nine tool modules
 * call `PlaywrightEngine.getInstance()` at module scope, and threading a
 * context parameter through every signature would touch all of them.
 *
 * AsyncLocalStorage is the seam that avoids that: the broker wraps each
 * connection's transport dispatch in `runInConnectionScope(scope, ...)`, and
 * the three stateful modules consult `getConnectionScope()` first, falling
 * back to their module globals when no scope is active. The single-child
 * entry never establishes a scope, so its behavior is byte-for-byte the
 * legacy path.
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { PinnedRoute } from './paneResolver';

/** Declared-identity + role state normally held in wmux-client globals. */
export interface RpcIdentityState {
  clientName?: string;
  clientVersion?: string;
  /** Commander role claim (BYOB P4). Presence of the field IS the claim. */
  commanderToken?: string;
}

export interface ConnectionScope {
  rpcIdentity: RpcIdentityState;
  /**
   * Per-connection PlaywrightEngine. Typed as unknown to avoid an import
   * cycle (PlaywrightEngine imports this module); the engine module owns
   * the cast.
   */
  playwright?: unknown;
  /** paneResolver pin, per connection instead of per process. */
  pinnedRoute: PinnedRoute | null;
  pinnedClaimInFlight: Promise<PinnedRoute> | null;
  /**
   * dom-intelligence smart-snapshot element cache (ref → locator), per
   * connection instead of per process — otherwise a second connection's
   * snapshot would overwrite the first's refs and browser_click({smartRef})
   * would resolve against the wrong agent's page. Typed as unknown[] to avoid
   * an import cycle (dom-intelligence imports this module); it owns the cast.
   */
  elementCache?: unknown[];
}

const storage = new AsyncLocalStorage<ConnectionScope>();

export function createConnectionScope(): ConnectionScope {
  return { rpcIdentity: {}, pinnedRoute: null, pinnedClaimInFlight: null };
}

/** The active connection's scope, or undefined in single-child mode. */
export function getConnectionScope(): ConnectionScope | undefined {
  return storage.getStore();
}

export function runInConnectionScope<T>(scope: ConnectionScope, fn: () => T): T {
  return storage.run(scope, fn);
}
