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

/** A client as a filter or hook sees it. */
export interface ClientRef { readonly kind: 'internal' | 'external'; readonly label: string }

/**
 * What a filter does with a client's command: refuse it (the client gets the
 * error), absorb it (the client gets the result, the browser gets nothing),
 * or let it through (null). `reason` is what the counters show; the command's
 * params are never recorded.
 */
export type FilterAnswer =
  | { refuse: { code: number; message: string }; reason: string }
  | { absorb: Record<string, unknown>; reason: string }
  | null;

/** Method blocks and download ownership for a profile (ProtectedPipePolicy). */
export type ClientCommandFilter = (client: ClientRef, command: ClientCommand) => FilterAnswer;

/**
 * Runs on a successful reply to a client's command before the client sees
 * it. An error it returns (or throws) becomes the client's answer instead.
 */
export type BeforeReply = (client: ClientRef, method: string, result: Record<string, unknown>) => Promise<ReplyError | null> | null;

/** An error answer; `reason` names it in the counters (default: `<method>-after`). */
export interface ReplyError { code: number; message: string; reason?: string }

/** Refused from every external client: one client ending or crashing the browser every client shares. */
const ENDS_SHARED_BROWSER = new Set(['Browser.close', 'Browser.crash', 'Browser.crashGpuProcess']);

/**
 * Refused from every external client: commands that add to what the browser
 * offers beyond the client's own pages (a forwarded port, extensions,
 * installed web apps, a DevTools window, remote target discovery).
 */
function changesBrowserSurface(method: string): boolean {
  if (method.startsWith('Extensions.')) return true;
  if (method.startsWith('PWA.')) return method !== 'PWA.getOsAppState';
  return method === 'Tethering.bind' || method === 'Tethering.unbind' || method === 'Target.openDevTools' || method === 'Target.setRemoteLocations';
}

/**
 * Rules that hold for every external client on every profile. A rule sees a
 * command's own method only, so a channel that carries protocol messages
 * inside another command is refused rather than read: sendMessageToTarget,
 * a page's protocol binding, and the non-flat sessions that use them (Chrome
 * defaults `flatten` to false; Playwright always sends true).
 */
function externalRule(command: ClientCommand): FilterAnswer {
  const refuse = (what: string, reason: string): FilterAnswer => ({ refuse: { code: -32000, message: `${what} is not available to this client` }, reason });
  if (ENDS_SHARED_BROWSER.has(command.method)) return refuse(command.method, 'ends-shared-browser');
  if (changesBrowserSurface(command.method)) return refuse(command.method, 'browser-surface');
  switch (command.method) {
    case 'Target.sendMessageToTarget':
    case 'Target.exposeDevToolsProtocol':
      return refuse(command.method, 'unsupported-channel');
    case 'Target.attachToTarget':
      return command.params.flatten === true ? null : refuse(`${command.method} without flatten`, 'unsupported-channel');
    case 'Target.setAutoAttach':
      return command.params.autoAttach === true && command.params.flatten !== true
        ? refuse(`${command.method} without flatten`, 'unsupported-channel')
        : null;
    default:
      return null;
  }
}

/**
 * Whether `client` may see and address the target `targetId`: C3's caller
 * identity with C2b's rules. Without one every target is every client's, as on
 * the port. With one, a target not granted to a client is, to that client, not
 * there: commands naming it get the browser's own unknown-target answer, its
 * target events and its Target.getTargets entry are left out, and a session
 * auto-attached to it is detached again rather than handed over.
 *
 * Checked where targets are found: on every browser session the client
 * holds, the mux's and any it attached itself (Target.attachToBrowserTarget).
 * What attaches on a page session the client already owns (a granted page's
 * frames and workers) follows that page and is not checked again, by design.
 */
export type TargetGrant = (client: ClientRef, targetId: string) => boolean;

/** Shown by `wmux doctor --performance` (perf.status). */
export type CdpPipeCounters = CdpPipeDiagnostics;

const totals: Required<CdpPipeCounters> = { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0, absorbed: {}, refusals: {} };

/** Copies of the counters across every mux, for the app's diagnostics. */
export function cdpPipeCounters(): CdpPipeCounters {
  return { ...totals, dropped: { ...totals.dropped }, absorbed: { ...totals.absorbed }, refusals: { ...totals.refusals } };
}

/** Tests only. */
export function resetCdpPipeCounters(): void {
  Object.assign(totals, { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0, absorbed: {}, refusals: {} });
}

function bump(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

/** Answer a client's command with an error (counted as refused), on `sessionId` when it came on one. */
function refuseTo(client: Client, clientId: number, error: { code: number; message: string }, sessionId?: string): void {
  totals.refused++;
  const frame = { id: clientId, error, ...(sessionId !== undefined && { sessionId }) };
  client.reply(clientId, frame, JSON.stringify(frame));
}

/**
 * Keep a page session's child frames as Chrome reports them: attached and
 * navigated frames are added, a detached frame goes with its descendants, and
 * a main-frame navigation starts the page over.
 */
function trackFrames(client: Client, session: string, method: string, params: unknown): void {
  const p = params as { frameId?: unknown; parentFrameId?: unknown; frame?: { id?: unknown; parentId?: unknown } } | undefined;
  let frames = client.frames.get(session);
  if (method === 'Page.frameAttached' && typeof p?.frameId === 'string' && typeof p.parentFrameId === 'string') {
    if (!frames) client.frames.set(session, (frames = new Map()));
    frames.set(p.frameId, p.parentFrameId);
  } else if (method === 'Page.frameNavigated' && typeof p?.frame?.id === 'string') {
    if (typeof p.frame.parentId !== 'string') { client.frames.delete(session); return; }
    if (!frames) client.frames.set(session, (frames = new Map()));
    frames.set(p.frame.id, p.frame.parentId);
  } else if (method === 'Page.frameDetached' && typeof p?.frameId === 'string' && frames) {
    const gone = new Set([p.frameId]);
    // Descendants, whatever order they were added in.
    for (let grew = true; grew;) {
      grew = false;
      for (const [id, parent] of frames) if (!gone.has(id) && gone.has(parent)) { gone.add(id); grew = true; }
    }
    for (const id of gone) frames.delete(id);
    if (!frames.size) client.frames.delete(session);
  }
}

interface Pending {
  client: Client;
  /** The id the client sent (external) or its waiter (internal). */
  clientId: number;
  method: string;
  /** Target.attachToTarget's target, recorded with the session its reply names. */
  targetId?: string;
}

/** One client of the mux: its browser session and the sessions it owns. */
abstract class Client {
  browserSession: string | null = null;
  /** Browser sessions the client attached itself (Target.attachToBrowserTarget), beside the mux's. */
  readonly ownBrowserSessions = new Set<string>();
  /** In flight: the mux's attachToBrowserTarget for this client. */
  attaching: Promise<string> | null = null;
  readonly owned = new Set<string>();
  /** The target each owned page session is attached to, with its browser context when Chrome named it. */
  readonly targets = new Map<string, { targetId: string; browserContextId?: string }>();
  /**
   * The child frames Chrome reported on each owned page session (Page events,
   * as the client enabled them), frame id to parent frame id: a frame in the
   * page's process that is not a target of its own.
   */
  readonly frames = new Map<string, Map<string, string>>();
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
      /** C2b. */
      beforeReply?: BeforeReply;
      /** C3 and C2b. */
      targetGrant?: TargetGrant;
      /** A client left (closed, or dropped); called once, after it is detached. */
      onClientGone?: (client: ClientRef) => void;
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

  /** Whether `client` holds a session on the target `targetId` (a page it attached to). */
  ownsTarget(client: ClientRef, targetId: string): boolean {
    if (!(client instanceof Client) || !this.clients.has(client)) return false;
    for (const held of client.targets.values()) if (held.targetId === targetId) return true;
    return false;
  }

  /**
   * The browser context of a frame `client` holds: a target it has a session
   * to, or a child frame Chrome reported on one of its own page sessions. As
   * Chrome named it when that session was attached (Target.attachedToTarget);
   * null when the client holds the frame but no attach event named a context;
   * undefined only when the client doesn't hold it.
   */
  contextOfFrame(client: ClientRef, frameId: string): string | null | undefined {
    if (!(client instanceof Client) || !this.clients.has(client)) return undefined;
    for (const held of client.targets.values()) if (held.targetId === frameId) return held.browserContextId ?? null;
    for (const [session, frames] of client.frames) if (frames.has(frameId)) return client.targets.get(session)?.browserContextId ?? null;
    return undefined;
  }

  /** Send a command on the pipe's root session as the mux itself; rejects with the browser's error. */
  command(method: string, params: Record<string, unknown>): Promise<unknown> {
    return this.ownCommand(method, params).then((frame) => frame.result);
  }

  /**
   * Send `client` a browser-level event: on its root (its own browser session,
   * as it sees it), or on `sessionId`, a session it holds. False when the client
   * or that session is gone.
   */
  emitEvent(client: ClientRef, method: string, params: Record<string, unknown>, sessionId?: string): boolean {
    if (!(client instanceof Client) || client.closed || !this.clients.has(client)) return false;
    if (sessionId !== undefined && !client.owned.has(sessionId)) return false;
    const frame = { method, params, ...(sessionId !== undefined && { sessionId }) };
    client.event(frame, JSON.stringify(frame));
    return true;
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
    if (command.sessionId !== undefined && !client.owned.has(command.sessionId)) {
      refuseTo(client, clientId, UNKNOWN_SESSION);
      return;
    }
    const answer: FilterAnswer = (client.kind === 'external' ? externalRule(command) : null) ?? this.opts.filter?.(client, command) ?? null;
    if (answer && 'refuse' in answer) {
      bump(totals.refusals, answer.reason);
      // An answer given here goes back on the session the command came on.
      refuseTo(client, clientId, answer.refuse, command.sessionId);
      return;
    }
    if (answer) {
      bump(totals.absorbed, answer.reason);
      const frame = { id: clientId, result: answer.absorb, ...(command.sessionId !== undefined && { sessionId: command.sessionId }) };
      client.reply(clientId, frame, JSON.stringify(frame));
      return;
    }
    const session = command.sessionId ?? (await this.browserSessionOf(client));
    const named = command.params.sessionId;
    if (PARAM_SESSION_METHODS.has(command.method) && named !== undefined && (typeof named !== 'string' || !client.owned.has(named))) {
      refuseTo(client, clientId, UNKNOWN_PARAM_SESSION);
      return;
    }
    const target = command.params.targetId;
    if (typeof target === 'string' && !this.granted(client, target)) {
      refuseTo(client, clientId, UNKNOWN_TARGET);
      return;
    }
    if (client.closed || !this.open) return;
    const id = this.nextClientCommandId++;
    if (this.nextClientCommandId >= MUX_ID_BASE) this.nextClientCommandId = 1;
    const targetId = command.method === 'Target.attachToTarget' && typeof target === 'string' ? { targetId: target } : {};
    this.pending.set(id, { client, clientId, method: command.method, ...targetId });
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
    this.opts.onClientGone?.(client);
    return true;
  }

  /** @internal Forget a client's sessions (it closed, or will reattach on its next send). */
  detachClient(client: Client): void {
    client.epoch++;
    for (const session of client.owned) this.owner.delete(session);
    client.owned.clear();
    client.targets.clear();
    client.frames.clear();
    client.ownBrowserSessions.clear();
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
    const refuse = (error: { code: number; message: string }) => refuseTo(client, id, error);
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
        if (typeof session === 'string') {
          this.adopt(job.client, session);
          if (job.targetId !== undefined && this.owner.get(session) === job.client) {
            if (!job.client.targets.has(session)) job.client.targets.set(session, { targetId: job.targetId });
          }
          if (job.method === 'Target.attachToBrowserTarget' && this.owner.get(session) === job.client) job.client.ownBrowserSessions.add(session);
        }
      }
      if (job.method === 'Target.getTargets' && this.opts.targetGrant && !frame.error) {
        const infos = (frame.result as { targetInfos?: Array<{ targetId?: unknown }> } | undefined)?.targetInfos;
        if (Array.isArray(infos)) {
          const shown = { ...frame, result: { ...(frame.result as Record<string, unknown>), targetInfos: infos.filter((t) => typeof t.targetId === 'string' && this.granted(job.client, t.targetId)) } };
          job.client.reply(job.clientId, shown, JSON.stringify(shown));
          return;
        }
      }
      let hook: ReturnType<BeforeReply> = null;
      if (!frame.error && this.opts.beforeReply) {
        try {
          hook = this.opts.beforeReply(job.client, job.method, (frame.result as Record<string, unknown> | undefined) ?? {});
        } catch (err) {
          hook = Promise.reject(err);
        }
      }
      if (hook) {
        // The client hears its answer only once the hook is done.
        void hook.catch((err: unknown): ReplyError => ({ code: -32000, message: err instanceof Error ? err.message : String(err) })).then((error) => {
          if (job.client.closed) return;
          if (error) {
            const { reason, ...answer } = error;
            bump(totals.refusals, reason ?? `${job.method}-after`);
            refuseTo(job.client, job.clientId, answer, typeof frame.sessionId === 'string' ? frame.sessionId : undefined);
          } else {
            job.client.reply(job.clientId, frame, text);
          }
        });
        return;
      }
      job.client.reply(job.clientId, frame, text);
      return;
    }

    if (typeof frame.method !== 'string') { bump(totals.dropped, 'neither-reply-nor-event'); return; }
    if (typeof frame.sessionId !== 'string') { bump(totals.dropped, 'root-event'); return; }
    const owner = this.owner.get(frame.sessionId);
    if (!owner) { bump(totals.dropped, 'unknown-session'); return; }
    // Grants are checked where targets are discovered, on every browser
    // session the client holds. A page's own frames and workers come on that
    // page's session and go with the page. A session the client owns is always
    // told it ended.
    const onBrowserSession = frame.sessionId === owner.browserSession || owner.ownBrowserSessions.has(frame.sessionId);
    if (this.opts.targetGrant && onBrowserSession && frame.method.startsWith('Target.')) {
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
      if (typeof child === 'string') {
        this.adopt(owner, child);
        const info = (frame.params as { targetInfo?: { targetId?: unknown; browserContextId?: unknown } } | undefined)?.targetInfo;
        if (typeof info?.targetId === 'string' && this.owner.get(child) === owner) {
          owner.targets.set(child, { targetId: info.targetId, ...(typeof info.browserContextId === 'string' && { browserContextId: info.browserContextId }) });
        }
      }
    }
    if (owner.targets.has(frame.sessionId)) trackFrames(owner, frame.sessionId, frame.method, frame.params);
    owner.event(frame, text);
    if (frame.method === 'Target.detachedFromTarget') {
      const child = (frame.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof child === 'string' && this.owner.get(child) === owner && child !== owner.browserSession) {
        this.owner.delete(child);
        owner.owned.delete(child);
        owner.targets.delete(child);
        owner.frames.delete(child);
        owner.ownBrowserSessions.delete(child);
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
