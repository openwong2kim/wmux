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
 *      opened by a person, or opened before this shipped — which this
 *      connection then ADOPTS, so the next connection does not take it too
 *   4. otherwise nothing: the caller opens (and pins) its own rather than
 *      taking over a surface another connection opened
 *
 * The opener key is a random id minted once per connection and sent with every
 * open, so main can record who asked for a surface. Main answers only with a
 * verdict — mine, another's, or unclaimed — never with anyone's key, so no
 * caller can learn another connection's identity from wmux.
 *
 * It is an identity HINT, not a credential, and cannot be anything stronger
 * here: `sendRpc` opens a fresh socket per call (wmux-client), so main has no
 * transport-level connection to bind the identity to. Nothing rests on it that
 * would not already be true without it — ownership decides only where an
 * UNSAID target lands, and an explicit surfaceId still reaches any surface in
 * the workspace, including another connection's.
 */

/** A surface pinned to one connection: the last surface it opened. */
export interface SurfacePin {
  workspaceId: string;
  surfaceId: string;
}

/** Main's verdict about who opened a surface; absent = nobody claims it. */
export type OpenerVerdict = 'mine' | 'other';

/** The target fields routing needs; `browser.cdp.info` returns a superset. */
export interface RoutableTarget {
  surfaceId: string;
  workspaceId?: string;
  /** Main's verdict for THIS caller. Absent means the surface is unclaimed. */
  opener?: OpenerVerdict;
}

export interface RoutableCdpInfo {
  targets: readonly RoutableTarget[];
  targetsScoped?: boolean;
  workspaceBackend?: string;
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
 * Record a surface this connection just opened (or adopted) as its default
 * target.
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

/** The pinned surface of this workspace, or undefined. */
export function pinnedSurfaceFor(workspaceId: string): string | undefined {
  const pin = readPin();
  return pin && pin.workspaceId === workspaceId ? pin.surfaceId : undefined;
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
  /** Use this surface; `adopt` means claim it first — nobody owns it yet. */
  | { kind: 'surface'; surfaceId: string; adopt?: true }
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
  pin: SurfacePin | null,
): DefaultSurfacePick {
  if (pin && pin.workspaceId === workspaceId) {
    if (targets.some((t) => t.surfaceId === pin.surfaceId)) {
      return { kind: 'surface', surfaceId: pin.surfaceId };
    }
    // A surface can exist before its CDP target registers — a pane that was
    // just created has not registered one yet — so an absence here is not
    // proof the pin is gone. The caller confirms against the control plane
    // before dropping it; guessing instead would hand this call to somebody
    // else's tab at exactly the moment the agent opened its own.
    return { kind: 'pin-unlisted', surfaceId: pin.surfaceId };
  }
  const mine = newestWhere(targets, (t) => t.opener === 'mine');
  if (mine) return { kind: 'surface', surfaceId: mine.surfaceId };
  const unclaimed = newestWhere(targets, (t) => t.opener === undefined);
  // Adopted, not merely used: without recording the claim, every connection
  // that has opened nothing converges on the same restored or human-opened tab
  // — the bug this routing exists to prevent, one level down.
  if (unclaimed) return { kind: 'surface', surfaceId: unclaimed.surfaceId, adopt: true };
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

/**
 * Does the control plane still know this surface?
 *
 * Three answers, not two: a refused or failed `browser.tabs` means "cannot
 * check", and treating that as "gone" would drop the pin on every lane that
 * does not allow the method (the commander lane refuses it outright) — the
 * connection would lose its tab on the first miss and start adopting others'.
 */
async function surfaceListing(
  workspaceId: string,
): Promise<{ status: 'listed'; surfaceIds: string[] } | { status: 'unknown' }> {
  try {
    const result = (await sendRpc('browser.tabs', { action: 'list', workspaceId })) as
      | { ok?: unknown; action?: unknown; tabs?: Array<{ surfaceId?: unknown; opener?: unknown }> }
      | undefined;
    if (result?.ok !== true || result.action !== 'list' || !Array.isArray(result.tabs)) {
      return { status: 'unknown' };
    }
    return {
      status: 'listed',
      surfaceIds: result.tabs
        .map((tab) => tab?.surfaceId)
        .filter((id): id is string => typeof id === 'string'),
    };
  } catch {
    return { status: 'unknown' };
  }
}

/**
 * A surface in the pane tree that nobody claims and no CDP target mentions.
 *
 * The case is a browser pane a person opened seconds ago: it exists, but its
 * guest has not registered a target yet, so `cdp.info` cannot see it and the
 * caller would split a SECOND pane beside it. Builtin only — on a live-Chrome
 * attach the tab list is every tab the person has open, and adopting one of
 * those as an agent's default is exactly what that backend must never do.
 */
async function unclaimedPaneSurface(
  workspaceId: string,
  backend: string | undefined,
): Promise<string | undefined> {
  if (backend !== undefined && backend !== 'builtin') return undefined;
  try {
    const result = (await sendRpc('browser.tabs', { action: 'list', workspaceId })) as
      | { ok?: unknown; action?: unknown; tabs?: Array<{ surfaceId?: unknown; opener?: unknown }> }
      | undefined;
    if (result?.ok !== true || result.action !== 'list' || !Array.isArray(result.tabs)) {
      return undefined;
    }
    for (let i = result.tabs.length - 1; i >= 0; i--) {
      const tab = result.tabs[i];
      if (typeof tab?.surfaceId === 'string' && tab.opener === undefined) return tab.surfaceId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Claim an unclaimed surface for this connection, and pin it. */
async function adoptSurface(workspaceId: string, surfaceId: string): Promise<void> {
  noteOpenedSurface(workspaceId, surfaceId);
  try {
    await sendRpc('browser.surface.adopt', {
      workspaceId,
      surfaceId,
      openerKey: getOpenerKey(),
    });
  } catch (err) {
    // An older main without the method, or a lane that refuses it: the pin
    // still holds for THIS connection, so the adoption is local-only and the
    // surface stays adoptable by others. Worth a line, never worth failing on.
    console.error(
      '[surfaceRouting] could not record the adoption of this surface:',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Open a surface for THIS connection and pin it. Returns its id, or null when
 * the open was refused or produced no addressable surface.
 *
 * `browser.tabs new`, not `browser.open`: on the builtin backend an open
 * REUSES the workspace's first browser surface when one exists, which is how a
 * surface opened for one agent used to be another agent's tab. `new` always
 * creates, on every backend.
 *
 * A THROW from that method means it is not available to this caller at all — a
 * main too old to know it, or a lane that denies it (`browser.tabs` can close
 * surfaces, so the commander lane refuses the whole method). The fallback is
 * `browser.open`, which those lanes do allow; it carries the opener key too,
 * and main applies the same "never reuse another connection's surface" rule to
 * it. Any ANSWER — including the external backend's `{ok:true}` with no tab,
 * which opened a tab in the OS browser that wmux holds no handle on — is the
 * end of the attempt: retrying through the other method would open a second
 * one.
 */
export async function openSurfaceForConnection(
  workspaceId: string,
  opts: { awaitReady?: boolean } = {},
): Promise<string | null> {
  if (!workspaceId) return null;
  const opened = await openSurface(workspaceId);
  if (!opened) return null;
  noteOpenedSurface(workspaceId, opened);
  // The RPC lane asks to wait, because main answers a call naming a surface
  // whose guest has not REGISTERED yet with "no browser surface is open in
  // this workspace" — the pane is there, its target is not. Live dogfood:
  // browser_navigate opened its own pane and was refused a millisecond later.
  // (The page lane does its own settling after an auto-open, so it does not
  // ask and does not pay for this twice.)
  if (opts.awaitReady) await awaitSurfaceRegistered(workspaceId, opened);
  return opened;
}

/** How long to wait for a freshly opened surface to become addressable. */
const SURFACE_READY_TIMEOUT_MS = 6_000;
const SURFACE_READY_POLL_MS = 150;

/**
 * Wait until main lists the surface among the caller's targets.
 *
 * That listing is exactly the condition every target-addressing handler
 * checks, so it is the honest readiness signal rather than a fixed sleep. A
 * timeout is not an error: the call proceeds and main answers for itself —
 * waiting longer would turn a slow guest into a hung tool.
 */
async function awaitSurfaceRegistered(workspaceId: string, surfaceId: string): Promise<void> {
  const deadline = Date.now() + SURFACE_READY_TIMEOUT_MS;
  for (;;) {
    try {
      const info = (await sendRpc('browser.cdp.info', {
        workspaceId,
        openerKey: getOpenerKey(),
      })) as RoutableCdpInfo;
      if (Array.isArray(info?.targets) && info.targets.some((t) => t.surfaceId === surfaceId)) {
        return;
      }
    } catch {
      return; // cannot ask — let the call itself report whatever happens
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, SURFACE_READY_POLL_MS));
  }
}

async function openSurface(workspaceId: string): Promise<string | null> {
  try {
    const created = (await sendRpc('browser.tabs', {
      action: 'new',
      workspaceId,
      openerKey: getOpenerKey(),
    })) as { ok?: unknown; action?: unknown; tab?: { surfaceId?: unknown } } | undefined;
    if (created?.ok === true) {
      return typeof created.tab?.surfaceId === 'string' && created.tab.surfaceId
        ? created.tab.surfaceId
        : null;
    }
    // An `ok:false` result is a real refusal from a main that understands the
    // method (pane cap, a backend with nothing to create) — not a reason to
    // try the reuse-shaped open behind its back.
    if (created?.ok === false) return null;
  } catch (err) {
    console.error(
      '[surfaceRouting] browser.tabs new unavailable, falling back to browser.open:',
      err instanceof Error ? err.message : String(err),
    );
  }
  const reply = (await sendRpc('browser.open', {
    workspaceId,
    openerKey: getOpenerKey(),
  })) as { surfaceId?: unknown } | undefined;
  return typeof reply?.surfaceId === 'string' && reply.surfaceId ? reply.surfaceId : null;
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
): Promise<
  | { kind: 'surface'; surfaceId: string }
  /** `foreignSurfaces`: live surfaces exist here, they just all belong to
   *  other connections — the case where an unnamed call is not vague but
   *  wrong, because main would resolve it to one of them. */
  | { kind: 'none'; foreignSurfaces: number }
> {
  if (!workspaceId) {
    throw new WorkspaceScopeUnresolvedError('workspace identity resolved to an empty id');
  }
  let info: RoutableCdpInfo;
  try {
    // Pass the resolved workspace so main filters `targets` server-side; the
    // response then carries only our own targets (#580, Option 1).
    info = (await sendRpc('browser.cdp.info', {
      workspaceId,
      // So main can answer "is this one yours?" per target without ever
      // returning anyone's key.
      openerKey: getOpenerKey(),
    })) as RoutableCdpInfo;
  } catch (err) {
    throw new WorkspaceScopeUnresolvedError(
      `browser.cdp.info unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  opts.onInfo?.(info);
  const scoped = scopeTargets(info, workspaceId);
  let pick = pickDefaultSurface(scoped, workspaceId, readPin());

  if (pick.kind === 'pin-unlisted') {
    const listing = await surfaceListing(workspaceId);
    if (listing.status === 'unknown' || listing.surfaceIds.includes(pick.surfaceId)) {
      // Still there, or unverifiable — either way the pin is the best answer
      // this connection has, and dropping it would send the call to a surface
      // somebody else is working in.
      return { kind: 'surface', surfaceId: pick.surfaceId };
    }
    clearPinnedSurface();
    // The pin was the only reason the other steps were skipped, so run them
    // now that it is gone — against the targets already in hand.
    pick = pickDefaultSurface(scoped, workspaceId, null);
  }

  if (pick.kind === 'surface') {
    if (pick.adopt) await adoptSurface(workspaceId, pick.surfaceId);
    else noteOpenedSurface(workspaceId, pick.surfaceId);
    return { kind: 'surface', surfaceId: pick.surfaceId };
  }

  // Nothing in the target list. A pane whose guest has not registered yet is
  // invisible there, and splitting a second pane beside it is a worse answer
  // than adopting it.
  const pane = await unclaimedPaneSurface(workspaceId, info.workspaceBackend);
  if (pane) {
    await adoptSurface(workspaceId, pane);
    return { kind: 'surface', surfaceId: pane };
  }
  return { kind: 'none', foreignSurfaces: scoped.length };
}
