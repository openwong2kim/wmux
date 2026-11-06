import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import type { CdpConnection, CdpEventHandler } from './CdpSocket';
import type { CdpPipeDiagnostics } from '../../shared/memoryDiagnostics';

// ---------------------------------------------------------------------------
// One debugging pipe (`--remote-debugging-pipe`: the browser reads fd 3 and
// writes fd 4, one JSON message per NUL-terminated frame) shared by several
// clients: main's own connections (the launcher's watcher, download guard,
// probes) and external ones (CdpPipeEndpoint).
//
// Ownership, not broadcast:
//  - Every client gets a browser session of its own (Target.attachToBrowserTarget),
//    so browser-level state (auto-attach, target discovery) is per client: the
//    browser keeps it per session, and sends each session's events on it.
//  - A client owns its browser session and every session announced on, or
//    attached through, a session it owns. Every frame from the browser goes to
//    the one owner of its session or command id, or nowhere: a frame for an
//    unknown session or id is dropped and counted, never broadcast.
//  - A client may address only sessions it owns. Main's sessions are refused to
//    every external client. A refusal is the browser's own answer for an
//    unknown session, so a client can't tell "not yours" from "not there".
//  - A client's command is parsed and written out anew (its id remapped, its
//    session filled in), never forwarded as sent: duplicate keys or a second
//    sessionId in the text can't reach the browser.
//  - The mux's own commands use ids from MUX_ID_BASE up; their replies are
//    consumed here and never reach a client (a client that sees an id it never
//    sent may fail on it).
//  - Targets themselves stay visible to every client, as on the port: target
//    discovery and Target.getTargets are browser-wide. A TargetGrant (C3's
//    caller identity with C2b's rules) narrows that per client when given.
//
// Cost (measured 2026-11-07, Chrome 149, macOS arm64, a synthetic 6 MB/s
// terminal relay on the same Node event loop; the gate is relative to
// terminal-only on the same machine):
//   terminal only                        busy  6.5%, loop delay p99 2.20 ms
//   + 33 MB/s CDP (1080p screencast +    busy  9.9%, p99 2.04 ms, max  9.5 ms
//     a 4 MB body every 0.5 s)           (parse 25.5 ms/s, routing 2.6 ms/s)
//   + 54 MB/s (16 MB bodies)             busy 13.3%, p99 2.05 ms, max 23.7 ms
// JSON.parse runs ~0.8 ms per MB; the stall that matters is the largest single
// frame (~0.85 ms per MB of it). Ceiling: delay p99 within +2 ms, busy within
// +10 points at 33 MB/s, and a single-frame stall under 50 ms at 20 MiB. To be
// repeated in packaged Electron main under real terminal load before the pipe
// becomes the default. Over the ceiling, in order: route big replies by their
// parse-checked head, then tail routing, then a separate process.
// ---------------------------------------------------------------------------

/** Ids at and above this are the mux's own commands. */
export const MUX_ID_BASE = 2 ** 30;
/** How long a connection's command waits on the browser, unless the connection says otherwise. */
export const CDP_PIPE_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_TIMEOUT_MS = CDP_PIPE_COMMAND_TIMEOUT_MS;

/** The browser's answer for a session it does not know. */
const UNKNOWN_SESSION = { code: -32001, message: 'Session with given id not found.' };
/** Its answer when a Target command names, in its params, a session it does not know. */
const UNKNOWN_TARGET = { code: -32602, message: 'No target with given id found' };
const UNKNOWN_PARAM_SESSION = { code: -32602, message: 'No session with given id' };
/**
 * Commands that name a session in their params. The browser already scopes
 * them to the session the command is sent on (measured: one browser session
 * cannot detach, or message, another's); the mux checks them too.
 */
const PARAM_SESSION_METHODS = new Set(['Target.detachFromTarget', 'Target.sendMessageToTarget']);
/** The mux's own ids wrap back to MUX_ID_BASE below this. */
const MUX_ID_LIMIT = 2 ** 31 - 1;

interface Frame {
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: { message?: unknown };
  sessionId?: unknown;
}

/** A command a client may send; anything else in its frame is dropped. */
export interface ClientCommand {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/**
 * A place for C2b's method blocks and download ownership. Returns an error to
 * refuse a command; nothing is refused here yet.
 */
export type ClientCommandFilter = (client: { kind: 'internal' | 'external'; label: string }, command: ClientCommand) => { code: number; message: string } | null;

/**
 * Whether `client` may see and address the target `targetId`: C3's caller
 * identity with C2b's rules. Without one every target is every client's, as on
 * the port. With one, a target not granted to a client is, to that client, not
 * there: commands naming it get the browser's own unknown-target answer, its
 * target events and its Target.getTargets entry are left out, and a session
 * auto-attached to it is detached again rather than handed over.
 */
export type TargetGrant = (client: { kind: 'internal' | 'external'; label: string }, targetId: string) => boolean;

/** Shown by `wmux doctor --performance` (perf.status). */
export type CdpPipeCounters = CdpPipeDiagnostics;

const totals: CdpPipeCounters = { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0 };

/** Copies of the counters across every mux, for the app's diagnostics. */
export function cdpPipeCounters(): CdpPipeCounters {
  return { ...totals, dropped: { ...totals.dropped } };
}

/** Tests only. */
export function resetCdpPipeCounters(): void {
  Object.assign(totals, { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0 });
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

interface Pending {
  client: Client;
  /** The id the client sent (external) or its waiter (internal). */
  clientId: number;
  method: string;
}

/** One client of the mux: its browser session and the sessions it owns. */
abstract class Client {
  browserSession: string | null = null;
  /** In flight: the mux's attachToBrowserTarget for this client. */
  attaching: Promise<string> | null = null;
  readonly owned = new Set<string>();
  closed = false;
  /** Bumped by every detach, so an attach that lands after a close is not published. */
  epoch = 0;

  constructor(readonly kind: 'internal' | 'external', readonly label: string) {}

  /** A reply to a command this client sent. */
  abstract reply(clientId: number, frame: Frame, text: string): void;
  /** An event on a session this client owns. */
  abstract event(frame: Frame, text: string): void;
  /** The client was released or the mux ended; `hadSession` when it had a browser session open. */
  abstract gone(reason: string, hadSession: boolean): void;
}

export class CdpPipeMux {
  private readonly clients = new Set<Client>();
  private readonly owner = new Map<string, Client>();
  private readonly pending = new Map<number, Pending>();
  private readonly own = new Map<number, { resolve: (v: Frame) => void; reject: (e: Error) => void }>();
  private nextClientCommandId = 1;
  private nextOwnId = MUX_ID_BASE;
  private carry: Buffer[] = [];
  private open = true;

  constructor(
    private readonly toBrowser: Writable,
    fromBrowser: Readable,
    private readonly opts: {
      /** The pipe closed or failed: every client is told, and the mux is done. */
      onClose?: () => void;
      /** C2b. */
      filter?: ClientCommandFilter;
      /** C3 and C2b. */
      targetGrant?: TargetGrant;
    } = {},
  ) {
    fromBrowser.on('data', (chunk: Buffer) => this.onData(chunk));
    const end = () => this.end('connection closed');
    fromBrowser.once('end', end);
    fromBrowser.once('close', end);
    fromBrowser.once('error', end);
    toBrowser.once('error', end);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** A connection for main itself, shaped like the launcher's WebSocket one. */
  connect(opts: { label?: string; timeoutMs?: number; onDisconnect?: () => void } = {}): CdpConnection {
    return new InternalConnection(this, opts);
  }

  /**
   * An external client. `send` receives each frame for it as text; the
   * returned `receive` takes each frame it sends. `close` ends it and frees
   * every session it owned.
   */
  attachExternal(label: string, send: (text: string) => void, onGone: (reason: string) => void): { receive: (text: string) => void; close: () => void } {
    const client = new ExternalClient(label, send, onGone);
    this.clients.add(client);
    return {
      receive: (text) => this.fromExternal(client, text),
      close: () => this.release(client, 'closed'),
    };
  }

  /** Close the pipe. The browser exits when it reads the end of its input. */
  close(): void {
    this.toBrowser.end();
    this.end('closed');
  }

  // ── Clients ───────────────────────────────────────────────────────────────

  /** @internal */ registerInternal(client: Client): void {
    this.clients.add(client);
  }

  /** @internal Send a command for `client`, opening its browser session first. */
  async submit(client: Client, clientId: number, command: ClientCommand): Promise<void> {
    const refusal = this.opts.filter?.(client, command) ?? null;
    if (refusal) {
      totals.refused++;
      client.reply(clientId, { id: clientId, error: refusal }, JSON.stringify({ id: clientId, error: refusal }));
      return;
    }
    const session = command.sessionId ?? (await this.browserSessionOf(client));
    if (command.sessionId !== undefined && !client.owned.has(command.sessionId)) {
      totals.refused++;
      client.reply(clientId, { id: clientId, error: UNKNOWN_SESSION }, JSON.stringify({ id: clientId, error: UNKNOWN_SESSION }));
      return;
    }
    const named = command.params.sessionId;
    if (PARAM_SESSION_METHODS.has(command.method) && named !== undefined && (typeof named !== 'string' || !client.owned.has(named))) {
      totals.refused++;
      client.reply(clientId, { id: clientId, error: UNKNOWN_PARAM_SESSION }, JSON.stringify({ id: clientId, error: UNKNOWN_PARAM_SESSION }));
      return;
    }
    const target = command.params.targetId;
    if (typeof target === 'string' && !this.granted(client, target)) {
      totals.refused++;
      client.reply(clientId, { id: clientId, error: UNKNOWN_TARGET }, JSON.stringify({ id: clientId, error: UNKNOWN_TARGET }));
      return;
    }
    if (client.closed || !this.open) return;
    const id = this.nextClientCommandId++;
    if (this.nextClientCommandId >= MUX_ID_BASE) this.nextClientCommandId = 1;
    this.pending.set(id, { client, clientId, method: command.method });
    this.write({ id, method: command.method, params: command.params, sessionId: session });
  }

  /** @internal Drop a client: its sessions, its browser session, its pending replies. False when it was not attached. */
  release(client: Client, reason: string): boolean {
    if (!this.clients.has(client)) return false;
    const session = client.browserSession;
    this.detachClient(client);
    this.clients.delete(client);
    client.closed = true;
    if (session && this.open) this.ownCommand('Target.detachFromTarget', { sessionId: session }).catch(() => undefined);
    client.gone(reason, session !== null);
    return true;
  }

  /** @internal Forget a client's sessions (it closed, or will reattach on its next send). */
  detachClient(client: Client): void {
    client.epoch++;
    for (const session of client.owned) this.owner.delete(session);
    client.owned.clear();
    client.browserSession = null;
    client.attaching = null;
    for (const [id, p] of this.pending) if (p.client === client) this.pending.delete(id);
  }

  private browserSessionOf(client: Client): Promise<string> {
    if (client.browserSession) return Promise.resolve(client.browserSession);
    if (client.attaching) return client.attaching;
    const epoch = client.epoch;
    const attaching = this.ownCommand('Target.attachToBrowserTarget', {}).then((frame) => {
      const session = (frame.result as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof session !== 'string') throw new Error('the browser named no session');
      if (client.epoch !== epoch || client.closed) {
        // Closed while attaching: the session is nobody's.
        this.ownCommand('Target.detachFromTarget', { sessionId: session }).catch(() => undefined);
        throw new Error('disposed');
      }
      client.browserSession = session;
      this.adopt(client, session);
      return session;
    });
    client.attaching = attaching;
    attaching.catch(() => { if (client.attaching === attaching) client.attaching = null; });
    return attaching;
  }

  private granted(client: Client, targetId: string): boolean {
    return this.opts.targetGrant?.(client, targetId) ?? true;
  }

  private adopt(client: Client, session: string): void {
    if (this.owner.has(session)) return; // the browser's session ids are unique; never reassign one
    this.owner.set(session, client);
    client.owned.add(session);
  }

  private ownCommand(method: string, params: Record<string, unknown>, sessionId?: string): Promise<Frame> {
    if (!this.open) return Promise.reject(new Error('the pipe is closed'));
    const id = this.nextOwnId++;
    if (this.nextOwnId >= MUX_ID_LIMIT) this.nextOwnId = MUX_ID_BASE;
    return new Promise((resolve, reject) => {
      this.own.set(id, { resolve, reject });
      this.write({ id, method, params, ...(sessionId && { sessionId }) });
    });
  }

  private write(message: Record<string, unknown>): void {
    this.toBrowser.write(`${JSON.stringify(message)}\0`);
  }

  // ── External input ───────────────────────────────────────────────────────

  private fromExternal(client: Client, text: string): void {
    if (client.closed) return;
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      totals.refused++;
      return;
    }
    const id = frame?.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
      totals.refused++;
      return;
    }
    const refuse = (error: { code: number; message: string }) => {
      totals.refused++;
      client.reply(id, { id, error }, JSON.stringify({ id, error }));
    };
    if (typeof frame.method !== 'string') { refuse({ code: -32600, message: "Message must have string 'method' property" }); return; }
    if (frame.params !== undefined && (frame.params === null || typeof frame.params !== 'object' || Array.isArray(frame.params))) {
      refuse({ code: -32602, message: 'Invalid parameters' });
      return;
    }
    if ('sessionId' in frame && typeof frame.sessionId !== 'string') { refuse(UNKNOWN_SESSION); return; }
    void this.submit(client, id, {
      method: frame.method,
      params: (frame.params as Record<string, unknown> | undefined) ?? {},
      ...(typeof frame.sessionId === 'string' && { sessionId: frame.sessionId }),
    }).catch(() => refuse({ code: -32000, message: 'The browser session could not be opened' }));
  }

  // ── Browser output ───────────────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    let start = 0;
    for (let end = chunk.indexOf(0, start); end !== -1; end = chunk.indexOf(0, start)) {
      const part = chunk.subarray(start, end);
      const frame = this.carry.length ? Buffer.concat([...this.carry, part]) : part;
      this.carry = [];
      start = end + 1;
      this.onFrame(frame);
    }
    if (start < chunk.length) this.carry.push(chunk.subarray(start));
  }

  private onFrame(buf: Buffer): void {
    const started = performance.now();
    const text = buf.toString('utf8');
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      bump(totals.dropped, 'unparsable');
      return;
    }
    const ms = performance.now() - started;
    totals.frames++;
    totals.bytes += buf.length;
    totals.parseMsTotal += ms;
    totals.parseMsMax = Math.max(totals.parseMsMax, ms);
    totals.largestFrameBytes = Math.max(totals.largestFrameBytes, buf.length);
    if (frame === null || typeof frame !== 'object') { bump(totals.dropped, 'not-an-object'); return; }

    if (typeof frame.id === 'number') {
      if (frame.id >= MUX_ID_BASE) {
        const waiter = this.own.get(frame.id);
        this.own.delete(frame.id);
        if (!waiter) bump(totals.dropped, 'unknown-own-id');
        else if (frame.error) waiter.reject(new Error(String(frame.error.message ?? 'CDP error')));
        else waiter.resolve(frame);
        return;
      }
      const job = this.pending.get(frame.id);
      if (!job) { bump(totals.dropped, 'unknown-id'); return; }
      this.pending.delete(frame.id);
      if (job.client.closed) return;
      // A session attached by the client's own command is the client's.
      if ((job.method === 'Target.attachToTarget' || job.method === 'Target.attachToBrowserTarget') && !frame.error) {
        const session = (frame.result as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof session === 'string') this.adopt(job.client, session);
      }
      if (job.method === 'Target.getTargets' && this.opts.targetGrant && !frame.error) {
        const infos = (frame.result as { targetInfos?: Array<{ targetId?: unknown }> } | undefined)?.targetInfos;
        if (Array.isArray(infos)) {
          const shown = { ...frame, result: { ...(frame.result as Record<string, unknown>), targetInfos: infos.filter((t) => typeof t.targetId === 'string' && this.granted(job.client, t.targetId)) } };
          job.client.reply(job.clientId, shown, JSON.stringify(shown));
          return;
        }
      }
      job.client.reply(job.clientId, frame, text);
      return;
    }

    if (typeof frame.method !== 'string') { bump(totals.dropped, 'neither-reply-nor-event'); return; }
    if (typeof frame.sessionId !== 'string') { bump(totals.dropped, 'root-event'); return; }
    const owner = this.owner.get(frame.sessionId);
    if (!owner) { bump(totals.dropped, 'unknown-session'); return; }
    // Grants are checked where targets are discovered, on the client's browser
    // session. A page's own frames and workers come on that page's session and
    // go with the page. A session the client owns is always told it ended.
    if (this.opts.targetGrant && frame.sessionId === owner.browserSession && frame.method.startsWith('Target.')) {
      const params = frame.params as { targetId?: unknown; targetInfo?: { targetId?: unknown }; sessionId?: unknown } | undefined;
      const target = params?.targetInfo?.targetId ?? params?.targetId;
      const endsOwned = frame.method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string' && owner.owned.has(params.sessionId);
      if (typeof target === 'string' && !endsOwned && !this.granted(owner, target)) {
        bump(totals.dropped, 'ungranted-target');
        // Auto-attached to a target the client may not have: let it go again, on the session it came on.
        if (frame.method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') {
          this.ownCommand('Target.detachFromTarget', { sessionId: params.sessionId }, frame.sessionId).catch(() => undefined);
        }
        return;
      }
    }
    if (frame.method === 'Target.attachedToTarget') {
      const child = (frame.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof child === 'string') this.adopt(owner, child);
    }
    owner.event(frame, text);
    if (frame.method === 'Target.detachedFromTarget') {
      const child = (frame.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof child === 'string' && this.owner.get(child) === owner && child !== owner.browserSession) {
        this.owner.delete(child);
        owner.owned.delete(child);
      }
    }
  }

  private end(reason: string): void {
    if (!this.open) return;
    this.open = false;
    for (const waiter of this.own.values()) waiter.reject(new Error(reason));
    this.own.clear();
    for (const client of [...this.clients]) {
      const hadSession = client.browserSession !== null;
      this.detachClient(client);
      this.clients.delete(client);
      client.closed = true;
      client.gone(reason, hadSession);
    }
    this.opts.onClose?.();
  }
}

/** `text` with its top-level id replaced, when the parse confirms where it is. */
function withId(frame: Frame, text: string, id: number): string {
  const prefix = `{"id":${frame.id as number},`;
  if (text.startsWith(prefix)) return `{"id":${id},${text.slice(prefix.length)}`;
  return JSON.stringify({ ...frame, id });
}

/** `text` without its top-level sessionId, when it is `session`. */
function withoutSession(frame: Frame, text: string, session: string | null): string {
  if (session === null || frame.sessionId !== session) return text;
  const suffix = `,"sessionId":${JSON.stringify(session)}}`;
  if (text.endsWith(suffix)) return `${text.slice(0, -suffix.length)}}`;
  const rest: Frame = { ...frame };
  delete rest.sessionId;
  return JSON.stringify(rest);
}

class ExternalClient extends Client {
  constructor(label: string, private readonly sendText: (text: string) => void, private readonly onGone: (reason: string) => void) {
    super('external', label);
  }

  reply(clientId: number, frame: Frame, text: string): void {
    // The browser session is the client's root: it never sees that session's id.
    this.sendText(withoutSession({ ...frame, id: clientId }, withId(frame, text, clientId), this.browserSession));
  }

  event(frame: Frame, text: string): void {
    this.sendText(withoutSession(frame, text, this.browserSession));
  }

  gone(reason: string): void {
    this.onGone(reason);
  }
}

/** Main's own connection: the CdpConnection the launcher uses, over the pipe. */
class InternalConnection extends Client implements CdpConnection {
  private readonly handlers = new Map<string, Set<CdpEventHandler>>();
  private readonly waiters = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private nextId = 1;
  private readonly timeoutMs: number;
  private readonly onDisconnect?: () => void;

  constructor(private readonly mux: CdpPipeMux, opts: { label?: string; timeoutMs?: number; onDisconnect?: () => void }) {
    super('internal', opts.label ?? 'CdpPipe');
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.onDisconnect = opts.onDisconnect;
    mux.registerInternal(this);
  }

  isOpen(): boolean {
    return this.mux.isOpen() && this.browserSession !== null;
  }

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

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (!this.mux.isOpen()) return Promise.reject(new Error(`${this.label}: connection closed`));
    this.closed = false;
    this.mux.registerInternal(this);
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiters.delete(id)) reject(new Error(`${this.label}: ${method} timed out`));
      }, this.timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.waiters.set(id, { resolve, reject, timer });
    });
    this.mux.submit(this, id, { method, params, ...(sessionId !== undefined && { sessionId }) }).catch((err: unknown) => {
      this.settle(id, undefined, new Error(`${this.label}: ${err instanceof Error ? err.message : String(err)}`));
    });
    return result;
  }

  /** Close and reject everything in flight. Handlers survive; a later send() opens a new browser session. */
  close(): void {
    if (!this.mux.release(this, 'disposed')) this.rejectAll(`${this.label}: disposed`);
  }

  reply(clientId: number, frame: Frame): void {
    if (frame.error) this.settle(clientId, undefined, new Error(`${this.label}: ${String(frame.error.message ?? 'CDP error')}`));
    else this.settle(clientId, frame.result);
  }

  event(frame: Frame): void {
    const handlers = this.handlers.get(frame.method as string);
    if (!handlers) return;
    const session = frame.sessionId === this.browserSession ? undefined : (frame.sessionId as string);
    for (const handler of [...handlers]) {
      try {
        handler((frame.params as Record<string, unknown> | undefined) ?? {}, session);
      } catch (err) {
        console.warn(`[${this.label}] ${String(frame.method)} handler threw:`, err);
      }
    }
  }

  gone(reason: string, hadSession: boolean): void {
    this.rejectAll(`${this.label}: ${reason}`);
    // As CdpSocket: once per connection that was open and no longer is.
    if (!hadSession) return;
    try {
      this.onDisconnect?.();
    } catch (err) {
      console.warn(`[${this.label}] onDisconnect handler threw:`, err);
    }
  }

  private settle(id: number, value: unknown, error?: Error): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    this.waiters.delete(id);
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error);
    else waiter.resolve(value);
  }

  private rejectAll(reason: string): void {
    const waiters = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of waiters) { clearTimeout(w.timer); w.reject(new Error(reason)); }
  }
}
