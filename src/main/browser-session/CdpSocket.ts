// ---------------------------------------------------------------------------
// A minimal CDP client over one WebSocket, extracted from LiveChromeClient so
// the dedicated 'chrome' backend can share it (ChromeLauncher's tab-target
// watcher). Deliberately tiny: this is not a CDP library, it is the request/
// reply + event plumbing two call sites needed twice.
//
// Two things the extraction adds over the original inline client:
//   • Events. The old message handler dropped every frame without an `id`
//     ("event, not a reply"), which made CDP subscriptions impossible. Frames
//     with a `method` are now dispatched to on() handlers.
//   • Flattened sessions. `sessionId` rides as a TOP-LEVEL frame field on the
//     way out (CDP flatten mode) and is handed back to event handlers on the
//     way in, so one socket can drive the browser session and any number of
//     attached target sessions.
//
// The endpoint is resolved lazily on every call: Chrome mints a new secret
// browser path each boot, so a stale socket is dropped and re-dialed rather
// than kept.
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 10_000;

/** CDP event handler. `sessionId` is the session the event arrived on
 *  (undefined = the browser session). */
export type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

export interface CdpSocketOptions {
  /** Prefix on every error this socket raises ("<label>: <detail>"). */
  label?: string;
  /** Error text when the socket cannot be opened. Callers with a better
   *  remedy to offer (LiveChromeClient's chrome://inspect hint) pass it here. */
  connectError?: string;
  /** Per-request timeout, also the connect timeout. */
  timeoutMs?: number;
}

interface CdpFrame {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export class CdpSocket {
  private ws: WebSocket | null = null;
  private wsEndpoint: string | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private readonly label: string;
  private readonly connectError: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly resolveEndpoint: () => string,
    opts?: CdpSocketOptions,
  ) {
    this.label = opts?.label ?? 'CdpSocket';
    this.connectError = opts?.connectError ?? `${this.label}: could not connect`;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Subscribe to a CDP event. Returns an unsubscribe function. */
  on(method: string, handler: CdpEventHandler): () => void {
    const set = this.handlers.get(method) ?? new Set<CdpEventHandler>();
    set.add(handler);
    this.handlers.set(method, set);
    return () => {
      const current = this.handlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.handlers.delete(method);
    };
  }

  /** Send a CDP command. `sessionId` targets an attached session (flatten). */
  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    const ws = await this.ensureSocket();
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${this.label}: ${method} timed out`));
      }, this.timeoutMs);
      (t as { unref?: () => void }).unref?.();
    });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId !== undefined && { sessionId }) }));
    return result;
  }

  /** Close the socket and reject everything in flight. Handlers survive, so a
   *  later send() re-dials and the subscriptions still apply. */
  close(): void {
    this.detach(`${this.label}: disposed`, true);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private detach(reason: string, closeSocket: boolean): void {
    const ws = this.ws;
    this.ws = null;
    this.wsEndpoint = null;
    if (this.pending.size > 0) {
      const waiters = [...this.pending.values()];
      this.pending.clear();
      for (const p of waiters) p.reject(new Error(reason));
    }
    if (!closeSocket || !ws) return;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
  }

  private async ensureSocket(): Promise<WebSocket> {
    const endpoint = this.resolveEndpoint();
    // Chrome restarts mint a new secret path — a stale socket is replaced.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsEndpoint === endpoint) {
      return this.ws;
    }
    this.detach(`${this.label}: disposed`, true);
    const ws = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(this.connectError)), this.timeoutMs);
      (t as { unref?: () => void }).unref?.();
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error(this.connectError)); }, { once: true });
    });
    ws.addEventListener('message', (ev: MessageEvent) => this.onMessage(ev));
    ws.addEventListener('close', () => {
      // Reject in-flight calls; the next send() re-resolves the endpoint.
      if (this.ws === ws) this.detach(`${this.label}: connection closed`, false);
    });
    this.ws = ws;
    this.wsEndpoint = endpoint;
    return ws;
  }

  private onMessage(ev: MessageEvent): void {
    let msg: CdpFrame;
    try {
      msg = JSON.parse(String(ev.data)) as CdpFrame;
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${this.label}: ${msg.error.message ?? 'CDP error'}`));
      else waiter.resolve(msg.result);
      return;
    }
    // No id → a CDP event. Dispatch instead of dropping it on the floor.
    if (typeof msg.method !== 'string') return;
    const handlers = this.handlers.get(msg.method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(msg.params ?? {}, msg.sessionId);
      } catch (err) {
        // One bad subscriber must not take down the socket's read loop.
        console.warn(`[${this.label}] ${msg.method} handler threw:`, err);
      }
    }
  }
}
