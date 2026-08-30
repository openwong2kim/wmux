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

/** A handshake still open this long is worth telling someone about. */
const DEFAULT_CONNECT_NOTICE_MS = 5_000;

/** CDP event handler. `sessionId` is the session the event arrived on
 *  (undefined = the browser session). */
export type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

/** Why a dial failed. `timeout` means the handshake never completed inside the
 *  budget — on the live endpoint that usually means a permission prompt nobody
 *  has answered yet, which needs a different remedy from a refused socket. */
export type CdpConnectFailure = 'timeout' | 'error';

export interface CdpSocketOptions {
  /** Prefix on every error this socket raises ("<label>: <detail>"). */
  label?: string;
  /** Error text when the socket cannot be opened. Callers with a better
   *  remedy to offer (LiveChromeClient's chrome://inspect hint) pass it here. */
  connectError?: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  /**
   * Budget for the WebSocket handshake, when it differs from the per-request
   * timeout. These used to be one number, which is wrong for any endpoint that
   * asks a human before accepting: the live Chrome endpoint holds the handshake
   * open while Chrome shows its permission prompt, so a 10 s request timeout
   * gave up before the user could reach the Allow button — a connection that
   * could not succeed however fast they clicked. Defaults to `timeoutMs`.
   */
  connectTimeoutMs?: number;
  /**
   * Fires once per dial if the handshake is still open after
   * `connectNoticeAfterMs` — the only hook that can say "we are waiting on you"
   * while the caller is still blocked inside the dial.
   */
  onConnectPending?: (elapsedMs: number) => void;
  /** How long a handshake may run before onConnectPending fires. */
  connectNoticeAfterMs?: number;
  /**
   * Turns a dial failure into the message the caller sees. Async, so the
   * implementation can probe (is the port even listening?) before deciding.
   * Omitted, or throwing, falls back to `connectError` — every existing caller
   * keeps its current behaviour.
   */
  connectErrorFor?: (reason: CdpConnectFailure, endpoint: string) => Promise<string> | string;
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
  /** Dial in flight, shared by every concurrent send (singleflight). */
  private connecting: Promise<WebSocket> | null = null;
  private connectingEndpoint: string | null = null;
  /** Bumped by every detach, so a dial that finishes after a close/re-dial
   *  can tell it has been superseded instead of resurrecting the socket. */
  private epoch = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private readonly label: string;
  private readonly connectError: string;
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly connectNoticeAfterMs: number;
  private readonly onConnectPending?: (elapsedMs: number) => void;
  private readonly connectErrorFor?: (reason: CdpConnectFailure, endpoint: string) => Promise<string> | string;

  constructor(
    private readonly resolveEndpoint: () => string,
    opts?: CdpSocketOptions,
  ) {
    this.label = opts?.label ?? 'CdpSocket';
    this.connectError = opts?.connectError ?? `${this.label}: could not connect`;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.connectTimeoutMs = opts?.connectTimeoutMs ?? this.timeoutMs;
    this.connectNoticeAfterMs = opts?.connectNoticeAfterMs ?? DEFAULT_CONNECT_NOTICE_MS;
    this.onConnectPending = opts?.onConnectPending;
    this.connectErrorFor = opts?.connectErrorFor;
  }

  /** The message for a failed dial. Never throws: a diagnosis that itself
   *  fails must not replace the caller's real failure with its own. */
  private async describeConnectFailure(reason: CdpConnectFailure, endpoint: string): Promise<string> {
    if (!this.connectErrorFor) return this.connectError;
    try {
      return (await this.connectErrorFor(reason, endpoint)) || this.connectError;
    } catch {
      return this.connectError;
    }
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
    // Any dial still in flight belongs to the contract being torn down here.
    this.epoch++;
    this.connecting = null;
    this.connectingEndpoint = null;
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

  private ensureSocket(): Promise<WebSocket> {
    const endpoint = this.resolveEndpoint();
    // Chrome restarts mint a new secret path — a stale socket is replaced.
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.wsEndpoint === endpoint) {
      return Promise.resolve(this.ws);
    }
    // Singleflight. Two concurrent sends over a dead socket used to open two
    // WebSockets: one leaked, and every event reached the handlers twice.
    if (this.connecting && this.connectingEndpoint === endpoint) return this.connecting;
    this.detach(`${this.label}: disposed`, true);
    const dial: Promise<WebSocket> = this.dial(endpoint).finally(() => {
      if (this.connecting !== dial) return;
      this.connecting = null;
      this.connectingEndpoint = null;
    });
    this.connecting = dial;
    this.connectingEndpoint = endpoint;
    return dial;
  }

  private async dial(endpoint: string): Promise<WebSocket> {
    const epoch = this.epoch;
    const ws = new WebSocket(endpoint);
    const startedAt = Date.now();
    // Timeout and socket error are kept apart all the way out. Collapsing them
    // into one string was the reason a caller could not tell "nobody has
    // approved this yet" from "the port is dead" — the two failures with the
    // least in common and the most different remedies.
    const reason = await new Promise<CdpConnectFailure | null>((resolve) => {
      const timer = setTimeout(() => { clearTimeout(notice); resolve('timeout'); }, this.connectTimeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const notice = setTimeout(() => {
        try {
          this.onConnectPending?.(Date.now() - startedAt);
        } catch {
          /* a notice must never fail the dial */
        }
      }, this.connectNoticeAfterMs);
      (notice as { unref?: () => void }).unref?.();
      const settle = (value: CdpConnectFailure | null) => {
        clearTimeout(timer);
        clearTimeout(notice);
        resolve(value);
      };
      ws.addEventListener('open', () => settle(null), { once: true });
      ws.addEventListener('error', () => settle('error'), { once: true });
    });
    if (reason) {
      // The socket may still be mid-handshake on a timeout; drop it so a slow
      // approval cannot open a connection nobody is holding any more.
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      throw new Error(await this.describeConnectFailure(reason, endpoint));
    }
    if (this.epoch !== epoch) {
      // close() (or a re-dial) landed while this one was still connecting.
      // Publishing the socket now would resurrect a contract the caller
      // already tore down.
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      throw new Error(`${this.label}: disposed`);
    }
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
