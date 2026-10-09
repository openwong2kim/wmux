// Pane names as targets: lets every pane-taking tool accept `#w1-2` /
// `#backend` (or a bare `w1-2` / `backend`) where it takes a ptyId, paneId or
// surfaceId. The name is turned into ids through `pane.resolveName` BEFORE the
// tool runs, and the tool then routes and authorizes on those ids exactly as if
// the caller had typed them — a name never reaches a pane its ids could not.
//
// Bundled into the ES2020 MCP server: no Array.prototype.at, replaceAll, ??=.

import type { RpcMethod } from '../shared/rpc';

export interface ResolvedPaneTarget {
  workspaceId: string;
  paneId: string;
  surfaceId: string;
  /** '' when the pane has no local terminal. */
  ptyId: string;
  paneName: string;
  paneTag: string;
}

export type PaneNameRpc = (method: RpcMethod, params: Record<string, unknown>) => Promise<unknown>;

/**
 * Id shapes wmux mints for the values these tools take, so an id is never sent
 * through name resolution: `generateId` (`pane-<uuid>`, `surface-<uuid>`),
 * daemon sessions (`daemon-<hex>`), local-mode PTYManager (`pty-<n>`), brain
 * and automation ptys (`brain-…`, `auto-…`) and the colon-keyed remote / A2A
 * pseudo-ptys (`remote:host:session`, `a2a:…`). Matched on the full shape, not
 * the prefix: a legal label such as `pane-build` or `daemon-api` must still be
 * tried as a name, and a shape this misses only costs a 'maybe' round trip.
 */
const ID_SHAPE_RE =
  /^(?:(?:pane|surface)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?:daemon|brain)-[0-9a-f]+|pty-\d+|auto-.+)$|:/i;

/**
 * - 'name': starts with `#` — always resolved, and a miss is an error.
 * - 'id':   matches a minted id shape — passed through untouched.
 * - 'maybe': anything else — resolved, but a miss (or wmux being unable to
 *   answer) falls back to the raw value, so an id in a shape this list does
 *   not know keeps working exactly as before.
 */
export function classifyPaneRef(value: string): 'name' | 'id' | 'maybe' {
  const trimmed = value.trim();
  if (trimmed.charAt(0) === '#') return 'name';
  if (ID_SHAPE_RE.test(trimmed)) return 'id';
  return 'maybe';
}

/**
 * Resolve a pane reference that might be a name. Returns null when the value
 * should be used as an id unchanged; throws when a name cannot be used (an
 * explicit `#name` that does not resolve, or any ambiguous name).
 */
export async function resolvePaneRef(
  value: string | undefined,
  rpc: PaneNameRpc,
  /** Resolve only within this workspace (pane.resolveName's scope). */
  workspaceId?: string,
): Promise<ResolvedPaneTarget | null> {
  if (value === undefined || value === '') return null;
  const kind = classifyPaneRef(value);
  if (kind === 'id') return null;
  let res: { ok?: unknown; reason?: unknown; error?: unknown; target?: ResolvedPaneTarget } | null;
  try {
    res = (await rpc('pane.resolveName', { name: value, ...(workspaceId ? { workspaceId } : {}) })) as typeof res;
  } catch (err) {
    if (kind === 'maybe') return null;
    throw err;
  }
  if (res && res.ok === true && res.target) return res.target;
  const reason = res && typeof res.reason === 'string' ? res.reason : 'not_found';
  if (kind === 'maybe' && reason !== 'ambiguous') return null;
  throw new Error(res && typeof res.error === 'string' ? res.error : `no pane named "${value}"`);
}

/** A ptyId parameter that may be a pane name → the pane's terminal ptyId. */
export async function resolvePtyRef(value: string | undefined, rpc: PaneNameRpc): Promise<string | undefined> {
  const target = await resolvePaneRef(value, rpc);
  if (!target) return value;
  if (!target.ptyId) throw new Error(`pane ${target.paneTag} has no local terminal`);
  return target.ptyId;
}

/** A paneId parameter that may be a pane name → the paneId. */
export async function resolvePaneIdRef(value: string | undefined, rpc: PaneNameRpc, workspaceId?: string): Promise<string | undefined> {
  const target = await resolvePaneRef(value, rpc, workspaceId);
  return target ? target.paneId : value;
}
