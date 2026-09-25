import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ChatSendResult, TranscriptAppendData, TranscriptPage, TranscriptStatus, TurnEvent } from '../../shared/transcript/turnEvents';
import { validStoredEvent } from '../chat/storedEvent';
import { OPENCODE_REQUEST_MAX_BYTES } from '../chat/chatBridge';

interface Owner { pid: number; incarnation: string }
interface NativeRead { status: TranscriptStatus; page: TranscriptPage }
export interface TerminalChatSendOutcome { result: ChatSendResult; reason?: 'receipts-full' | 'transport-lost' | 'too-large' | 'unauthorized' }
interface Watch { clients: Set<string>; timer: ReturnType<typeof setInterval>; busy: boolean; seq: number; digest?: string; epoch?: string; ids?: Set<string>; last?: NativeRead }
export interface TerminalChatDependencies {
  directory: string;
  /** Fresh process attribution, never a persisted/hook-only agent label. */
  owner(id: string): Promise<Owner | undefined>;
  emit(id: string, data: TranscriptAppendData, clients: readonly string[]): void;
}
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Optional authenticated bridge INSIDE a native TUI, not a new model process.
 * RPCs never accept a port, token, PID or native session chosen by the renderer.
 * Reads and sends revalidate pane process ownership at every asynchronous edge. */
export class TerminalChatService {
  private watches = new Map<string, Watch>();
  constructor(private readonly deps: TerminalChatDependencies) {}

  async read(id: string): Promise<NativeRead | null> {
    const result = await this.request(id, { action: 'read' });
    if (!result) return null;
    if (result.available === false) return { status: { available: false, reason: 'stale-session', agentAlive: true }, page: this.page([], '') };
    const sessionId = result.sessionId;
    const epoch = result.epoch;
    if (typeof sessionId !== 'string' || !/^ses_[a-zA-Z0-9]+$/.test(sessionId) || typeof epoch !== 'string' || epoch.length > 256 ||
        !Array.isArray(result.events) || result.events.length > 3000 || !result.events.every(validStoredEvent) ||
        !['complete', 'running', 'awaiting_input'].includes(String(result.phase))) return null;
    const phase = result.phase as 'complete' | 'running' | 'awaiting_input';
    return { status: { available: true, reason: 'ok', agentSessionId: sessionId, agentAlive: true, agentStatus: phase,
      terminal: { kind: 'terminal', agent: 'opencode', nativeSessionId: sessionId, historyTruncated: result.truncated === true,
        capabilities: { history: true, send: phase === 'complete', permissions: false, cancel: false, fileUndo: false } },
    }, page: { ...this.page(result.events as TurnEvent[], epoch), truncatedHead: result.truncated === true } };
  }

  /**
   * `expectedRawEpoch` pins the history the caller last read: a route switch
   * away and back keeps the `ses_` id but not the generation, and the fresh
   * read's epoch would otherwise be forwarded unchecked (N15). `reason` tells
   * "nothing reached the plugin" from "the request left and the answer was
   * lost" (`transport-lost`, uncertain) and names the plugin's own refusals.
   */
  async send(id: string, sessionId: string, text: string, requestId: string,
    opts: { expectedRawEpoch?: string; authorized?: (stage?: 'first-write' | 'submit') => Promise<boolean> } = {}): Promise<TerminalChatSendOutcome> {
    const read = await this.read(id);
    if (!read?.status.available) return { result: 'unavailable' };
    if (read.status.agentSessionId !== sessionId) return { result: 'session_changed' };
    const epoch = read.page.cursor.historyEpoch ?? '';
    if (opts.expectedRawEpoch !== undefined && opts.expectedRawEpoch !== epoch) return { result: 'session_changed' };
    // Plugin repeats the selected-session, phase and generation checks directly
    // beside native dispatch; a server-side route switch cannot target another chat.
    const request = { action: 'send', sessionId, epoch, text, requestId };
    // The plugin destroys an oversize body mid-read; that must never read as
    // "may have been delivered" (N16).
    if (Buffer.byteLength(JSON.stringify(request)) > OPENCODE_REQUEST_MAX_BYTES) return { result: 'error', reason: 'too-large' };
    const answer = await this.exchange(id, request, opts.authorized);
    if (!answer.ok && answer.unauthorized) return { result: 'error', reason: 'unauthorized' };
    if (!answer.ok) return answer.left ? { result: 'unconfirmed', reason: 'transport-lost' } : { result: 'unavailable' };
    const value = answer.body.result;
    const result = ['sent', 'busy', 'blocked', 'unconfirmed', 'session_changed', 'unavailable', 'error'].includes(String(value)) ? value as ChatSendResult : 'unconfirmed';
    // An older plugin answers a full receipt map with a bare `unavailable`.
    return result === 'unavailable' && answer.body.reason === 'receipts-full' ? { result, reason: 'receipts-full' } : { result };
  }

  subscribe(client: string, id: string): void {
    const prior = this.watches.get(id);
    if (prior) { if (prior.clients.size < 32) prior.clients.add(client); return; }
    if (this.watches.size >= 128) return;
    const watch: Watch = { clients: new Set([client]), busy: false, seq: 0,
      timer: setInterval(() => { void this.tick(id, watch); }, 1000) };
    watch.timer.unref(); this.watches.set(id, watch);
    void this.tick(id, watch);
  }
  unsubscribe(client: string, id: string): void {
    const watch = this.watches.get(id);
    if (!watch) return;
    watch.clients.delete(client);
    if (!watch.clients.size) { clearInterval(watch.timer); this.watches.delete(id); }
  }
  dropClient(client: string): void { for (const id of this.watches.keys()) this.unsubscribe(client, id); }
  dropPty(id: string): void { const watch = this.watches.get(id); if (watch) clearInterval(watch.timer); this.watches.delete(id); }
  dispose(): void { for (const id of this.watches.keys()) this.dropPty(id); }

  private page(events: TurnEvent[], epoch: string): TranscriptPage {
    return { events, cursor: { historyEpoch: epoch, headOffset: 0, tailOffset: events.length, fileSize: events.length, mtimeMs: 0 }, hasMore: false, truncatedHead: false };
  }
  private async tick(id: string, watch: Watch): Promise<void> {
    if (watch.busy || this.watches.get(id) !== watch) return;
    watch.busy = true;
    try {
      const read = await this.read(id);
      if (this.watches.get(id) !== watch) return;
      const status: TranscriptStatus = read?.status ?? { ...watch.last?.status, available: false, reason: 'unavailable', agentAlive: false,
        ...(watch.last?.status.terminal ? { terminal: { ...watch.last.status.terminal,
          capabilities: { ...watch.last.status.terminal.capabilities, send: false } } } : {}) };
      const page = read?.page ?? (watch.last ? { ...watch.last.page, events: [] } : this.page([], ''));
      const digest = createHash('sha256').update(JSON.stringify([status, page])).digest('hex');
      if (digest === watch.digest) return;
      watch.digest = digest;
      const ids = new Set(page.events.map(e => e.id));
      const reset = !!read && (watch.epoch !== page.cursor.historyEpoch || !!watch.ids && [...watch.ids].some(id => !ids.has(id)));
      if (read) { watch.epoch = page.cursor.historyEpoch; watch.ids = ids; watch.last = read; }
      this.deps.emit(id, { status, seq: ++watch.seq, events: page.events, cursor: page.cursor, ...(reset ? { reset: true } : {}) }, [...watch.clients]);
    } finally { watch.busy = false; }
  }

  private async request(id: string, request: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    const answer = await this.exchange(id, request);
    return answer.ok ? answer.body : null;
  }

  /** `left` is true once the request may have reached the plugin. `authorized`
   *  runs as the last await before the request leaves, after the owner checks. */
  private async exchange(id: string, request: Record<string, unknown>, authorized?: (stage?: 'first-write' | 'submit') => Promise<boolean>):
    Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; left: boolean; unauthorized?: true }> {
    let left = false;
    try {
      const owner = await this.deps.owner(id);
      if (!owner) return { ok: false, left };
      const file = path.join(this.deps.directory, `${createHash('sha256').update(id).digest('hex')}.json`);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 1024 || process.platform !== 'win32' && (stat.mode & 0o077 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) return { ok: false, left };
      const record = object(JSON.parse(await fs.readFile(file, 'utf8')));
      if (record.version !== 1 || record.agent !== 'opencode' || record.pid !== owner.pid || !Number.isInteger(record.port) ||
          Number(record.port) < 1 || Number(record.port) > 65535 || typeof record.token !== 'string' || !/^[0-9a-f]{64}$/.test(record.token)) return { ok: false, left };
      const sameOwner = async () => JSON.stringify(await this.deps.owner(id)) === JSON.stringify(owner);
      if (!await sameOwner()) return { ok: false, left };
      if (authorized) {
        let ok = false;
        try { ok = await authorized('first-write'); } catch { /* a failed check is a refusal */ }
        if (!ok) return { ok: false, left, unauthorized: true };
      }
      left = true;
      let response: Response;
      try {
        response = await fetch(`http://127.0.0.1:${record.port}/`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
          headers: { Authorization: `Bearer ${record.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      } catch (error) {
        // A refused connection provably delivered nothing.
        if ((error as { cause?: { code?: unknown } })?.cause?.code === 'ECONNREFUSED') left = false;
        throw error;
      }
      // The plugin answers non-2xx only before dispatch (bad auth, unparsable body).
      if (!response.ok) return { ok: false, left: false };
      if (!response.body) return { ok: false, left };
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 128000) { await reader.cancel(); return { ok: false, left }; }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      if (!await sameOwner()) return { ok: false, left };
      return { ok: true, body: object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) };
    } catch { return { ok: false, left }; }
  }
}
