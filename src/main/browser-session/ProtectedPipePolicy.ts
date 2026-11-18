import type { BeforeReply, ClientCommandFilter, ClientRef, ReplyError } from './CdpPipeMux';

// ---------------------------------------------------------------------------
// A protected profile's rules for the clients of its debugging pipe (C2b).
// Downloads belong to main: only its download guard and the consent pass set
// the download behaviour Chrome sees. A client's own setting is answered and
// recorded, never forwarded, so neither its allow nor Chrome resetting the
// behaviour when it leaves reaches the browser; the download events it asked
// for come from the guard's session instead, and only for pages it holds in
// the contexts it asked for.
// Browser contexts a client creates are denied on the guard's session before
// the client hears the new context's id. Context options that change where a
// context's traffic goes, or what it may reach, are refused, and so is
// choosing a Bluetooth or USB device for a page's request.
// A client opens and navigates pages only to the URLs protectedUrlAllowed
// takes: Target.createTarget, Page.navigate, and a history entry it was shown.
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

/**
 * The pages an outside client of a protected profile may open, navigate to,
 * see and drive: http:, https:, data:, blob: of an http(s) origin, and
 * about:blank (a target with no URL yet counts as blank). Read the way Chrome
 * reads a typed URL: surrounding whitespace dropped, the scheme in any case
 * (`CHROME://x`, `chrome:x`), and a view-source: wrapper refused whatever it
 * wraps. Anything that doesn't parse is refused.
 */
export function protectedUrlAllowed(url: string): boolean {
  const text = url.trim();
  if (text === '') return true;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  switch (parsed.protocol) {
    case 'http:':
    case 'https:':
    case 'data:':
      return true;
    case 'about:':
      return parsed.pathname === 'blank';
    case 'blob:': {
      try {
        const inner = new URL(parsed.pathname);
        return inner.protocol === 'http:' || inner.protocol === 'https:';
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

/** History entries remembered per client for Page.navigateToHistoryEntry. */
const HISTORY_ENTRIES_KEPT = 500;

/** The refusal for a URL `protectedUrlAllowed` refuses. */
export const SCHEME_NOT_ALLOWED = { code: -32000, message: 'policy_denied: scheme not allowed on a protected profile' } as const;

const policyDenied = (what: string) => ({ code: -32000, message: `policy_denied: ${what} is not available on a protected browser profile` });

export interface ProtectedPipeDeps {
  /** Deny downloads in a browser context, with events on, on the download guard's session. */
  denyContext(browserContextId: string): Promise<unknown>;
  /** Close a browser context main could not deny downloads in, without the guard. */
  disposeContext(browserContextId: string): Promise<unknown>;
  /**
   * The browser context of a frame the client holds (a page it has a session
   * to, or a frame Chrome reported on that page's session), as Chrome named it;
   * null when it holds the frame but no context was named, undefined when it
   * doesn't hold it.
   */
  contextOf(client: ClientRef, frameId: string): string | null | undefined;
  /** Send the client a browser-level event on its root or on one of its sessions; false when that is gone. */
  emit(client: ClientRef, method: string, params: Record<string, unknown>, sessionId?: string): boolean;
}

/** A client, and the session it asked on (undefined: its root). */
interface Listener { readonly client: ClientRef; readonly sessionId: string | undefined }

/** The key for the default browser context: Browser.setDownloadBehavior without a browserContextId. */
const DEFAULT_CONTEXT = '';

export class ProtectedPipePolicy {
  /**
   * Who asked for download events with their own Browser.setDownloadBehavior:
   * by client, by the session it asked on, the contexts it asked for
   * (DEFAULT_CONTEXT for the call that named none). Chrome keeps eventsEnabled
   * per context, so turning it off for one leaves the others.
   */
  private readonly listening = new Map<ClientRef, Map<string | undefined, Set<string>>>();
  /** Who was told a download began, by its guid, for the progress that follows. */
  private readonly told = new Map<string, Listener[]>();
  /** Every browser context created over the pipe; a page in any other is in the default context. */
  private readonly created = new Set<string>();
  /** New contexts' deny (and, when it fails, close) not yet settled. */
  private readonly denying = new Set<Promise<unknown>>();
  /** Contexts that could be neither denied nor closed; denied again before any list names them. */
  private readonly unguarded = new Set<string>();
  /** The history entries each client was shown (Page.getNavigationHistory), by id: their URLs. */
  private readonly history = new Map<ClientRef, Map<number, string>>();
  private warned = false;

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
      case 'DeviceAccess.selectPrompt':
        return { refuse: policyDenied('choosing a device for a page'), reason: 'device-access' };
      case 'Target.createBrowserContext':
        return REFUSED_CONTEXT_OPTIONS.some((option) => command.params[option] !== undefined)
          ? { refuse: policyDenied('this browser context option'), reason: 'context-options' }
          : null;
      case 'Target.createTarget': {
        // No URL opens about:blank.
        const url = command.params.url ?? '';
        return typeof url === 'string' && protectedUrlAllowed(url) ? null : { refuse: SCHEME_NOT_ALLOWED, reason: 'scheme-not-allowed' };
      }
      case 'Page.navigate': {
        const url = command.params.url;
        return typeof url === 'string' && protectedUrlAllowed(url) ? null : { refuse: SCHEME_NOT_ALLOWED, reason: 'scheme-not-allowed' };
      }
      case 'Page.navigateToHistoryEntry': {
        // Only an entry this client was shown, at a URL it may open.
        const id = command.params.entryId;
        const url = typeof id === 'number' ? this.history.get(client)?.get(id) : undefined;
        return url !== undefined && protectedUrlAllowed(url) ? null : { refuse: SCHEME_NOT_ALLOWED, reason: 'scheme-not-allowed' };
      }
      default:
        return null;
    }
  };

  /**
   * A client's new browser context is denied downloads before the client hears
   * of it. A context list is held while such a deny (or the close that follows
   * a failed one) is in flight, and until any context that could be neither
   * denied nor closed is denied.
   */
  readonly beforeReply: BeforeReply = (client, method, result) => {
    if (method === 'Target.createBrowserContext' && typeof result.browserContextId === 'string') this.created.add(result.browserContextId);
    if (client.kind !== 'external') return null;
    if (method === 'Page.getNavigationHistory') {
      this.learnHistory(client, result);
      return null;
    }
    if (method === 'Target.getBrowserContexts') {
      return this.denying.size || this.unguarded.size ? this.listHeld(result) : null;
    }
    if (method !== 'Target.createBrowserContext') return null;
    const id = result.browserContextId;
    if (typeof id !== 'string') return Promise.resolve(policyDenied('a browser context without an id'));
    const settled = this.deps.denyContext(id).then(
      () => null,
      () => this.deps.disposeContext(id).then(
        () => policyDenied('a new browser context'),
        () => {
          this.unguarded.add(id);
          if (!this.warned) {
            this.warned = true;
            console.warn('[ProtectedPipePolicy] a new browser context could be neither denied downloads nor closed; it is denied again before it is listed');
          }
          return { ...policyDenied('a new browser context'), reason: 'context-unguarded' };
        },
      ),
    );
    this.denying.add(settled);
    void settled.then(() => this.denying.delete(settled));
    return settled;
  };

  /**
   * A download event the guard's session saw. downloadWillBegin goes to each
   * client session that asked for download events in the context of the frame
   * the download began in, and holds that frame: the page itself, or a frame
   * in its process that Chrome reported on the client's own page session. One
   * that began elsewhere goes to no one. downloadProgress follows the sessions
   * told of its begin.
   */
  downloadEvent(method: string, params: Record<string, unknown>): void {
    const guid = typeof params.guid === 'string' ? params.guid : '';
    if (!guid) return;
    let to: Listener[];
    if (method === 'Browser.downloadWillBegin') {
      const frameId = params.frameId;
      to = typeof frameId === 'string' ? this.listenersFor(frameId) : [];
      if (to.length) this.told.set(guid, to);
    } else if (method === 'Browser.downloadProgress') {
      to = this.told.get(guid) ?? [];
      if (params.state === 'completed' || params.state === 'canceled') this.told.delete(guid);
    } else {
      return;
    }
    for (const { client, sessionId } of to) {
      if (!this.deps.emit(client, method, params, sessionId)) this.stopListening(client, sessionId);
    }
  }

  /** A client left: what it asked for and what it was told go with it. */
  forget(client: ClientRef): void {
    this.listening.delete(client);
    this.history.delete(client);
    for (const [guid, listeners] of this.told) {
      const kept = listeners.filter((l) => l.client !== client);
      if (kept.length) this.told.set(guid, kept);
      else this.told.delete(guid);
    }
  }

  /** The entries of a history `client` was shown, kept for its later navigateToHistoryEntry. */
  private learnHistory(client: ClientRef, result: Record<string, unknown>): void {
    if (!Array.isArray(result.entries)) return;
    const known = this.history.get(client) ?? new Map<number, string>();
    for (const entry of result.entries as Array<{ id?: unknown; url?: unknown }>) {
      if (typeof entry?.id !== 'number' || typeof entry.url !== 'string') continue;
      known.delete(entry.id);
      known.set(entry.id, entry.url);
    }
    // The newest entries are kept; an id older than these is refused like an unknown one.
    for (const id of known.keys()) {
      if (known.size <= HISTORY_ENTRIES_KEPT) break;
      known.delete(id);
    }
    if (known.size) this.history.set(client, known);
  }

  private listenersFor(frameId: string): Listener[] {
    return [...this.listening].flatMap(([client, sessions]) => {
      const context = this.deps.contextOf(client, frameId);
      if (context === undefined) return [];
      // A held frame whose context no attach event named counts as the default context.
      const key = context !== null && this.created.has(context) ? context : DEFAULT_CONTEXT;
      return [...sessions].filter(([, contexts]) => contexts.has(key)).map(([sessionId]) => ({ client, sessionId }));
    });
  }

  private async listHeld(result: Record<string, unknown>): Promise<ReplyError | null> {
    await Promise.allSettled([...this.denying]);
    const listed = Array.isArray(result.browserContextIds) ? result.browserContextIds : [];
    for (const id of [...this.unguarded]) {
      // Not listed: it is gone.
      if (!listed.includes(id)) { this.unguarded.delete(id); continue; }
      try {
        await this.deps.denyContext(id);
        this.unguarded.delete(id);
      } catch {
        return { ...policyDenied('the browser context list'), reason: 'context-unguarded' };
      }
    }
    return null;
  }

  private listen(client: ClientRef, sessionId: string | undefined, params: Record<string, unknown>): void {
    const context = typeof params.browserContextId === 'string' ? params.browserContextId : DEFAULT_CONTEXT;
    const sessions = this.listening.get(client) ?? new Map<string | undefined, Set<string>>();
    const contexts = sessions.get(sessionId) ?? new Set<string>();
    if (params.eventsEnabled === true) contexts.add(context);
    else contexts.delete(context);
    if (contexts.size) sessions.set(sessionId, contexts);
    else sessions.delete(sessionId);
    if (sessions.size) this.listening.set(client, sessions);
    else this.listening.delete(client);
  }

  private stopListening(client: ClientRef, sessionId: string | undefined): void {
    const sessions = this.listening.get(client);
    if (!sessions) return;
    sessions.delete(sessionId);
    if (!sessions.size) this.listening.delete(client);
  }
}
