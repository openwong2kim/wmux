/**
 * `window.electronAPI.pty` for the browser build (wmux web), on the daemon's
 * web API instead of a main process.
 *
 * The desktop's own Terminal/useTerminal mount unchanged; this module answers
 * the handful of `pty.*` calls they make:
 *
 *  - `setViewerVisibility(id, true|false)` opens / closes the pane's SSE stream
 *    (`GET /api/stream`). Nothing else opens one. A device credential opens it
 *    with a stream ticket and never rides the URL itself — no ticket, no stream
 *    (the retry backs off); the operator token uses `?token=`.
 *  - The stream's `snapshot` becomes ONE replay write (`onData(…, replay=true)`)
 *    followed by `onFlushComplete`, which is the contract useTerminal's
 *    resync/reset paths are written against. The replay starts with RIS, so a
 *    re-opened stream repaints instead of stacking a second copy of the screen.
 *    Snapshot and live bytes share one streaming UTF-8 decoder.
 *  - `write` posts to `/api/input` in order, per pane, only while this caller
 *    may type. Keys typed while a replay is being parsed WAIT for it instead of
 *    being dropped (the terminal's automatic query answers are absorbed at the
 *    parser — viewerParser.ts — so nothing here has to guess which bytes are
 *    the user's). A delivery that fails or cannot be confirmed stops the pane's
 *    input and says so (`inputHaltOf`); nothing is dropped silently, and an
 *    unconfirmed keystroke is never re-sent (it may have arrived). The daemon's
 *    input receipts would make a retry safe, but they cost two durable disk
 *    writes each and hold 10 000 a day for every client together — sized for
 *    a phone's composed messages, not for one request per keystroke.
 *  - `list` feeds useTerminal's stale-mode reset with the snapshot's own gate
 *    inputs, capped at the alive-shell level: every pane this page streams has
 *    a live shell, and that shell owns bracketed paste (?2004).
 *  - create / dispose / promote / resize are NOT here — the shim denies them.
 *
 * Live streams are rationed: at most WEB_LIVE_STREAM_CAP panes hold a slot.
 * The browser allows six HTTP/1.1 connections per origin (and the daemon eight
 * streams per principal), and the poll loop needs the rest. A shown pane that
 * gets no slot waits; `activate` hands it one by retiring the least recently
 * activated live pane, and a released slot goes to the longest waiter. A
 * stream that keeps failing gives its slot up and shows as unavailable.
 */
import {
  STALE_REPLAY_ALIVE_SHELL_RESETS,
  STALE_REPLAY_DISPLAY_RESETS,
  staleReplayResetLevel,
} from '../../shared/terminal/staleReplayModeReset';
import { isFocusReport } from './viewerParser';

export const WEB_LIVE_STREAM_CAP = 4;
/** Consecutive stream failures before the pane gives its slot up. */
export const STREAM_FAIL_LIMIT = 5;
const STREAM_RETRY_BASE_MS = 1000;
const STREAM_RETRY_MAX_MS = 30_000;
/** Renew a stream ticket this long before it expires. */
const TICKET_RENEW_MARGIN_MS = 15_000;
/** Upper bound on one control request (config, ticket, input). */
const REQUEST_TIMEOUT_MS = 10_000;
/** How often the caller's grant is re-read while things are fine. */
export const CONFIG_REFRESH_MS = 10_000;
const CONFIG_RETRY_MAX_MS = 30_000;
/** Longest a keystroke waits for a replay parse (or the first grant) to finish. */
const INPUT_WAIT_MAX_MS = 5_000;
/** Reset to initial state (RIS): a re-opened stream repaints, never stacks. */
const RIS = '\x1bc';

export interface PaneGeometry {
  cols: number;
  rows: number;
}

/** Whether this caller may type: unknown until `/api/config` answers. */
export type InputState = 'checking' | 'allowed' | 'read-only';

export interface InputHalt {
  /** Short machine reason: offline | refused:<code> | unauthorized | too-large. */
  reason: string;
  /** Keystrokes (writes) that were not sent after the halt. */
  dropped: number;
}

type DataListener = (ptyId: string, data: string, replay?: boolean) => void;
type FlushListener = (ptyId: string, recoveredBytes: number) => void;

interface EventSourceLike {
  readonly readyState: number;
  onerror: ((ev: Event) => unknown) | null;
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
}

export interface WebPtyDeps {
  token: string;
  fetchImpl?: typeof fetch;
  createEventSource?: (url: string) => EventSourceLike;
  /** True while this pane's terminal is parsing replayed bytes. */
  isReplaying?: (ptyId: string) => boolean;
  /** The owner resized the pane: apply the grid now, before the next byte parses. */
  applyGeometry?: (ptyId: string, g: PaneGeometry) => void;
  /** The daemon refused the credential (401). */
  onUnauthorized?: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface SnapshotGate {
  commandRunning?: boolean;
  resumeAgent?: string;
}

interface Stream {
  es: EventSourceLike | null;
  /** Bumped per open, so a late callback from a closed stream is ignored. */
  gen: number;
  decoder: TextDecoder;
  retry: unknown;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function validGeometry(v: unknown): PaneGeometry | null {
  const g = v as { cols?: unknown; rows?: unknown } | null;
  if (!g || typeof g.cols !== 'number' || typeof g.rows !== 'number') return null;
  if (!Number.isInteger(g.cols) || !Number.isInteger(g.rows) || g.cols <= 0 || g.rows <= 0) return null;
  return { cols: g.cols, rows: g.rows };
}

/**
 * The terminal-side reset a snapshot has earned, from the SHARED gate
 * (src/shared/terminal) with the SAME cap the classic page applies: never the
 * 'full' set, which would clear ?2004 under a live shell.
 */
export function snapshotTail(gate: SnapshotGate | undefined): string {
  if (!gate) return '';
  return staleReplayResetLevel(gate) === 'none' ? '' : STALE_REPLAY_ALIVE_SHELL_RESETS + STALE_REPLAY_DISPLAY_RESETS;
}

/** A device credential is `<deviceId>.<secret>`; the operator token has no dot. */
export function isDeviceCredential(token: string): boolean {
  return token.includes('.');
}

export function createWebPty(deps: WebPtyDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const createEventSource = deps.createEventSource ?? ((url: string) => new EventSource(url));
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const auth = { Authorization: `Bearer ${deps.token}` };
  const device = isDeviceCredential(deps.token);
  const sleep = (ms: number) => new Promise<void>((r) => { setTimer(r, ms); });

  const dataListeners = new Set<DataListener>();
  const flushListeners = new Set<FlushListener>();
  const viewListeners = new Set<() => void>();

  /** Panes holding a live slot, least recently activated first. */
  let live: string[] = [];
  /** Shown panes waiting for a slot, oldest first. */
  let waiting: string[] = [];
  const viewerVisible = new Map<string, boolean>();
  const streams = new Map<string, Stream>();
  const failures = new Map<string, number>();
  const failed = new Set<string>();
  const geometry = new Map<string, PaneGeometry>();
  const gates = new Map<string, SnapshotGate>();
  const inputChain = new Map<string, Promise<void>>();
  const halts = new Map<string, InputHalt>();
  let inputState: InputState = 'checking';
  let hostPlatform: string | null = null;
  let version = 0;

  let ticket = '';
  let ticketExpiresAt = 0;
  let ticketInFlight: Promise<boolean> | null = null;

  const notify = () => {
    version++;
    for (const l of [...viewListeners]) l();
  };

  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const ctl = new AbortController();
    const timer = setTimer(() => ctl.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetchImpl(url, { ...init, signal: ctl.signal });
    } finally {
      clearTimer(timer);
    }
  };

  /** Resolves true once a usable ticket is held (always true for the operator token). */
  const ensureTicket = (force: boolean): Promise<boolean> => {
    if (!device) return Promise.resolve(true);
    if (!force && ticket && now() < ticketExpiresAt - TICKET_RENEW_MARGIN_MS) return Promise.resolve(true);
    if (ticketInFlight) return ticketInFlight;
    ticketInFlight = (async () => {
      try {
        const res = await request('/api/stream-ticket', { method: 'POST', headers: auth });
        if (res.status === 401) { deps.onUnauthorized?.(); return false; }
        if (!res.ok) return false;
        const body = await res.json() as { ticket?: unknown; expiresAt?: unknown };
        if (typeof body.ticket !== 'string' || !body.ticket) return false;
        ticket = body.ticket;
        ticketExpiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : now() + 60_000;
        return true;
      } catch {
        return false;
      } finally {
        ticketInFlight = null;
      }
    })();
    return ticketInFlight;
  };

  const streamUrl = (ptyId: string): string => {
    const base = `/api/stream?session=${encodeURIComponent(ptyId)}`;
    // A device credential is durable: it never goes into a URL.
    return device ? `${base}&ticket=${encodeURIComponent(ticket)}` : `${base}&token=${encodeURIComponent(deps.token)}`;
  };

  const emitData = (ptyId: string, data: string, replay: boolean) => {
    for (const l of [...dataListeners]) l(ptyId, data, replay);
  };

  const wantsStream = (ptyId: string) => live.includes(ptyId) && viewerVisible.get(ptyId) === true;

  const closeStream = (ptyId: string) => {
    const s = streams.get(ptyId);
    if (!s) return;
    streams.delete(ptyId);
    s.gen = -1;
    if (s.retry !== undefined) clearTimer(s.retry);
    try { s.es?.close(); } catch { /* already closed */ }
  };

  const setGeometry = (ptyId: string, g: PaneGeometry) => {
    const prev = geometry.get(ptyId);
    if (prev && prev.cols === g.cols && prev.rows === g.rows) return;
    geometry.set(ptyId, g);
    notify();
  };

  const retire = (ptyId: string) => {
    live = live.filter((id) => id !== ptyId);
    closeStream(ptyId);
    if (!waiting.includes(ptyId)) waiting = [...waiting, ptyId];
  };

  /** Back off, and after STREAM_FAIL_LIMIT failures give the slot up. */
  const streamFailed = (ptyId: string, stream: Stream) => {
    const n = (failures.get(ptyId) ?? 0) + 1;
    failures.set(ptyId, n);
    stream.es = null;
    if (n >= STREAM_FAIL_LIMIT) {
      failed.add(ptyId);
      retire(ptyId);
      promoteWaiter();
      notify();
      void refreshConfig();
      return;
    }
    const delay = Math.min(STREAM_RETRY_MAX_MS, STREAM_RETRY_BASE_MS * 2 ** (n - 1));
    stream.retry = setTimer(() => {
      if (streams.get(ptyId) !== stream) return;
      streams.delete(ptyId);
      openStream(ptyId, true);
    }, delay);
  };

  const openStream = (ptyId: string, forceTicket = false) => {
    if (streams.has(ptyId) || !wantsStream(ptyId)) return;
    const stream: Stream = { es: null, gen: 0, decoder: new TextDecoder(), retry: undefined };
    streams.set(ptyId, stream);
    const gen = ++stream.gen;
    const current = () => streams.get(ptyId) === stream && stream.gen === gen;
    void ensureTicket(forceTicket).then((ok) => {
      if (!current() || !wantsStream(ptyId)) return;
      if (!ok) { streamFailed(ptyId, stream); return; }
      const es = createEventSource(streamUrl(ptyId));
      stream.es = es;
      let snapshotGate: SnapshotGate | undefined;
      es.addEventListener('meta', (ev) => {
        if (!current()) return;
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
        const g = validGeometry(meta);
        if (g) {
          setGeometry(ptyId, g);
          // Bytes after this meta are framed for the new grid: apply it now,
          // not after the next render.
          deps.applyGeometry?.(ptyId, g);
        }
        // A mid-stream resize meta has no snapshot behind it; only the meta
        // that precedes a snapshot describes it.
        if (meta.resize !== true) {
          snapshotGate = {
            ...(typeof meta.commandRunning === 'boolean' ? { commandRunning: meta.commandRunning } : {}),
            ...(typeof meta.resumeAgent === 'string' ? { resumeAgent: meta.resumeAgent } : {}),
          };
        }
      });
      es.addEventListener('snapshot', (ev) => {
        if (!current()) return;
        let bytes: Uint8Array;
        try { bytes = b64ToBytes(String(ev.data)); } catch { return; }
        failures.delete(ptyId);
        // The snapshot starts the stream over; live bytes continue it through
        // the same decoder, so a character split across the boundary survives.
        stream.decoder = new TextDecoder();
        gates.set(ptyId, snapshotGate ?? {});
        // One write, so the reset, the screen and the mode tail parse inside
        // one replay span.
        emitData(ptyId, RIS + stream.decoder.decode(bytes, { stream: true }) + snapshotTail(snapshotGate), true);
        for (const l of [...flushListeners]) l(ptyId, bytes.length);
      });
      es.addEventListener('data', (ev) => {
        if (!current()) return;
        let bytes: Uint8Array;
        try { bytes = b64ToBytes(String(ev.data)); } catch { return; }
        const text = stream.decoder.decode(bytes, { stream: true });
        if (text) emitData(ptyId, text, false);
      });
      es.onerror = () => {
        if (!current()) return;
        // CONNECTING: the browser is retrying on its own. CLOSED: a non-200
        // (an expired ticket, the stream quota, a revoked device) — it will
        // never retry itself.
        if (es.readyState !== 2) return;
        try { es.close(); } catch { /* closed */ }
        streamFailed(ptyId, stream);
      };
    });
  };

  const syncStream = (ptyId: string) => {
    if (wantsStream(ptyId)) openStream(ptyId);
    else closeStream(ptyId);
  };

  const grant = (ptyId: string) => {
    waiting = waiting.filter((id) => id !== ptyId);
    live = [...live.filter((id) => id !== ptyId), ptyId];
    syncStream(ptyId);
  };

  const promoteWaiter = () => {
    const next = waiting.find((id) => !failed.has(id));
    if (next && live.length < WEB_LIVE_STREAM_CAP) grant(next);
  };

  const release = (ptyId: string) => {
    const wasLive = live.includes(ptyId);
    live = live.filter((id) => id !== ptyId);
    waiting = waiting.filter((id) => id !== ptyId);
    closeStream(ptyId);
    if (wasLive) promoteWaiter();
    notify();
  };

  /** Repaint every live stream (the read-only mouse policy applies at parse). */
  const reopenLive = () => {
    for (const id of live) {
      if (!streams.has(id)) continue;
      closeStream(id);
      openStream(id);
    }
  };

  const setInputState = (next: InputState) => {
    if (inputState === next) return;
    const repaint = inputState !== 'checking' || next === 'read-only';
    inputState = next;
    if (next === 'allowed') halts.forEach((h, id) => { if (h.reason === 'read-only') halts.delete(id); });
    if (repaint) reopenLive();
    notify();
  };

  // --- the caller's grant, re-read while the page lives -------------------
  let configTimer: unknown;
  let configFailures = 0;
  let configStopped = true;
  let configInFlight: Promise<void> | null = null;
  const scheduleConfig = (ms: number) => {
    if (configStopped) return;
    if (configTimer !== undefined) clearTimer(configTimer);
    configTimer = setTimer(() => { configTimer = undefined; void refreshConfig(); }, ms);
  };
  const refreshConfig = (): Promise<void> => {
    if (configInFlight) return configInFlight;
    configInFlight = (async () => {
      let ok = false;
      try {
        const res = await request('/api/config', { headers: auth, cache: 'no-store' });
        if (res.status === 401) { deps.onUnauthorized?.(); return; }
        if (res.ok) {
          const cfg = await res.json() as { allowInput?: unknown; hostPlatform?: unknown };
          if (typeof cfg.hostPlatform === 'string') hostPlatform = cfg.hostPlatform;
          setInputState(cfg.allowInput === true ? 'allowed' : 'read-only');
          ok = true;
        }
      } catch {
        /* unreachable or timed out: retried below */
      } finally {
        configInFlight = null;
      }
      configFailures = ok ? 0 : configFailures + 1;
      scheduleConfig(ok ? CONFIG_REFRESH_MS : Math.min(CONFIG_RETRY_MAX_MS, 1000 * 2 ** Math.min(configFailures, 5)));
    })();
    return configInFlight;
  };

  // --- input ---------------------------------------------------------------
  const waitUntil = async (ready: () => boolean): Promise<void> => {
    const deadline = now() + INPUT_WAIT_MAX_MS;
    while (!ready() && now() < deadline) await sleep(16);
  };

  const halt = (ptyId: string, reason: string) => {
    if (!halts.has(ptyId)) halts.set(ptyId, { reason, dropped: 0 });
    notify();
  };

  const countDropped = (ptyId: string) => {
    const h = halts.get(ptyId);
    if (!h) return;
    h.dropped += 1;
    notify();
  };

  const send = async (ptyId: string, data: string): Promise<void> => {
    let status = 0;
    let code = '';
    try {
      const res = await request(`/api/input?session=${encodeURIComponent(ptyId)}`, {
        method: 'POST', body: data, headers: { ...auth, 'Content-Type': 'application/octet-stream' }, keepalive: true,
      });
      status = res.status;
      if (!res.ok) code = await res.json().then((b: { error?: unknown }) => (typeof b?.error === 'string' ? b.error : ''), () => '');
    } catch {
      status = 0; // network error or timeout: the outcome is unknown
    }
    if (status >= 200 && status < 300) return;
    if (status === 401) { halt(ptyId, 'unauthorized'); deps.onUnauthorized?.(); return; }
    if (status === 403) { setInputState('read-only'); halt(ptyId, 'read-only'); return; }
    if (status === 413) { halt(ptyId, 'too-large'); return; }
    if (status >= 400 && status < 500) { halt(ptyId, `refused:${code || status}`); return; }
    halt(ptyId, 'offline');
  };

  const pty = {
    onData(cb: DataListener): () => void {
      dataListeners.add(cb);
      return () => { dataListeners.delete(cb); };
    },
    onFlushComplete(cb: FlushListener): () => void {
      flushListeners.add(cb);
      return () => { flushListeners.delete(cb); };
    },
    // The stream's `exit` event carries no code, and a pane that ended leaves
    // `/api/sessions` on the next poll, which turns its tab into a
    // placeholder. Nothing to forward.
    onExit(): () => void {
      return () => undefined;
    },
    onRestarted(): () => void {
      return () => undefined;
    },
    setViewerVisibility(ptyId: string, visible: boolean): void {
      viewerVisible.set(ptyId, visible === true);
      syncStream(ptyId);
    },
    write(ptyId: string, data: string): Promise<void> {
      if (!ptyId || typeof data !== 'string' || data.length === 0) return Promise.resolve();
      // The viewer's own focus is not the pane owner's.
      if (isFocusReport(data)) return Promise.resolve();
      if (inputState === 'read-only') return Promise.resolve();
      const prev = inputChain.get(ptyId) ?? Promise.resolve();
      const next = prev.then(async () => {
        // Keys typed during the first grant check or a replay parse wait for
        // it; they are neither dropped nor sent early.
        await waitUntil(() => inputState !== 'checking' && !deps.isReplaying?.(ptyId));
        if (halts.has(ptyId)) { countDropped(ptyId); return; }
        if (inputState !== 'allowed') return;
        await send(ptyId, data);
      });
      inputChain.set(ptyId, next);
      return next;
    },
    async list(): Promise<Array<{ id: string; commandRunning?: boolean }>> {
      // Only the stale-mode gate reads this. Capped at the alive-shell level:
      // `commandRunning: false` earns the mouse/focus reset, never ?2004.
      return [...gates].map(([id, gate]) => (
        staleReplayResetLevel(gate) === 'none' ? { id } : { id, commandRunning: false }
      ));
    },
    async reconnect(ptyId: string): Promise<{ success: boolean; code?: string }> {
      if (!wantsStream(ptyId)) return { success: false, code: 'not-live' };
      closeStream(ptyId);
      openStream(ptyId);
      return { success: true };
    },
    async resync(): Promise<{ success: false; code: string }> {
      // No live-pipe snapshot reflush here; useTerminal falls back to
      // `reconnect`, which repaints from a fresh stream's snapshot.
      return { success: false, code: 'local-mode' };
    },
    /** The daemon's OS, for key encodings the pane's host decides (null until known). */
    hostPlatform: (): string | null => hostPlatform,
  };

  return {
    pty,
    /** Ask for a live slot for a shown pane; false = it waits (placeholder). */
    request(ptyId: string): boolean {
      if (live.includes(ptyId)) return true;
      if (live.length < WEB_LIVE_STREAM_CAP && !failed.has(ptyId)) {
        grant(ptyId);
        notify();
        return true;
      }
      if (!waiting.includes(ptyId)) {
        waiting = [...waiting, ptyId];
        notify();
      }
      return false;
    },
    /** The user asked for this pane: give it a slot, retiring the least recent. */
    activate(ptyId: string): void {
      failed.delete(ptyId);
      failures.delete(ptyId);
      if (live.includes(ptyId)) {
        live = [...live.filter((id) => id !== ptyId), ptyId];
        notify();
        return;
      }
      while (live.length >= WEB_LIVE_STREAM_CAP) retire(live[0]);
      grant(ptyId);
      notify();
    },
    /** The pane is no longer shown (tab switch, unmount). */
    release,
    isLive: (ptyId: string) => live.includes(ptyId),
    /** The stream gave up (quota, credential, server): the pane shows why. */
    isUnavailable: (ptyId: string) => failed.has(ptyId),
    geometryOf: (ptyId: string): PaneGeometry | undefined => geometry.get(ptyId),
    /** Pane sizes from `GET /api/sessions`. */
    setSessions(rows: ReadonlyArray<{ id: string; cols?: unknown; rows?: unknown }>): void {
      for (const row of rows) {
        const g = validGeometry(row);
        if (g) setGeometry(row.id, g);
      }
    },
    /** Start re-reading `/api/config` (now, then periodically, backing off on failure). */
    startConfig(): () => void {
      configStopped = false;
      void refreshConfig();
      return () => {
        configStopped = true;
        if (configTimer !== undefined) clearTimer(configTimer);
      };
    },
    refreshConfig,
    /** Test/boot seam: set the grant directly. */
    setAllowInput(v: boolean): void {
      setInputState(v ? 'allowed' : 'read-only');
    },
    inputState: (): InputState => inputState,
    allowsInput: () => inputState === 'allowed',
    inputHaltOf: (ptyId: string): InputHalt | undefined => halts.get(ptyId),
    /** The user acknowledged a halt: this pane's input goes out again. */
    resumeInput(ptyId: string): void {
      if (halts.delete(ptyId)) notify();
    },
    subscribe(listener: () => void): () => void {
      viewListeners.add(listener);
      return () => { viewListeners.delete(listener); };
    },
    version: () => version,
    /** Dogfood/test hook: streams this page holds open (or is opening). */
    openStreamCount: () => streams.size,
    liveIds: () => [...live],
  };
}

export type WebPtyHub = ReturnType<typeof createWebPty>;
