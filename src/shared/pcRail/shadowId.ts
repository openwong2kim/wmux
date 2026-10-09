/**
 * The id namespace of a shadow workspace: the local projection of one
 * workspace on a web-paired computer (PC rail, PR4 builds them).
 *
 *   shadow:<hostId>:<remoteId>
 *
 * A shadow lives in the same `workspaces` array as local workspaces, so its id
 * must never equal a local one (`ws-<uuid>`, see generateId) and two shadows of
 * different hosts must never share one, even when both hosts report the same
 * remote id. `hostId` is this desktop's own uuid for the host (never colon-
 * bearing), so the FIRST colon after the prefix separates the halves and the
 * remote id keeps any colons it carries. format refuses a colon-bearing hostId,
 * which is what makes the mapping one-to-one.
 */

export const SHADOW_WORKSPACE_PREFIX = 'shadow:';

/** Length bounds for each half. A remote id longer than this is not addressable. */
export const SHADOW_ID_LIMITS = { hostId: 128, remoteId: 128 } as const;

export interface ShadowWorkspaceRef {
  hostId: string;
  remoteId: string;
}

function validHostId(hostId: unknown): hostId is string {
  return typeof hostId === 'string'
    && hostId.length > 0
    && hostId.length <= SHADOW_ID_LIMITS.hostId
    && !hostId.includes(':');
}

function validRemoteId(remoteId: unknown): remoteId is string {
  return typeof remoteId === 'string' && remoteId.length > 0 && remoteId.length <= SHADOW_ID_LIMITS.remoteId;
}

/** The shadow id for a host's workspace, or null when either half is unusable. */
export function formatShadowWorkspaceId(hostId: string, remoteId: string): string | null {
  if (!validHostId(hostId) || !validRemoteId(remoteId)) return null;
  return `${SHADOW_WORKSPACE_PREFIX}${hostId}:${remoteId}`;
}

/** Inverse of formatShadowWorkspaceId; null for anything it could not have produced. */
export function parseShadowWorkspaceId(id: unknown): ShadowWorkspaceRef | null {
  if (typeof id !== 'string' || !id.startsWith(SHADOW_WORKSPACE_PREFIX)) return null;
  const rest = id.slice(SHADOW_WORKSPACE_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const hostId = rest.slice(0, sep);
  const remoteId = rest.slice(sep + 1);
  if (!validHostId(hostId) || !validRemoteId(remoteId)) return null;
  return { hostId, remoteId };
}

/** True for an id in the shadow namespace (well-formed or not). Used to keep shadows out of persistence. */
export function isShadowWorkspaceId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(SHADOW_WORKSPACE_PREFIX);
}
