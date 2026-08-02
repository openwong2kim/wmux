import type { RpcMethod } from '../../shared/rpc';
import { sendRpc } from '../wmux-client';

/** Stable error code for browser operations whose caller cannot be scoped. */
export const WORKSPACE_SCOPE_UNRESOLVED_CODE = 'WORKSPACE_SCOPE_UNRESOLVED';

export function isWorkspaceScopeUnresolvedError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith(`${WORKSPACE_SCOPE_UNRESOLVED_CODE}:`);
}

/**
 * Page discovery failures may fall back to a scoped main-process RPC. A scope
 * refusal may not: on an older main that ignores workspaceId, doing so would
 * recreate the cross-workspace path the refusal was meant to close.
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

/**
 * Resolve browser routing once, before any lease or browser RPC is issued.
 * An empty identity is a refusal: omitting it would restore main's legacy
 * first-live-target behavior and could cross workspace boundaries (#695).
 */
export async function requireBrowserTargetScope(
  deps: BrowserToolDeps,
  surfaceId?: string,
): Promise<BrowserTargetScope> {
  const workspaceId = await deps.resolveWorkspaceId();
  if (!workspaceId) {
    throw new Error(
      `${WORKSPACE_SCOPE_UNRESOLVED_CODE}: browser tool workspace identity resolved to an empty id.`,
    );
  }
  return Object.freeze({ workspaceId, ...(surfaceId && { surfaceId }) });
}

/**
 * Send a browser RPC whose target must be constrained to one workspace.
 * Scope is a required argument and wins over caller-supplied params, making it
 * impossible for a fallback helper to silently omit or override workspaceId.
 */
export function sendScopedBrowserRpc<T = unknown>(
  method: RpcMethod,
  scope: BrowserTargetScope,
  params: Record<string, unknown> = {},
): Promise<T> {
  return sendRpc(method, { ...params, ...scope }) as Promise<T>;
}
