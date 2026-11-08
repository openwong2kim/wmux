import { performance } from 'node:perf_hooks';
import type { Readable, Writable } from 'node:stream';
import type { CdpConnection, CdpEventHandler } from './CdpSocket';
import type { CdpPipeDiagnostics } from '../../shared/memoryDiagnostics';
import { CdpPipeStallWatch, STALL_MS, type WatchedClient } from './CdpPipeStallWatch';
import { CdpTargetOwnership, type TargetInfoLike, type TargetRegistry } from './CdpTargetOwnership';

// ---------------------------------------------------------------------------
// One debugging pipe (`--remote-debugging-pipe`: the browser reads fd 3 and
// writes fd 4, one JSON message per NUL-terminated frame) shared by several
// clients: main's own connections (the launcher's watcher, download guard,
// probes) and external ones (CdpPipeRelay).
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
//  - A target waiting for an external client that stopped answering is let go
//    for that client, on evidence only (CdpPipeStallWatch, C2c).
//  - Targets themselves stay visible to every client, as on the port: target
//    discovery and Target.getTargets are browser-wide. A TargetGrant (C3's
//    caller identity with C2b's rules) narrows that per client when given,
//    and so do `grants` (C3b, CdpTargetOwnership): each external client sees
//    and addresses only its own targets, on every session it holds.
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
/**
 * Grants (C3b): a client's frames held while its createTarget's new page waits
 * to be named are capped; over either cap the client is dropped.
 */
export const GRANT_HOLD_MAX_FRAMES = 2_000;
/** The size cap, in characters of held browser events. */
export const GRANT_HOLD_MAX_BYTES = 16 * 1024 * 1024;
/** How long a fact about a destroyed target is kept, for the other sessions told of it after. */
const DESTROYED_FACT_TTL_MS = 5_000;
/** Targets let go from a client's auto-attach and remembered for a later grant, per client. */
const DENIED_REMEMBERED = 256;
/** Targets that attach on a page's own session and go with the page: never judged on their own. */
const FOLLOWS_PAGE = new Set(['iframe', 'worker']);
/**
 * Commands that reach the whole browser context of the session they are sent
 * on, or the profile: with grants, refused unless that context is one the
 * client created.
 */
const CONTEXT_WIDE = new Set([
  'Network.clearBrowserCookies', 'Network.clearBrowserCache',
  'Storage.clearCookies', 'Storage.setCookies', 'Storage.clearDataForOrigin', 'Storage.clearDataForStorageKey',
]);
/** Browser commands that name a window by id; with grants, only a window of the client's own pages. */
const WINDOW_METHODS = new Set(['Browser.getWindowBounds', 'Browser.setWindowBounds', 'Browser.setContentsSize']);
/**
 * Storage commands a page session in the shared default context may send: they
 * reach only that page's own frames, or (track/untrack) an origin or first-party
 * storage key one of its frames has now. Every other Storage command there is refused.
 */
const PAGE_STORAGE_FRAME = new Set(['Storage.getStorageKeyForFrame', 'Storage.getStorageKey']);
const PAGE_STORAGE_ORIGIN = new Set([
  'Storage.trackCacheStorageForOrigin', 'Storage.untrackCacheStorageForOrigin',
  'Storage.trackIndexedDBForOrigin', 'Storage.untrackIndexedDBForOrigin',
]);
const PAGE_STORAGE_KEY = new Set([
  'Storage.trackCacheStorageForStorageKey', 'Storage.untrackCacheStorageForStorageKey',
  'Storage.trackIndexedDBForStorageKey', 'Storage.untrackIndexedDBForStorageKey',
]);
/** Target events that discover targets; filtered on every session a client holds. */
const DISCOVERY_EVENTS = new Set(['Target.targetCreated', 'Target.targetInfoChanged', 'Target.targetDestroyed']);
/** Commands that name a browser context, and Chrome's own answer when it does not know the one named. */
function unknownContext(method: string, contextId: string): { code: number; message: string } | null {
  if (method === 'Target.createTarget') return { code: -32000, message: `Failed to find browser context with id ${contextId}` };
  if (method === 'Target.disposeBrowserContext') return { code: -32000, message: `Failed to find context with id ${contextId}` };
  if (method === 'Browser.setDownloadBehavior' || method === 'Browser.cancelDownload' || method === 'Browser.grantPermissions' || method === 'Browser.resetPermissions'
    || method === 'Browser.setPermission' || method.startsWith('Storage.')) {
    return { code: -32602, message: `Failed to find browser context for id ${contextId}` };
  }
  return null;
}

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
 * Who an external client connected as: what browser.cdp.info resolved for the
 * caller its relay token was minted for. Carried on the client for a
 * TargetGrant to judge by; nothing narrows on it yet.
 */
export interface CallerIdentity {
  readonly workspaceId?: string;
  readonly profile?: string;
  readonly protectedEpoch?: number;
  /**
   * With `grants`, every target, as on the port: the operator lane's callers
   * only. Set by main from the authenticated caller, never from params.
   */
  readonly everyTarget?: boolean;
}

/** A client as a filter or hook sees it. */
export interface ClientRef { readonly kind: 'internal' | 'external'; readonly label: string; readonly identity?: CallerIdentity }

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

const totals: Required<CdpPipeCounters> = { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0, absorbed: {}, refusals: {}, watchdog: {} };

/** Copies of the counters across every mux, for the app's diagnostics. */
export function cdpPipeCounters(): CdpPipeCounters {
  return { ...totals, dropped: { ...totals.dropped }, absorbed: { ...totals.absorbed }, refusals: { ...totals.refusals }, watchdog: { ...totals.watchdog } };
}

/** Tests only. */
export function resetCdpPipeCounters(): void {
  Object.assign(totals, { frames: 0, bytes: 0, parseMsTotal: 0, parseMsMax: 0, largestFrameBytes: 0, dropped: {}, refused: 0, absorbed: {}, refusals: {}, watchdog: {} });
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
 * A Storage command on `session`, a page of the shared default context, that
 * reaches only that page's own frames. The page's frames and their origins are
 * as Chrome reported them on any session the client holds to the same target
 * (a fresh CDP session has no Page events of its own).
 */
function pageStorageAllowed(client: Client, session: string, method: string, params: Record<string, unknown>): boolean {
  const targetId = client.targets.get(session)?.targetId;
  if (targetId === undefined) return false;
  const frameIds = new Set<string>([targetId]);
  const origins = new Set<string>();
  for (const [held, info] of client.targets) {
    if (info.targetId !== targetId) continue;
    for (const id of client.frames.get(held)?.keys() ?? []) frameIds.add(id);
    for (const [id, origin] of client.origins.get(held) ?? []) {
      frameIds.add(id);
      origins.add(origin);
    }
  }
  if (PAGE_STORAGE_FRAME.has(method)) {
    const frameId = params.frameId;
    if (frameId === undefined) return method === 'Storage.getStorageKey';
    return typeof frameId === 'string' && frameIds.has(frameId);
  }
  if (PAGE_STORAGE_ORIGIN.has(method)) return typeof params.origin === 'string' && origins.has(params.origin);
  if (PAGE_STORAGE_KEY.has(method)) {
    // A first-party storage key is the origin and a slash; a partitioned one is never the page's own.
    const key = params.storageKey;
    return typeof key === 'string' && key.endsWith('/') && origins.has(key.slice(0, -1));
  }
  return false;
}

/** Add the child frames of a page session's frame tree (Page.getFrameTree's answer). */
function seedFrames(client: Client, session: string, tree: unknown): void {
  type Node = { frame?: { id?: unknown; parentId?: unknown; securityOrigin?: unknown }; childFrames?: unknown };
  const walk = (node: Node | undefined, depth: number) => {
    if (!node || depth > 64) return;
    const { id, parentId, securityOrigin } = node.frame ?? {};
    if (typeof id === 'string' && typeof securityOrigin === 'string') {
      let origins = client.origins.get(session);
      if (!origins) client.origins.set(session, (origins = new Map()));
      origins.set(id, securityOrigin);
    }
    if (typeof id === 'string' && typeof parentId === 'string') {
      let frames = client.frames.get(session);
      if (!frames) client.frames.set(session, (frames = new Map()));
      frames.set(id, parentId);
    }
    if (Array.isArray(node.childFrames)) for (const child of node.childFrames) walk(child as Node, depth + 1);
  };
  walk(tree as Node | undefined, 0);
}

/**
 * Keep a page session's child frames as Chrome reports them: attached and
 * navigated frames are added, a detached frame goes with its descendants, and
 * a main-frame navigation starts the page over.
 */
function trackFrames(client: Client, session: string, method: string, params: unknown): void {
  const p = params as { frameId?: unknown; parentFrameId?: unknown; frame?: { id?: unknown; parentId?: unknown; securityOrigin?: unknown } } | undefined;
  let frames = client.frames.get(session);
  if (method === 'Page.frameNavigated' && typeof p?.frame?.id === 'string') {
    // A main-frame navigation starts the page's origins over.
    let origins = typeof p.frame.parentId === 'string' ? client.origins.get(session) : undefined;
    if (typeof p.frame.securityOrigin === 'string') {
      if (!origins) client.origins.set(session, (origins = new Map()));
      origins.set(p.frame.id, p.frame.securityOrigin);
    } else {
      origins?.delete(p.frame.id);
      if (typeof p.frame.parentId !== 'string') client.origins.delete(session);
    }
  }
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
    const origins = client.origins.get(session);
    for (const id of gone) {
      frames.delete(id);
      origins?.delete(id);
    }
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
  /** The session the command was written on. */
  session?: string;
  /** Target.disposeBrowserContext's context. */
  contextId?: string;
  /** Browser.getWindowForTarget: the granted page it asked about (named, or the page session it came on). */
  windowTarget?: string;
}

/** A frame for a client, held until its createTarget's new page is named (C3b). */
type HeldItem =
  | { readonly kind: 'event'; readonly frame: Frame; readonly text: string }
  | { readonly kind: 'reply'; readonly job: Pending; readonly frame: Frame; readonly text: string }
  /** An answer or event the mux makes itself (an absorb, a refusal, main's event): in order too. */
  | { readonly kind: 'direct'; readonly text: string; readonly run: () => void };

interface Hold {
  readonly items: HeldItem[];
  /** Browser events held (the client's own replies don't count: it asked for them). */
  events: number;
  /** Their size, in characters. */
  chars: number;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Methods the mux answers itself for a connection, never sent to the browser. */
export const LOCAL_METHOD_PREFIX = 'Wmux.';

/**
 * A connection's answerer for `Wmux.*` commands: a result, an error, or
 * undefined for a method it does not know (answered as unknown).
 */
export type LocalMethods = (
  method: string,
  params: Record<string, unknown>,
) => { result: Record<string, unknown> } | { error: { code: number; message: string } } | undefined;

/** One client of the mux: its browser session and the sessions it owns. */
abstract class Client {
  /** For the stall watch (external clients on a WebSocket only). */
  readonly ping?: () => void;
  readonly drain?: () => { buffered: number; flushed: number };
  browserSession: string | null = null;
  /** Browser sessions the client attached itself (Target.attachToBrowserTarget), beside the mux's. */
  readonly ownBrowserSessions = new Set<string>();
  /** In flight: the mux's attachToBrowserTarget for this client. */
  attaching: Promise<string> | null = null;
  readonly owned = new Set<string>();
  /**
   * The target each owned page session is attached to, with its browser
   * context when Chrome named it, and the session it was attached on.
   */
  readonly targets = new Map<string, { targetId: string; browserContextId?: string; parent?: string; type?: string }>();
  /** Grants (C3b): frames held while a new page waits to be named. */
  hold: Hold | null = null;
  /** Grants: createTarget commands in flight. */
  creatingCount = 0;
  /** Grants: sessions whose grant went; refused at once, detached as soon as Chrome does. */
  readonly revoked = new Set<string>();
  /** Grants: windows that hold the client's own pages, by window id, with the pages that taught them. */
  readonly windows = new Map<number, Set<string>>();
  /** Grants: targets let go from this client's auto-attach, by the browser session they came on. */
  readonly denied = new Map<string, string>();
  /**
   * The child frames Chrome reported on each owned page session (Page events,
   * as the client enabled them), frame id to parent frame id: a frame in the
   * page's process that is not a target of its own.
   */
  readonly frames = new Map<string, Map<string, string>>();
  /** The security origin of each frame of an owned page session, main frame included, as Chrome last reported it. */
  readonly origins = new Map<string, Map<string, string>>();
  closed = false;
  /** Bumped by every detach, so an attach that lands after a close is not published. */
  epoch = 0;

  constructor(readonly kind: 'internal' | 'external', readonly label: string) {}

  /** Who the client connected as (external clients); main's own have none. */
  get callerIdentity(): CallerIdentity | undefined {
    return undefined;
  }

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
  private readonly watch: CdpPipeStallWatch;
  /** Grants (C3b): who owns what, or null when every target is every client's. */
  private readonly ownership: CdpTargetOwnership | null;
  /** Grants: the mux's own browser session that discovers every target first. */
  private discoverySession: string | null = null;
  /** Grants: destroyed targets whose facts go after DESTROYED_FACT_TTL_MS. */
  private readonly pruning = new Set<string>();

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
      /**
       * C3b: narrow every external client to its own targets, by main's
       * registry and what the client made (CdpTargetOwnership). Overrides
       * `targetGrant`.
       */
      grants?: {
        registry: TargetRegistry;
        /** How long a hold waits for its createTarget reply; tests shorten it. */
        holdMs?: number;
        /** The size of the events a hold keeps before the client is dropped; tests shorten it. */
        holdMaxChars?: number;
      };
      /** A client left (closed, or dropped); called once, after it is detached. */
      onClientGone?: (client: ClientRef) => void;
      /** How long a waiting target waits on a client with no sign of life (C2c); tests shorten it. */
      stallMs?: number;
    } = {},
  ) {
    this.watch = new CdpPipeStallWatch({
      stallMs: opts.stallMs ?? STALL_MS,
      // The mux's own command: its reply is consumed here, whoever has gone since.
      resume: (session) => { this.ownCommand('Runtime.runIfWaitingForDebugger', {}, session).catch(() => undefined); },
      count: (reason) => bump(totals.watchdog, reason),
    });
    this.ownership = opts.grants ? new CdpTargetOwnership(opts.grants.registry) : null;
    fromBrowser.on('data', (chunk: Buffer) => this.onData(chunk));
    if (this.ownership) this.discover();
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
  attachExternal(
    label: string,
    send: (text: string) => void,
    onGone: (reason: string) => void,
    /**
     * For the stall watch: a WebSocket ping (its answer goes to the returned
     * `pong`) and the socket's backlog. `identity`: who the client connected as.
     */
    watched: WatchedClient & { identity?: CallerIdentity; local?: LocalMethods } = {},
  ): { receive: (text: string) => void; close: () => void; pong: () => void } {
    const client = new ExternalClient(label, send, onGone, watched);
    this.clients.add(client);
    return {
      receive: (text) => this.fromExternal(client, text),
      close: () => this.release(client, 'closed'),
      pong: () => this.watch.pong(client),
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
    this.deliver(client, frame, true);
    return true;
  }

  /**
   * Grants (C3b): main's registry changed. A target now granted to a client
   * whose auto-attach let it go is attached for it again, so the client sees
   * it; a page session it holds on a target no longer granted is detached.
   */
  regrant(): void {
    if (!this.ownership || !this.open) return;
    for (const client of this.clients) {
      if (client.kind !== 'external' || client.closed) continue;
      // A session on a target no longer granted, whichever session it was
      // attached on, and every session attached through it: refused from now on,
      // and detached.
      let grew = true;
      while (grew) {
        grew = false;
        for (const [session, held] of client.targets) {
          if (client.revoked.has(session)) continue;
          const parentRevoked = held.parent !== undefined && client.revoked.has(held.parent);
          const judged = !(held.type !== undefined && FOLLOWS_PAGE.has(held.type));
          if (!parentRevoked && (!judged || this.granted(client, held.targetId))) continue;
          client.revoked.add(session);
          this.forgetWindowsOf(client, held.targetId);
          grew = true;
          bump(totals.dropped, 'revoked-target');
          if (!parentRevoked) this.ownCommand('Target.detachFromTarget', { sessionId: session }, held.parent).catch(() => undefined);
        }
      }
      for (const [targetId, browserSession] of [...client.denied]) {
        if (!this.owner.has(browserSession) || this.owner.get(browserSession) !== client) { client.denied.delete(targetId); continue; }
        if (!this.granted(client, targetId)) continue;
        client.denied.delete(targetId);
        bump(totals.absorbed, 'late-grant');
        // Chrome answers with Target.attachedToTarget on that browser session, before this reply.
        this.ownCommand('Target.attachToTarget', { targetId, flatten: true }, browserSession).catch(() => undefined);
      }
    }
  }

  /** Grants: a browser session of the mux's own that sees every target first. */
  private discover(attempt = 1): void {
    this.ownCommand('Target.attachToBrowserTarget', {})
      .then((frame) => {
        const session = (frame.result as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof session !== 'string') throw new Error('the browser named no session');
        this.discoverySession = session;
        return this.ownCommand('Target.setDiscoverTargets', { discover: true }, session);
      })
      .catch(() => {
        if (!this.open) return;
        if (attempt >= 3) {
          console.warn('[CdpPipeMux] target discovery for grants failed; grants decide on what clients are told');
          return;
        }
        const timer = setTimeout(() => this.discover(attempt + 1), 1_000 * attempt);
        timer.unref?.();
      });
  }

  /** A frame the mux makes itself for `client`: behind a hold, in order; otherwise at once. */
  private deliver(client: Client, frame: Record<string, unknown>, asEvent = false): void {
    const text = JSON.stringify(frame);
    const run = () => {
      if (client.closed) return;
      if (asEvent) client.event(frame as Frame, text);
      else client.reply(frame.id as number, frame as Frame, text);
    };
    if (client.hold) this.holdFrame(client, { kind: 'direct', text, run });
    else run();
  }

  /** Answer a client's command with an error (counted as refused), behind any hold. */
  private refuseFor(client: Client, clientId: number, error: { code: number; message: string }, sessionId?: string): void {
    totals.refused++;
    this.deliver(client, { id: clientId, error, ...(sessionId !== undefined && { sessionId }) });
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
    if (command.sessionId !== undefined && (!client.owned.has(command.sessionId) || client.revoked.has(command.sessionId))) {
      this.refuseFor(client, clientId, UNKNOWN_SESSION);
      return;
    }
    // wmux's own methods are answered here, by the connection's local
    // answerer (the relay's proof), and never reach the browser.
    if (command.method.startsWith(LOCAL_METHOD_PREFIX)) {
      const local = client instanceof ExternalClient ? client.local?.(command.method, command.params) : undefined;
      if (local && 'result' in local) {
        this.deliver(client, { id: clientId, result: local.result, ...(command.sessionId !== undefined && { sessionId: command.sessionId }) });
        return;
      }
      this.refuseFor(client, clientId, local?.error ?? { code: -32601, message: `'${command.method}' wasn't found` }, command.sessionId);
      return;
    }
    // Protected-profile rules first (they record what they absorb), then grants.
    const answer: FilterAnswer = (client.kind === 'external' ? externalRule(command) : null)
      ?? this.opts.filter?.(client, command)
      ?? (client.kind === 'external' ? this.grantRule(client, command) : null);
    if (answer && 'refuse' in answer) {
      bump(totals.refusals, answer.reason);
      // An answer given here goes back on the session the command came on.
      this.refuseFor(client, clientId, answer.refuse, command.sessionId);
      return;
    }
    if (answer) {
      bump(totals.absorbed, answer.reason);
      this.deliver(client, { id: clientId, result: answer.absorb, ...(command.sessionId !== undefined && { sessionId: command.sessionId }) });
      return;
    }
    const session = command.sessionId ?? (await this.browserSessionOf(client));
    const named = command.params.sessionId;
    if (PARAM_SESSION_METHODS.has(command.method) && named !== undefined && (typeof named !== 'string' || !client.owned.has(named))) {
      // On the session the command came on, as the browser answers: a client's
      // reply router finds the waiting command by that session and id.
      this.refuseFor(client, clientId, UNKNOWN_PARAM_SESSION, command.sessionId);
      return;
    }
    const target = command.params.targetId;
    if (typeof target === 'string' && !this.granted(client, target)) {
      this.refuseFor(client, clientId, UNKNOWN_TARGET, command.sessionId);
      return;
    }
    if (client.closed || !this.open) return;
    const id = this.nextClientCommandId++;
    if (this.nextClientCommandId >= MUX_ID_BASE) this.nextClientCommandId = 1;
    const targetId = command.method === 'Target.attachToTarget' && typeof target === 'string' ? { targetId: target } : {};
    const contextId = command.method === 'Target.disposeBrowserContext' && typeof command.params.browserContextId === 'string'
      ? { contextId: command.params.browserContextId } : {};
    // A window is learned only from a page the client holds: one it named (granted
    // just above), or the page session it asked on. A browser session asking
    // without a target teaches nothing.
    const windowTarget = command.method === 'Browser.getWindowForTarget'
      ? (typeof target === 'string' ? target : command.sessionId !== undefined ? client.targets.get(command.sessionId)?.targetId : undefined)
      : undefined;
    this.pending.set(id, { client, clientId, method: command.method, session, ...targetId, ...contextId, ...(windowTarget !== undefined && { windowTarget }) });
    if (command.method === 'Target.createTarget') client.creatingCount++;
    // Only a resume that goes to the browser ends the watch on that session.
    if (command.method === 'Runtime.runIfWaitingForDebugger' && command.sessionId !== undefined) this.watch.resumed(client, command.sessionId);
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
    if (client.hold) clearTimeout(client.hold.timer);
    client.hold = null;
    client.denied.clear();
    client.creatingCount = 0;
    client.revoked.clear();
    client.windows.clear();
    this.ownership?.forget(client);
    for (const session of client.owned) this.owner.delete(session);
    client.owned.clear();
    client.targets.clear();
    client.frames.clear();
    client.origins.clear();
    client.ownBrowserSessions.clear();
    client.browserSession = null;
    client.attaching = null;
    this.watch.forget(client);
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
    if (this.ownership) {
      if (client.kind !== 'external') return true;
      const identity = client.callerIdentity ?? {};
      return this.ownership.decide(client, { workspaceId: identity.workspaceId, everyTarget: identity.everyTarget }, targetId) === 'grant';
    }
    return this.opts.targetGrant?.(client, targetId) ?? true;
  }

  /** Grants: whether `client` has a createTarget in flight (its new page may not be named yet). */
  private creating(client: Client): boolean {
    return client.creatingCount > 0;
  }

  /** Grants: whether `session` is one of `client`'s browser sessions (the root included). */
  private isBrowserSession(client: Client, session: string | undefined): boolean {
    return session === undefined || session === client.browserSession || client.ownBrowserSessions.has(session);
  }

  /**
   * Grants (C3b): what a client may not do to the browser all clients share.
   * Fetch and Tracing on a browser session reach every target; a browser
   * context the client did not create is, to it, not there; downloads,
   * permissions and storage of the shared default context are not its alone.
   */
  private grantRule(client: Client, command: ClientCommand): FilterAnswer {
    if (!this.ownership) return null;
    const { method, params } = command;
    // A session that turns Page events off stops hearing its frames' origins:
    // what it learned goes now, not when it is next wrong (pageStorageAllowed).
    if (method === 'Page.disable' && command.sessionId !== undefined) client.origins.delete(command.sessionId);
    const onBrowser = this.isBrowserSession(client, command.sessionId);
    if (onBrowser && (method.startsWith('Fetch.') || method.startsWith('Tracing.'))) {
      return { refuse: { code: -32000, message: `${method} is not available to this client` }, reason: 'browser-wide' };
    }
    if (WINDOW_METHODS.has(method) && typeof params.windowId === 'number' && !client.windows.get(params.windowId)?.size) {
      return { refuse: { code: -32000, message: 'Browser window not found' }, reason: 'foreign-window' };
    }
    const context = params.browserContextId;
    if (typeof context === 'string') {
      // Only a method that takes a context: Chrome ignores the parameter on any
      // other, which then falls through to the rules below.
      const unknown = unknownContext(method, context);
      if (unknown) return this.ownership.ownsContext(client, context) ? null : { refuse: unknown, reason: 'foreign-context' };
    }
    // The shared default context's cookie jar: its pages use it, but no client
    // reads it whole. A page's own cookies (getCookies without urls) and one
    // URL's (setCookie) are no more than visiting the site. Storage.getCookies
    // on a page session returns the jar of that page's context.
    if (method === 'Network.getAllCookies' || method === 'Storage.getCookies'
      || (method === 'Network.getCookies' && params.urls !== undefined)) {
      const pageContext = command.sessionId !== undefined ? client.targets.get(command.sessionId)?.browserContextId : undefined;
      if (!onBrowser && pageContext !== undefined && this.ownership.ownsContext(client, pageContext)) return null;
      return { refuse: { code: -32000, message: `${method} on the shared default browser context is not available to this client` }, reason: 'default-context-cookies' };
    }
    if (CONTEXT_WIDE.has(method)) {
      // On a page session: the page's own context, when the client made it.
      const pageContext = command.sessionId !== undefined ? client.targets.get(command.sessionId)?.browserContextId : undefined;
      if (!onBrowser && pageContext !== undefined && this.ownership.ownsContext(client, pageContext)) return null;
      return { refuse: { code: -32000, message: `${method} on the shared default browser context is not available to this client` }, reason: 'default-context' };
    }
    if (!onBrowser && method.startsWith('Storage.')) {
      // On a page session: everything in a context the client made; in the
      // shared default one, only what stays within the page's own frames.
      const pageContext = command.sessionId !== undefined ? client.targets.get(command.sessionId)?.browserContextId : undefined;
      if (pageContext !== undefined && this.ownership.ownsContext(client, pageContext)) return null;
      if (command.sessionId !== undefined && pageStorageAllowed(client, command.sessionId, method, params)) return null;
      return { refuse: { code: -32000, message: `${method} on the shared default browser context is not available to this client` }, reason: 'default-context-storage' };
    }
    if (method === 'Browser.setDownloadBehavior') return { absorb: {}, reason: 'default-context-downloads' };
    if (method === 'Browser.grantPermissions' || method === 'Browser.resetPermissions' || method === 'Browser.setPermission'
      || (onBrowser && method.startsWith('Storage.'))) {
      return { refuse: { code: -32000, message: `${method} on the shared default browser context is not available to this client` }, reason: 'default-context' };
    }
    return null;
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
    this.watch.frame(client);
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
      if (job.method === 'Target.createTarget' && job.client.creatingCount > 0) job.client.creatingCount--;
      if (this.ownership) {
        // Attributed as it arrives, before any frame held ahead of it is let go.
        this.learnReply(job, frame);
        if (job.client.hold) {
          if (this.holdFrame(job.client, { kind: 'reply', job, frame, text }) && job.method === 'Target.createTarget') this.releaseHold(job.client, false);
          return;
        }
      }
      this.routeReply(job, frame, text);
      return;
    }

    if (typeof frame.method !== 'string') { bump(totals.dropped, 'neither-reply-nor-event'); return; }
    if (typeof frame.sessionId !== 'string') { bump(totals.dropped, 'root-event'); return; }
    const event = frame as Frame & { method: string; sessionId: string };
    if (this.ownership) {
      this.learnEvent(event);
      if (frame.sessionId === this.discoverySession) return;
    }
    const owner = this.owner.get(frame.sessionId);
    if (!owner) { bump(totals.dropped, 'unknown-session'); return; }
    if (owner.hold) { this.holdFrame(owner, { kind: 'event', frame, text }); return; }
    this.routeEvent(owner, event, text, false);
  }

  /** A reply to a client's own command, as the client hears it. */
  private routeReply(job: Pending, frame: Frame, text: string): void {
    {
      // A session attached by the client's own command is the client's.
      if ((job.method === 'Target.attachToTarget' || job.method === 'Target.attachToBrowserTarget') && !frame.error) {
        const session = (frame.result as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof session === 'string') {
          this.adopt(job.client, session);
          const type = job.targetId !== undefined ? this.ownership?.typeOf(job.targetId) : undefined;
          if (type === 'browser' && this.owner.get(session) === job.client) {
            // A browser session by another name: held to everything a browser session is.
            job.client.ownBrowserSessions.add(session);
          } else if (job.targetId !== undefined && this.owner.get(session) === job.client) {
            if (!job.client.targets.has(session)) {
              const context = this.ownership?.contextOf(job.targetId);
              job.client.targets.set(session, {
                targetId: job.targetId,
                ...(context !== undefined && { browserContextId: context }),
                ...(job.session !== undefined && { parent: job.session }),
                ...(type !== undefined && { type }),
              });
            }
          }
          if (job.method === 'Target.attachToBrowserTarget' && this.owner.get(session) === job.client) job.client.ownBrowserSessions.add(session);
        }
      }
      if (job.method === 'Browser.getWindowForTarget' && !frame.error && job.windowTarget !== undefined) {
        const windowId = (frame.result as { windowId?: unknown } | undefined)?.windowId;
        if (typeof windowId === 'number') {
          const pages = job.client.windows.get(windowId) ?? new Set<string>();
          pages.add(job.windowTarget);
          job.client.windows.set(windowId, pages);
        }
      }
      // A page already loaded when the client attached: Chrome reports its frames
      // only in the answer to the client's own Page.getFrameTree.
      if (job.method === 'Page.getFrameTree' && !frame.error && typeof frame.sessionId === 'string' && job.client.targets.has(frame.sessionId)) {
        seedFrames(job.client, frame.sessionId, (frame.result as { frameTree?: unknown } | undefined)?.frameTree);
      }
      if (job.method === 'Target.getBrowserContexts' && this.ownership && job.client.kind === 'external' && !frame.error) {
        const ids = (frame.result as { browserContextIds?: unknown } | undefined)?.browserContextIds;
        if (Array.isArray(ids)) {
          const shown = { ...frame, result: { ...(frame.result as Record<string, unknown>), browserContextIds: ids.filter((c) => typeof c === 'string' && this.ownership?.ownsContext(job.client, c)) } };
          job.client.reply(job.clientId, shown, JSON.stringify(shown));
          return;
        }
      }
      if (job.method === 'Target.getTargets' && (this.opts.targetGrant || this.ownership) && !frame.error) {
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
    }
  }

  /**
   * An event on a session `owner` holds, as it hears it. With grants, false
   * when it started a hold with this frame (`final`: never; a target nothing
   * names is then not the client's).
   */
  private routeEvent(owner: Client, frame: Frame & { method: string; sessionId: string }, text: string, final: boolean): boolean {
    // A session whose grant went hears nothing more; what it attached ends with it, quietly.
    if (owner.revoked.has(frame.sessionId)) {
      bump(totals.dropped, 'revoked-session');
      if (frame.method === 'Target.detachedFromTarget') {
        const child = (frame.params as { sessionId?: unknown } | undefined)?.sessionId;
        if (typeof child === 'string') this.forgetSession(owner, child);
      }
      return true;
    }
    // Grants are checked where targets are discovered: on every browser
    // session the client holds, and, with `grants`, discovery events on any
    // session (a page session can discover too). A page's own frames and
    // workers attach on that page's session and go with the page. A session
    // the client owns is always told it ended.
    const onBrowserSession = frame.sessionId === owner.browserSession || owner.ownBrowserSessions.has(frame.sessionId);
    const checked = this.ownership ? owner.kind === 'external' : !!this.opts.targetGrant;
    const params0 = frame.params as { targetInfo?: { type?: unknown } } | undefined;
    // With grants, what attaches on a page session is judged too, unless it is
    // the page's own frame or worker (a service worker is the origin's, not the page's).
    const pageAttach = !!this.ownership && !onBrowserSession && frame.method === 'Target.attachedToTarget'
      && !(typeof params0?.targetInfo?.type === 'string' && FOLLOWS_PAGE.has(params0.targetInfo.type));
    if (checked && frame.method.startsWith('Target.') && (onBrowserSession || (this.ownership && (DISCOVERY_EVENTS.has(frame.method) || pageAttach)))) {
      const params = frame.params as { targetId?: unknown; targetInfo?: { targetId?: unknown }; sessionId?: unknown } | undefined;
      const target = params?.targetInfo?.targetId ?? params?.targetId;
      const endsOwned = frame.method === 'Target.detachedFromTarget' && typeof params?.sessionId === 'string' && owner.owned.has(params.sessionId);
      if (typeof target === 'string' && !endsOwned) {
        let verdict: 'grant' | 'deny' | 'unknown';
        if (this.ownership) {
          const identity = owner.callerIdentity ?? {};
          // A popup is decided at once by its opener; only a page with none may be a create's.
          const mayHold = !final && !this.ownership.hasOpener(target) && this.creating(owner);
          verdict = this.ownership.decide(owner, { workspaceId: identity.workspaceId, everyTarget: identity.everyTarget }, target, mayHold);
        } else {
          verdict = this.granted(owner, target) ? 'grant' : 'deny';
        }
        if (verdict === 'unknown') {
          this.startHold(owner, { kind: 'event', frame, text });
          return false;
        }
        if (verdict === 'deny') {
          bump(totals.dropped, 'ungranted-target');
          // Auto-attached to a target the client may not have: let it go again, on the session it came on.
          if (frame.method === 'Target.attachedToTarget' && typeof params?.sessionId === 'string') {
            this.ownCommand('Target.detachFromTarget', { sessionId: params.sessionId }, frame.sessionId).catch(() => undefined);
            if (this.ownership && onBrowserSession) this.rememberDenied(owner, target, frame.sessionId);
          }
          return true;
        }
      }
    }
    if (frame.method === 'Target.attachedToTarget') {
      const child = (frame.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof child === 'string') {
        this.adopt(owner, child);
        if (owner.kind === 'external' && (frame.params as { waitingForDebugger?: unknown }).waitingForDebugger === true && this.owner.get(child) === owner) {
          this.watch.waiting(owner, child);
        }
        const info = (frame.params as { targetInfo?: { targetId?: unknown; browserContextId?: unknown } } | undefined)?.targetInfo;
        const type = (info as { type?: unknown } | undefined)?.type;
        if (type === 'browser' && this.ownership && this.owner.get(child) === owner) {
          // The client's own attach to the browser: a browser session, held to everything one is.
          owner.ownBrowserSessions.add(child);
        } else if (typeof info?.targetId === 'string' && this.owner.get(child) === owner) {
          owner.targets.set(child, {
            targetId: info.targetId,
            ...(typeof info.browserContextId === 'string' && { browserContextId: info.browserContextId }),
            parent: frame.sessionId,
            ...(typeof type === 'string' && { type }),
          });
          owner.denied.delete(info.targetId);
        }
      }
    }
    if (owner.targets.has(frame.sessionId)) trackFrames(owner, frame.sessionId, frame.method, frame.params);
    owner.event(frame, text);
    if (frame.method === 'Target.detachedFromTarget') {
      const child = (frame.params as { sessionId?: unknown } | undefined)?.sessionId;
      if (typeof child === 'string') this.forgetSession(owner, child);
    }
    return true;
  }

  /** A session `owner` held has ended. */
  private forgetSession(owner: Client, child: string): void {
    if (this.owner.get(child) !== owner || child === owner.browserSession) return;
    this.owner.delete(child);
    owner.owned.delete(child);
    owner.targets.delete(child);
    owner.frames.delete(child);
    owner.origins.delete(child);
    owner.ownBrowserSessions.delete(child);
    owner.revoked.delete(child);
    this.watch.detached(owner, child);
  }

  /** Grants: windows learned from `targetId` no longer count for `client`. */
  private forgetWindowsOf(client: Client, targetId: string): void {
    for (const [windowId, pages] of client.windows) {
      pages.delete(targetId);
      if (!pages.size) client.windows.delete(windowId);
    }
  }

  // ── Grants (C3b) ─────────────────────────────────────────────────────────

  /** What a client's own reply says about targets and contexts, as it arrives. */
  private learnReply(job: Pending, frame: Frame): void {
    const ownership = this.ownership;
    if (!ownership || frame.error) return;
    const result = (frame.result ?? {}) as { targetId?: unknown; browserContextId?: unknown; targetInfos?: unknown; targetInfo?: unknown };
    if (job.method === 'Target.createTarget' && typeof result.targetId === 'string') ownership.created(job.client, result.targetId);
    else if (job.method === 'Target.createBrowserContext' && typeof result.browserContextId === 'string') ownership.createdContext(job.client, result.browserContextId);
    else if (job.method === 'Target.disposeBrowserContext' && job.contextId !== undefined) ownership.disposedContext(job.contextId);
    else if (job.method === 'Target.getTargets' && Array.isArray(result.targetInfos)) for (const info of result.targetInfos) ownership.learn(info as TargetInfoLike);
    else if (job.method === 'Target.getTargetInfo') ownership.learn(result.targetInfo as TargetInfoLike | undefined);
  }

  /** What a Target event says about a target, on any session, before anyone is told. */
  private learnEvent(frame: Frame & { method: string }): void {
    const ownership = this.ownership;
    if (!ownership || !frame.method.startsWith('Target.')) return;
    const params = frame.params as { targetInfo?: TargetInfoLike; targetId?: unknown } | undefined;
    if (params?.targetInfo) ownership.learn(params.targetInfo);
    if (frame.method === 'Target.targetDestroyed' && typeof params?.targetId === 'string' && !this.pruning.has(params.targetId)) {
      const gone = params.targetId;
      this.pruning.add(gone);
      // Kept a moment for the other sessions told of it after the mux's own.
      const timer = setTimeout(() => {
        this.pruning.delete(gone);
        ownership.destroyed(gone);
        for (const client of this.clients) {
          client.denied.delete(gone);
          this.forgetWindowsOf(client, gone);
        }
      }, DESTROYED_FACT_TTL_MS);
      timer.unref?.();
    }
  }

  private rememberDenied(client: Client, targetId: string, browserSession: string): void {
    client.denied.delete(targetId);
    client.denied.set(targetId, browserSession);
    if (client.denied.size > DENIED_REMEMBERED) client.denied.delete(client.denied.keys().next().value as string);
  }

  /**
   * Hold `client`'s frames from `first` on: a new page its createTarget may
   * have made, announced before the reply that names it. Every later frame for
   * the client waits behind it, in order, until that reply.
   */
  private startHold(client: Client, first: HeldItem): void {
    const timer = setTimeout(() => this.releaseHold(client, true), this.opts.grants?.holdMs ?? DEFAULT_TIMEOUT_MS);
    timer.unref?.();
    client.hold = { items: [], events: 0, chars: 0, timer };
    bump(totals.absorbed, 'grant-hold');
    this.holdFrame(client, first);
  }

  /** False when the hold overflowed and the client was dropped. */
  private holdFrame(client: Client, item: HeldItem): boolean {
    const hold = client.hold;
    if (!hold) return false;
    hold.items.push(item);
    if (item.kind === 'event') {
      hold.events++;
      hold.chars += item.text.length;
    }
    if (hold.events > GRANT_HOLD_MAX_FRAMES || hold.chars > (this.opts.grants?.holdMaxChars ?? GRANT_HOLD_MAX_BYTES)) {
      bump(totals.dropped, 'grant-hold-overflow');
      this.releaseHold(client, true);
      this.release(client, 'too many frames held for a new page');
      return false;
    }
    return true;
  }

  /**
   * Let `client`'s held frames go, in order, each decided again now. A page
   * still unnamed while another of its creates is in flight holds the rest
   * again. `final` (the hold timed out, or the client is going): what nothing
   * names is not the client's.
   */
  private releaseHold(client: Client, final: boolean): void {
    const hold = client.hold;
    if (!hold) return;
    clearTimeout(hold.timer);
    client.hold = null;
    const items = hold.items;
    for (let i = 0; i < items.length; i++) {
      if (client.closed) return;
      const item = items[i];
      if (item.kind === 'reply') {
        this.routeReply(item.job, item.frame, item.text);
        continue;
      }
      if (item.kind === 'direct') {
        item.run();
        continue;
      }
      if (!this.routeEvent(client, item.frame as Frame & { method: string; sessionId: string }, item.text, final) && client.hold) {
        const again = client.hold as Hold;
        for (const rest of items.slice(i + 1)) {
          again.items.push(rest);
          if (rest.kind === 'event') {
            again.events++;
            again.chars += rest.text.length;
          }
        }
        return;
      }
    }
  }

  private end(reason: string): void {
    if (!this.open) return;
    this.open = false;
    for (const waiter of this.own.values()) waiter.reject(new Error(reason));
    this.own.clear();
    this.watch.close();
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
  constructor(
    label: string,
    private readonly sendText: (text: string) => void,
    private readonly onGone: (reason: string) => void,
    watched: WatchedClient & { identity?: CallerIdentity; local?: LocalMethods },
  ) {
    super('external', label);
    this.ping = watched.ping;
    this.drain = watched.drain;
    this.identity = watched.identity;
    this.local = watched.local;
  }

  readonly identity?: CallerIdentity;

  override get callerIdentity(): CallerIdentity | undefined {
    return this.identity;
  }
  /** Answers this connection's `Wmux.*` commands (CdpPipeMux.submit). */
  readonly local?: LocalMethods;

  override readonly ping?: () => void;
  override readonly drain?: () => { buffered: number; flushed: number };

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
