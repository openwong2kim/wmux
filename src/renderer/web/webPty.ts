/**
 * `window.electronAPI.pty` for the browser build (wmux web), on the daemon's
 * web API instead of a main process.
 *
 * The desktop's own Terminal/useTerminal mount unchanged; this module answers
 * the handful of `pty.*` calls they make:
 *
 *  - `setViewerVisibility(id, true|false)` opens / closes the pane's SSE stream
 *    (`GET /api/stream`). Nothing else opens one.
 *  - The stream's `snapshot` becomes ONE replay write (`onData(…, replay=true)`)
 *    followed by `onFlushComplete`, which is the contract useTerminal's
 *    resync/reset paths are written against. The replay starts with RIS, so a
 *    re-opened stream repaints instead of stacking a second copy of the screen.
 *  - `write` posts to `/api/input` (in order, per pane) only when this caller
 *    may type; otherwise it drops the bytes. It also drops xterm's automatic
 *    answers to device queries (DA / DSR / DECRQM) while a replay is being
 *    parsed: the snapshot carries whatever queries the pane's app once sent,
 *    and the machine that owns the pane already answered them.
 *  - `list` feeds useTerminal's stale-mode reset with the snapshot's own gate
 *    inputs, capped at the alive-shell level: every pane this page streams has
 *    a live shell, and that shell owns bracketed paste (?2004).
 *  - create / dispose / promote / resize are NOT here — the shim denies them.
 *
 * Live streams are rationed: at most WEB_LIVE_STREAM_CAP panes hold a slot.
 * The browser allows six HTTP/1.1 connections per origin (and the daemon eight
 * streams per principal), and the poll loop needs the rest. A shown pane that
 * gets no slot waits; `activate` hands it one by retiring the least recently
 * activated live pane, and a released slot goes to the longest waiter.
 */
import {
  STALE_REPLAY_ALIVE_SHELL_RESETS,
  STALE_REPLAY_DISPLAY_RESETS,
  staleReplayResetLevel,
} from '../../shared/terminal/staleReplayModeReset';

export const WEB_LIVE_STREAM_CAP = 4;
/** Reopen delay after a stream the browser gave up on (non-200). */
const STREAM_RETRY_MS = 3000;
/** Renew a stream ticket this long before it expires. */
const TICKET_RENEW_MARGIN_MS = 15_000;
/** Reset to initial state (RIS): a re-opened stream repaints, never stacks. */
const RIS = '\x1bc';

export interface PaneGeometry {
  cols: number;
  rows: number;
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

export function createWebPty(deps: WebPtyDeps) {
  const fetchImpl = deps.fetchImpl ?? fetch.bind(globalThis);
  const createEventSource = deps.createEventSource ?? ((url: string) => new EventSource(url));
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const auth = { Authorization: `Bearer ${deps.token}` };

  const dataListeners = new Set<DataListener>();
  const flushListeners = new Set<FlushListener>();
  const viewListeners = new Set<() => void>();

  /** Panes holding a live slot, least recently activated first. */
  let live: string[] = [];
  /** Shown panes waiting for a slot, oldest first. */
  let waiting: string[] = [];
  const viewerVisible = new Map<string, boolean>();
  const streams = new Map<string, Stream>();
  const geometry = new Map<string, PaneGeometry>();
  const gates = new Map<string, SnapshotGate>();
  const inputChain = new Map<string, Promise<void>>();
  let allowInput = false;
  let version = 0;

  let ticket = '';
  let ticketExpiresAt = 0;
  /** This session holds the operator token, which opens streams with ?token=. */
  let ticketsUnavailable = false;
  let ticketInFlight: Promise<void> | null = null;

  const notify = () => {
    version++;
    for (const l of [...viewListeners]) l();
  };

  const ensureTicket = (force: boolean): Promise<void> => {
    if (ticketsUnavailable) return Promise.resolve();
    if (!force && ticket && now() < ticketExpiresAt - TICKET_RENEW_MARGIN_MS) return Promise.resolve();
    if (ticketInFlight) return ticketInFlight;
    ticketInFlight = (async () => {
      try {
        const res = await fetchImpl('/api/stream-ticket', { method: 'POST', headers: auth });
        if (res.status === 403) { ticketsUnavailable = true; return; }
        if (res.status === 401) { deps.onUnauthorized?.(); return; }
        if (!res.ok) return;
        const body = await res.json() as { ticket?: unknown; expiresAt?: unknown };
        if (typeof body.ticket !== 'string' || !body.ticket) return;
        ticket = body.ticket;
        ticketExpiresAt = typeof body.expiresAt === 'number' ? body.expiresAt : now() + 60_000;
      } catch {
        /* the stream open that follows reports the failure */
      } finally {
        ticketInFlight = null;
      }
    })();
    return ticketInFlight;
  };

  const streamUrl = (ptyId: string): string => {
    const base = `/api/stream?session=${encodeURIComponent(ptyId)}`;
    return ticket && !ticketsUnavailable
      ? `${base}&ticket=${encodeURIComponent(ticket)}`
      : `${base}&token=${encodeURIComponent(deps.token)}`;
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

  const openStream = (ptyId: string, forceTicket = false) => {
    if (streams.has(ptyId) || !wantsStream(ptyId)) return;
    const stream: Stream = { es: null, gen: 0, decoder: new TextDecoder(), retry: undefined };
    streams.set(ptyId, stream);
    const gen = ++stream.gen;
    const current = () => streams.get(ptyId) === stream && stream.gen === gen;
    void ensureTicket(forceTicket).then(() => {
      if (!current() || !wantsStream(ptyId)) return;
      const es = createEventSource(streamUrl(ptyId));
      stream.es = es;
      let snapshotGate: SnapshotGate | undefined;
      es.addEventListener('meta', (ev) => {
        if (!current()) return;
        let meta: Record<string, unknown>;
        try { meta = JSON.parse(String(ev.data)) as Record<string, unknown>; } catch { return; }
        const g = validGeometry(meta);
        if (g) setGeometry(ptyId, g);
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
        stream.decoder = new TextDecoder();
        gates.set(ptyId, snapshotGate ?? {});
        // One write, so the reset, the screen and the mode tail parse inside
        // one replay span (the device-reply guard covers all of it).
        emitData(ptyId, RIS + new TextDecoder().decode(bytes) + snapshotTail(snapshotGate), true);
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
        // (an expired ticket, a revoked device) — it will never retry itself.
        if (es.readyState !== 2) return;
        try { es.close(); } catch { /* closed */ }
        stream.es = null;
        void fetchImpl('/api/config', { headers: auth, cache: 'no-store' }).then((res) => {
          if (res.status === 401) deps.onUnauthorized?.();
        }, () => undefined);
        stream.retry = setTimer(() => {
          if (!current()) return;
          streams.delete(ptyId);
          openStream(ptyId, true);
        }, STREAM_RETRY_MS);
      };
    });
  };

  const syncStream = (ptyId: string) => {
    if (wantsStream(ptyId)) openStream(ptyId);
    else closeStream(ptyId);
  };

  const setGeometry = (ptyId: string, g: PaneGeometry) => {
    const prev = geometry.get(ptyId);
    if (prev && prev.cols === g.cols && prev.rows === g.rows) return;
    geometry.set(ptyId, g);
    notify();
  };

  const grant = (ptyId: string) => {
    waiting = waiting.filter((id) => id !== ptyId);
    live = [...live.filter((id) => id !== ptyId), ptyId];
    syncStream(ptyId);
  };

  const release = (ptyId: string) => {
    const wasLive = live.includes(ptyId);
    live = live.filter((id) => id !== ptyId);
    waiting = waiting.filter((id) => id !== ptyId);
    closeStream(ptyId);
    if (wasLive && waiting.length > 0 && live.length < WEB_LIVE_STREAM_CAP) grant(waiting[0]);
    notify();
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
      if (!allowInput || !ptyId || typeof data !== 'string' || data.length === 0) return Promise.resolve();
      // An automatic answer to a replayed device query — see the module comment.
      if (deps.isReplaying?.(ptyId)) return Promise.resolve();
      const prev = inputChain.get(ptyId) ?? Promise.resolve();
      const next = prev.then(async () => {
        if (!allowInput) return;
        try {
          const res = await fetchImpl(`/api/input?session=${encodeURIComponent(ptyId)}`, {
            method: 'POST',
            body: data,
            headers: { ...auth, 'Content-Type': 'application/octet-stream' },
            keepalive: true,
          });
          if (res.status === 401) deps.onUnauthorized?.();
          else if (res.status === 403) {
            // The server has shut this door (read-only device or server).
            allowInput = false;
            notify();
          }
        } catch {
          /* transient — the stream reports connectivity */
        }
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
  };

  return {
    pty,
    /** Ask for a live slot for a shown pane; false = it waits (placeholder). */
    request(ptyId: string): boolean {
      if (live.includes(ptyId)) return true;
      if (live.length < WEB_LIVE_STREAM_CAP) {
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
      if (live.includes(ptyId)) {
        live = [...live.filter((id) => id !== ptyId), ptyId];
        return;
      }
      while (live.length >= WEB_LIVE_STREAM_CAP) {
        const evicted = live[0];
        live = live.slice(1);
        closeStream(evicted);
        // Still shown: it waits for the next free slot.
        if (!waiting.includes(evicted)) waiting = [...waiting, evicted];
      }
      grant(ptyId);
      notify();
    },
    /** The pane is no longer shown (tab switch, unmount). */
    release,
    isLive: (ptyId: string) => live.includes(ptyId),
    geometryOf: (ptyId: string): PaneGeometry | undefined => geometry.get(ptyId),
    /** Pane sizes from `GET /api/sessions`. */
    setSessions(rows: ReadonlyArray<{ id: string; cols?: unknown; rows?: unknown }>): void {
      for (const row of rows) {
        const g = validGeometry(row);
        if (g) setGeometry(row.id, g);
      }
    },
    setAllowInput(v: boolean): void {
      if (allowInput === v) return;
      allowInput = v;
      notify();
    },
    allowsInput: () => allowInput,
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
