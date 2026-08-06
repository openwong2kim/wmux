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
import type { RemoteHost, RemoteWorkspacesResponse } from '../../shared/remoteHosts';

export interface RemoteMetaEvent {
  attachId: string;
  cols: number;
  rows: number;
  snapshotB64: string;
  truncated?: boolean;
  omittedBytes?: number;
}

export interface RemoteDataEvent {
  attachId: string;
  dataB64: string;
}

export interface RemoteExitEvent {
  attachId: string;
}

export interface RemotePaneEvents {
  onMeta(cb: (e: RemoteMetaEvent) => void): void;
  onData(cb: (e: RemoteDataEvent) => void): void;
  onExit(cb: (e: RemoteExitEvent) => void): void;
}

// Reconnect backoff: 1s -> 2s -> 5s, capped, with +/-30% jitter so that a
// tailnet blip affecting several mirrors at once does not have them all
// hammer the remote host in lockstep.
const BACKOFF_STEPS_MS = [1000, 2000, 5000];
const JITTER_RATIO = 0.3;

// Write coalescing window: two POSTs in flight at once can land out of order
// and scramble keystrokes, and per-character POSTs at desktop typing rates
// are wasteful, so writes that arrive while one is in flight are queued and
// merged into a single follow-up POST.
const WRITE_COALESCE_MS = 5;

interface Attachment {
  attachId: string;
  sessionId: string;
  controller: AbortController;
  // Buffered meta JSON, held until the paired `snapshot` frame arrives so a
  // single onMeta callback carries cols/rows/snapshotB64/truncated together
  // (matching the RemotePaneEvents contract — there is no separate onSnapshot).
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

export class RemoteHostClient implements RemotePaneEvents {
  private readonly host: RemoteHost;
  private readonly fetchImpl: typeof fetch;

  private readonly attachments = new Map<string, Attachment>();
  private readonly writeQueues = new Map<string, WriteQueueState>();

  private metaCbs: Array<(e: RemoteMetaEvent) => void> = [];
  private dataCbs: Array<(e: RemoteDataEvent) => void> = [];
  private exitCbs: Array<(e: RemoteExitEvent) => void> = [];

  constructor(host: RemoteHost, fetchImpl: typeof fetch = fetch) {
    this.host = host;
    this.fetchImpl = fetchImpl;
  }

  onMeta(cb: (e: RemoteMetaEvent) => void): void {
    this.metaCbs.push(cb);
  }

  onData(cb: (e: RemoteDataEvent) => void): void {
    this.dataCbs.push(cb);
  }

  onExit(cb: (e: RemoteExitEvent) => void): void {
    this.exitCbs.push(cb);
  }

  async listWorkspaces(): Promise<RemoteWorkspacesResponse> {
    const res = await this.fetchImpl(`${this.host.origin}/api/workspaces`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`listWorkspaces failed: HTTP ${res.status}`);
    }
    return (await res.json()) as RemoteWorkspacesResponse;
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
        { headers: this.authHeaders(), signal: attachment.controller.signal },
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
    // Successful (re)connect resets the backoff schedule.
    attachment.reconnectAttempt = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
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
        let parsed: { cols: number; rows: number; truncated?: boolean; omittedBytes?: number };
        try {
          parsed = JSON.parse(data);
        } catch {
          return; // malformed frame — drop rather than crash the pump
        }
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
        for (const cb of this.dataCbs) cb({ attachId: attachment.attachId, dataB64: data });
        return;
      }
      case 'exit': {
        for (const cb of this.exitCbs) cb({ attachId: attachment.attachId });
        return;
      }
      default:
        // Unknown/fan-out event (e.g. `attention`) — never treat as pane bytes.
        return;
    }
  }

  private scheduleReconnect(attachment: Attachment, _err: unknown): void {
    if (attachment.detached) return;
    const delay = backoffForAttempt(attachment.reconnectAttempt);
    attachment.reconnectAttempt += 1;
    attachment.reconnectTimer = setTimeout(() => {
      attachment.reconnectTimer = null;
      if (attachment.detached) return;
      this.openStream(attachment);
    }, delay);
  }
}
