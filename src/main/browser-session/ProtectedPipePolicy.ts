import type { BeforeReply, ClientCommandFilter, ClientRef } from './CdpPipeMux';

// ---------------------------------------------------------------------------
// A protected profile's rules for the clients of its debugging pipe (C2b).
// Downloads belong to main: only its download guard and the consent pass set
// the download behaviour Chrome sees. A client's own setting is answered and
// recorded, never forwarded, so neither its allow nor Chrome resetting the
// behaviour when it leaves reaches the browser; the download events it asked
// for come from the guard's session instead, and only for pages it holds.
// Browser contexts a client creates are denied on the guard's session before
// the client hears the new context's id. Context options that change where a
// context's traffic goes, or what it may reach, are refused.
//
// Internal clients (main's own connections: the guard, consent, the watcher)
// are never filtered. Unprotected profiles get no policy at all.
// ---------------------------------------------------------------------------

/**
 * Target.createBrowserContext options refused on a protected profile. Checked
 * against the protocol shipped with playwright-core 1.58 and Chrome 149, whose
 * other option is disposeOnDetach (allowed).
 */
const REFUSED_CONTEXT_OPTIONS = ['proxyServer', 'proxyBypassList', 'originsWithUniversalNetworkAccess'] as const;

const policyDenied = (what: string) => ({ code: -32000, message: `policy_denied: ${what} is not available on a protected browser profile` });

export interface ProtectedPipeDeps {
  /** Deny downloads in a browser context, with events on, on the download guard's session. */
  denyContext(browserContextId: string): Promise<unknown>;
  /** Close a browser context main could not deny downloads in, without the guard. */
  disposeContext(browserContextId: string): Promise<unknown>;
  /** Whether the client is still attached. */
  attached(client: ClientRef): boolean;
  /** Whether the client holds a session on the target (a page it attached to). */
  ownsTarget(client: ClientRef, targetId: string): boolean;
  /** Send the client a browser-level event on its root or on one of its sessions; false when that is gone. */
  emit(client: ClientRef, method: string, params: Record<string, unknown>, sessionId?: string): boolean;
}

/** A client, and the session it asked on (undefined: its root). */
interface Listener { readonly client: ClientRef; readonly sessionId: string | undefined }

export class ProtectedPipePolicy {
  /**
   * Who asked for download events with their own Browser.setDownloadBehavior:
   * by client, by the session it asked on, the contexts it asked for ('' for
   * the call that named none). Chrome keeps eventsEnabled per context, so
   * turning it off for one leaves the others.
   */
  private readonly listening = new Map<ClientRef, Map<string | undefined, Set<string>>>();
  /** Who was told a download began, by its guid, for the progress that follows. */
  private readonly told = new Map<string, Listener[]>();
  /** Denies of clients' new contexts not yet answered. */
  private readonly denying = new Set<Promise<unknown>>();

  constructor(private readonly deps: ProtectedPipeDeps) {}

  readonly filter: ClientCommandFilter = (client, command) => {
    if (client.kind !== 'external') return null;
    switch (command.method) {
      case 'Browser.setDownloadBehavior':
        this.listen(client, command.sessionId, command.params);
        return { absorb: {}, reason: 'download-behavior' };
      case 'Page.setDownloadBehavior':
        return { absorb: {}, reason: 'page-download-behavior' };
      case 'Browser.cancelDownload':
        return { absorb: {}, reason: 'cancel-download' };
      case 'Target.createBrowserContext':
        return REFUSED_CONTEXT_OPTIONS.some((option) => command.params[option] !== undefined)
          ? { refuse: policyDenied('this browser context option'), reason: 'context-options' }
          : null;
      default:
        return null;
    }
  };

  /**
   * A client's new browser context is denied downloads before the client hears
   * of it. A context list is held while such a deny is in flight, so no client
   * learns the new id from it first.
   */
  readonly beforeReply: BeforeReply = (client, method, result) => {
    if (client.kind !== 'external') return null;
    if (method === 'Target.getBrowserContexts') {
      return this.denying.size ? Promise.allSettled([...this.denying]).then(() => null) : null;
    }
    if (method !== 'Target.createBrowserContext') return null;
    const id = result.browserContextId;
    if (typeof id !== 'string') return Promise.resolve(policyDenied('a browser context without an id'));
    const deny = this.deps.denyContext(id);
    this.denying.add(deny);
    const done = () => { this.denying.delete(deny); };
    return deny.then(
      () => { done(); return null; },
      () => this.deps.disposeContext(id).catch(() => undefined).then(() => { done(); return policyDenied('a new browser context'); }),
    );
  };

  /**
   * A download event the guard's session saw. downloadWillBegin goes to each
   * client that asked for download events and holds the page it began in (its
   * frameId is that page's target id); one that began elsewhere goes to no one.
   * downloadProgress follows the clients told of its begin.
   */
  downloadEvent(method: string, params: Record<string, unknown>): void {
    const guid = typeof params.guid === 'string' ? params.guid : '';
    if (!guid) return;
    let to: Listener[];
    if (method === 'Browser.downloadWillBegin') {
      this.forgetGone();
      const frameId = params.frameId;
      to = typeof frameId === 'string'
        ? [...this.listening]
          .filter(([client]) => this.deps.ownsTarget(client, frameId))
          .flatMap(([client, sessions]) => [...sessions.keys()].map((sessionId) => ({ client, sessionId })))
        : [];
      if (to.length) this.told.set(guid, to);
    } else if (method === 'Browser.downloadProgress') {
      to = this.told.get(guid) ?? [];
      if (params.state === 'completed' || params.state === 'canceled') this.told.delete(guid);
    } else {
      return;
    }
    for (const { client, sessionId } of to) {
      if (!this.deps.emit(client, method, params, sessionId)) this.listening.get(client)?.delete(sessionId);
    }
  }

  private listen(client: ClientRef, sessionId: string | undefined, params: Record<string, unknown>): void {
    this.forgetGone();
    const context = typeof params.browserContextId === 'string' ? params.browserContextId : '';
    const sessions = this.listening.get(client) ?? new Map<string | undefined, Set<string>>();
    const contexts = sessions.get(sessionId) ?? new Set<string>();
    if (params.eventsEnabled === true) contexts.add(context);
    else contexts.delete(context);
    if (contexts.size) sessions.set(sessionId, contexts);
    else sessions.delete(sessionId);
    if (sessions.size) this.listening.set(client, sessions);
    else this.listening.delete(client);
  }

  /** Clients that have left are dropped, with what they asked for. */
  private forgetGone(): void {
    for (const client of this.listening.keys()) if (!this.deps.attached(client)) this.listening.delete(client);
  }
}
