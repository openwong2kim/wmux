import net from 'node:net';
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
import { stripReplayQuerySequences } from '../shared/replayQuerySanitizer';
import { SessionPipeStreamScanner } from './daemon/sessionPipeStreamScanner';
import { DAEMON_RPC_TIMEOUT_MS } from '../shared/timeouts';
import {
  dataSuffix,
  getDaemonAuthTokenPath,
  getLegacyDaemonAuthTokenPath,
} from '../shared/constants';
import { connectWithRetry, type ConnectAttemptResult } from './daemonConnectRetry';

// RCA A2 — single source of truth in shared/timeouts.ts so the renderer's
// RECONCILE_TIMEOUT_MS can be derived from (and stay greater than) this value.
const RPC_TIMEOUT_MS = DAEMON_RPC_TIMEOUT_MS;
const MAX_LINE_BUFFER = 1024 * 1024; // 1 MB

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
 *   'session:data'   — { sessionId: string, data: Buffer }
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
        this.setupControlPipe(socket);
        finish({ ok: true });
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

  /**
   * daemon AgentDetector가 gate로 확정한 에이전트 표시명을 조회한다(없으면 null).
   * renderer detection pull의 권위 소스 — session:agent emit 전파 race를 우회한다.
   */
  async getAgentName(sessionId: string): Promise<string | null> {
    try {
      const result = await this.rpc('daemon.getAgentName', { id: sessionId });
      const name = (result as { agentName?: unknown })?.agentName;
      return typeof name === 'string' && name ? name : null;
    } catch {
      return null;
    }
  }

  /** Whether the daemon control pipe is connected. */
  get isConnected(): boolean {
    return this.connected;
  }

  // --- Private helpers ---

  private getSessionPipeName(sessionId: string): string {
    if (process.platform === 'win32') {
      return `\\\\.\\pipe\\wmux-session-${sessionId}`;
    }
    const os = require('os');
    return `${os.homedir()}/.wmux-session-${sessionId}.sock`;
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
          const data = event.data as { exitCode?: number | null } | null;
          this.emit('session:died', {
            sessionId: event.sessionId,
            exitCode: data?.exitCode ?? null,
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
        case 'activity.idle':
          this.emit('session:idle', { sessionId: event.sessionId });
          break;
        case 'activity.active':
          // data에 실린 gate 확정 agentName(없으면 null)을 함께 전달.
          this.emit('session:active', {
            sessionId: event.sessionId,
            agentName: typeof event.data === 'string' ? event.data : undefined,
          });
          break;
        case 'agent.event':
          this.emit('session:agent', { sessionId: event.sessionId, event: event.data });
          break;
        case 'agent.critical':
          this.emit('session:critical', { sessionId: event.sessionId, event: event.data });
          break;
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
      stripReplay: stripReplayQuerySequences,
    });
    this.sessionScanners.set(sessionId, scanner);

    const drain = (events: ReturnType<SessionPipeStreamScanner['feed']>) => {
      for (const ev of events) {
        if (ev.type === 'data') {
          this.emit('session:data', { sessionId, data: ev.data });
        } else {
          this.emit('session:flushComplete', { sessionId, recoveredBytes: ev.recoveredBytes });
        }
      }
    };

    socket.on('data', (chunk: Buffer) => {
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
    scanner.armResync();
    return true;
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
        this.emit('session:data', { sessionId, data: ev.data });
      }
    }
  }
}

/** Get the daemon control pipe name for the current platform/user. */
export function getDaemonPipeName(): string {
  const os = require('os');
  const path = require('path');
  const username = os.userInfo().username || 'default';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-daemon${dataSuffix()}-${username}`;
  }
  return path.join(os.homedir(), `.wmux-daemon${dataSuffix()}.sock`);
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
