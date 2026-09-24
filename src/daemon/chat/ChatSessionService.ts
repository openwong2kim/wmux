import fs from 'node:fs';
import { validStoredEvent } from './storedEvent';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { ChatControlResult, ChatInteraction, ChatInteractionAnswer, ManagedChatStatus } from '../../shared/transcript/chatSession';
import type { ChatSendResult, TranscriptPage, TranscriptStatus, TurnEvent } from '../../shared/transcript/turnEvents';
import { BASE_CAPABILITIES, deadline, type ChatAdapter, type ChatProvider } from './adapter';

interface StoredSession {
  version: 1;
  id: string;
  providerId: string;
  cwd: string;
  sessionId?: string;
  events: TurnEvent[];
  revision: number;
  inFlight?: string;
  receipts: Record<string, { textHash: string; result: ChatSendResult }>;
  historyTruncated?: boolean;
  historyEpoch?: string;
}
interface Session {
  saved: StoredSession;
  status: ManagedChatStatus;
  adapter?: ChatAdapter;
  epoch: number;
  saving?: ReturnType<typeof setTimeout>;
  cancelTimer?: ReturnType<typeof setTimeout>;
  cancelRequested?: boolean;
  bytes: number;
  sizes: Map<string, number>;
  pending: Map<string, { request: ChatInteraction; resolve: (answer: ChatInteractionAnswer) => void; answering: boolean }>;
}
export interface ChatSessionDeps {
  directory: string;
  providers: ChatProvider[];
  /** Must return trusted spawn cwd, not terminal-emitted OSC cwd. */
  pane: (id: string) => { cwd: string; env: NodeJS.ProcessEnv } | undefined;
  changed: (id: string) => void;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (error: unknown): ChatControlResult => ({ ok: false, error: error instanceof Error ? error.message : 'Chat operation failed' });
const MAX_BYTES = 4 * 1024 * 1024;

/** Owns session identity, durable send intents and provider-independent controls.
 * Closing a UI subscription never closes a running session. */
export class ChatSessionService {
  private sessions = new Map<string, Session>();
  private providers: Map<string, ChatProvider>;
  constructor(private deps: ChatSessionDeps) {
    this.providers = new Map();
    for (const provider of deps.providers) {
      if (this.providers.has(provider.id)) throw new Error(`Duplicate chat provider: ${provider.id}`);
      this.providers.set(provider.id, provider);
    }
  }
  listProviders() { return [...this.providers.values()].map(({ id, name, transport }) => ({ id, name, transport })); }
  private file(id: string) { return path.join(this.deps.directory, `${hash(id)}.json`); }
  private get(id: string): Session | undefined {
    const existing = this.sessions.get(id); if (existing) return existing;
    try {
      const file = this.file(id); const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return;
      const saved: StoredSession = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || saved.id !== id || !Array.isArray(saved.events) || !saved.receipts ||
        !Number.isSafeInteger(saved.revision) || typeof saved.cwd !== 'string' || typeof saved.sessionId !== 'string' || saved.events.length > 2000 || saved.events.some((event) => !validStoredEvent(event)) ||
        typeof saved.receipts !== 'object' || Array.isArray(saved.receipts) ||
        (saved.historyEpoch !== undefined && typeof saved.historyEpoch !== 'string') ||
        Object.values(saved.receipts).some((receipt) => !receipt || typeof receipt.textHash !== 'string' || !['sent', 'unconfirmed'].includes(receipt.result))) return;
      const provider = this.providers.get(saved.providerId); if (!provider) return;
      const session: Session = { saved, epoch: 0, bytes: Buffer.byteLength(JSON.stringify(saved.events)), sizes: new Map(saved.events.map((event) => [event.id, Buffer.byteLength(JSON.stringify(event))])), pending: new Map(), status: {
        provider: { id: provider.id, name: provider.name, transport: provider.transport },
        capabilities: { ...BASE_CAPABILITIES, send: false, cancel: false },
        phase: saved.inFlight ? 'unconfirmed' : 'disconnected', pending: [], historyTruncated: saved.historyTruncated,
      } };
      this.sessions.set(id, session); return session;
    } catch { return; }
  }
  has(id: string) { return !!this.get(id); }
  status(id: string): TranscriptStatus | undefined {
    const session = this.get(id); if (!session) return;
    const phase = session.status.phase;
    return { available: true, reason: 'ok', agentSessionId: session.saved.sessionId ?? session.saved.id,
      agentAlive: true, agentStatus: phase === 'running' ? 'running' : phase === 'blocked' ? 'awaiting_input' : phase === 'ready' ? 'complete' : 'idle',
      managed: { ...session.status, historyTruncated: session.saved.historyTruncated, pending: [...session.pending.values()].map((p) => p.request) },
    };
  }
  snapshot(id: string, before?: number): TranscriptPage | null {
    const session = this.get(id); if (!session) return null;
    const all = session.saved.events;
    const end = before === undefined ? all.length : Math.max(0, Math.min(all.length, before));
    let start = end; let bytes = 0;
    while (start > 0 && end - start < 80) {
      const size = Buffer.byteLength(JSON.stringify(all[start - 1]));
      if (bytes + size > 192_000) break;
      bytes += size; start--;
    }
    return { events: all.slice(start, end), hasMore: start > 0, truncatedHead: !!session.saved.historyTruncated,
      cursor: { headOffset: start, tailOffset: session.saved.revision, fileSize: session.saved.revision, mtimeMs: 0, historyEpoch: session.saved.historyEpoch } };
  }
  private save(session: Session): void {
    if (session.saving) clearTimeout(session.saving); session.saving = undefined;
    fs.mkdirSync(this.deps.directory, { recursive: true, mode: 0o700 });
    const file = this.file(session.saved.id); const temp = `${file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(session.saved)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
    } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* renamed */ } }
  }
  private changed(session: Session): void { this.deps.changed(session.saved.id); }
  private emit(session: Session, event: TurnEvent): void {
    // Bound both per-row payloads and retained history. Show retention explicitly.
    let bounded = event;
    if ('text' in event && event.text.length > 32_000) bounded = { ...event, text: event.text.slice(0, 32_000), truncated: true };
    if (Buffer.byteLength(JSON.stringify(bounded)) > 192_000) {
      bounded = { id: event.id, kind: 'meta', subtype: 'unknown', label: 'Agent output exceeded the display limit.' };
    }
    const size = Buffer.byteLength(JSON.stringify(bounded));
    session.bytes += size - (session.sizes.get(bounded.id) ?? 0);
    session.sizes.set(bounded.id, size);
    const index = session.saved.events.findIndex((row) => row.id === bounded.id);
    if (index >= 0) session.saved.events[index] = bounded; else session.saved.events.push(bounded);
    while (session.saved.events.length > 2000 || session.bytes > MAX_BYTES) {
      const removed = session.saved.events.shift();
      if (removed) { session.bytes -= session.sizes.get(removed.id) ?? 0; session.sizes.delete(removed.id); }
      session.saved.historyTruncated = true;
      session.saved.historyEpoch = randomUUID();
    }
    session.saved.revision++;
    if (!session.saving) session.saving = setTimeout(() => {
      try { this.save(session); } catch { this.disconnect(session, 'Unable to persist chat history'); }
    }, 200);
    this.changed(session);
  }
  async start(id: string, providerId: string): Promise<ChatControlResult> {
    if (this.get(id)) return { ok: false, error: 'This pane already owns a chat session' };
    if (fs.existsSync(this.file(id))) return { ok: false, error: 'Saved chat cannot be restored; its data has been preserved' };
    if (this.sessions.size >= 32) return { ok: false, error: 'Managed chat session limit reached' };
    const pane = this.deps.pane(id); const provider = this.providers.get(providerId);
    if (!pane || !provider) return { ok: false, error: 'Pane or provider unavailable' };
    const session: Session = { epoch: 0, bytes: 2, sizes: new Map(), pending: new Map(),
      saved: { version: 1, id, providerId, cwd: pane.cwd, events: [], revision: 1, receipts: {} },
      status: { provider: { id: provider.id, name: provider.name, transport: provider.transport }, phase: 'connecting',
        capabilities: { ...BASE_CAPABILITIES, send: false }, pending: [] },
    };
    this.sessions.set(id, session);
    return this.connect(session);
  }
  async reconnect(id: string, sessionId: string): Promise<ChatControlResult> {
    const session = this.get(id);
    if (!session || (session.saved.sessionId ?? id) !== sessionId) return { ok: false, error: 'Session changed' };
    if (['connecting', 'running', 'blocked'].includes(session.status.phase)) return { ok: false, error: 'Session is busy' };
    return this.connect(session);
  }
  private async connect(session: Session): Promise<ChatControlResult> {
    const pane = this.deps.pane(session.saved.id); const provider = this.providers.get(session.saved.providerId);
    if (!pane || pane.cwd !== session.saved.cwd || !provider) return { ok: false, error: 'Session workspace changed' };
    const epoch = ++session.epoch;
    session.adapter?.close(); this.clearPending(session);
    const adapter = provider.create(); session.adapter = adapter;
    session.status.phase = 'connecting'; session.status.error = undefined; this.changed(session);
    // Stage replay until connection + session identity have been validated.
    const replay = new Map<string, TurnEvent>(); let replayBytes = 0; let connected = false;
    try {
      const nativeId = await deadline(adapter.connect({ cwd: pane.cwd, env: { ...process.env, ...pane.env }, sessionId: session.saved.sessionId,
        emit: (event) => {
          if (epoch !== session.epoch) return;
          if (connected) this.emit(session, event);
          else {
            const bounded = 'text' in event && event.text.length > 32_000 ? { ...event, text: event.text.slice(0, 32_000), truncated: true } : event;
            replayBytes -= Buffer.byteLength(JSON.stringify(replay.get(event.id) ?? null));
            replay.set(event.id, bounded); replayBytes += Buffer.byteLength(JSON.stringify(bounded));
            while (replay.size > 2000 || replayBytes > MAX_BYTES) {
              const first = replay.keys().next().value; if (first === undefined) break;
              replayBytes -= Buffer.byteLength(JSON.stringify(replay.get(first))); replay.delete(first); session.saved.historyTruncated = true;
            }
          }
        },
        request: (request) => {
          if (epoch !== session.epoch || !session.saved.inFlight || session.cancelRequested || session.pending.size >= 16 || JSON.stringify(request).length > 32_000) return Promise.resolve({});
          return new Promise((resolve) => {
            const id = randomUUID(); session.pending.set(id, { request: { ...request, id }, resolve, answering: false });
            session.status.phase = 'blocked'; this.changed(session);
          });
        },
        disconnected: (reason) => { if (epoch === session.epoch) this.disconnect(session, reason); },
      }));
      if (epoch !== session.epoch) { adapter.close(); return { ok: false, error: 'Connection superseded' }; }
      session.saved.sessionId = nativeId;
      if (replay.size) { session.saved.historyEpoch = randomUUID(); session.saved.events = []; session.sizes.clear(); session.bytes = 2; }
      connected = true;
      for (const event of replay.values()) this.emit(session, event);
      // Reconnect never resubmits a saved intent. The user explicitly reconciles
      // against restored history before choosing their next message.
      delete session.saved.inFlight;
      session.status = { ...session.status, phase: 'ready', capabilities: { ...adapter.capabilities } };
      this.save(session); this.changed(session); return { ok: true };
    } catch (error) {
      this.disconnect(session, fail(error).error!); return fail(error);
    }
  }
  async send(id: string, nativeId: string, text: string, requestId: string): Promise<ChatSendResult> {
    const session = this.get(id);
    if (!session || !session.adapter) return 'unavailable';
    if (session.saved.sessionId !== nativeId) return 'session_changed';
    if (!text.trim() || text.length > 16_000 || !/^[a-zA-Z0-9][\w-]{0,127}$/.test(requestId) || ['constructor', 'prototype'].includes(requestId)) return 'error';
    const old = Object.hasOwn(session.saved.receipts, requestId) ? session.saved.receipts[requestId] : undefined;
    if (old) return old.textHash === hash(text) ? old.result : 'error';
    if (session.status.phase === 'blocked') return 'blocked';
    if (session.status.phase !== 'ready') return session.status.phase === 'running' ? 'busy' : 'unconfirmed';
    if (Object.keys(session.saved.receipts).length >= 10_000) return 'unavailable';
    session.saved.inFlight = requestId;
    session.saved.receipts[requestId] = { textHash: hash(text), result: 'unconfirmed' };
    // Write intent BEFORE crossing the process boundary. Persistence failure
    // must leave the provider untouched.
    try { this.save(session); } catch { delete session.saved.inFlight; delete session.saved.receipts[requestId]; return 'error'; }
    session.status.phase = 'running'; session.status.error = undefined; session.cancelRequested = false;
    const epoch = session.epoch;
    const adapter = session.adapter;
    const turn = Promise.resolve().then(() => {
      if (epoch !== session.epoch) throw new Error('Connection changed before dispatch');
      return adapter.prompt(text, requestId);
    });
    void turn.then(() => {
      if (epoch !== session.epoch) return;
      session.saved.receipts[requestId].result = 'sent'; delete session.saved.inFlight;
      if (session.cancelTimer) clearTimeout(session.cancelTimer); session.cancelTimer = undefined;
      session.status.phase = 'ready'; this.clearPending(session);
      this.emit(session, { id: `${requestId}:complete`, kind: 'meta', subtype: 'unknown', label: session.cancelRequested ? 'Turn stopped' : 'Turn completed', turnId: requestId });
      try { this.save(session); } catch { this.disconnect(session, 'Unable to persist completed turn'); }
      this.changed(session);
    }, (error) => { if (epoch === session.epoch) this.disconnect(session, fail(error).error!); });
    this.changed(session); return 'sent';
  }
  async respond(id: string, nativeId: string, requestId: string, answer: ChatInteractionAnswer): Promise<ChatControlResult> {
    const session = this.get(id); const pending = session?.pending.get(requestId);
    if (!session || session.saved.sessionId !== nativeId || !pending || pending.answering || session.cancelRequested || !session.saved.inFlight) return { ok: false, error: 'Request expired or session changed' };
    if (pending.request.kind === 'permission' && !pending.request.options.some((option) => option.id === answer.optionId)) return { ok: false, error: 'Invalid permission response' };
    if (pending.request.kind === 'question') {
      for (const q of pending.request.questions ?? []) {
        const values = answer.answers?.[q.id];
        if (!Array.isArray(values) || !values.length || values.some((v) => typeof v !== 'string' || v.length > 16_000)) return { ok: false, error: 'Answer every question' };
      }
    }
    pending.answering = true; session.pending.delete(requestId); pending.resolve(answer);
    session.status.phase = session.pending.size ? 'blocked' : 'running'; this.changed(session); return { ok: true };
  }
  async cancel(id: string, nativeId: string): Promise<ChatControlResult> {
    const session = this.get(id);
    if (!session?.adapter || session.saved.sessionId !== nativeId || !session.saved.inFlight) return { ok: false, error: 'No active turn' };
    if (session.cancelTimer) return { ok: true };
    session.cancelRequested = true; session.status.phase = 'running'; this.clearPending(session); this.changed(session);
    session.cancelTimer = setTimeout(() => this.disconnect(session, 'Agent did not confirm cancellation'), 15_000);
    try { await deadline(session.adapter.cancel()); return { ok: true }; }
    catch (error) { this.disconnect(session, fail(error).error!); return fail(error); }
  }
  async close(id: string, nativeId: string): Promise<ChatControlResult> {
    const session = this.get(id);
    if (!session || (session.saved.sessionId ?? id) !== nativeId) return { ok: false, error: 'Session changed' };
    if (['connecting', 'running', 'blocked'].includes(session.status.phase)) return { ok: false, error: 'Stop the active turn before closing chat' };
    try {
      this.save(session);
      fs.renameSync(this.file(id), path.join(this.deps.directory, `${hash(id)}-archived-${randomUUID()}.json`));
      this.disconnect(session, 'Chat closed'); this.sessions.delete(id); this.deps.changed(id);
      return { ok: true };
    } catch (error) { return fail(error); }
  }
  private clearPending(session: Session) { for (const pending of session.pending.values()) pending.resolve({}); session.pending.clear(); }
  private disconnect(session: Session, reason: string) {
    session.epoch++; this.clearPending(session);
    if (session.cancelTimer) clearTimeout(session.cancelTimer); session.cancelTimer = undefined;
    const adapter = session.adapter; session.adapter = undefined; adapter?.close();
    session.status.phase = session.saved.inFlight ? 'unconfirmed' : 'disconnected';
    session.status.error = reason; session.status.capabilities.send = false; this.changed(session);
  }
  drop(id: string): void {
    const session = this.sessions.get(id); if (!session) return;
    this.disconnect(session, 'Pane closed');
    try { this.save(session); } catch { /* keep last durable snapshot */ }
    this.sessions.delete(id);
  }
  dispose(): void { for (const id of this.sessions.keys()) this.drop(id); }
}
