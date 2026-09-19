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
  /**
   * #922 PR-A — the workspace claim token returned by `mcp.claimWorkspace`.
   *
   * It lives HERE, beside the rest of the envelope identity, for the same
   * reason `pinnedRoute` does: the broker hosts N server instances in one
   * process, and a process-global token would let two hosted callers stamp
   * each other's claim onto outbound envelopes — one connection acting as
   * another's workspace. Scoping it with the pin it belongs to makes that
   * unrepresentable rather than merely avoided.
   */
  workspaceToken?: string;
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
   * would resolve against the wrong agent's page. Typed as unknown to avoid
   * an import cycle (dom-intelligence imports this module); it owns the cast.
   */
  elementCache?: unknown;
  /**
   * browser_snapshot auto-diff baselines (surface key → last snapshot), per
   * connection for the same reason as elementCache. Typed as unknown to avoid
   * an import cycle (snapshotCache imports this module); it owns the cast.
   */
  snapshotCache?: unknown;
  /**
   * Truncated-snapshot captures a continuation cursor pages through (capture id
   * → stored text), per connection for the same reason as snapshotCache: a
   * cursor is an opaque handle, and a process-global map would let one agent's
   * token address another agent's capture of another agent's page. Typed as
   * unknown to avoid an import cycle (snapshotCache imports this module); it
   * owns the cast.
   */
  snapshotCaptures?: unknown;
  /**
   * Per-connection REPL session registry, for the same reason as `playwright`:
   * a REPL session is a live runtime holding the caller's variables and open
   * handles, so a process-global map would hand one agent another agent's
   * state. Typed as unknown to avoid an import cycle (replRegistry imports this
   * module); it owns the cast.
   */
  repl?: unknown;
  /**
   * Per-connection `browser_repl` worker session, for the same reason as
   * `repl`. Typed as unknown to avoid an import cycle; browser-repl/tool owns
   * the cast.
   */
  browserRepl?: unknown;
  /**
   * Site guide announcements (surface key → set of guide paths last announced),
   * per connection so one agent's landing never silences another's. Typed as
   * unknown to avoid an import cycle; guideAnnounce owns the cast.
   */
  siteGuideAnnounce?: unknown;
  /**
   * Frame refs minted by this connection's last snapshot of a surface, per
   * connection for the same reason as snapshotCache: the guard answers "did
   * *I* mint this ref inside an iframe", and a shared map let one agent's
   * snapshot refuse another agent's perfectly good DOM ref. Typed as unknown
   * to avoid an import cycle; snapshot.ts owns the cast.
   */
  frameRefs?: unknown;
  /**
   * Per-surface ref descriptors (role + name + nth-of-kind) for the last few
   * snapshot generations, per connection for the same reason as snapshotCache:
   * they decide which number an element keeps and which old ref may be
   * recovered, so one agent's snapshot must never renumber another's. Typed as
   * unknown to avoid an import cycle; refDescriptors owns the cast.
   */
  refDescriptors?: unknown;
  /**
   * Random id identifying this connection as the OPENER of a browser surface.
   * Sent with every open so main can record who asked for a surface, and the
   * default target of a call that names none stays on this connection's own
   * tab. Minted on first use by surfaceRouting, which owns the semantics.
   */
  browserOpenerKey?: string;
  /**
   * The surface this connection last opened: its default target while it
   * exists. Typed as unknown to avoid an import cycle (surfaceRouting imports
   * this module); it owns the cast.
   */
  browserPin?: unknown;
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
