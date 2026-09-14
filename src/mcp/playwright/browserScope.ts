import type { RpcMethod } from '../../shared/rpc';
import { sendRpc } from '../wmux-client';
// Cycle-safe: surfaceRouting imports the refusal type from here, and both
// sides touch the other only from inside function bodies, never at module
// evaluation time.
import { resolveDefaultSurface } from './surfaceRouting';

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
  const resolved = await resolveDefaultSurface(workspaceId).catch(() => ({ kind: 'none' as const }));
  return Object.freeze({
    workspaceId,
    ...(resolved.kind === 'surface' && { surfaceId: resolved.surfaceId }),
  });
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
  if (scope.surfaceId) scopedParams.surfaceId = scope.surfaceId;
  else delete scopedParams.surfaceId;
  return sendRpc(method, scopedParams) as Promise<T>;
}
