import type { RpcMethod } from '../../shared/rpc';
import { sendRpc } from '../wmux-client';
// Cycle-safe: surfaceRouting imports the refusal type from here, and both
// sides touch the other only from inside function bodies, never at module
// evaluation time.
import {
  openSurfaceForConnection,
  pinnedSurfaceFor,
  resolveDefaultSurface,
} from './surfaceRouting';

/** Stable error code for browser operations whose caller cannot be scoped. */
export const WORKSPACE_SCOPE_UNRESOLVED_CODE = 'WORKSPACE_SCOPE_UNRESOLVED';

/** Typed refusal used wherever continuing could select another workspace. */
export class WorkspaceScopeUnresolvedError extends Error {
  readonly code = WORKSPACE_SCOPE_UNRESOLVED_CODE;

  constructor(reason: string) {
    super(`${WORKSPACE_SCOPE_UNRESOLVED_CODE}: ${reason}`);
    this.name = 'WorkspaceScopeUnresolvedError';
  }
}

export function isWorkspaceScopeUnresolvedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === WORKSPACE_SCOPE_UNRESOLVED_CODE
  );
}

/**
 * Page discovery failures may fall back to a scoped main-process RPC. A
 * withheld raw CDP endpoint is intentionally in this class: tools with an RPC
 * equivalent stay in the workspace-scoped, lease-covered lane, while tools
 * that require a Playwright Page omit this helper and surface the attachment
 * refusal.
 *
 * A scope refusal may not fall back: on an older main that ignores workspaceId,
 * doing so would recreate the cross-workspace path the refusal was meant to
 * close.
 */
export function allowScopedRpcFallback(error: unknown): null {
  if (isWorkspaceScopeUnresolvedError(error)) throw error;
  return null;
}

/** Dependencies shared by every workspace-routed browser tool. */
export interface BrowserToolDeps {
  /** Strict per-connection resolver; it must never fall back to the UI-active workspace. */
  resolveWorkspaceId: () => Promise<string>;
}

/** The immutable routing scope reused by one browser tool invocation. */
export interface BrowserTargetScope {
  readonly workspaceId: string;
  readonly surfaceId?: string;
  /**
   * Routing ran and this connection may drive NOTHING that exists: every live
   * surface belongs to another connection, or there are none at all.
   *
   * Distinct from a plain absent `surfaceId`, which also covers "routing could
   * not run" (transport down, a main too old to scope). The difference decides
   * behavior: a known-empty answer lets the page lane skip re-asking and the
   * RPC lane open its own surface, while an unknown one leaves both to their
   * existing fail-closed paths.
   */
  readonly noSurface?: true;
  /**
   * …and this many of those surfaces belong to somebody else. Any number above
   * zero is the case where sending an unnamed RPC is not merely vague but
   * wrong: main resolves it to the workspace's first live session, which is
   * another connection's tab. The count is carried so a refusal can say what
   * the caller is up against rather than "nothing is open".
   */
  readonly foreignSurfaces?: number;
}

/** Runtime guard for scopes created outside requireBrowserTargetScope(). */
export function assertBrowserTargetScope(
  scope: BrowserTargetScope,
): asserts scope is BrowserTargetScope {
  if (!scope.workspaceId) {
    throw new WorkspaceScopeUnresolvedError(
      'browser tool workspace identity resolved to an empty id.',
    );
  }
}

/**
 * Resolve browser routing once, before any lease or browser RPC is issued.
 * An empty identity is a refusal: omitting it would restore main's legacy
 * first-live-target behavior and could cross workspace boundaries (#695).
 *
 * A call that names no surface gets one resolved HERE, per connection (see
 * surfaceRouting), so every lane of the operation agrees on which surface it
 * is: the automation lease, the scoped RPC fallback, the Playwright page, the
 * snapshot baseline / guide / frame-ref keys, and the replay ring. They used to
 * decide separately and disagreed — the engine took the workspace's NEWEST
 * surface while main's lease and RPC default took its OLDEST live session — so
 * one call could lease one tab and drive another.
 *
 * Resolution failure is not a refusal: it leaves the scope unpinned, exactly as
 * before, and the engine's own (fail-closed) selection then decides. Making
 * this a gate would newly refuse tools that never needed a live surface.
 */
export async function requireBrowserTargetScope(
  deps: BrowserToolDeps,
  surfaceId?: string,
): Promise<BrowserTargetScope> {
  const workspaceId = await deps.resolveWorkspaceId();
  if (!workspaceId) {
    throw new WorkspaceScopeUnresolvedError(
      'browser tool workspace identity resolved to an empty id.',
    );
  }
  if (surfaceId) return Object.freeze({ workspaceId, surfaceId });
  let resolved: Awaited<ReturnType<typeof resolveDefaultSurface>> | null = null;
  try {
    resolved = await resolveDefaultSurface(workspaceId);
  } catch {
    // Routing failed rather than answered. Swallowing this into "no surface"
    // would silently restore the pre-fix behavior — permanently, on a build
    // with CDP disabled — so the connection's own pin answers instead, and
    // when it has none the scope stays UNKNOWN: the RPC lane then opens its
    // own surface or refuses, never falls back to the workspace default.
    const pinned = pinnedSurfaceFor(workspaceId);
    return Object.freeze({ workspaceId, ...(pinned && { surfaceId: pinned }) });
  }
  if (resolved.kind === 'surface') {
    return Object.freeze({ workspaceId, surfaceId: resolved.surfaceId });
  }
  return Object.freeze({
    workspaceId,
    noSurface: true as const,
    ...(resolved.foreignSurfaces > 0 && { foreignSurfaces: resolved.foreignSurfaces }),
  });
}

/**
 * Browser RPCs that act on the WORKSPACE, not on one surface.
 *
 * They are the exception to the rule below: a call that names no surface must
 * not cause a browser surface to be opened just to read a recorded flow, a
 * site note, or the backend marker. Everything else in the `browser.*` family
 * drives or reads a page, and main resolves an unnamed surface to the
 * workspace's first live session — another connection's tab as often as the
 * caller's.
 */
const WORKSPACE_LEVEL_BROWSER_METHODS: ReadonlySet<string> = new Set<string>([
  'browser.open',
  'browser.close',
  'browser.tabs',
  'browser.cdp.info',
  'browser.cdp.target',
  'browser.lifecycle.get',
  'browser.lease.acquire',
  'browser.lease.renew',
  'browser.lease.release',
  'browser.actionCache.list',
  'browser.actionCache.get',
  'browser.actionCache.put',
  'browser.actionCache.stats',
  'browser.actionCache.forget',
  'browser.actionCache.promote',
  'browser.actionCache.demote',
  'browser.actionCache.promoted',
  'browser.siteMemory.list',
  'browser.siteMemory.record',
  'browser.siteMemory.forget',
  'browser.siteGuides.match',
  'browser.session.start',
  'browser.session.stop',
  'browser.session.status',
  'browser.session.list',
  // Ownership bookkeeping, always sent with the surface it claims — and sent
  // outside this helper. Listed so it can never be the reason a surface is
  // opened.
  'browser.surface.adopt',
]);

/**
 * The surface this RPC should name when the scope pinned none.
 *
 * Two lanes drive a browser: the Playwright page and these RPCs. The page lane
 * resolves an unnamed surface per connection; this one used to send no
 * surfaceId at all, and main then picked the workspace's first live session —
 * so on a build where no Page can be had (CDP off, packaged guest) one agent's
 * `browser_navigate` landed in another agent's tab. Live dogfood caught
 * exactly that.
 *
 * So: the connection's pin if it has one, otherwise — for a surface-acting
 * method — its own newly opened surface, which is fallback (d). Only an open
 * that cannot happen at all leaves the call unnamed, and that is the case
 * where main has nothing else to pick either.
 */
async function surfaceForScopedRpc(
  method: RpcMethod,
  scope: BrowserTargetScope,
): Promise<string | undefined> {
  const pinned = pinnedSurfaceFor(scope.workspaceId);
  if (pinned) return pinned;
  if (WORKSPACE_LEVEL_BROWSER_METHODS.has(method)) return undefined;
  let opened: string | null = null;
  try {
    opened = await openSurfaceForConnection(scope.workspaceId, { awaitReady: true });
  } catch (err) {
    console.error(
      `[browserScope] ${method}: could not open a surface for this caller:`,
      err instanceof Error ? err.message : String(err),
    );
  }
  if (opened) return opened;
  // Nothing of this caller's to drive, and no way to make one. Sending the
  // call unnamed would hand it to main's workspace default, which is another
  // connection's tab whenever one exists — so it is refused with the remedy
  // instead. (A workspace with no surface at all has nothing to land on, so
  // the older "no target" error is the honest answer there and is left to
  // main.)
  if (scope.foreignSurfaces) throw noOwnSurfaceError(scope.foreignSurfaces);
  return undefined;
}

/**
 * Says what is actually true, which "no browser surface is open in this
 * workspace" was not: surfaces ARE open here — they belong to other agents,
 * and this connection may not be pointed at one implicitly.
 */
function noOwnSurfaceError(foreignSurfaces = 0): Error {
  const others =
    foreignSurfaces > 0
      ? `${foreignSurfaces} browser surface(s) in this workspace belong to other agents and are never targeted implicitly. `
      : '';
  return new Error(
    'BROWSER_NO_OWN_SURFACE: you have no browser surface of your own here, and one could not be ' +
      `opened for you. ${others}Open yours with browser_open, or pass a surfaceId from ` +
      'browser_tabs list to act on a specific surface.',
  );
}

/**
 * Send a browser RPC whose target must be constrained to one workspace.
 * Scope is a required argument and wins over caller-supplied params, making it
 * impossible for a fallback helper to silently omit or override workspaceId.
 */
export async function sendScopedBrowserRpc<T = unknown>(
  method: RpcMethod,
  scope: BrowserTargetScope,
  params: Record<string, unknown> = {},
): Promise<T> {
  assertBrowserTargetScope(scope);
  const scopedParams: Record<string, unknown> = {
    ...params,
    workspaceId: scope.workspaceId,
  };
  // The operation scope is authoritative for both routing dimensions. When
  // no surface is pinned, a caller cannot smuggle one through params that the
  // automation lease did not cover.
  const surfaceId = scope.surfaceId ?? (await surfaceForScopedRpc(method, scope));
  if (surfaceId) scopedParams.surfaceId = surfaceId;
  else delete scopedParams.surfaceId;
  return sendRpc(method, scopedParams) as Promise<T>;
}

/**
 * A scope that names a surface this connection may drive, opening one if it
 * has none.
 *
 * For the tools that reach the RPC lane without ever asking for a Page —
 * `browser_navigate` and `browser_navigate_back` on the builtin backend — so
 * that the surface is settled BEFORE the call, and the keys derived from the
 * scope (the replay ring, the snapshot baseline) describe the surface the call
 * actually used. Throws rather than proceeding unnamed: an unnamed navigate is
 * the one that lands on somebody else's page.
 */
export async function ensureOwnSurfaceScope(
  scope: BrowserTargetScope,
): Promise<BrowserTargetScope> {
  assertBrowserTargetScope(scope);
  if (scope.surfaceId) return scope;
  const pinned = pinnedSurfaceFor(scope.workspaceId);
  if (pinned) return Object.freeze({ workspaceId: scope.workspaceId, surfaceId: pinned });
  const opened = await openSurfaceForConnection(scope.workspaceId, { awaitReady: true });
  if (!opened) throw noOwnSurfaceError(scope.foreignSurfaces);
  return Object.freeze({ workspaceId: scope.workspaceId, surfaceId: opened });
}

/**
 * The surface this operation should hold its automation lease on, or undefined
 * when the caller has none and none can be opened.
 *
 * Used before the lease is acquired rather than after: an unnamed
 * `browser.lease.acquire` resolves to the workspace's first live session, so a
 * lightweight-mode lease was being held on ANOTHER connection's guest while
 * Playwright drove the surface this call actually opened — the wrong guest
 * stayed unthrottled and the right one stayed throttled.
 *
 * Opening happens only when there is something to be wrong about: a workspace
 * whose surfaces all belong to other connections. An empty workspace has
 * nothing to lease and nothing to mistarget, so the body is left to open what
 * it needs (and the lease helper's late-acquire loop picks the new surface up
 * through the pin).
 */
export async function leaseSurfaceScope(scope: BrowserTargetScope): Promise<BrowserTargetScope> {
  if (scope.surfaceId) return scope;
  const pinned = pinnedSurfaceFor(scope.workspaceId);
  if (pinned) return Object.freeze({ workspaceId: scope.workspaceId, surfaceId: pinned });
  if (!scope.foreignSurfaces) return scope;
  try {
    const opened = await openSurfaceForConnection(scope.workspaceId, { awaitReady: true });
    if (opened) return Object.freeze({ workspaceId: scope.workspaceId, surfaceId: opened });
  } catch (err) {
    console.error(
      '[browserScope] could not open a surface to lease for this caller:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return scope;
}
