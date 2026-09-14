import * as crypto from 'crypto';
import { sendRpc } from '../wmux-client';
import { getConnectionScope } from '../connectionScope';
import { WorkspaceScopeUnresolvedError } from './browserScope';

/**
 * Which browser surface a call that omitted `surfaceId` belongs to.
 *
 * The default used to be "the newest surface in the caller's workspace", which
 * is the right answer only while one agent is driving. Two agent panes in one
 * workspace hold two MCP connections, and both resolved to the same newest
 * surface: the second agent's browser_navigate drove the first agent's tab,
 * and every following call kept overwriting the other's page.
 *
 * So the default is per CONNECTION, not per workspace:
 *
 *   1. the surface this connection last OPENED (its pin), while it still exists
 *   2. otherwise the newest surface this connection opened
 *   3. otherwise the newest surface NOBODY claims — restored after a restart,
 *      opened by a person, or opened before this shipped
 *   4. otherwise nothing: the caller opens (and pins) its own rather than
 *      taking over a surface another connection opened
 *
 * The opener key is a random id minted once per connection and sent with every
 * open, so main can record who asked for a surface. It is memory only, never
 * persisted — a surface that outlives the app comes back ownerless and is
 * reachable again through step 3.
 *
 * None of this is a permission boundary: an explicit surfaceId still reaches
 * any surface in the workspace, including another connection's. It decides
 * where an UNSAID target lands, which is the only place a wrong guess is
 * silent.
 */

/** A surface pinned to one connection: the last surface it opened. */
export interface SurfacePin {
  workspaceId: string;
  surfaceId: string;
}

/** The target fields routing needs; `browser.cdp.info` returns a superset. */
export interface RoutableTarget {
  surfaceId: string;
  workspaceId?: string;
  /** The connection that opened this surface, when main knows it. */
  openerKey?: string;
}

export interface RoutableCdpInfo {
  targets: readonly RoutableTarget[];
  targetsScoped?: boolean;
}

/** Module fallback for the single-child stdio server (no broker scope). */
let moduleOpenerKey: string | undefined;
let modulePin: SurfacePin | null = null;

/**
 * This connection's opener key, minted on first use.
 *
 * Per connection in broker mode (the ConnectionScope idiom used by the engine,
 * the snapshot baselines and the guide announcements), per process in the
 * single-child stdio server — where one process IS one caller, so the module
 * fallback has exactly the same meaning.
 */
export function getOpenerKey(): string {
  const scope = getConnectionScope();
  if (scope) {
    if (!scope.browserOpenerKey) scope.browserOpenerKey = crypto.randomUUID();
    return scope.browserOpenerKey;
  }
  if (!moduleOpenerKey) moduleOpenerKey = crypto.randomUUID();
  return moduleOpenerKey;
}

function readPin(): SurfacePin | null {
  const scope = getConnectionScope();
  if (scope) return (scope.browserPin as SurfacePin | null | undefined) ?? null;
  return modulePin;
}

function writePin(pin: SurfacePin | null): void {
  const scope = getConnectionScope();
  if (scope) {
    scope.browserPin = pin;
    return;
  }
  modulePin = pin;
}

/**
 * Record a surface this connection just opened as its default target.
 *
 * Only OPENING moves the pin. Passing an explicit surfaceId to a tool does
 * not: that call says where it wants to go once, and silently re-aiming every
 * later unsaid call at it would make one explicit detour permanent.
 */
export function noteOpenedSurface(workspaceId: string, surfaceId: string): void {
  if (!workspaceId || !surfaceId) return;
  writePin({ workspaceId, surfaceId });
}

/** The pin, for tests and for the resolver below. */
export function getPinnedSurface(): SurfacePin | null {
  return readPin();
}

export function clearPinnedSurface(): void {
  writePin(null);
}

/** Test seam: forget the module-fallback identity (single-child path only). */
export function __resetSurfaceRoutingForTesting(): void {
  moduleOpenerKey = undefined;
  modulePin = null;
}

/**
 * The last matching entry, not the first: both backends list surfaces in
 * creation order, so the newest one a predicate accepts is at the end.
 * (Manual scan instead of Array.findLast — this file compiles under the ES2020
 * MCP tsconfig, whose lib predates findLast.)
 */
function newestWhere(
  targets: readonly RoutableTarget[],
  accept: (target: RoutableTarget) => boolean,
): RoutableTarget | undefined {
  for (let i = targets.length - 1; i >= 0; i--) {
    if (accept(targets[i])) return targets[i];
  }
  return undefined;
}

/** What `pickDefaultSurface` decided, and why the caller may need to act. */
export type DefaultSurfacePick =
  /** Use this surface. */
  | { kind: 'surface'; surfaceId: string }
  /** The pin names a surface no target list mentions — confirm before dropping it. */
  | { kind: 'pin-unlisted'; surfaceId: string }
  /** Nothing this connection may take: open its own. */
  | { kind: 'none' };

/**
 * The routing decision itself, pure so the fallback order is testable without
 * a transport. `targets` must already be scoped to `workspaceId`.
 */
export function pickDefaultSurface(
  targets: readonly RoutableTarget[],
  workspaceId: string,
  openerKey: string,
  pin: SurfacePin | null,
): DefaultSurfacePick {
  if (pin && pin.workspaceId === workspaceId) {
    if (targets.some((t) => t.surfaceId === pin.surfaceId)) {
      return { kind: 'surface', surfaceId: pin.surfaceId };
    }
    // A surface can exist without a live CDP target — a pane that was just
    // created has not registered one yet — so an absence here is not proof the
    // pin is gone. The caller confirms against the control plane before
    // dropping it; guessing instead would hand this call to somebody else's
    // tab at exactly the moment the agent opened its own.
    return { kind: 'pin-unlisted', surfaceId: pin.surfaceId };
  }
  const mine = newestWhere(targets, (t) => t.openerKey === openerKey);
  if (mine) return { kind: 'surface', surfaceId: mine.surfaceId };
  const ownerless = newestWhere(targets, (t) => t.openerKey === undefined);
  if (ownerless) return { kind: 'surface', surfaceId: ownerless.surfaceId };
  return { kind: 'none' };
}

/**
 * Narrow a `browser.cdp.info` response to the targets that provably belong to
 * `workspaceId`, refusing rather than guessing when it cannot be told.
 *
 * The rules are the ones page selection has always used (#554/#580): a main
 * that honored the scope request marks the response, a main too old to tag
 * targets at all cannot be scoped, and an empty list is unambiguous either way.
 */
export function scopeTargets(
  info: RoutableCdpInfo,
  workspaceId: string,
): readonly RoutableTarget[] {
  // A response with no target list at all is "nothing to route to", never a
  // crash: routing runs before the tool body, so a malformed reply from an
  // unexpected main must cost the caller its pin, not its call.
  if (!Array.isArray(info.targets)) return [];
  if (info.targetsScoped) return info.targets;
  if (info.targets.length === 0) return [];
  const anyTagged = info.targets.some(
    (t) => typeof t.workspaceId === 'string' && t.workspaceId.length > 0,
  );
  if (!anyTagged) {
    throw new WorkspaceScopeUnresolvedError(
      'the connected wmux main does not tag browser targets with a workspace',
    );
  }
  return info.targets.filter((t) => t.workspaceId === workspaceId);
}

/** Does the control plane still know this surface? Unknown answers are "no". */
async function surfaceStillListed(workspaceId: string, surfaceId: string): Promise<boolean> {
  try {
    const result = (await sendRpc('browser.tabs', { action: 'list', workspaceId })) as
      | { ok?: unknown; action?: unknown; tabs?: Array<{ surfaceId?: unknown }> }
      | undefined;
    if (result?.ok !== true || result.action !== 'list' || !Array.isArray(result.tabs)) {
      return false;
    }
    return result.tabs.some((tab) => tab?.surfaceId === surfaceId);
  } catch {
    return false;
  }
}

export interface ResolveDefaultSurfaceOptions {
  /** Lets the engine keep caching shell URL / backend from the same response. */
  onInfo?: (info: RoutableCdpInfo) => void;
}

/**
 * Resolve the default surface for a call that named none.
 *
 * Throws WorkspaceScopeUnresolvedError when ownership cannot be established —
 * the same refusal page selection has always made, rather than reaching for
 * some other workspace's guest.
 */
export async function resolveDefaultSurface(
  workspaceId: string,
  opts: ResolveDefaultSurfaceOptions = {},
): Promise<{ kind: 'surface'; surfaceId: string } | { kind: 'none' }> {
  if (!workspaceId) {
    throw new WorkspaceScopeUnresolvedError('workspace identity resolved to an empty id');
  }
  let info: RoutableCdpInfo;
  try {
    // Pass the resolved workspace so main filters `targets` server-side; the
    // response then carries only our own targets (#580, Option 1).
    info = (await sendRpc('browser.cdp.info', { workspaceId })) as RoutableCdpInfo;
  } catch (err) {
    throw new WorkspaceScopeUnresolvedError(
      `browser.cdp.info unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  opts.onInfo?.(info);
  const scoped = scopeTargets(info, workspaceId);
  const pick = pickDefaultSurface(scoped, workspaceId, getOpenerKey(), readPin());
  if (pick.kind === 'surface') return pick;
  if (pick.kind === 'pin-unlisted') {
    if (await surfaceStillListed(workspaceId, pick.surfaceId)) {
      return { kind: 'surface', surfaceId: pick.surfaceId };
    }
    clearPinnedSurface();
    // The pin was the only reason the other steps were skipped, so run them now
    // that it is gone — against the targets already in hand.
    const afterPin = pickDefaultSurface(scoped, workspaceId, getOpenerKey(), null);
    if (afterPin.kind === 'surface') return afterPin;
  }
  return { kind: 'none' };
}
