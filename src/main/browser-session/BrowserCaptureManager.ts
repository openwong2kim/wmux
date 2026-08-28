import { webContents } from 'electron';

// ---------------------------------------------------------------------------
// Main-process CDP event capture for MCP browser_console / browser_network /
// browser_response_body (issue #106).
//
// In packaged builds connectOverCDP does not surface the <webview> guest as a
// Playwright Page, so the MCP tools' page.on('console'|'request'|'response')
// listeners never attach. This captures the same data in the main process by
// listening to the guest webContents' CDP debugger (the same wc.debugger that
// WebviewCdpManager attaches and that browser.screenshot / browser.evaluate
// already drive via sendCommand). The MCP tools drain it over RPC.
//
// Capture is LAZY: domains are enabled and the listener attached on the first
// ensure() call (driven by the first browser_console/network/response_body call
// in packaged mode), matching the dev tools' "listener attaches on first call"
// semantics. Nothing is captured before that first call.
// ---------------------------------------------------------------------------

export interface ConsoleEntry {
  level: string;
  text: string;
}

export interface NetworkEntry {
  url: string;
  method: string;
  status?: number;
  response?: {
    headers: Record<string, string>;
    body?: string;
  };
}

// Bounds. Mirror the MCP-side caps in inspection.ts (different bundle, so the
// values are duplicated rather than imported) and add a total-body budget so a
// chatty page cannot pin hundreds of MB (1000 entries * 256KB would be ~256MB).
const MAX_CAPTURE_ENTRIES = 1000;
const MAX_RESPONSE_BODY_BYTES = 256 * 1024;
const MAX_TOTAL_BODY_BYTES = 4 * 1024 * 1024;

// CDP RemoteObject (subset we read for console formatting).
interface RemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  description?: string;
  unserializableValue?: string;
}

// Internal per-request record. Extends the wire NetworkEntry with the requestId
// correlation key, the captured mime type, and the retained-body byte count.
interface NetEntry extends NetworkEntry {
  requestId: string;
  mimeType?: string;
  bodyBytes?: number;
}

// Browser lifecycle events surfaced inline in MCP tool results (act→verify
// loop compression): main-frame navigations, load completion, guest closure.
export interface LifecycleEntry {
  type: 'navigated' | 'loaded' | 'closed';
  url?: string;
  ts: number;
}

// Lifecycle ring bound: these are drained on nearly every browser_* tool call,
// so a small cap suffices — anything older than 20 events is stale context.
const MAX_LIFECYCLE_ENTRIES = 20;
// Closure records for already-dropped guests, kept so a `closed` event can
// still be drained once after the per-webContents state is gone.
const MAX_PENDING_CLOSURES = 8;

interface CaptureState {
  dbg: Electron.Debugger;
  onMessage: (event: Electron.Event, method: string, params: unknown, sessionId?: string) => void;
  onDetach: () => void;
  console: ConsoleEntry[];
  network: NetEntry[];
  byRequestId: Map<string, NetEntry>;
  lifecycle: LifecycleEntry[];
  totalBodyBytes: number;
  enabled: boolean;
}

/** CDP consoleAPICalled `type` -> the level vocabulary the MCP tool filters on. */
function mapConsoleLevel(cdpType: string | undefined): string {
  // The tool filters: error->'error', warn->'warn', info->'log'|'info'. CDP
  // emits 'warning' (not 'warn'), so remap; everything else passes through.
  if (cdpType === 'warning') return 'warn';
  return cdpType ?? 'log';
}

/** Format one CDP RemoteObject to a readable string (Playwright gives us a
 *  pre-rendered msg.text(); CDP gives args: RemoteObject[], so we render). */
function formatRemoteObject(o: RemoteObject | undefined): string {
  if (!o) return '';
  if (o.type === 'undefined') return 'undefined';
  if (o.type === 'string') return typeof o.value === 'string' ? o.value : (o.description ?? '');
  if (o.value !== undefined && o.value !== null) return String(o.value);
  if (o.unserializableValue !== undefined) return o.unserializableValue; // NaN, Infinity, bigint, -0
  if (o.description !== undefined) return o.description; // objects: "Object", "Array(3)", Error stacks
  if (o.value === null) return 'null';
  return o.type ?? '';
}

function lowerHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [k, v] of Object.entries(headers)) out[k.toLowerCase()] = v;
  return out;
}

/** Simple glob match ('*' = any run of chars), mirroring inspection.ts. */
function matchesGlob(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp('^' + escaped.replace(/\*/g, '.*') + '$', 'i');
  return regex.test(url);
}

function isTextualContentType(contentType: string | undefined): boolean {
  const ct = contentType ?? '';
  return (
    ct.startsWith('text/') ||
    ct.includes('application/json') ||
    ct.includes('application/xml') ||
    ct.includes('application/xhtml') ||
    ct.includes('+json') ||
    ct.includes('+xml')
  );
}

export class BrowserCaptureManager {
  private states = new Map<number, CaptureState>();
  // Singleflight: concurrent first calls share one enable Promise so the
  // listener is never attached twice (which would double-buffer every event).
  private ensuring = new Map<number, Promise<CaptureState | null>>();
  // Lifecycle entries that must outlive their CaptureState: drop({closed:true})
  // moves undrained events plus a synthesized `closed` record here, keyed by
  // the departed webContentsId, so the next drain can still report the close.
  private pendingClosures = new Map<number, LifecycleEntry[]>();

  /**
   * Ensure capture is active for a guest webContents, enabling the CDP domains
   * and attaching the message listener on first call. Returns null if the
   * webContents is gone or the domains cannot be enabled.
   */
  async ensure(webContentsId: number): Promise<CaptureState | null> {
    const existing = this.states.get(webContentsId);
    if (existing && existing.enabled) return existing;

    const inflight = this.ensuring.get(webContentsId);
    if (inflight) return inflight;

    const p = this.enable(webContentsId).finally(() => {
      this.ensuring.delete(webContentsId);
    });
    this.ensuring.set(webContentsId, p);
    return p;
  }

  private async enable(webContentsId: number): Promise<CaptureState | null> {
    const wc = webContents.fromId(webContentsId);
    if (!wc || wc.isDestroyed()) return null;

    const dbg = wc.debugger;
    if (!dbg.isAttached()) {
      // WebviewCdpManager normally attaches on register; attach defensively in
      // case capture is the first consumer.
      try {
        dbg.attach('1.3');
      } catch (err) {
        if (!String(err).includes('Already attached')) {
          console.error('[BrowserCaptureManager] debugger.attach failed:', err);
          return null;
        }
      }
    }

    const state: CaptureState = {
      dbg,
      onMessage: () => { /* set below */ },
      onDetach: () => { /* set below */ },
      console: [],
      network: [],
      byRequestId: new Map(),
      lifecycle: [],
      totalBodyBytes: 0,
      enabled: false,
    };

    // Attach the listener and register state BEFORE enabling domains: CDP can
    // emit events during/just after enable, before sendCommand resolves.
    state.onMessage = (_event, method, params) => {
      this.handleEvent(state, method, params as Record<string, unknown>);
    };
    // Opening webview DevTools terminates the debugger session (Electron allows
    // one client). Drop capture so the next call re-attaches + re-enables.
    state.onDetach = () => this.drop(webContentsId);

    dbg.on('message', state.onMessage);
    dbg.on('detach', state.onDetach);
    this.states.set(webContentsId, state);

    try {
      await dbg.sendCommand('Runtime.enable');
      await dbg.sendCommand('Network.enable', {
        maxResourceBufferSize: MAX_RESPONSE_BODY_BYTES,
        maxTotalBufferSize: MAX_TOTAL_BODY_BYTES,
      });
      await dbg.sendCommand('Page.enable');
    } catch (err) {
      console.error('[BrowserCaptureManager] domain enable failed:', err);
      this.drop(webContentsId);
      return null;
    }

    state.enabled = true;
    wc.once('destroyed', () => this.drop(webContentsId, { closed: true }));
    return state;
  }

  private handleEvent(state: CaptureState, method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = Array.isArray(params.args) ? (params.args as RemoteObject[]) : [];
        const text = args.map(formatRemoteObject).join(' ');
        this.pushConsole(state, { level: mapConsoleLevel(params.type as string), text });
        break;
      }
      case 'Network.requestWillBeSent': {
        const requestId = String(params.requestId ?? '');
        const request = (params.request ?? {}) as { url?: string; method?: string };
        // A redirect arrives as a new requestWillBeSent carrying the previous
        // hop's redirectResponse; record that hop's status before reusing the id.
        const redirect = params.redirectResponse as { status?: number; headers?: Record<string, string> } | undefined;
        const prev = state.byRequestId.get(requestId);
        if (redirect && prev && prev.status === undefined) {
          prev.status = redirect.status;
          prev.response = { headers: lowerHeaders(redirect.headers) };
        }
        const entry: NetEntry = {
          requestId,
          url: request.url ?? '',
          method: request.method ?? 'GET',
        };
        this.pushNetwork(state, entry);
        break;
      }
      case 'Network.responseReceived': {
        const requestId = String(params.requestId ?? '');
        const entry = state.byRequestId.get(requestId);
        if (!entry) break;
        const response = (params.response ?? {}) as {
          status?: number;
          headers?: Record<string, string>;
          mimeType?: string;
        };
        entry.status = response.status;
        entry.mimeType = response.mimeType;
        entry.response = { headers: lowerHeaders(response.headers) };
        break;
      }
      case 'Network.loadingFinished': {
        const requestId = String(params.requestId ?? '');
        const entry = state.byRequestId.get(requestId);
        if (!entry) break;
        const ct = entry.response?.headers['content-type'] ?? entry.mimeType;
        if (isTextualContentType(ct)) {
          void this.fetchBody(state, entry);
        }
        break;
      }
      case 'Page.frameNavigated': {
        // Main frame only — subframe churn (ads, embeds) is noise here.
        const frame = (params.frame ?? {}) as { parentId?: string; url?: string };
        if (frame.parentId !== undefined) break;
        const url = frame.url ?? '';
        // Collapse consecutive same-URL navigations (SPA replaceState churn,
        // redirect hops that settle on the same URL).
        const last = state.lifecycle[state.lifecycle.length - 1];
        if (last?.type === 'navigated' && last.url === url) break;
        this.pushLifecycle(state, { type: 'navigated', url, ts: Date.now() });
        break;
      }
      case 'Page.loadEventFired': {
        this.pushLifecycle(state, { type: 'loaded', ts: Date.now() });
        break;
      }
      default:
        break;
    }
  }

  private async fetchBody(state: CaptureState, entry: NetEntry): Promise<void> {
    try {
      const result = (await state.dbg.sendCommand('Network.getResponseBody', {
        requestId: entry.requestId,
      })) as { body: string; base64Encoded: boolean };

      let body = result.base64Encoded
        ? Buffer.from(result.body, 'base64').toString('utf8')
        : result.body;

      // Truncate by UTF-8 BYTES (not string length) so a multibyte body cannot
      // exceed the byte budget the constant names.
      const byteLen = Buffer.byteLength(body, 'utf8');
      if (byteLen > MAX_RESPONSE_BODY_BYTES) {
        body =
          Buffer.from(body, 'utf8').subarray(0, MAX_RESPONSE_BODY_BYTES).toString('utf8') +
          `\n... [truncated ${byteLen - MAX_RESPONSE_BODY_BYTES} bytes]`;
      }

      // The entry may have been evicted, or its requestId reused by a redirect
      // hop, while getResponseBody was in flight — only attach if it is still
      // the tracked entry (identity, not just requestId presence).
      if (state.byRequestId.get(entry.requestId) !== entry) return;

      if (!entry.response) entry.response = { headers: {} };
      entry.response.body = body;
      entry.bodyBytes = Buffer.byteLength(body, 'utf8');
      state.totalBodyBytes += entry.bodyBytes;
      this.evictBodies(state);
    } catch {
      // getResponseBody rejects for cached/evicted/failed/redirected/navigated
      // requests or a detached debugger — leave a body-less but valid entry.
    }
  }

  /** Drop the oldest retained bodies (keeping their metadata) until under budget. */
  private evictBodies(state: CaptureState): void {
    if (state.totalBodyBytes <= MAX_TOTAL_BODY_BYTES) return;
    for (const e of state.network) {
      if (state.totalBodyBytes <= MAX_TOTAL_BODY_BYTES) break;
      if (e.response?.body !== undefined) {
        state.totalBodyBytes -= e.bodyBytes ?? 0;
        e.bodyBytes = undefined;
        e.response.body = undefined;
      }
    }
  }

  private pushConsole(state: CaptureState, entry: ConsoleEntry): void {
    state.console.push(entry);
    if (state.console.length > MAX_CAPTURE_ENTRIES) {
      state.console.splice(0, state.console.length - MAX_CAPTURE_ENTRIES);
    }
  }

  private pushLifecycle(state: CaptureState, entry: LifecycleEntry): void {
    state.lifecycle.push(entry);
    if (state.lifecycle.length > MAX_LIFECYCLE_ENTRIES) {
      state.lifecycle.splice(0, state.lifecycle.length - MAX_LIFECYCLE_ENTRIES);
    }
  }

  private pushNetwork(state: CaptureState, entry: NetEntry): void {
    state.network.push(entry);
    state.byRequestId.set(entry.requestId, entry);
    while (state.network.length > MAX_CAPTURE_ENTRIES) {
      const old = state.network.shift();
      if (!old) break;
      // Redirect hops share a requestId: only drop the index entry if it still
      // points at the evicted object, so an older hop never deletes the mapping
      // for a newer hop that is still in the ring.
      if (state.byRequestId.get(old.requestId) === old) {
        state.byRequestId.delete(old.requestId);
      }
      if (old.response?.body !== undefined) {
        state.totalBodyBytes -= old.bodyBytes ?? 0;
      }
    }
  }

  // --- Drain API (called by the browser.*.get RPC handlers) ---

  getConsole(webContentsId: number): ConsoleEntry[] {
    return this.states.get(webContentsId)?.console ?? [];
  }

  clearConsole(webContentsId: number): void {
    const state = this.states.get(webContentsId);
    if (state) state.console = [];
  }

  /**
   * Network entries as lightweight summaries (url, method, status) — no bodies,
   * matching browser_network's output and keeping the RPC payload small. Bodies
   * are retrieved separately via getResponseBody.
   */
  getNetwork(webContentsId: number): Array<{ url: string; method: string; status?: number }> {
    const state = this.states.get(webContentsId);
    if (!state) return [];
    return state.network.map((e) => ({
      url: e.url,
      method: e.method,
      ...(e.status !== undefined && { status: e.status }),
    }));
  }

  /**
   * Last captured response body whose URL matches the glob and that actually
   * has a retained body. Returns null when nothing matches (or the body was
   * evicted / never textual). Mirrors browser_response_body's selection.
   */
  getResponseBody(webContentsId: number, urlPattern: string): string | null {
    const state = this.states.get(webContentsId);
    if (!state) return null;
    for (let i = state.network.length - 1; i >= 0; i--) {
      const e = state.network[i];
      if (matchesGlob(e.url, urlPattern) && e.response?.body !== undefined) {
        return e.response.body;
      }
    }
    return null;
  }

  clearNetwork(webContentsId: number): void {
    const state = this.states.get(webContentsId);
    if (!state) return;
    state.network = [];
    state.byRequestId.clear();
    state.totalBodyBytes = 0;
  }

  /**
   * Drain lifecycle events, destructively: each event is reported to exactly
   * one consumer (the browser.console.get clear semantics, but in one call —
   * lifecycle is inlined into every tool result, so a non-destructive read
   * would repeat the same events forever). Falls back to pending closure
   * records when the guest's state is already gone.
   */
  drainLifecycle(webContentsId: number): LifecycleEntry[] {
    const state = this.states.get(webContentsId);
    if (state) {
      const entries = state.lifecycle;
      state.lifecycle = [];
      return entries;
    }
    const pending = this.pendingClosures.get(webContentsId);
    if (pending) {
      this.pendingClosures.delete(webContentsId);
      return pending;
    }
    return [];
  }

  /**
   * Stop capturing for a webContents and remove all listeners.
   * `closed: true` marks a real guest departure (destroyed / unregistered):
   * undrained lifecycle events plus a synthesized `closed` record survive in
   * pendingClosures. A plain drop (DevTools stealing the debugger, enable
   * failure) must NOT report a close — the guest is still there.
   */
  drop(webContentsId: number, opts?: { closed?: boolean }): void {
    const state = this.states.get(webContentsId);
    if (!state) return;
    try {
      // detach() does NOT remove EventEmitter listeners — remove them explicitly.
      state.dbg.removeListener('message', state.onMessage);
      state.dbg.removeListener('detach', state.onDetach);
    } catch {
      // debugger already gone
    }
    this.states.delete(webContentsId);
    if (opts?.closed) {
      this.pendingClosures.set(webContentsId, [
        ...state.lifecycle,
        { type: 'closed', ts: Date.now() },
      ]);
      // Bound the map: evict the oldest closure record (insertion order).
      while (this.pendingClosures.size > MAX_PENDING_CLOSURES) {
        const oldest = this.pendingClosures.keys().next().value;
        if (oldest === undefined) break;
        this.pendingClosures.delete(oldest);
      }
    }
  }

  dropAll(): void {
    for (const id of [...this.states.keys()]) this.drop(id);
  }
}
