// ---------------------------------------------------------------------------
// Which targets of a shared Chrome each external client of its debugging pipe
// may see and address (C3b, the TargetGrant). Off unless
// WMUX_CDP_TARGET_GRANT=1; then CdpPipeMux asks decide() wherever a target is
// found or named, and main's own clients are never narrowed.
//
// A target is a client's when, in this order:
//  1. its type is never any external client's (a tab, browser UI, an
//     extension's background page, a service or shared worker, the browser
//     itself) or it is a prerender: no one's;
//  2. main's registry files it under another workspace: not this client's,
//     whatever else holds (a popup main filed under that workspace stays there);
//  3. main's registry files it under the client's workspace: the client's;
//  4. the client created it (Target.createTarget, on any session it holds), or
//     it lives in a browser context the client created: the client's, for the
//     target's life;
//  5. the page that opened it is the client's, by these same rules, through at
//     most OPENER_DEPTH openers: the client's, for the target's life.
// Anything else is no one's. A registry record without a workspace grants
// nothing (rule 3 needs a workspace on both sides) and takes nothing away.
// An operator caller is granted every target, as on the port.
//
// Every failure denies: an unknown opener, a cycle, the depth running out, a
// registry lookup that throws. A target with no opener, no record and no
// creator yet is 'unknown' while the client has a createTarget in flight:
// Chrome announces a new page before its createTarget reply names it, so the
// mux holds that client's frames until the reply (see CdpPipeMux).
// ---------------------------------------------------------------------------

const GRANT_ENV = 'WMUX_CDP_TARGET_GRANT';

/** Whether the pipe narrows each external client to its own targets. */
export function cdpTargetGrantEnabled(): boolean {
  return process.env[GRANT_ENV] === '1';
}

/** Target types no external client is ever granted. */
export const NEVER_GRANTED_TYPES: ReadonlySet<string> = new Set([
  'tab', 'browser_ui', 'background_page', 'service_worker', 'shared_worker', 'browser',
]);

/** How many openers a grant follows back. */
export const OPENER_DEPTH = 8;

/** What a grant judges a caller by: as main resolved it, never as the caller said. */
export interface GrantIdentity {
  readonly workspaceId?: string;
  /** The operator lane (browser.cdp.info's ctx.operator): every target, as on the port. */
  readonly operator?: boolean;
}

/**
 * Main's registry: for a target it holds a record of, that record's workspace
 * (undefined when it has none); for any other target, `null`. Synchronous; a
 * throw denies.
 */
export type TargetRegistry = (targetId: string) => { readonly workspaceId?: string } | null;

/**
 * Whether a registry record filed under `recordWorkspace` is shown to a caller
 * of `callerWorkspace`: the one rule main's target lists and the pipe share.
 * A record with no workspace is shown to no one, and neither is any record to
 * a caller with none.
 */
export function recordVisibleTo(recordWorkspace: string | undefined, callerWorkspace: string | undefined): boolean {
  return recordWorkspace !== undefined && callerWorkspace !== undefined && recordWorkspace === callerWorkspace;
}

/** What the browser said of a target, from any targetInfo the mux routed. */
interface TargetFacts {
  type?: string;
  subtype?: string;
  openerId?: string;
  browserContextId?: string;
  /** The client whose createTarget named it. */
  createdBy?: object;
  /**
   * What its opener stood for when it was found (a popup's grant lasts its
   * life): the client that created the opener or its context, and the
   * workspace main filed the opener under.
   */
  openedBy?: object;
  openedIn?: string;
}

export type GrantDecision = 'grant' | 'deny' | 'unknown';

/** A targetInfo as Chrome sends it, read defensively. */
export interface TargetInfoLike {
  targetId?: unknown;
  type?: unknown;
  subtype?: unknown;
  openerId?: unknown;
  browserContextId?: unknown;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

/**
 * The facts behind every grant on one pipe. `owner` is any object the mux
 * uses for a client; it is compared by identity only.
 */
export class CdpTargetOwnership {
  private readonly facts = new Map<string, TargetFacts>();
  private readonly contexts = new Map<string, object>();

  constructor(private readonly registry: TargetRegistry) {}

  /** Record what a targetInfo says (Target.targetCreated, attachedToTarget, targetInfoChanged, getTargets). */
  learn(info: TargetInfoLike | undefined): void {
    const id = str(info?.targetId);
    if (!id || !info) return;
    const known = this.facts.get(id) ?? {};
    if (known.openerId === undefined && str(info.openerId)) Object.assign(known, this.inherit(str(info.openerId) as string));
    const type = str(info.type);
    const subtype = str(info.subtype);
    const openerId = str(info.openerId);
    const browserContextId = str(info.browserContextId);
    this.facts.set(id, {
      ...known,
      ...(type && { type }),
      // A prerender that is activated loses its subtype.
      subtype,
      // An opener, once known, stays: the grant it gave lasts the target's life.
      ...(openerId && !known.openerId && { openerId }),
      ...(browserContextId && { browserContextId }),
    });
  }

  /** What a new popup takes from its opener, as things stand now. */
  private inherit(openerId: string): Pick<TargetFacts, 'openedBy' | 'openedIn'> {
    const opener = this.facts.get(openerId);
    let openedIn: string | undefined;
    try {
      openedIn = this.registry(openerId)?.workspaceId ?? opener?.openedIn;
    } catch {
      openedIn = undefined;
    }
    const contextOwner = opener?.browserContextId ? this.contexts.get(opener.browserContextId) : undefined;
    const openedBy = opener?.createdBy ?? contextOwner ?? opener?.openedBy;
    return { ...(openedBy && { openedBy }), ...(openedIn !== undefined && { openedIn }) };
  }

  /** `owner`'s createTarget named `targetId`. */
  created(owner: object, targetId: string): void {
    const known = this.facts.get(targetId) ?? {};
    if (!known.createdBy) this.facts.set(targetId, { ...known, createdBy: owner });
  }

  /** `owner`'s createBrowserContext named `contextId`. */
  createdContext(owner: object, contextId: string): void {
    if (!this.contexts.has(contextId)) this.contexts.set(contextId, owner);
  }

  /** Whether `owner` created the browser context `contextId`. */
  ownsContext(owner: object, contextId: string): boolean {
    return this.contexts.get(contextId) === owner;
  }

  /** The target is gone (Target.targetDestroyed). */
  destroyed(targetId: string): void {
    this.facts.delete(targetId);
  }

  /** The context is gone (Target.disposeBrowserContext answered). */
  disposedContext(contextId: string): void {
    this.contexts.delete(contextId);
  }

  /** Every client-made fact of `owner` goes with it. */
  forget(owner: object): void {
    for (const [id, context] of this.contexts) if (context === owner) this.contexts.delete(id);
    for (const [id, f] of this.facts) {
      if (f.createdBy === owner || f.openedBy === owner) this.facts.set(id, { ...f, ...(f.createdBy === owner && { createdBy: undefined }), ...(f.openedBy === owner && { openedBy: undefined }) });
    }
  }

  /** Whether the target has an opener on record (a popup is decided at once, never held). */
  hasOpener(targetId: string): boolean {
    return this.facts.get(targetId)?.openerId !== undefined;
  }

  /**
   * Whether `owner`, who connected as `identity`, may see and address
   * `targetId`. 'unknown' only when `creating` (the client has a createTarget
   * in flight) and nothing yet attributes the target to anyone.
   */
  decide(owner: object, identity: GrantIdentity, targetId: string, creating = false): GrantDecision {
    if (identity.operator === true) return 'grant';
    const seen = new Set<string>();
    const verdict = this.judge(owner, identity, targetId, OPENER_DEPTH, seen);
    if (verdict !== 'deny' || !creating) return verdict;
    // Nothing decided it, and the client is creating a page: maybe this one.
    const f = this.facts.get(targetId);
    let record: { readonly workspaceId?: string } | null;
    try {
      record = this.registry(targetId);
    } catch {
      return 'deny';
    }
    const unattributed = !f?.openerId && !f?.createdBy && !f?.openedBy && f?.openedIn === undefined && record === null
      && !(f?.type && NEVER_GRANTED_TYPES.has(f.type)) && !f?.subtype
      && !(f?.browserContextId && this.contexts.has(f.browserContextId));
    return unattributed ? 'unknown' : 'deny';
  }

  private judge(owner: object, identity: GrantIdentity, targetId: string, depth: number, seen: Set<string>): 'grant' | 'deny' {
    if (seen.has(targetId)) return 'deny';
    seen.add(targetId);
    const f = this.facts.get(targetId);
    if (f?.type && NEVER_GRANTED_TYPES.has(f.type)) return 'deny';
    if (f?.subtype) return 'deny';
    let record: { readonly workspaceId?: string } | null;
    try {
      record = this.registry(targetId);
    } catch {
      return 'deny';
    }
    if (record && record.workspaceId !== undefined) {
      return recordVisibleTo(record.workspaceId, identity.workspaceId) ? 'grant' : 'deny';
    }
    if (f?.createdBy === owner) return 'grant';
    if (f?.browserContextId && this.contexts.get(f.browserContextId) === owner) return 'grant';
    // Opened by the client's page: kept for the popup's life, opener gone or not.
    if (f?.openedBy === owner) return 'grant';
    if (f?.openedIn !== undefined && recordVisibleTo(f.openedIn, identity.workspaceId)) return 'grant';
    if (f?.openerId && depth > 0) return this.judge(owner, identity, f.openerId, depth - 1, seen);
    return 'deny';
  }
}
