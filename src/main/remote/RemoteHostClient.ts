// Main-process HTTP/SSE bridge to a remote wmux daemon's web server.
//
// Talks to the same routes the browser frontend uses (WebTerminalServer.ts:
// `handleStream`/`handleInput`), but from the main process instead of a
// browser tab — so it can set an `Authorization` header directly rather than
// relying on EventSource's query-string token, and it drives the pane state
// for Task 5's IPC handler instead of a DOM terminal.
//
// This class is observer + input only: it never calls a destroy/delete
// endpoint on the remote host.

import * as crypto from 'crypto';
import type {
  RemoteHost,
  RemotePaneSummary,
  RemoteWorkspaceSummary,
  RemoteWorkspacesResponse,
} from '../../shared/remoteHosts';

export interface RemoteMetaEvent {
  attachId: string;
  cols: number;
  rows: number;
  snapshotB64: string;
  truncated?: boolean;
  omittedBytes?: number;
}

/**
 * A geometry-only update: the remote pane was resized while we were attached.
 * Separate from {@link RemoteMetaEvent} because it carries NO snapshot — the
 * receiver resizes its grid and keeps everything already on screen, where a
 * meta event means "reset and repaint".
 */
export interface RemoteResizeEvent {
  attachId: string;
  cols: number;
  rows: number;
}

export interface RemoteDataEvent {
  attachId: string;
  dataB64: string;
}

export interface RemoteExitEvent {
  attachId: string;
}

export interface RemoteErrorEvent {
  attachId: string;
  message: string;
}

export interface RemotePaneEvents {
  onMeta(cb: (e: RemoteMetaEvent) => void): void;
  onResize(cb: (e: RemoteResizeEvent) => void): void;
  onData(cb: (e: RemoteDataEvent) => void): void;
  onExit(cb: (e: RemoteExitEvent) => void): void;
  onError(cb: (e: RemoteErrorEvent) => void): void;
}

// Reconnect backoff: 1s -> 2s -> 5s, capped, with +/-30% jitter so that a
// tailnet blip affecting several mirrors at once does not have them all
// hammer the remote host in lockstep.
const BACKOFF_STEPS_MS = [1000, 2000, 5000];
const JITTER_RATIO = 0.3;

// After this many consecutive failed reconnect attempts, stop retrying and
// emit onError instead — otherwise a dead remote gets hammered forever
// (every ~5s, the max backoff step) while the renderer sits on a silent
// blank mirror with no signal the stream is gone for good.
const MAX_RECONNECT_ATTEMPTS = 5;

// Write coalescing window: two POSTs in flight at once can land out of order
// and scramble keystrokes, and per-character POSTs at desktop typing rates
// are wasteful, so writes that arrive while one is in flight are queued and
// merged into a single follow-up POST.
const WRITE_COALESCE_MS = 5;

// Bounded-reads timeout for the request/response calls (listWorkspaces,
// write) — these are one-shot fetches, unlike the long-lived SSE stream,
// so a hung remote must not leave the caller awaiting forever.
const REQUEST_TIMEOUT_MS = 10_000;

interface Attachment {
  attachId: string;
  sessionId: string;
  controller: AbortController;
  // Buffered meta JSON, held until the paired `snapshot` frame arrives so a
  // single onMeta callback carries cols/rows/snapshotB64/truncated together
  // (matching the RemotePaneEvents contract — there is no separate onSnapshot).
  //
  // Only the ATTACH frame is a pair. A mid-stream geometry update arrives on
  // its own and is dispatched as a resize instead — holding it here for a
  // partner that never comes is how a resize used to reach the mirror as
  // nothing at all.
  pendingMeta: { cols: number; rows: number; truncated?: boolean; omittedBytes?: number } | null;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  detached: boolean;
}

interface WriteQueueState {
  pending: string[];
  coalesceTimer: ReturnType<typeof setTimeout> | null;
  inFlight: boolean;
  // Resolvers for every write() call folded into the currently-queued (not
  // yet sent) batch — all resolve/reject together once that batch's POST
  // settles, preserving submission order without per-character requests.
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
}

function jitteredDelay(baseMs: number): number {
  const jitter = baseMs * JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(baseMs + jitter));
}

function backoffForAttempt(attempt: number): number {
  const step = BACKOFF_STEPS_MS[Math.min(attempt, BACKOFF_STEPS_MS.length - 1)];
  return jitteredDelay(step);
}

/** `/api/workspaces` is a trust boundary: the body is produced by ANOTHER
 *  machine, possibly running an older or misbehaving build, and nothing but a
 *  TypeScript cast stood between it and callers that do `.find()` / `.map()`
 *  on it. A single malformed body used to throw far downstream and take a
 *  whole refresh round — every other host in it — with it.
 *
 *  So: normalise here, once, where every caller benefits. Anything that does
 *  not match the declared shape is DROPPED rather than passed on; a workspace
 *  with no usable id, or a pane with no sessionId, cannot be addressed anyway. */
function normalizeWorkspaces(body: unknown): RemoteWorkspaceSummary[] {
  if (typeof body !== 'object' || body === null) return [];
  const list = (body as { workspaces?: unknown }).workspaces;
  if (!Array.isArray(list)) return [];

  const workspaces: RemoteWorkspaceSummary[] = [];
  for (const rawWs of list) {
    if (typeof rawWs !== 'object' || rawWs === null) continue;
    const ws = rawWs as Record<string, unknown>;
    if (typeof ws.id !== 'string' || !ws.id) continue;

    const panes: RemotePaneSummary[] = [];
    if (Array.isArray(ws.panes)) {
      for (const rawPane of ws.panes) {
        if (typeof rawPane !== 'object' || rawPane === null) continue;
        const pane = rawPane as Record<string, unknown>;
        if (typeof pane.sessionId !== 'string' || !pane.sessionId) continue;
        panes.push({
          sessionId: pane.sessionId,
          ...(typeof pane.shell === 'string' ? { shell: pane.shell } : {}),
          ...(typeof pane.cwd === 'string' ? { cwd: pane.cwd } : {}),
        });
      }
    }
    workspaces.push({ id: ws.id, name: typeof ws.name === 'string' ? ws.name : '', panes });
  }
  return workspaces;
}

export class RemoteHostClient implements RemotePaneEvents {
  private readonly host: RemoteHost;
  private readonly fetchImpl: typeof fetch;

  private readonly attachments = new Map<string, Attachment>();
  private readonly writeQueues = new Map<string, WriteQueueState>();

  private metaCbs: Array<(e: RemoteMetaEvent) => void> = [];
  private resizeCbs: Array<(e: RemoteResizeEvent) => void> = [];
  private dataCbs: Array<(e: RemoteDataEvent) => void> = [];
  private exitCbs: Array<(e: RemoteExitEvent) => void> = [];
  private errorCbs: Array<(e: RemoteErrorEvent) => void> = [];

  constructor(host: RemoteHost, fetchImpl: typeof fetch = fetch) {
    this.host = host;
    this.fetchImpl = fetchImpl;
  }

  onMeta(cb: (e: RemoteMetaEvent) => void): void {
    this.metaCbs.push(cb);
  }

  onResize(cb: (e: RemoteResizeEvent) => void): void {
    this.resizeCbs.push(cb);
  }

  onData(cb: (e: RemoteDataEvent) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (e: RemoteExitEvent) => void): void {
    this.exitCbs.push(cb);
  }

  onError(cb: (e: RemoteErrorEvent) => void): void {
    this.errorCbs.push(cb);
  }

  /**
   * Bootstrap the first pane of a NEW workspace on this host (#1001). Mints
   * no id itself — the caller (the renderer, which owns the workspace
   * registry today) supplies `workspaceId`, and this is the operator-Bearer
   * request `WebTerminalServer.rejectWorkspaceId` lets mint an unknown id
   * for: `RemoteHost.token` is always the operator credential (parsed from
   * the pasted wmux-web URL or the pair exchange — see remoteHosts.ts), never
   * a paired device's, so every call through this client already qualifies.
   *
   * Returns the new pane's `sessionId` on success — the caller attaches to
   * it the same way `REMOTE_PANE_ATTACH` attaches to any other remote pane.
   */
  async createWorkspace(workspaceId: string, cwd?: string): Promise<{ sessionId: string }> {
    const res = await this.fetchImpl(`${this.host.origin}/api/sessions`, {
      method: 'POST',
      headers: { ...this.authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, ...(cwd ? { cwd } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      let message = `createWorkspace failed: HTTP ${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string; detail?: string };
        if (parsed?.detail) message = parsed.detail;
        else if (parsed?.error) message = parsed.error;
      } catch {
        /* body wasn't JSON — fall back to the generic message */
      }
      throw new Error(message);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error('createWorkspace failed: response body was not JSON');
    }
    const sessionId = (body as { id?: unknown } | null)?.id;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error('createWorkspace failed: response carried no session id');
    }
    return { sessionId };
  }

  async listWorkspaces(): Promise<RemoteWorkspacesResponse> {
    const res = await this.fetchImpl(`${this.host.origin}/api/workspaces`, {
      headers: this.authHeaders(),
      // Bearer-credentialed request: never silently follow a redirect —
      // a redirected credentialed request is wrong here regardless of
      // whether undici happens to strip Authorization cross-origin.
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`listWorkspaces failed: HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new Error('listWorkspaces failed: response body was not JSON');
    }
    return { workspaces: normalizeWorkspaces(body) };
  }

  attach(sessionId: string): string {
    const attachId = crypto.randomUUID();
    const attachment: Attachment = {
      attachId,
      sessionId,
      controller: new AbortController(),
      pendingMeta: null,
      reconnectAttempt: 0,
      reconnectTimer: null,
      detached: false,
    };
    this.attachments.set(attachId, attachment);
    this.openStream(attachment);
    return attachId;
  }

  detach(attachId: string): void {
    const attachment = this.attachments.get(attachId);
    if (!attachment) return;
    attachment.detached = true;
    if (attachment.reconnectTimer) {
      clearTimeout(attachment.reconnectTimer);
      attachment.reconnectTimer = null;
    }
    attachment.controller.abort();
    this.attachments.delete(attachId);
  }

  detachAll(): void {
    for (const id of [...this.attachments.keys()]) {
      this.detach(id);
    }
  }

  write(attachId: string, utf8: string): Promise<void> {
    const attachment = this.attachments.get(attachId);
    const sessionId = attachment ? attachment.sessionId : attachId;
    let queue = this.writeQueues.get(sessionId);
    if (!queue) {
      queue = { pending: [], coalesceTimer: null, inFlight: false, waiters: [] };
      this.writeQueues.set(sessionId, queue);
    }
    queue.pending.push(utf8);
    return new Promise<void>((resolve, reject) => {
      queue!.waiters.push({ resolve, reject });
      this.scheduleWriteFlush(sessionId, queue!);
    });
  }

  private scheduleWriteFlush(sessionId: string, queue: WriteQueueState): void {
    if (queue.inFlight) return; // a flush will be scheduled when the in-flight POST settles
    if (queue.coalesceTimer) return; // already scheduled
    queue.coalesceTimer = setTimeout(() => {
      queue.coalesceTimer = null;
      void this.flushWrite(sessionId, queue);
    }, WRITE_COALESCE_MS);
  }

  private async flushWrite(sessionId: string, queue: WriteQueueState): Promise<void> {
    if (queue.pending.length === 0) return;
    const body = queue.pending.join('');
    const waiters = queue.waiters;
    queue.pending = [];
    queue.waiters = [];
    queue.inFlight = true;
    try {
      const res = await this.fetchImpl(`${this.host.origin}/api/input?session=${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: this.authHeaders(),
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        let message = `write failed: HTTP ${res.status}`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (parsed?.error) message = parsed.error;
        } catch {
          /* body wasn't JSON — fall back to the generic message */
        }
        const err = new Error(message);
        for (const w of waiters) w.reject(err);
        return;
      }
      for (const w of waiters) w.resolve();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      for (const w of waiters) w.reject(e);
    } finally {
      queue.inFlight = false;
      // More writes may have accumulated while this POST was in flight.
      if (queue.pending.length > 0) {
        this.scheduleWriteFlush(sessionId, queue);
      }
    }
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.host.token}` };
  }

  private openStream(attachment: Attachment): void {
    attachment.pendingMeta = null;
    void this.runStream(attachment);
  }

  private async runStream(attachment: Attachment): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.host.origin}/api/stream?session=${encodeURIComponent(attachment.sessionId)}`,
        // No timeout here — the SSE stream is long-lived by design. Still
        // refuse a redirect on this Bearer-credentialed request, same as
        // listWorkspaces/write.
        { headers: this.authHeaders(), redirect: 'error', signal: attachment.controller.signal },
      );
    } catch (err) {
      this.scheduleReconnect(attachment, err);
      return;
    }
    if (attachment.detached) return;
    if (!res.ok || !res.body) {
      this.scheduleReconnect(attachment, new Error(`stream failed: HTTP ${res.status}`));
      return;
    }

    try {
      await this.pumpStream(attachment, res.body);
      if (attachment.detached) return;
      // The stream ended without an explicit abort — treat as a drop and
      // reconnect the same as a network error.
      this.scheduleReconnect(attachment, new Error('stream closed'));
    } catch (err) {
      if (attachment.detached) return;
      this.scheduleReconnect(attachment, err);
    }
  }

  private async pumpStream(attachment: Attachment, body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        // Reset the backoff schedule only once a frame has actually
        // arrived — resetting it right after headers (connect-only, no
        // data) would let a server that accepts the request then drops
        // before sending anything retry forever, since the counter never
        // gets a chance to climb past MAX_RECONNECT_ATTEMPTS.
        attachment.reconnectAttempt = 0;
        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          this.handleFrame(attachment, rawFrame);
          if (attachment.detached) return;
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private handleFrame(attachment: Attachment, rawFrame: string): void {
    const lines = rawFrame.split('\n');
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(':')) continue; // comment frame (heartbeat) — ignore
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    if (event === null) return; // pure comment frame, nothing to dispatch
    const data = dataLines.join('\n');

    switch (event) {
      case 'meta': {
        let parsed: {
          cols: number; rows: number;
          truncated?: boolean; omittedBytes?: number; resize?: boolean;
        };
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // malformed frame — drop rather than crash the pump
        }
        // Geometry-only: the daemon marks the mid-stream form, which has no
        // snapshot behind it. Dispatch it straight through so the mirror
        // resizes its grid WITHOUT resetting and losing its scrollback.
        if (parsed.resize) {
          this.dispatchResize(attachment, parsed);
          return;
        }
        // Belt and braces for a peer that sends a bare meta without the marker:
        // a held meta that a second meta overtakes was never going to get its
        // snapshot either, so let it out as geometry rather than dropping it.
        this.flushPendingMetaAsResize(attachment);
        attachment.pendingMeta = parsed;
        return;
      }
      case 'snapshot': {
        const meta = attachment.pendingMeta;
        if (!meta) return; // snapshot without a preceding meta — nothing to combine with
        attachment.pendingMeta = null;
        const evt: RemoteMetaEvent = {
          attachId: attachment.attachId,
          cols: meta.cols,
          rows: meta.rows,
          snapshotB64: data,
          ...(meta.truncated !== undefined ? { truncated: meta.truncated } : {}),
          ...(meta.omittedBytes !== undefined ? { omittedBytes: meta.omittedBytes } : {}),
        };
        for (const cb of this.metaCbs) cb(evt);
        return;
      }
      case 'data': {
        this.flushPendingMetaAsResize(attachment);
        for (const cb of this.dataCbs) cb({ attachId: attachment.attachId, dataB64: data });
        return;
      }
      case 'exit': {
        this.flushPendingMetaAsResize(attachment);
        for (const cb of this.exitCbs) cb({ attachId: attachment.attachId });
        return;
      }
      default:
        // Unknown/fan-out event (e.g. `attention`) — never treat as pane bytes.
        return;
    }
  }

  /** A held meta that turned out to have no snapshot behind it is geometry. */
  private flushPendingMetaAsResize(attachment: Attachment): void {
    const held = attachment.pendingMeta;
    if (!held) return;
    attachment.pendingMeta = null;
    this.dispatchResize(attachment, held);
  }

  private dispatchResize(attachment: Attachment, geometry: { cols: number; rows: number }): void {
    const evt: RemoteResizeEvent = {
      attachId: attachment.attachId,
      cols: geometry.cols,
      rows: geometry.rows,
    };
    for (const cb of this.resizeCbs) cb(evt);
  }

  private scheduleReconnect(attachment: Attachment, err: unknown): void {
    if (attachment.detached) return;
    if (attachment.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      const message = err instanceof Error ? err.message : String(err ?? 'stream error');
      for (const cb of this.errorCbs) cb({ attachId: attachment.attachId, message });
      return;
    }
    const delay = backoffForAttempt(attachment.reconnectAttempt);
    attachment.reconnectAttempt += 1;
    attachment.reconnectTimer = setTimeout(() => {
      attachment.reconnectTimer = null;
      if (attachment.detached) return;
      this.openStream(attachment);
    }, delay);
  }
}
