import net from 'node:net';
import type { PaneUsageLimit, PaneUsageLimitPatch } from '../shared/usageLimit';
import { parseShellPromptChange, parseShellPromptList, type ShellPromptList } from '../shared/shellPrompt';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import type { RpcResponse, DaemonEvent } from '../shared/rpc';
import type {
  LanLinkInboxPollResult,
  LanLinkStatus,
  LanLinkConfigurePatch,
  LanLinkPairBeginResult,
  LanLinkPairingStatus,
  LanLinkPairJoinArgs,
  LanLinkJoinResult,
  LanLinkSendArgs,
  LanLinkPeersListResult,
} from '../shared/lanlink';
import type {
  A2aExposureCandidate,
  A2aRemoteExposureGetResult,
  A2aRemoteExposureSetResult,
  A2aRemoteExposureListResult,
  A2aRemoteHostsExposedResult,
  A2aRemoteLinkProposeParams,
  A2aRemoteLinkResult,
  A2aRemoteOfferAcceptParams,
  A2aRemoteOfferCreateResult,
  A2aRemoteOfferResult,
  A2aRemoteOffersListResult,
  A2aRemoteLinksListResult,
  A2aRemotePaneGoneParams,
  A2aRemoteHostsListResult,
  A2aRemoteHostsRemoveResult,
  A2aRemoteJoinResult,
  A2aRemotePairBeginResult,
  A2aRemotePairStatus,
  A2aRemotePeersListResult,
  A2aRemoteStatus,
} from '../shared/rpc';
import { stripReplayQuerySequences } from '../shared/replayQuerySanitizer';
import { A2A_SPAWN_RPC, type A2aSpawnAskInput, type A2aSpawnAskResult, type A2aSpawnOutgoingList, type A2aSpawnPolicySetResult, type A2aSpawnPolicyV1, type A2aSpawnRequestSummary } from '../shared/a2aSpawn';
import { createSessionPipeMarkers } from '../daemon/sessionPipeMarkers';
import type { FolderTrustState } from '../daemon/folderTrustState';
import { SessionPipeStreamScanner } from './daemon/sessionPipeStreamScanner';
import { DAEMON_RPC_TIMEOUT_MS } from '../shared/timeouts';
import { AGENT_STATE_BATCH_MAX } from '../shared/agentStateBatch';
import { VIEWER_VISIBILITY_BATCH_MAX } from '../shared/viewerVisibilityBatch';
import { DAEMON_CONTROL_LINE_MAX_CHARS } from '../shared/daemonControlLine';
import { sanitizeTitle } from './pty/titleDetect';
import {
  getDaemonAuthTokenPath,
  getDaemonSocketPath,
  getLegacyDaemonAuthTokenPath,
  getLegacySessionSocketPath,
  getSessionSocketPath,
} from '../shared/constants';
import { connectWithRetry, type ConnectAttemptResult } from './daemonConnectRetry';
import type { AgentStatus } from '../shared/types';
import type { AgentSlug } from '../shared/agentIdentity';
import { isSessionPromptScheduleResult, type SessionPromptScheduleResult } from '../shared/sessionPromptSchedule';
import { parseToolRefusal, type ToolRefusal } from '../shared/toolRefusal';
import { parseCommitOrigin, type CommitOrigin } from '../shared/commitOrigin';

// RCA A2 — single source of truth in shared/timeouts.ts so the renderer's
// RECONCILE_TIMEOUT_MS can be derived from (and stay greater than) this value.
const RPC_TIMEOUT_MS = DAEMON_RPC_TIMEOUT_MS;
/**
 * #2372 — how long a session-list read waits for others to share its call. A
 * reloaded window's panes ask over tens of milliseconds, not in one turn.
 */
const LIST_SESSIONS_COALESCE_MS = 20;
/** #2372 — likewise for viewer-visibility reports, which nobody awaits. */
const VIEWER_VISIBILITY_COALESCE_MS = 50;

/** Params made only of primitives, so their JSON is a faithful key. */
function flatParams(params: Record<string, unknown>): boolean {
  return Object.values(params).every((v) => v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v));
}
const MAX_LINE_BUFFER = DAEMON_CONTROL_LINE_MAX_CHARS; // 1 MB

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Client for connecting to wmux-daemon from the Electron main process.
 * Communicates over Named Pipe (Windows) / Unix domain socket using JSON-RPC.
 *
 * Events:
 *   'session:data'   — { sessionId: string, data: Buffer, replay: boolean }
 *   'session:died'   — { sessionId: string, exitCode: number | null }
 *   'disconnected'   — daemon control pipe disconnected
 *   'event'          — DaemonEvent from daemon broadcast
 */
export class DaemonClient extends EventEmitter {
  private controlPipe: net.Socket | null = null;
  private sessionPipes: Map<string, net.Socket> = new Map();
  // Per-session stream state machine (marker scanning + flush accounting).
  // Keyed by sessionId, lifecycle-bound to the socket in sessionPipes: created
  // in setupSessionPipe, dropped on socket close/error/disconnect.
  private sessionScanners: Map<string, SessionPipeStreamScanner> = new Map();
  private connected: boolean = false;
  private requestId: number = 0;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  /** Each pane's last refused tool call, as the daemon reported it (`agent.refusal`). */
  private readonly toolRefusals = new Map<string, ToolRefusal>();
  private controlBuffer: string = '';

  constructor(
    private pipeName: string,
    private authToken: string,
  ) {
    super();
  }

  /**
   * Connect to the daemon control pipe. Returns false on failure (for fallback).
   *
   * RCA A6 — wraps the connect attempt in a bounded retry: a transient Windows
   * named-pipe blip (EPERM/ECONNRESET from AV scan / handle contention) is
   * retried with short backoff instead of being treated as a dead daemon, while
   * a genuinely-absent daemon (ENOENT/ECONNREFUSED) still returns false fast
   * with no retry. The retry policy is the pure, unit-tested connectWithRetry.
   */
  async connect(): Promise<boolean> {
    if (this.connected) return true;
    return connectWithRetry({
      attempt: () => this.attemptConnect(),
      isConnected: () => this.connected,
      log: (message) => console.warn(`[lifecycle] DaemonClient.connect ${message} pipe=${this.pipeName}`),
    });
  }

  /** A single control-pipe connect attempt, classified for the retry layer. */
  private attemptConnect(): Promise<ConnectAttemptResult> {
    return new Promise<ConnectAttemptResult>((resolve) => {
      let settled = false;
      const finish = (r: ConnectAttemptResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const timeout = setTimeout(() => {
        // RCA A6/A8 — record connect timeouts. A daemon that is alive but slow
        // to accept on the control pipe is a transient condition (retried),
        // not a dead one; the timeout is surfaced in the log either way.
        console.warn(`[lifecycle] DaemonClient.connect attempt timeout (5s) pipe=${this.pipeName}`);
        socket.destroy();
        finish({ ok: false, timedOut: true });
      }, 5_000);

      const socket = net.createConnection(this.pipeName, () => {
        clearTimeout(timeout);
        this.controlPipe = socket;
        this.connected = true;
        // #2372 — a new connection may be a new daemon, and a list read left
        // in flight on the old socket must not hold up the ones queued behind it.
        this.connectionEpoch += 1;
        this.viewerVisibilityBatchRefused = false;
        for (const key of this.listSessionsQueue.keys()) {
          if (!this.listSessionsBusy(key)) setImmediate(() => this.flushListSessions(key));
        }
        this.setupControlPipe(socket);
        // Pushed events are first-party-only and opt-in. Start the event
        // handshake before connect() resolves so no caller RPC can overtake it
        // on this socket. The returned barrier settles after subscribe and
        // identify have both been written (not after either
        // reply), preserving non-blocking startup while fixing the wire order.
        void this.startEventHandshake().finally(() => finish({ ok: true }));
      });

      socket.on('error', (err: NodeJS.ErrnoException) => {
        // RCA A6/A8 — surface the error CODE (EPERM/ECONNREFUSED/ENOENT) and
        // hand it to classifyConnectFailure: EPERM/ECONNRESET on Windows are
        // transient (AV scan / handle contention) and get retried; ENOENT /
        // ECONNREFUSED mean the daemon is genuinely absent and fail fast.
        clearTimeout(timeout);
        console.warn(`[lifecycle] DaemonClient.connect error code=${err?.code ?? '?'} pipe=${this.pipeName} msg=${err?.message ?? String(err)}`);
        finish({ ok: false, code: err?.code });
      });
    });
  }

  /**
   * Ask for pushed events, identify as the Electron main client, then retry
   * subscribe if this daemon enforces the first-party gate.
   *
   * Retried, because a swallowed failure here is silent and total: the app
   * would keep running with no session, title, cwd, or notification events for
   * the life of the connection, and nothing would ever ask again. The realistic
   * failure is transient — the subscribe shares the daemon's RPC rate limit
   * with every other client, so a boot-time burst can bounce it once.
   *
   * `Unknown method` is the one terminal answer worth recognizing: that daemon
   * predates opt-in events and is already pushing to everyone, so retrying
   * would only spend the rate limit re-asking a question already answered.
   */
  private static readonly EVENT_HANDSHAKE_MAX_ATTEMPTS = 5;

  // Bumped on every connect so a retry loop left over from a previous socket
  // cannot resurrect itself and subscribe on behalf of a connection that is
  // already gone.
  private eventHandshakeGeneration = 0;
  /** #2372 — default-timeout agent reads asked for in this turn, by pane id. */
  private agentStateQueue: Map<string, Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }>> | null = null;
  /**
   * #2372 — `daemon.listSessions` reads waiting for their call, by params.
   * A key with a call in flight is in `listSessionsInFlight`; reads asked for
   * meanwhile wait here for the next one.
   */
  private listSessionsQueue = new Map<string, { params: Record<string, unknown>; waiters: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> }>();
  /** The connection each key's in-flight call went out on (see listSessionsBusy). */
  private listSessionsInFlight = new Map<string, number>();
  /** Bumped on every successful connect. */
  private connectionEpoch = 0;
  /** The connected daemon refused a batched visibility call (older than #2372). */
  private viewerVisibilityBatchRefused = false;
  /** #2372 — viewer-visibility reports waiting for their call, last one per pane. */
  private viewerVisibilityQueue: Map<string, boolean> | null = null;

  /**
   * Subscribe to pushed events again on the live connection. The daemon drops
   * a subscriber whose socket buffer passes its backpressure cap without
   * closing the socket, so the health probe calls this when a ping reports
   * `eventsSubscribed: false`.
   *
   * Unlike the connect-time handshake this settles on the OUTCOME, not on the
   * request being written: true once the daemon accepted a subscribe (or
   * predates opt-in events and pushes to every client), false when every
   * attempt was refused or the connection went away. The daemon refuses while
   * the socket is still backed up past its cap (#2469), and a state read made
   * before the accepted attempt can miss a change that lands in between, so
   * the caller resyncs only on true.
   */
  async resubscribeEvents(): Promise<boolean> {
    const generation = ++this.eventHandshakeGeneration;
    try {
      return await this.runEventHandshakeWithRetry(generation, () => undefined);
    } catch (err) {
      console.warn(
        `[lifecycle] DaemonClient event resubscribe threw: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private startEventHandshake(): Promise<void> {
    const generation = ++this.eventHandshakeGeneration;
    return new Promise<void>((resolve) => {
      let handshakeWritten = false;
      const signalHandshakeWritten = (): void => {
        if (handshakeWritten) return;
        handshakeWritten = true;
        resolve();
      };
      void this.runEventHandshakeWithRetry(generation, signalHandshakeWritten)
        .catch((err: unknown) => {
          console.warn(
            `[lifecycle] DaemonClient event handshake threw: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(signalHandshakeWritten);
    });
  }

  /** True once a subscribe was accepted (or the daemon has no opt-in). */
  private async runEventHandshakeWithRetry(
    generation: number,
    signalHandshakeWritten: () => void,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= DaemonClient.EVENT_HANDSHAKE_MAX_ATTEMPTS; attempt++) {
      if (generation !== this.eventHandshakeGeneration || !this.connected) return false;
      // Subscribe stays first for compatibility with daemons that already
      // retain an accept-to-subscribe backlog but do not yet enforce identity:
      // sending identify first would make those daemons discard the backlog.
      // A gated daemon refuses this first attempt, then the identify below
      // classifies the socket. Both writes happen before connect() resolves.
      const subscribe = this.rpc('daemon.events.subscribe');
      const identify = this.rpc('daemon.client.identify', { role: 'main' });
      signalHandshakeWritten();

      const [subscribeResult, identifyResult] = await Promise.allSettled([subscribe, identify]);
      const rpcSucceeded = (result: PromiseSettledResult<unknown>): boolean =>
        result.status === 'fulfilled'
        && (result.value as { ok?: boolean } | null)?.ok === true;

      if (rpcSucceeded(subscribeResult)) return true;
      if (subscribeResult.status === 'rejected') {
        const message = subscribeResult.reason instanceof Error
          ? subscribeResult.reason.message
          : String(subscribeResult.reason);
        if (message.includes('Unknown method')) return true;
      }

      if (identifyResult.status === 'rejected') {
        const message = identifyResult.reason instanceof Error
          ? identifyResult.reason.message
          : String(identifyResult.reason);
        // A daemon old enough not to recognise identity either predates opt-in
        // events or still permits subscribe without the classification gate.
        if (!message.includes('Unknown method')) {
          console.warn(`[lifecycle] DaemonClient identify attempt ${attempt} failed: ${message}`);
        }
      }

      // A gated daemon normally refuses the first subscribe and then accepts
      // this immediate post-identify retry. Awaiting the identity result makes
      // correctness independent of whether its handler ever gains an `await`
      // before classification, while connect() itself remains non-blocking.
      if (rpcSucceeded(identifyResult)
        && generation === this.eventHandshakeGeneration
        && this.connected) {
        try {
          const retry = (await this.rpc('daemon.events.subscribe')) as { ok?: boolean } | null;
          if (retry?.ok === true) return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('Unknown method')) return true;
          console.warn(`[lifecycle] DaemonClient post-identify subscribe attempt ${attempt} failed: ${message}`);
        }
      } else if (subscribeResult.status === 'rejected') {
        const message = subscribeResult.reason instanceof Error
          ? subscribeResult.reason.message
          : String(subscribeResult.reason);
        console.warn(`[lifecycle] DaemonClient events subscribe attempt ${attempt} failed: ${message}`);
      }
      if (attempt < DaemonClient.EVENT_HANDSHAKE_MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
      }
    }
    if (generation !== this.eventHandshakeGeneration || !this.connected) return false;
    console.error(
      '[lifecycle] DaemonClient could not subscribe to daemon events — this connection will receive none',
    );
    return false;
  }

  /** Disconnect from daemon, cleaning up all pipes. */
  async disconnect(): Promise<void> {
    // Disconnect all session pipes first
    const sessionIds = Array.from(this.sessionPipes.keys());
    for (const sessionId of sessionIds) {
      await this.disconnectSessionPipe(sessionId);
    }

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('DaemonClient disconnecting'));
      this.pendingRequests.delete(id);
    }

    // Disconnect control pipe
    if (this.controlPipe) {
      this.controlPipe.destroy();
      this.controlPipe = null;
    }
    this.connected = false;
    this.controlBuffer = '';
  }

  /** Synchronous disconnect — for use in process exit/session-end handlers
   *  where async operations cannot complete, AND for runtime recovery
   *  paths (the respawn controller's hang detector) where we need to
   *  drop the socket fast but still keep the rest of the app responsive.
   *  Destroys all sockets immediately and rejects every pending RPC so
   *  callers do not hang forever waiting on a reply that can no longer
   *  arrive. (Codex review #4 on issue #54 respawn loop.) */
  disconnectSync(): void {
    for (const [, socket] of this.sessionPipes) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.sessionPipes.clear();
    this.sessionScanners.clear();

    // Reject pending requests so in-flight RPC promises settle instead
    // of dangling. The async `disconnect()` already does this; the sync
    // path used to skip it because the exit path didn't care, but the
    // respawn controller calls disconnectSync at runtime — silently
    // dropped pendings would leave renderer actions hung forever.
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      try { pending.reject(new Error('DaemonClient disconnected')); } catch { /* defensive */ }
      this.pendingRequests.delete(id);
    }

    if (this.controlPipe) {
      try { this.controlPipe.destroy(); } catch { /* ignore */ }
      this.controlPipe = null;
    }
    this.connected = false;
    this.controlBuffer = '';
  }

  /**
   * Send an RPC call over the control pipe.
   *
   * `opts.timeoutMs` overrides the default {@link RPC_TIMEOUT_MS}. Pass a
   * larger value for long-running RPCs such as `daemon.shutdown`, which may
   * exceed 10 s while RingBuffer dumps complete.
   */
  async rpc(
    method: string,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    if (!this.controlPipe || !this.connected) {
      throw new Error('DaemonClient not connected');
    }
    if (method === 'daemon.listSessions' && opts.timeoutMs === undefined && flatParams(params)) {
      return this.listSessionsCoalesced(params);
    }
    // #2372 — a detach resets the daemon's viewer visibility to its default,
    // so a report for that pane still waiting in the queue must reach the
    // daemon first, or it would land after the reset.
    if (method === 'daemon.detachSession' && typeof params['id'] === 'string' && this.viewerVisibilityQueue?.has(params['id'])) {
      void this.flushViewerVisibility();
    }
    return this.send(method, params, opts);
  }

  /**
   * #2372 — every pane of a reloaded window asks main for the session list
   * (its reconnect, and `pty:list`), and each read is the whole list: 60
   * panes cost about 130 calls in one second, past the daemon's 200/s budget
   * with the panes' resizes, so some of those resizes and lists were refused.
   * Reads with the same params asked within LIST_SESSIONS_COALESCE_MS share
   * one call. A read never takes an answer
   * from a call sent before it was asked: one asked while a call is in
   * flight waits for the next, which goes out when that one returns. Each
   * waiter after the first gets its own copy, so one caller changing its
   * array cannot change another's. A read with its own timeout, or with
   * nested params, is not shared.
   *
   * Every read keeps the deadline it would have had alone (RPC_TIMEOUT_MS
   * from when it was asked), so waiting behind a slow call never stretches
   * it: callers such as the renderer's reconcile watchdog rely on that bound.
   */
  private listSessionsCoalesced(params: Record<string, unknown>): Promise<unknown> {
    const key = JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return new Promise((resolve, reject) => {
      let entry = this.listSessionsQueue.get(key);
      if (!entry) {
        entry = { params, waiters: [] };
        this.listSessionsQueue.set(key, entry);
        if (!this.listSessionsBusy(key)) setTimeout(() => this.flushListSessions(key), LIST_SESSIONS_COALESCE_MS).unref?.();
      }
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        reject(new Error(`RPC timeout: daemon.listSessions (${RPC_TIMEOUT_MS}ms)`));
      }, RPC_TIMEOUT_MS);
      entry.waiters.push({
        resolve: (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
        reject: (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); },
      });
    });
  }

  /** A call for `key` is out on THIS connection. One left on a dropped socket does not hold the key. */
  private listSessionsBusy(key: string): boolean {
    return this.listSessionsInFlight.get(key) === this.connectionEpoch;
  }

  private flushListSessions(key: string): void {
    const entry = this.listSessionsQueue.get(key);
    if (!entry) return;
    this.listSessionsQueue.delete(key);
    const epoch = this.connectionEpoch;
    this.listSessionsInFlight.set(key, epoch);
    let call: Promise<unknown>;
    try {
      call = this.controlPipe && this.connected ? this.send('daemon.listSessions', entry.params) : Promise.reject(new Error('DaemonClient not connected'));
    } catch (err) {
      call = Promise.reject(err);
    }
    void call.then(
      (rows) => entry.waiters.forEach((w, i) => w.resolve(i === 0 ? rows : structuredClone(rows))),
      (err: unknown) => entry.waiters.forEach((w) => w.reject(err)),
    ).finally(() => {
      if (this.listSessionsInFlight.get(key) === epoch) this.listSessionsInFlight.delete(key);
      if (this.listSessionsQueue.has(key) && !this.listSessionsBusy(key)) this.flushListSessions(key);
    });
  }

  private send(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number } = {},
  ): Promise<unknown> {
    const id = `req-${++this.requestId}`;
    const timeoutMs = opts.timeoutMs ?? RPC_TIMEOUT_MS;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      const request = JSON.stringify({
        id,
        method,
        params,
        token: this.authToken,
      }) + '\n';

      this.controlPipe!.write(request);
    });
  }

  /**
   * Connect a session data pipe for streaming PTY output/input.
   *
   * Idempotency is liveness-based, not map-presence-based. A stale entry
   * left over from a daemon-side pipe replacement (renderer reload,
   * daemon hot-reconnect, etc.) used to early-return success, leaving
   * writes to silently route to a half-dead socket. Now the call always
   * verifies the existing socket is still usable; if not, the stale
   * entry is torn down and a fresh pipe is opened.
   *
   * Caller can force a fresh connection (e.g. `pty:reconnect` after a
   * known daemon-side replacement) by passing `forceFresh: true`.
   */
  async connectSessionPipe(sessionId: string, opts?: { forceFresh?: boolean }): Promise<void> {
    const existing = this.sessionPipes.get(sessionId);
    if (existing) {
      const isHealthy = !existing.destroyed && existing.writable;
      if (isHealthy && !opts?.forceFresh) return;
      // Stale or caller demands fresh — tear down before reconnecting.
      // Removing from the map first prevents the close/error handlers
      // from racing the new entry we're about to install.
      this.sessionPipes.delete(sessionId);
      existing.destroy();
    }

    const pipeName = this.getSessionPipeName(sessionId);

    try {
      await this.connectSessionPipeOnce(sessionId, pipeName);
    } catch (err) {
      // P7 legacy 폴백: 업그레이드를 관통해 살아 있는 구버전 데몬은 세션 소켓을
      // 구경로(`~/.wmux-session-<id>.sock`)에 바인드한다. 새 경로가 ENOENT면
      // 구경로를 1회 재시도한다(Unix 전용 — win 파이프 이름은 불변).
      const code = (err as NodeJS.ErrnoException)?.code;
      if (process.platform !== 'win32' && code === 'ENOENT') {
        await this.connectSessionPipeOnce(sessionId, getLegacySessionSocketPath(sessionId));
        return;
      }
      throw err;
    }
  }

  /** 세션 파이프 단일 연결 시도 — 성공 시 소켓 등록까지 수행. */
  private connectSessionPipeOnce(sessionId: string, pipeName: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Session pipe connection timeout: ${sessionId}`));
      }, 5_000);

      const socket = net.createConnection(pipeName, () => {
        clearTimeout(timeout);
        // Send auth token before setting up data handler
        socket.write(this.authToken + '\n');
        this.sessionPipes.set(sessionId, socket);
        this.setupSessionPipe(sessionId, socket);
        resolve();
      });

      socket.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Disconnect a session data pipe. */
  async disconnectSessionPipe(sessionId: string): Promise<void> {
    const socket = this.sessionPipes.get(sessionId);
    if (socket) {
      socket.destroy();
      this.sessionPipes.delete(sessionId);
    }
    this.sessionScanners.delete(sessionId);
  }

  /**
   * Cheap liveness check for a session's data pipe. Used by pty:reconnect
   * to probe the freshly opened socket before reporting success, so a
   * truthy reconnect can't mask a half-dead pipe.
   */
  isSessionPipeWritable(sessionId: string): boolean {
    const socket = this.sessionPipes.get(sessionId);
    if (!socket) return false;
    return !socket.destroyed && socket.writable;
  }

  /**
   * Write input data to a session via its data pipe. Returns true if the
   * data was handed to a live socket, false if the call silently dropped.
   *
   * A false return points the caller at one of: (a) the session pipe was
   * never connected, (b) the cached socket was torn down between attach
   * and write, (c) the daemon replaced the pipe and our cached entry is
   * a stale reference about to receive its close event. The caller is
   * responsible for surfacing the drop so users don't see input-mute
   * without explanation.
   */
  writeToSession(sessionId: string, data: string | Buffer): boolean {
    const socket = this.sessionPipes.get(sessionId);
    if (!socket) return false;
    if (socket.destroyed || !socket.writable) return false;
    socket.write(data);
    return true;
  }

  /**
   * Read structured OSC 133 prompt/command events from a daemon session.
   * Returns an empty payload with sessionFound=false when the session does
   * not exist, so callers can degrade without throwing.
   */
  async readPromptEvents(
    sessionId: string,
    opts: { limit?: number; sinceOffset?: number; lastCommandOnly?: boolean } = {},
  ): Promise<{
    events: Array<{ type: string; ts: number; byteOffset: number; exitCode?: number }>;
    lastCompletedRange: { startOffset: number; endOffset: number; exitCode: number | null } | null;
    totalBytesWritten: number;
    sessionFound: boolean;
  }> {
    const params: Record<string, unknown> = { sessionId };
    if (opts.limit !== undefined) params.limit = opts.limit;
    if (opts.sinceOffset !== undefined) params.sinceOffset = opts.sinceOffset;
    if (opts.lastCommandOnly) params.lastCommandOnly = true;
    const result = await this.rpc('daemon.readPromptEvents', params);
    return result as {
      events: Array<{ type: string; ts: number; byteOffset: number; exitCode?: number }>;
      lastCompletedRange: { startOffset: number; endOffset: number; exitCode: number | null } | null;
      totalBytesWritten: number;
      sessionFound: boolean;
    };
  }

  /**
   * LanLink PR-2 — cursor-pull the daemon's durable inbox. Returns every record
   * with seq > cursor; `nextCursor` never rewinds. RemoteInboxBridge advances
   * its retained cursor only after the pulled items are materialized, so a
   * reconnect replay is exactly-once on the read side.
   */
  async inboxPoll(cursor: number): Promise<LanLinkInboxPollResult> {
    const result = await this.rpc('daemon.inbox.poll', { cursor });
    return result as LanLinkInboxPollResult;
  }

  /**
   * LanLink PR-3 — read the control-plane status: persisted enable/NIC/port plus
   * the live LAN-capable NIC list (re-enumerated daemon-side each call). The
   * Settings UI reads this on mount; the daemon is the source of truth.
   */
  async lanlinkStatus(): Promise<LanLinkStatus> {
    const result = await this.rpc('lanlink.status', {});
    return result as LanLinkStatus;
  }

  /**
   * LanLink PR-3 — apply a partial control-plane update (enable toggle / NIC
   * selection). The daemon validates, persists to config.json, and echoes the new
   * status. PR-3 builds no listener; this only flips persisted config + fires the
   * daemon-internal change signal a future LAN listener (PR-4) subscribes to.
   */
  async lanlinkConfigure(patch: LanLinkConfigurePatch): Promise<LanLinkStatus> {
    const result = await this.rpc('lanlink.configure', patch as Record<string, unknown>);
    return result as LanLinkStatus;
  }

  // === LanLink PR-5 — pairing/peer control-pipe bridge ===
  //
  // Thin pass-throughs to the daemon's PR-4 control-pipe RPCs (the trust boundary
  // and all validation live daemon-side: pair.join/send require host+port+pin/uuid
  // and throw otherwise; peers.remove no-ops on an empty uuid). pair.join/send do a
  // scrypt PIN-EKE PAKE + LAN round trip, so they override the default 10s RPC
  // timeout to 30s — otherwise a slow first-connect surfaces as a confusing "RPC
  // timeout" rather than a pairing/network error.

  /** Mint a 6-digit PIN + arm the ≤2min pairing window. */
  async lanlinkPairBegin(): Promise<LanLinkPairBeginResult> {
    const result = await this.rpc('lanlink.pair.begin', {});
    return result as LanLinkPairBeginResult;
  }

  /** Read-only poll of the pairing window (active / remaining ms / fail count). */
  async lanlinkPairStatus(): Promise<LanLinkPairingStatus> {
    const result = await this.rpc('lanlink.pair.status', {});
    return result as LanLinkPairingStatus;
  }

  /** Disarm the pairing window immediately. */
  async lanlinkPairCancel(): Promise<{ ok: true }> {
    const result = await this.rpc('lanlink.pair.cancel', {});
    return result as { ok: true };
  }

  /** Outbound join to a remote peer (all fields required; 30s for scrypt PAKE). */
  async lanlinkPairJoin(args: LanLinkPairJoinArgs): Promise<LanLinkJoinResult> {
    const result = await this.rpc(
      'lanlink.pair.join',
      args as unknown as Record<string, unknown>,
      { timeoutMs: 30_000 },
    );
    return result as LanLinkJoinResult;
  }

  /** Outbound text message to a paired peer (host/port/peerUuid required). */
  async lanlinkSend(args: LanLinkSendArgs): Promise<{ ok: true }> {
    const result = await this.rpc(
      'lanlink.send',
      args as unknown as Record<string, unknown>,
      { timeoutMs: 30_000 },
    );
    return result as { ok: true };
  }

  /** List paired peers (secrets stripped daemon-side; note the `peers` wrapper). */
  async lanlinkPeersList(): Promise<LanLinkPeersListResult> {
    const result = await this.rpc('lanlink.peers.list', {});
    return result as LanLinkPeersListResult;
  }

  /** Revoke a peer (live: deletes record + destroys its AEAD connection). */
  async lanlinkPeersRemove(peerUuid: string): Promise<{ ok: true }> {
    const result = await this.rpc('lanlink.peers.remove', { peerUuid });
    return result as { ok: true };
  }

  // === Cross-host A2A control plane (`a2a.remote.*`) ===
  //
  // Thin pass-throughs; validation lives daemon-side. `join` does a pinned TLS
  // pairing plus a hello round trip, so it gets 30s like lanlinkPairJoin; the
  // daemon answers a structured `{ ok:false, error }` long before that.

  async a2aRemoteStatus(): Promise<A2aRemoteStatus> {
    return (await this.rpc('a2a.remote.status', {})) as A2aRemoteStatus;
  }

  async a2aRemoteConfigure(patch: { enabled?: boolean; port?: number }): Promise<A2aRemoteStatus> {
    return (await this.rpc('a2a.remote.configure', patch as Record<string, unknown>)) as A2aRemoteStatus;
  }

  async a2aRemotePairBegin(): Promise<A2aRemotePairBeginResult> {
    return (await this.rpc('a2a.remote.pair.begin', {})) as A2aRemotePairBeginResult;
  }

  async a2aRemotePairCancel(): Promise<{ ok: true }> {
    return (await this.rpc('a2a.remote.pair.cancel', {})) as { ok: true };
  }

  async a2aRemotePairStatus(): Promise<A2aRemotePairStatus> {
    return (await this.rpc('a2a.remote.pair.status', {})) as A2aRemotePairStatus;
  }

  async a2aRemoteJoin(invite: string): Promise<A2aRemoteJoinResult> {
    return (await this.rpc('a2a.remote.join', { invite }, { timeoutMs: 30_000 })) as A2aRemoteJoinResult;
  }

  async a2aRemoteHostsList(): Promise<A2aRemoteHostsListResult> {
    return (await this.rpc('a2a.remote.hosts.list', {})) as A2aRemoteHostsListResult;
  }

  /** Also tells the other PC (best effort, over the pinned connection), hence 30s. */
  async a2aRemoteHostsRemove(hostId: string): Promise<A2aRemoteHostsRemoveResult> {
    return (await this.rpc('a2a.remote.hosts.remove', { hostId }, { timeoutMs: 30_000 })) as A2aRemoteHostsRemoveResult;
  }

  async a2aRemotePeersList(): Promise<A2aRemotePeersListResult> {
    return (await this.rpc('a2a.remote.peers.list', {})) as A2aRemotePeersListResult;
  }

  async a2aRemotePeersRevoke(peerId: string): Promise<{ ok: boolean }> {
    return (await this.rpc('a2a.remote.peers.revoke', { peerId })) as { ok: boolean };
  }

  /** `reconciled`: every share whose pane closed or moved was ended first (see ExposedPaneCache.isReconciled). */
  async a2aRemoteExposurePublish(panes: A2aExposureCandidate[], reconciled = false): Promise<{ ok: true; count: number }> {
    return (await this.rpc('a2a.remote.exposure.publish', { panes, reconciled })) as { ok: true; count: number };
  }

  async a2aRemoteExposureList(): Promise<A2aRemoteExposureListResult> {
    return (await this.rpc('a2a.remote.exposure.list', {})) as A2aRemoteExposureListResult;
  }

  async a2aRemoteExposureGet(hostId: string): Promise<A2aRemoteExposureGetResult> {
    return (await this.rpc('a2a.remote.exposure.get', { hostId })) as A2aRemoteExposureGetResult;
  }

  async a2aRemoteExposureSet(
    hostId: string, workspaceIds: string[], paneIds: Record<string, string[]>, brain: boolean, expected?: A2aRemoteExposureGetResult['exposure'],
  ): Promise<A2aRemoteExposureSetResult> {
    return (await this.rpc('a2a.remote.exposure.set', {
      hostId, workspaceIds, paneIds, brain, ...(expected !== undefined ? { expected } : {}),
    })) as A2aRemoteExposureSetResult;
  }

  async a2aSpawnPolicyGet(): Promise<{ policy: A2aSpawnPolicyV1 }> {
    return (await this.rpc(A2A_SPAWN_RPC.policyGet, {})) as { policy: A2aSpawnPolicyV1 };
  }

  /** The daemon checks and realpaths each root and bumps `version`. */
  async a2aSpawnPolicySet(policy: A2aSpawnPolicyV1): Promise<A2aSpawnPolicySetResult> {
    return (await this.rpc(A2A_SPAWN_RPC.policySet, { policy })) as A2aSpawnPolicySetResult;
  }

  async a2aSpawnRequestsList(): Promise<{ requests: A2aSpawnRequestSummary[] }> {
    return (await this.rpc(A2A_SPAWN_RPC.requestsList, {})) as { requests: A2aSpawnRequestSummary[] };
  }

  /** As the asking PC: store a request and queue it for the other PC (no network wait). */
  async a2aSpawnAsk(input: A2aSpawnAskInput): Promise<A2aSpawnAskResult> {
    return (await this.rpc(A2A_SPAWN_RPC.ask, { ...input })) as A2aSpawnAskResult;
  }

  async a2aSpawnOutgoing(spawnId?: string): Promise<A2aSpawnOutgoingList> {
    return (await this.rpc(A2A_SPAWN_RPC.outgoing, spawnId ? { spawnId } : {})) as A2aSpawnOutgoingList;
  }

  /** Reaches the other PC over the pinned connection, hence 30s. */
  async a2aRemoteHostsExposed(hostId: string): Promise<A2aRemoteHostsExposedResult> {
    return (await this.rpc('a2a.remote.hosts.exposed', { hostId }, { timeoutMs: 30_000 })) as A2aRemoteHostsExposedResult;
  }

  async a2aRemoteLinksList(): Promise<A2aRemoteLinksListResult> {
    return (await this.rpc('a2a.remote.links.list', {})) as A2aRemoteLinksListResult;
  }

  /** propose / revoke / refresh may reach the other PC, hence 30s. */
  async a2aRemoteLinksPropose(params: A2aRemoteLinkProposeParams): Promise<A2aRemoteLinkResult> {
    return (await this.rpc('a2a.remote.links.propose', params as unknown as Record<string, unknown>, { timeoutMs: 30_000 })) as A2aRemoteLinkResult;
  }

  async a2aRemoteLinkAction(action: 'accept' | 'reject' | 'revoke' | 'refresh', linkId: string): Promise<A2aRemoteLinkResult> {
    return (await this.rpc(`a2a.remote.links.${action}`, { linkId }, { timeoutMs: 30_000 })) as A2aRemoteLinkResult;
  }

  async a2aRemoteOffersList(): Promise<A2aRemoteOffersListResult> {
    return (await this.rpc('a2a.remote.offers.list', {})) as A2aRemoteOffersListResult;
  }

  /** Accept / decline reach the PC that shared, hence 30s. */
  async a2aRemoteOfferAccept(params: A2aRemoteOfferAcceptParams): Promise<A2aRemoteOfferResult> {
    return (await this.rpc('a2a.remote.offers.accept', params as unknown as Record<string, unknown>, { timeoutMs: 30_000 })) as A2aRemoteOfferResult;
  }

  async a2aRemoteOfferCreate(params: { hostId: string; end: A2aExposureCandidate; allow: { outbound: boolean; inbound: boolean } }): Promise<A2aRemoteOfferCreateResult> {
    return (await this.rpc('a2a.remote.offers.create', params as unknown as Record<string, unknown>)) as A2aRemoteOfferCreateResult;
  }

  async a2aRemoteOfferWithdraw(offerId: string): Promise<A2aRemoteOfferResult> {
    return (await this.rpc('a2a.remote.offers.withdraw', { offerId })) as A2aRemoteOfferResult;
  }

  async a2aRemoteOfferDecline(offerId: string): Promise<A2aRemoteOfferResult> {
    return (await this.rpc('a2a.remote.offers.decline', { offerId }, { timeoutMs: 30_000 })) as A2aRemoteOfferResult;
  }

  async a2aRemotePaneGone(params: A2aRemotePaneGoneParams): Promise<{ ok: true; broken: number }> {
    return (await this.rpc('a2a.remote.local.paneGone', params as unknown as Record<string, unknown>)) as { ok: true; broken: number };
  }

  /**
   * #2372 — one pane's raw `daemon.getAgentState` reply. Reads asked for in
   * the same turn go to the daemon as one call with `ids`, so a burst of
   * per-pane reads (the resync after a resubscribe, the renderer's name reads
   * at startup) costs one RPC instead of one per pane. A lone read stays a
   * single-id call. A daemon that answers a batch without `states` (older
   * than #2372) is read one pane at a time.
   */
  private readAgentStateRaw(sessionId: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.agentStateQueue) {
        this.agentStateQueue = new Map();
        setImmediate(() => void this.flushAgentStateQueue());
      }
      const waiters = this.agentStateQueue.get(sessionId) ?? [];
      waiters.push({ resolve, reject });
      this.agentStateQueue.set(sessionId, waiters);
    });
  }

  /**
   * #2372 — tell the daemon whether a desk renderer can see `sessionId`.
   * Fire-and-forget, as the renderer's report is. Reports made within
   * VIEWER_VISIBILITY_COALESCE_MS go as one call with `updates`, the last
   * report per pane winning (a
   * reloaded window reports every pane on mount and again after its
   * reattach). A lone report stays a single call. A daemon older than #2372
   * refuses `updates`; each pane is then sent one at a time, and so is every
   * later report on that connection.
   */
  setViewerVisibility(sessionId: string, visible: boolean): void {
    if (!this.viewerVisibilityQueue) {
      this.viewerVisibilityQueue = new Map();
      setTimeout(() => void this.flushViewerVisibility(), VIEWER_VISIBILITY_COALESCE_MS).unref?.();
    }
    // Re-inserted, so the order sent is the order of each pane's last report.
    this.viewerVisibilityQueue.delete(sessionId);
    this.viewerVisibilityQueue.set(sessionId, visible);
  }

  private async flushViewerVisibility(): Promise<void> {
    const queue = this.viewerVisibilityQueue;
    this.viewerVisibilityQueue = null;
    if (!queue || !this.connected) return;
    const single = (id: string, visible: boolean) =>
      this.send('daemon.setSessionViewerVisibility', { id, visible }).catch(() => undefined);
    const updates = [...queue].map(([id, visible]) => ({ id, visible }));
    if (updates.length === 1 || this.viewerVisibilityBatchRefused) {
      await Promise.all(updates.map((u) => single(u.id, u.visible)));
      return;
    }
    const chunks: Array<typeof updates> = [];
    for (let i = 0; i < updates.length; i += VIEWER_VISIBILITY_BATCH_MAX) chunks.push(updates.slice(i, i + VIEWER_VISIBILITY_BATCH_MAX));
    // Every chunk is written now, in order, before any later call.
    await Promise.all(chunks.map(async (chunk) => {
      let older = false;
      try {
        const res = (await this.send('daemon.setSessionViewerVisibility', { updates: chunk })) as { batched?: unknown } | null;
        older = res?.batched !== true;
      } catch (err) {
        // An older daemon requires `id` and refuses the batch. Any other
        // failure (a refused call) is dropped like a lost single report.
        older = /id \(string\) and visible \(boolean\) are required/.test(err instanceof Error ? err.message : String(err));
      }
      if (!older) return;
      this.viewerVisibilityBatchRefused = true;
      await Promise.all(chunk.map((u) => single(u.id, u.visible)));
    }));
  }

  private async flushAgentStateQueue(): Promise<void> {
    const queue = this.agentStateQueue;
    this.agentStateQueue = null;
    if (!queue) return;
    const settle = (id: string, read: Promise<unknown>) => read.then(
      (v) => { for (const w of queue.get(id) ?? []) w.resolve(v); },
      (err) => { for (const w of queue.get(id) ?? []) w.reject(err); },
    );
    const single = (id: string) => settle(id, this.rpc('daemon.getAgentState', { id }));
    const ids = [...queue.keys()];
    if (ids.length === 1) return single(ids[0]);
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += AGENT_STATE_BATCH_MAX) chunks.push(ids.slice(i, i + AGENT_STATE_BATCH_MAX));
    await Promise.all(chunks.map(async (chunk) => {
      let states: Record<string, unknown> | undefined;
      try {
        const res = (await this.rpc('daemon.getAgentState', { ids: chunk })) as { states?: unknown } | null;
        if (res && typeof res.states === 'object' && res.states !== null) states = res.states as Record<string, unknown>;
      } catch (err) {
        for (const id of chunk) void settle(id, Promise.reject(err));
        return;
      }
      await Promise.all(chunk.map((id) => (states && id in states ? settle(id, Promise.resolve(states[id])) : single(id))));
    }));
  }

  /**
   * daemon AgentDetector가 gate로 확정한 에이전트 표시명을 조회한다(없으면 null).
   * renderer detection pull의 권위 소스 — session:agent emit 전파 race를 우회한다.
   */
  async getAgentName(sessionId: string): Promise<string | null> {
    try {
      // Its agentName is the same daemon read (readDaemonAgentState) that
      // daemon.getAgentName answers, so a burst of name reads batches too.
      const result = await this.readAgentStateRaw(sessionId);
      const name = (result as { agentName?: unknown })?.agentName;
      return typeof name === 'string' && name ? name : null;
    } catch {
      return null;
    }
  }

  /** Current daemon-owned agent identity and status for reconnect-safe actions.
   *  `opts.timeoutMs` bounds one read for a caller that polls (#1680). */
  async getAgentState(sessionId: string, opts: { timeoutMs?: number } = {}): Promise<{
    agentName: string | null;
    /** #1307 — true when a live attributed process backs this pane.
     *  Missing or non-boolean parses to false, so an older daemon
     *  without the field still lets the resume path's slug check run. */
    agentVerified: boolean;
    agentStatus: AgentStatus;
    inputQuiet: boolean;
    inputRevision: number;
    incarnationId: string;
    /** #1680 — the key-only input counter: focus and pointer-motion reports do
     *  not move it. Absent on an older daemon. */
    keyInputRevision?: number;
    /** #1680 — `inputQuiet` for key input only. Absent on an older daemon. */
    keyInputQuiet?: boolean;
    /** #1680 — the pane's CURRENT agent has delivered a hook (reset when that
     *  agent ends). Absent on an older daemon. */
    hookReports?: boolean;
    /** The composer holds a typed but unsubmitted draft. Absent on an older daemon. */
    hasDraft?: boolean;
    /** Milliseconds since the last key input. Absent on an older daemon. */
    keyInputIdleMs?: number;
    /** #2263 — the latest window title ('' = none yet). Absent on an older daemon. */
    title?: string;
    /** #2263 — a turn is open (a quiet one reads `idle` in agentStatus). Absent on an older daemon. */
    turnOpen?: boolean;
    agentMidTurn?: boolean;
    /** Milliseconds since the pane's last settled result. Absent on an older
     *  daemon and when none settled since its agent started. */
    settledAgoMs?: number;
  } | null> {
    try {
      const result = await (opts.timeoutMs !== undefined
        ? this.rpc('daemon.getAgentState', { id: sessionId }, { timeoutMs: opts.timeoutMs })
        : this.readAgentStateRaw(sessionId)) as {
        agentName?: unknown;
        agentVerified?: unknown;
        agentStatus?: unknown;
        inputQuiet?: unknown;
        inputRevision?: unknown;
        incarnationId?: unknown;
        keyInputRevision?: unknown;
        keyInputQuiet?: unknown;
        hookReports?: unknown;
        hasDraft?: unknown;
        keyInputIdleMs?: unknown;
        title?: unknown;
        turnOpen?: unknown;
        agentMidTurn?: unknown;
        settledAgoMs?: unknown;
      };
      const validStatuses: AgentStatus[] = [
        'running',
        'complete',
        'error',
        'waiting',
        'awaiting_input',
        'idle',
      ];
      if (
        !validStatuses.includes(result.agentStatus as AgentStatus) ||
        typeof result.inputQuiet !== 'boolean' ||
        typeof result.inputRevision !== 'number' ||
        !Number.isInteger(result.inputRevision) ||
        result.inputRevision < 0 ||
        typeof result.incarnationId !== 'string' ||
        !result.incarnationId ||
        result.incarnationId.length > 128
      ) return null;
      return {
        agentName: typeof result.agentName === 'string' && result.agentName
          ? result.agentName
          : null,
        agentVerified: result.agentVerified === true,
        agentStatus: result.agentStatus as AgentStatus,
        inputQuiet: result.inputQuiet,
        inputRevision: result.inputRevision,
        incarnationId: result.incarnationId,
        ...(typeof result.keyInputRevision === 'number' &&
        Number.isInteger(result.keyInputRevision) &&
        result.keyInputRevision >= 0
          ? { keyInputRevision: result.keyInputRevision }
          : {}),
        ...(typeof result.keyInputQuiet === 'boolean' ? { keyInputQuiet: result.keyInputQuiet } : {}),
        ...(typeof result.hookReports === 'boolean' ? { hookReports: result.hookReports } : {}),
        ...(typeof result.hasDraft === 'boolean' ? { hasDraft: result.hasDraft } : {}),
        ...(typeof result.keyInputIdleMs === 'number' && Number.isFinite(result.keyInputIdleMs) && result.keyInputIdleMs >= 0
          ? { keyInputIdleMs: result.keyInputIdleMs }
          : {}),
        ...(typeof result.title === 'string' ? { title: sanitizeTitle(result.title) } : {}),
        ...(typeof result.turnOpen === 'boolean' ? { turnOpen: result.turnOpen } : {}),
        ...(typeof result.agentMidTurn === 'boolean' ? { agentMidTurn: result.agentMidTurn } : {}),
        ...(typeof result.settledAgoMs === 'number' && Number.isFinite(result.settledAgoMs) && result.settledAgoMs >= 0
          ? { settledAgoMs: result.settledAgoMs }
          : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * What `input.send` needs to paste and submit into a session (#1594): the
   * detected agent and whether the app enabled bracketed paste, both from the
   * daemon's live streams. Null on any failure, including a daemon that
   * predates the method — the caller then types, as before.
   */
  async getSendTarget(
    sessionId: string,
  ): Promise<{ agent: string | null; bracketedPaste: boolean | null } | null> {
    try {
      const r = (await this.rpc('daemon.getSendTarget', { id: sessionId }, { timeoutMs: 500 })) as {
        agentName?: unknown;
        bracketedPaste?: unknown;
      } | null;
      if (!r || typeof r !== 'object') return null;
      return {
        agent: typeof r.agentName === 'string' && r.agentName ? r.agentName : null,
        bracketedPaste: typeof r.bracketedPaste === 'boolean' ? r.bracketedPaste : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Whether a session's ring shows an agent's folder-trust dialog
   * (daemon/folderTrustState): the daemon's verdict, or why there is none
   * (not connected, a daemon that predates the method, no answer in time).
   * An 'unknown' carries the daemon's reason tag when it sent one (older
   * daemons do not), for the refusal logs. `budgetMs`: the daemon's read
   * budget, when not its default (an older daemon ignores it).
   */
  async folderTrustState(
    sessionId: string,
    timeoutMs: number,
    budgetMs?: number,
  ): Promise<{ state: FolderTrustState; reason?: string } | { unavailable: string }> {
    if (!this.isConnected) return { unavailable: 'daemon not connected' };
    try {
      const params = budgetMs !== undefined ? { id: sessionId, budgetMs } : { id: sessionId };
      const r = (await this.rpc('daemon.folderTrustState', params, { timeoutMs })) as { state?: unknown; reason?: unknown } | null;
      const state = r?.state;
      if (state !== 'trust' && state !== 'clear' && state !== 'unknown') return { unavailable: 'malformed answer' };
      // Only a short tag goes into a log line.
      const reason = state === 'unknown' && typeof r?.reason === 'string' && /^[a-z-]{1,32}$/.test(r.reason) ? r.reason : undefined;
      return reason ? { state, reason } : { state };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { unavailable: /Unknown method/.test(message) ? 'daemon predates daemon.folderTrustState' : message };
    }
  }

  /** Where a commit came from (daemon/commitOrigin): null when not recorded;
   *  'unavailable' when the daemon is unreachable or predates the record. */
  async lookupCommitOrigin(sha: string): Promise<CommitOrigin | null | 'unavailable'> {
    if (!this.isConnected) return 'unavailable';
    try {
      const response = await this.rpc('daemon.commitOrigin.lookup', { sha }) as { ok?: unknown; origin?: unknown };
      if (response.ok !== true) return 'unavailable';
      return response.origin == null ? null : parseCommitOrigin(response.origin) ?? 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  /** The daemon's pane usage-limit holds; empty when it is unreachable or predates them. */
  async listUsageLimits(): Promise<PaneUsageLimit[]> {
    if (!this.isConnected) return [];
    try {
      const response = await this.rpc('daemon.usageLimit.list', {}) as { limits?: unknown };
      return Array.isArray(response.limits) ? response.limits as PaneUsageLimit[] : [];
    } catch {
      return [];
    }
  }

  /** The pane's last refused tool call, or null. */
  toolRefusalOf(sessionId: string): ToolRefusal | null {
    return this.toolRefusals.get(sessionId) ?? null;
  }

  /**
   * The shell prompts the daemon shows now (daemon/shellPrompt), each checked
   * like an event. Null when it is unreachable or predates them: the caller
   * then keeps what it has instead of clearing it.
   */
  async listShellPrompts(): Promise<ShellPromptList | null> {
    if (!this.isConnected) return null;
    try {
      return parseShellPromptList(await this.rpc('daemon.shellPrompt.list', {}));
    } catch {
      return null;
    }
  }

  /** Hand the usage reserve's holds to the daemon (its scheduled runs). False when not delivered. */
  async setUsageReserveHolds(holds: ReadonlyArray<{ account: string; untilMs: number }>): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      const response = await this.rpc('daemon.usageReserve.set', { holds }) as { ok?: unknown };
      return response.ok === true;
    } catch {
      return false; // an older daemon has no reserve
    }
  }

  /** Edit one pane's usage-limit hold (auto-resume, dismiss, resume now, reset fill). */
  async updateUsageLimit(id: string, patch: PaneUsageLimitPatch): Promise<boolean> {
    if (!this.isConnected) return false;
    try {
      const response = await this.rpc('daemon.usageLimit.update', { id, patch }) as { ok?: unknown };
      return response.ok === true;
    } catch {
      return false;
    }
  }

  /** Daemon-owned identity/input-atomic scheduled prompt delivery. */
  async deliverScheduledPrompt(args: {
    id: string;
    agentSlug: AgentSlug;
    incarnationId: string;
    prompt: string;
  }): Promise<SessionPromptScheduleResult> {
    // This is known to be pre-send: rpc() cannot enqueue a request without a
    // live control pipe, so the occurrence remains safe to retry.
    if (!this.isConnected) return 'unavailable';

    try {
      const response = await this.rpc('daemon.deliverScheduledPromptV2', args) as {
        result?: unknown;
      };
      return isSessionPromptScheduleResult(response.result) ? response.result : 'error';
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('Unknown method')
      ) {
        // The v2 method name deliberately keeps mixed-version delivery from
        // falling through to a legacy handler that does not bind incarnation.
        // No write could have started, so keep the occurrence due for retry.
        return 'unavailable';
      }
      // The daemon may have accepted part of the occurrence before the control
      // reply was lost. Consume it as error; automatic retry could duplicate.
      return 'error';
    }
  }

  /** The fan-out caller nudge (daemon/callerNudgeDelivery.ts). An older
   *  daemon without the method answers Unknown method before any write. */
  async deliverCallerNudge(args: {
    id: string;
    agentSlug: AgentSlug;
    incarnationId: string;
    prompt: string;
  }): Promise<{ result: 'sent' | 'held' | 'approval_pending' | 'session_changed' | 'unavailable' | 'error'; pasted: boolean }> {
    if (!this.isConnected) return { result: 'unavailable', pasted: false };
    try {
      const response = await this.rpc('daemon.deliverCallerNudgeV1', args) as { result?: unknown; pasted?: unknown };
      const pasted = response.pasted === true;
      const r = response.result;
      if (r === 'sent' || r === 'held' || r === 'approval_pending' || r === 'session_changed' || r === 'unavailable' || r === 'error') {
        return { result: r, pasted };
      }
      return { result: 'error', pasted: true };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Unknown method')) {
        return { result: 'unavailable', pasted: false };
      }
      // The reply was lost: the daemon may have written. Never paste again.
      return { result: 'error', pasted: true };
    }
  }

  /** Whether the daemon control pipe is connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  // --- Private helpers ---

  // P7: shared 헬퍼가 데몬 바인더(daemon/SessionPipe.getPipeName)와 lockstep의
  // 단일 진실 소스. 구경로는 connectSessionPipe의 legacy 폴백에서만 쓴다.
  private getSessionPipeName(sessionId: string): string {
    return getSessionSocketPath(sessionId);
  }

  private setupControlPipe(socket: net.Socket): void {
    socket.setEncoding('utf8');

    socket.on('data', (chunk: string) => {
      this.controlBuffer += chunk;

      // Prevent OOM
      if (this.controlBuffer.length > MAX_LINE_BUFFER) {
        this.controlBuffer = '';
        return;
      }

      const lines = this.controlBuffer.split('\n');
      this.controlBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        this.handleControlMessage(trimmed);
      }
    });

    socket.on('error', () => {
      // Node.js will fire 'close' after 'error' — cleanup happens there
    });

    socket.on('close', () => {
      if (!this.connected) return; // guard against double emission
      this.connected = false;
      this.controlPipe = null;
      this.controlBuffer = '';
      this.toolRefusals.clear();
      this.emit('disconnected');
    });
  }

  private handleControlMessage(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line, (key, value) => {
        // Proto pollution prevention
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
        return value;
      });
    } catch {
      return;
    }

    // Check if it's a response to a pending RPC request
    const id = parsed['id'] as string | undefined;
    if (id && this.pendingRequests.has(id)) {
      const pending = this.pendingRequests.get(id)!;
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);

      const response = parsed as unknown as RpcResponse;
      if (response.ok) {
        pending.resolve(response.result);
      } else {
        pending.reject(new Error(response.error ?? 'Unknown RPC error'));
      }
      return;
    }

    // Otherwise treat as a daemon broadcast event
    const event = parsed as unknown as DaemonEvent;
    if (event.type) {
      this.emit('event', event);

      // Emit specific events for convenience. Daemon mode consumers (in
      // particular, DaemonNotificationRouter) subscribe to these to mirror
      // the local-mode PTYBridge wiring: activity → 'running', agent →
      // metadata + notification + toast, critical → approval request.
      switch (event.type) {
        case 'session.died': {
          const data = event.data as { exitCode?: number | null; signal?: number } | null;
          this.emit('session:died', {
            sessionId: event.sessionId,
            exitCode: data?.exitCode ?? null,
            ...(typeof data?.signal === 'number' ? { signal: data.signal } : {}),
          });
          break;
        }
        case 'session.destroyed':
          // pty:dispose path — distinct from session.died (natural exit).
          // Notification router treats both the same: clear agentStatus.
          this.emit('session:destroyed', { sessionId: event.sessionId });
          break;
        case 'session.restarted': {
          // X8 — the PaneSupervisor re-created this session under the same id
          // with a fresh PTY. pty.handler re-attaches via the existing
          // PTY_RECONNECT machinery (the daemon:connected reattach trigger
          // does NOT fire on a live restart). Distinct from session:died — a
          // restart must not run the died-path cleanup.
          const data = event.data as {
            restartCount?: number;
            consecutiveFailures?: number;
            exitCode?: number | null;
          } | null;
          this.emit('session:restarted', {
            sessionId: event.sessionId,
            restartCount: data?.restartCount ?? 0,
            consecutiveFailures: data?.consecutiveFailures ?? 0,
            exitCode: data?.exitCode ?? null,
          });
          break;
        }
        case 'supervision.changed': {
          // X8 — sticky supervision status flip (guard trip → 'stopped',
          // manual rearm/stop). pty.handler forwards every flip to the
          // renderer for badge sync and raises an OS toast on guard trips only.
          const data = event.data as {
            status?: 'armed' | 'stopped';
            reason?: 'guard-trip' | 'rearm' | 'manual-stop';
            restartCount?: number;
            consecutiveFailures?: number;
          } | null;
          this.emit('supervision:changed', {
            sessionId: event.sessionId,
            status: data?.status ?? 'armed',
            reason: data?.reason ?? 'rearm',
            restartCount: data?.restartCount ?? 0,
            consecutiveFailures: data?.consecutiveFailures ?? 0,
          });
          break;
        }
        case 'usage.limit.changed': {
          // A pane's usage-limit hold changed (shared/usageLimit); null = cleared.
          const data = event.data as { limit?: PaneUsageLimit | null } | null;
          this.emit('usageLimit:changed', { sessionId: event.sessionId, limit: data?.limit ?? null });
          break;
        }
        case 'agent.auth_lost': {
          // N4 — an agent's sign-in was lost, or its account works again (shared/agentAuthLost).
          const data = event.data as { lost?: unknown; works?: unknown } | null;
          this.emit('agent:authLost', { sessionId: event.sessionId, lost: data?.lost, works: data?.works });
          break;
        }
        case 'input.typed':
          this.emit('session:input', { sessionId: event.sessionId });
          break;
        case 'approvals.changed':
          // A re-list nudge (no record data) for the HQ approval lane.
          this.emit('approvals:changed');
          break;
        case 'activity.idle': {
          // #1463 — a daemon that knows the silence came before any turn says so.
          const data = event.data as { preTurn?: unknown; agentMidTurn?: unknown } | null;
          const preTurn = data?.preTurn === true;
          this.emit('session:idle', {
            sessionId: event.sessionId, ...(preTurn ? { preTurn } : {}),
            ...(typeof data?.agentMidTurn === 'boolean' ? { agentMidTurn: data.agentMidTurn } : {}),
          });
          break;
        }
        case 'activity.active':
          // data에 실린 gate 확정 agentName(없으면 null)을 함께 전달.
          this.emit('session:active', {
            sessionId: event.sessionId,
            agentName: typeof event.data === 'string' ? event.data : undefined,
          });
          break;
        case 'agent.turn': {
          const data = event.data as { running?: unknown; afterAnswer?: unknown } | null;
          if (typeof data?.running === 'boolean') {
            this.emit('session:agentTurn', {
              sessionId: event.sessionId, running: data.running,
              ...(data.afterAnswer === true ? { afterAnswer: true } : {}),
            });
          }
          break;
        }
        case 'agent.stall': {
          const data = event.data as { stalledSince?: unknown; compactions?: unknown } | null;
          const stalledSince = data?.stalledSince;
          const compactions = data?.compactions;
          if (stalledSince === null || (typeof stalledSince === 'number' && Number.isFinite(stalledSince))) {
            this.emit('session:agentStall', {
              sessionId: event.sessionId, stalledSince,
              ...(typeof stalledSince === 'number' && Number.isSafeInteger(compactions) && (compactions as number) > 0
                ? { compactions: compactions as number } : {}),
            });
          }
          break;
        }
        case 'agent.event':
          this.emit('session:agent', { sessionId: event.sessionId, event: event.data });
          break;
        case 'agent.critical':
          this.emit('session:critical', { sessionId: event.sessionId, event: event.data });
          break;
        case 'agent.interrupted':
          this.emit('session:agentInterrupted', { sessionId: event.sessionId });
          break;
        case 'agent.processExit': {
          // The pane's agent process died with the shell still alive. The one
          // release path for a pane the hook lit and never settled (killed
          // mid-turn, so no Stop ever fires); DaemonNotificationRouter clears
          // the status dot on it.
          const data = event.data as { slug?: string | null } | null;
          this.emit('session:agentProcessExit', {
            sessionId: event.sessionId,
            slug: data?.slug ?? null,
          });
          break;
        }
        case 'agent.transcriptActivity': {
          // The last tool of an agent with no per-tool hook, from its transcript.
          const data = event.data as { activity?: unknown } | null;
          if (typeof data?.activity === 'string') {
            this.emit('session:transcriptActivity', { sessionId: event.sessionId, activity: data.activity });
          }
          break;
        }
        case 'agent.teammates':
          this.emit('session:teammates', { sessionId: event.sessionId });
          break;
        case 'agent.teammateWake':
          this.emit('session:teammateWake', { sessionId: event.sessionId });
          break;
        case 'agent.subagents': {
          // How many subagents the pane's agent has running, from its transcript.
          const data = event.data as { count?: unknown } | null;
          if (typeof data?.count === 'number' && Number.isFinite(data.count) && data.count >= 0) {
            this.emit('session:subagents', { sessionId: event.sessionId, count: Math.floor(data.count) });
          }
          break;
        }
        case 'agent.refusal': {
          // The pane's last refused tool call (null clears), checked here.
          // Kept by the client itself: the daemon sends what it holds again
          // on subscribe, before main has a listener on a new client.
          const data = event.data as { refusal?: unknown } | null;
          // One it cannot read clears too: what stood before is no longer the last.
          const refusal = parseToolRefusal(data?.refusal);
          if (refusal) this.toolRefusals.set(event.sessionId, refusal);
          else this.toolRefusals.delete(event.sessionId);
          break;
        }
        case 'shell.prompt': {
          // A pane with no agent waits on stdin (daemon/shellPrompt); null clears.
          // Checked here: a `secret` keeps no question whatever was sent, and a
          // change without a version is dropped (it cannot be ordered against the list).
          const change = parseShellPromptChange(event.data);
          if (change) this.emit('session:shellPrompt', { sessionId: event.sessionId, ...change });
          break;
        }
        case 'prompt.event':
          // OSC 133 shell-integration marker (A/B/C/D) parsed in the daemon.
          // DaemonNotificationRouter consumes this to tee the D variant onto
          // the EventBus as a `source:'osc133'` agent.lifecycle event,
          // matching the local-mode PTYBridge.OscParser case 133 path.
          this.emit('session:prompt', { sessionId: event.sessionId, event: event.data });
          break;
        case 'notification.event':
          // Desktop-notification sequence (OSC 9/777/99) parsed daemon-side.
          // DaemonNotificationRouter tees this onto the EventBus as a
          // `notification.received` event and drives the toast surface,
          // matching the local-mode PTYBridge OSC 9/99/777 path.
          this.emit('session:notification', { sessionId: event.sessionId, event: event.data });
          break;
        case 'cwd.changed':
          // Working-directory change detected daemon-side; surfaced to the
          // renderer (via pty.handler) as IPC.CWD_CHANGED for live per-surface
          // cwd. event.data is the resolved cwd string.
          this.emit('session:cwd', { sessionId: event.sessionId, cwd: event.data as string });
          break;
        case 'title.changed':
          // OSC 0/2 window title detected daemon-side; surfaced to the renderer
          // (via pty.handler) as IPC.TERMINAL_TITLE_CHANGED. event.data is the
          // sanitized title string.
          this.emit('session:title', { sessionId: event.sessionId, title: event.data as string });
          break;
        case 'context.git':
          // X1 — git branch/worktree from the daemon's fs.watch on
          // .git/HEAD. WorkspaceContextRouter folds it into the sidebar
          // metadata and triggers the gh PR lookup.
          this.emit('session:git', { sessionId: event.sessionId, data: event.data });
          break;
        case 'context.ports':
          // X1 — PID-tree-scoped listening ports (10 s daemon poll).
          this.emit('session:ports', { sessionId: event.sessionId, data: event.data });
          break;
        case 'lanlink.remote.received': {
          // LanLink PR-2 — a remote message landed in the daemon's durable
          // inbox. This broadcast is a FIRE-AND-FORGET NUDGE only ("re-pull"),
          // NOT delivery. RemoteInboxBridge listens for 'lanlink:nudge' and
          // pulls via daemon.inbox.poll — the cursor-pull is the guarantee, so a
          // dropped nudge is recovered by the bridge's interval/reconnect pull.
          const data = event.data as { seq?: number } | null;
          this.emit('lanlink:nudge', { seq: data?.seq ?? 0 });
          break;
        }
        case 'a2a.remote.inbound':
          // Cross-host A2A — a peer's task landed in the ledger, undelivered.
          // A NUDGE only: RemoteA2aBridge re-pulls a2a.remote.pending (it also
          // listens on the generic 'event' above); its backstop covers a drop.
          this.emit('a2a:remoteInbound', { data: event.data });
          break;
        case 'channel.message':
          // A2A channels (a2a-channels U4) — every successful post on the
          // daemon side is broadcast as `channel.message` with the full
          // ChannelMessageEvent envelope in `data`. DaemonNotificationRouter
          // tees this onto the main-process EventBus as a WmuxEvent
          // `channel.message` (with the per-recipient scope filter in
          // events.rpc.ts). Field shape mirrors the WmuxEvent counterpart
          // 1:1 — see ChannelMessageEvent in src/shared/events.ts.
          // `sessionId` is '' (no session owns the event); consumers read
          // only `data`.
          this.emit('channel:message', { data: event.data });
          break;
        case 'channel.catalog':
          // A1 — catalog/membership lifecycle (create/archive/join/leave/kick/
          // invite). Same bridge as channel.message; DaemonNotificationRouter
          // tees it onto the main EventBus as a WmuxEvent `channel.catalog`.
          this.emit('channel:catalog', { data: event.data });
          break;
        case 'channel.nudgeExhausted':
          // Channels v2 wake worker — a mention episode ran out of nudge
          // budget; humans must look. DaemonNotificationRouter surfaces it
          // (toast + OS notification) and tees it onto the EventBus.
          this.emit('channel:nudgeExhausted', { data: event.data });
          break;
        default:
          break;
      }
    }
  }

  private setupSessionPipe(sessionId: string, socket: net.Socket): void {
    // The marker scanning / flush accounting lives in a pure state machine so
    // it can be unit-tested in isolation (see sessionPipeStreamScanner.ts). The
    // scanner returns ordered events; this closure only fans them out onto the
    // EventBus, preserving the original emit signatures and ordering.
    const scanner = new SessionPipeStreamScanner({
      markers: createSessionPipeMarkers(this.authToken),
      stripReplay: stripReplayQuerySequences,
    });
    this.sessionScanners.set(sessionId, scanner);

    const drain = (events: ReturnType<SessionPipeStreamScanner['feed']>) => {
      for (const ev of events) {
        if (ev.type === 'data') {
          this.emit('session:data', { sessionId, data: ev.data, replay: ev.replay });
        } else {
          this.emit('session:flushComplete', { sessionId, recoveredBytes: ev.recoveredBytes });
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
      // A forceFresh reconnect can install a replacement before the old
      // socket's final queued data callback runs. Only the socket that still
      // owns this session may emit bytes; otherwise stale output could
      // interleave with the replacement stream.
      if (this.sessionPipes.get(sessionId) !== socket) return;
      drain(scanner.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    });

    // Identity-guarded teardown (CodeRabbit): a forceFresh reconnect installs
    // a replacement socket+scanner under the same sessionId BEFORE the old
    // socket's async close/error callbacks run — an unconditional delete here
    // would evict the LIVE replacement and leave the session's stream dead.
    const teardownIfCurrent = () => {
      if (this.sessionPipes.get(sessionId) === socket) {
        this.sessionScanners.delete(sessionId);
        this.sessionPipes.delete(sessionId);
      }
    };
    socket.on('close', teardownIfCurrent);
    socket.on('error', teardownIfCurrent);
  }

  /**
   * Arm the session's live stream scanner to watch for the in-band
   * RESYNC_BEGIN_MARKER (phase 3 PR-B). Returns true only when a live scanner
   * exists for the session; a missing or still-accumulating scanner returns
   * false so the caller can degrade (the session pipe is not ready for a live
   * re-flush). MUST be paired with a matching disarm on the failure path so a
   * scanner left armed does not sit watching a normal live stream for a marker
   * that will never come.
   */
  armSessionResync(sessionId: string): boolean {
    const scanner = this.sessionScanners.get(sessionId);
    if (!scanner || scanner.mode !== 'live') return false;
    return scanner.armResync();
  }

  /**
   * Disarm the session's resync scanner and flush any bytes it was holding back
   * as a possible marker prefix (those are real live output). Safe to call when
   * no scanner exists or it was never armed.
   */
  disarmSessionResync(sessionId: string): void {
    const scanner = this.sessionScanners.get(sessionId);
    if (!scanner) return;
    const events = scanner.disarmResync();
    for (const ev of events) {
      if (ev.type === 'data') {
        this.emit('session:data', { sessionId, data: ev.data, replay: ev.replay });
      }
    }
  }
}

/** Get the daemon control pipe name for the current platform/user.
 * P7: shared 헬퍼로 위임 — 데몬(daemon/config.ts)·CLI(cli/client.ts)와 lockstep.
 * 실행 중인 데몬의 실제 경로는 daemon-pipe 힌트 파일이 우선한다(launcher). */
export function getDaemonPipeName(): string {
  return getDaemonSocketPath();
}

/**
 * Read the daemon auth token from disk. Returns empty string if not found.
 *
 * Reads the suffix-aware path (getDaemonAuthTokenPath) first, then the legacy
 * unsuffixed path as a migration fallback so a suffixed ('-dev'/dogfood)
 * instance upgrading over a still-running older daemon can still authenticate
 * — see getDaemonAuthTokenPath / getLegacyDaemonAuthTokenPath in
 * shared/constants. MUST stay in lockstep with the daemon writer
 * (DaemonPipeServer.getTokenPath) and the CLI reader
 * (cli/client.resolveDaemonAuthToken): if they compute different paths, nothing
 * authenticates.
 */
export function readDaemonAuthToken(): string {
  const fs = require('fs');
  for (const tokenPath of [getDaemonAuthTokenPath(), getLegacyDaemonAuthTokenPath()]) {
    try {
      const token = fs.readFileSync(tokenPath, 'utf8').trim();
      if (token) return token;
    } catch {
      // candidate absent/unreadable — try the next one
    }
  }
  return '';
}
