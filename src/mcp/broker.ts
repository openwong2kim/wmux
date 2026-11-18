#!/usr/bin/env node
/**
 * Shared MCP broker — one resident process hosting N MCP server instances,
 * one per shim connection (plans/mcp-broker-design-2026-07-16.md Option A).
 *
 * Topology: agent CLI → shim (stdio⇄pipe pump, ~bare-node) → THIS process.
 * Each accepted connection gets its own McpServer from createWmuxServer()
 * plus a ConnectionScope, so the state the single-child world kept in
 * process globals (declared client identity, commander role, pinned route,
 * the PlaywrightEngine) is per-connection here. Every transport dispatch is
 * wrapped in runInConnectionScope so the scope rides AsyncLocalStorage into
 * the tool handlers without threading a context through 80+ signatures.
 *
 * Weight contract: this bundle is built exactly like mcp-bundle/index.js —
 * playwright-core stays an EXTERNAL lazy chunk (B0, PR #472), so the broker
 * idles at ~the post-B0 single child (~32 MB) and pays playwright's ~49 MB
 * once, on the first browser_* call across ALL agents, instead of once per
 * agent.
 *
 * Lifecycle: spawned and supervised by the Electron main process (like the
 * daemon). Broker death drops every shim (they exit; hosts restart them),
 * so the supervisor restarts the broker with backoff — shared fate is the
 * accepted trade for the shared weight.
 */
// Must stay the first import: turns off working-directory executable lookup (Windows) before any module runs.
import '../shared/exeSearchGuard';
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getMcpBrokerPipeName, getAuthTokenPath } from '../shared/constants';
import { createWmuxServer } from './index';
import {
  createConnectionScope,
  markBrokerHost,
  runInConnectionScope,
  type ConnectionScope,
} from './connectionScope';
import type { PlaywrightEngine } from './playwright/PlaywrightEngine';
import { disposeReplRegistry, setReplBrokerMode } from './repl/replRegistry';
import { socketIdentity, staleSocketAction, staleSocketKind, stampSocket } from './brokerSocketPath';
import { BROKER_EXIT_PATH_OCCUPIED, BROKER_EXIT_PEER_UNAVAILABLE } from '../shared/mcpBroker';
import { disposeBrowserRepl, setBrowserReplBrokerMode } from './browser-repl/tool';
import { peerPidOf, selfCheckPeerPid } from '../shared/peerPid';
import {
  decidePeer,
  decideWin32Peer,
  PreAuthGate,
  retryingSelfCheck,
  selfCheckNativePipe,
  TOKEN_FACTS_TIMEOUT_MS,
  win32SelfCheckPipeName,
  type HostDecision,
  type Win32HostDecision,
  type Win32TokenFacts,
} from './brokerPeer';
import { listenNativePipe, loadNativePipe, NATIVE_PIPE_MAX_INSTANCES, type NativePipeModule, type PipeOwnerVerdict } from './nativePipe';
import type { NativePipeSocket } from './nativePipeSocket';
import { createConnectionReporter, trackConnection, trackToolCalls, type ReportChannel } from './brokerConnectionReporter';
import { setBrokerEnvelopeMode } from './wmux-client';
import { acceptBrokerStamp } from './brokerStamp';
import { brokerTokenSource, tokenMatches } from './brokerToken';
import {
  admissionRefusal,
  BROKER_LIMITS_ENV,
  BROKER_MAX_NEW_CONNECTIONS_PER_SEC,
  brokerLimitsFromEnv,
  ConnectionRate,
} from '../shared/brokerLimits';
import { setBrowserReplRunnerTotal } from './browser-repl/runnerProcess';

interface ShimHandshake {
  wmuxShim: number;
  authToken?: string;
  callerPid?: number;
  callerPpid?: number;
  envWorkspaceHint?: string;
  envPtyHint?: string;
  commanderToken?: string;
  commanderMode?: boolean;
  /** Optional `--core` surface selection. Absent from a pre-core shim, which
   *  then gets the `full` default — a wider surface, never a narrower one. */
  coreMode?: boolean;
  /** Optional `--role=<Role>` value; absent from an older shim (full surface). */
  roleSurface?: string;
  /** Additive: `1` asks for one broker line, `{"wmuxBroker":1,"ok":…}`, as
   *  the first bytes on the connection: ok:true once the session's server is
   *  created, ok:false when it is refused. Absent from shim.ts and older
   *  shims, which get no such line. */
  ack?: number;
}

/** The answer to a handshake that asked for one (`ack: 1`): always the first
 *  bytes the shim reads. The native shim forwards no stdin until it arrives. */
function brokerAckLine(ok: boolean, error?: string): string {
  return JSON.stringify(ok ? { wmuxBroker: 1, ok } : { wmuxBroker: 1, ok, error }) + '\n';
}

let connSeq = 0;

/** Open hosted connections, reported to the supervisor for `wmux doctor`. */
const connectionReporter = createConnectionReporter(process as unknown as ReportChannel);

/** How long a connection may sit without completing the wmuxShim handshake. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * The exit when the Windows pipe listener stops accepting on its own: a crash
 * code, so the supervisor's restart backoff and breaker take over. The broker
 * never binds the name again in the same process.
 */
const EXIT_LISTENER_STOPPED = 1;

/** A connection the broker serves: a unix socket, or a native pipe connection on Windows. */
type BrokerSocket = net.Socket | NativePipeSocket;

/** Decides whether a connection's session is hosted, from its handshake. */
type DecideHost = (claimed: ShimHandshake) => Promise<HostDecision | Win32HostDecision>;

async function hostConnection(socket: BrokerSocket, handshake: ShimHandshake): Promise<void> {
  const connId = ++connSeq;
  const scope: ConnectionScope = createConnectionScope();
  // Reached only after decidePeer took the OS peer as this pid.
  if (typeof handshake.callerPid === 'number') scope.verifiedCallerPid = handshake.callerPid;

  const log = (msg: string) => console.error(`[wmux-mcp-broker] #${connId} ${msg}`);
  // Before the await below: a socket that closes during it is counted closed.
  trackConnection(socket, connectionReporter);
  log(
    `shim connected pid=${handshake.callerPid} ppid=${handshake.callerPpid} ` +
      `commander=${handshake.commanderMode ? 'yes' : 'no'} ` +
      // The server's own "--core ignored" warning goes to the DAEMON's stderr
      // on this path, not the agent host's, so record the requested flags here
      // too — otherwise a contradictory launch is invisible to the operator.
      `core=${handshake.coreMode ? 'yes' : 'no'} ` +
      (typeof handshake.roleSurface === 'string' ? `role=${handshake.roleSurface.slice(0, 32)} ` : '') +
      `envHints=${handshake.envWorkspaceHint ? 'ws' : ''}${handshake.envPtyHint ? '+pty' : ''}`,
  );

  // Hoisted so the socket lifecycle handlers below can close the transport when
  // the shim exits. StdioServerTransport.onclose does NOT fire from the socket
  // closing on its own, so without this the per-connection server and its
  // Playwright/CDP session would leak on every shim disconnect.
  let transport: StdioServerTransport | null = null;
  // Guards the onclose teardown against the re-entry that server.close() causes.
  let connClosed = false;
  // Ends this connection's tool calls still in flight when it closes.
  let endToolCalls: () => void = () => undefined;

  await runInConnectionScope(scope, async () => {
    const server = createWmuxServer({
      envWorkspaceHint: handshake.envWorkspaceHint || '',
      envPtyHint: handshake.envPtyHint || '',
      commanderToken: handshake.commanderToken,
      commanderMode: handshake.commanderMode === true,
      coreMode: handshake.coreMode === true,
      roleSurface: typeof handshake.roleSurface === 'string' ? handshake.roleSurface.slice(0, 32) : undefined,
      // Identity walks start at the SHIM's pid — it sits in the agent's
      // process tree exactly where the old full child sat, so both the
      // server-side walk (a2a.resolve.identity { callerPid }) and the
      // client-side upward walk see the same ancestry as before.
      callerPid: handshake.callerPid ?? -1,
      callerPpid: handshake.callerPpid ?? null,
    });

    // The remaining socket bytes are line-framed MCP JSON-RPC — exactly what
    // StdioServerTransport speaks; it accepts any Readable/Writable pair.
    // The session's server exists: answer a shim that asked, before connect.
    // The socket stays paused from the handshake read until the resume() after
    // this function returns (transport.start() only adds a 'data' listener,
    // which does not resume an explicitly paused stream), so bytes the shim
    // sends on the ack wait in the socket until the scope wrappers below are in
    // place. If connect then rejects, the caller destroys the socket: the shim,
    // already pumping, exits 1.
    if (handshake.ack === 1) socket.write(brokerAckLine(true));

    transport = new StdioServerTransport(socket, socket);
    await server.connect(transport);
    // The tool names in flight go to the supervisor, so a crash can say what
    // it cut off. Wrapped inside the scope wrapper below, so it sees every
    // message the server does.
    endToolCalls = trackToolCalls(transport as never, connectionReporter);

    // server.connect wired transport.onmessage/onclose/onerror. Re-wrap them
    // so every later dispatch (they fire from socket events, OUTSIDE this
    // als.run) re-enters this connection's scope.
    const onmessage = transport.onmessage;
    transport.onmessage = (...args: unknown[]) =>
      runInConnectionScope(scope, () =>
        (onmessage as unknown as (...a: unknown[]) => void)?.(...args),
      );
    const onclose = transport.onclose;
    transport.onclose = () =>
      runInConnectionScope(scope, () => {
        // Re-entry guard: server.close() below closes the transport, which
        // re-fires this handler — run the teardown exactly once.
        if (connClosed) return;
        connClosed = true;
        log('transport closed');
        endToolCalls();
        // Tear down THIS caller's browser session only. The engine is
        // per-connection (scope.playwright), so no other agent is touched.
        const engine = scope.playwright as PlaywrightEngine | undefined;
        if (engine) {
          void engine.disconnect().catch(() => { /* best-effort */ });
        }
        // Same reasoning for this caller's REPL children: they are per-connection
        // and hold live state, so they die with the connection. The children also
        // self-exit when their IPC channel closes, which is what covers the case
        // this handler cannot — the broker being killed outright.
        disposeReplRegistry();
        // And this caller's browser_repl worker, which holds script globals
        // the same way a REPL child does.
        disposeBrowserRepl();
        // Close the per-connection McpServer too — without this, repeated shim
        // reconnects accumulate server instances in the broker process.
        void server.close().catch(() => { /* best-effort */ });
        onclose?.();
      });
  });

  socket.on('error', (err) => log(`socket error: ${err.message}`));

  // A shim exit closes the socket but does not, on its own, fire the MCP
  // transport's onclose — so drive it explicitly. transport.close() invokes the
  // wrapped onclose above (which disconnects this connection's Playwright/CDP
  // session), guarded so a close+end pair only tears down once.
  let torndown = false;
  const teardown = () => {
    if (torndown) return;
    torndown = true;
    void transport?.close();
  };
  socket.on('close', teardown);
  socket.on('end', teardown);
  // Closed while the session was being set up: no close event is coming.
  if (socket.destroyed) teardown();
}

function main(): void {
  // Main sends its stamp right after the spawn: listen before any I/O runs.
  if (process.send) process.on('message', acceptBrokerStamp);
  // This process hosts many agents at once, so a REPL call that arrives without
  // a connection scope must fail rather than fall back to a shared registry.
  setReplBrokerMode();
  setBrowserReplBrokerMode();
  markBrokerHost();
  setBrokerEnvelopeMode();
  const ownUid = typeof process.getuid === 'function' ? process.getuid() : null;
  const tokenSource = brokerTokenSource(getAuthTokenPath(), process.env.WMUX_AUTH_TOKEN, ownUid);
  if (tokenSource.startProblem && tokenSource.startProblem !== 'missing') {
    console.error(`[wmux-mcp-broker] auth token file not usable at start (${tokenSource.startProblem})`);
  }
  const expectedToken = tokenSource.read;
  if (!expectedToken) {
    console.error('[wmux-mcp-broker] auth token not found; refusing to serve. Is wmux running?');
    process.exit(1);
  }

  const pipeName = getMcpBrokerPipeName();
  // Windows: the broker listens with the native pipe listener, which reads the
  // client's pid, session and token (src/mcp/nativePipe.ts). A core without it
  // cannot host any session, and no restart brings it: the exit the
  // supervisor treats as final for a check that never passes.
  let nativeModule: NativePipeModule | null = null;
  if (process.platform === 'win32') {
    try {
      nativeModule = loadNativePipe();
    } catch (err) {
      console.error(`[wmux-mcp-broker] native pipe listener unavailable (${err instanceof Error ? err.message : String(err)}); stopping (exit ${BROKER_EXIT_PEER_UNAVAILABLE})`);
      process.exit(BROKER_EXIT_PEER_UNAVAILABLE);
      return;
    }
  }
  const pipeModule = nativeModule;
  // Sessions are hosted only for a peer the OS names (src/mcp/brokerPeer.ts);
  // while this process cannot read peer pids it refuses every session, and it
  // checks again with backoff. A check that never passes through the whole
  // schedule ends the broker with exit 79: the supervisor then marks it off,
  // so launchers start their own server instead of asking it first. The
  // check's socket sits beside the broker's, under a name no longer than the
  // broker socket's own. On Windows the check listens on a private pipe name
  // with the native listener and reads its own connection back.
  let lastVerdict: string | null | undefined;
  const peerSelfCheck = retryingSelfCheck(
    pipeModule
      ? () => selfCheckNativePipe(
        (name, options) => listenNativePipe(name, { ...options, module: pipeModule }),
        win32SelfCheckPipeName(pipeName),
      )
      : () => selfCheckPeerPid(undefined, path.join(path.dirname(pipeName), `${path.basename(pipeName, '.sock')}.pc`)),
    (verdict, attempt) => {
      if (attempt > 1 && verdict === lastVerdict) return;
      lastVerdict = verdict;
      console.error(`[wmux-mcp-broker] peer-pid${attempt > 1 ? ` (check ${attempt})` : ''}: ${verdict ?? 'unavailable (no peer pids on this platform)'}${verdict === 'available' ? '' : '; every session is refused'}`);
    },
    undefined,
    (verdict, attempts) => {
      console.error(`[wmux-mcp-broker] peer-pid: still ${verdict} after ${attempts} checks; stopping (exit ${BROKER_EXIT_PEER_UNAVAILABLE})`);
      // Runs from the backoff timer, after main() has returned.
      shutdown(BROKER_EXIT_PEER_UNAVAILABLE);
    },
  );

  // config.json mcp.broker, as the app read it when it started this broker.
  const limits = brokerLimitsFromEnv(process.env[BROKER_LIMITS_ENV]);
  setBrowserReplRunnerTotal(limits.maxBrowserReplRunners);
  console.error(`[wmux-mcp-broker] limits: maxSessions ${limits.maxSessions ?? 'none'}, maxRssMb ${limits.maxRssMb ?? 'none'}, maxBrowserReplRunners ${limits.maxBrowserReplRunners ?? 'none'}`);
  const connectionRate = new ConnectionRate();
  let rateLogged = 0;
  /** Sessions admitted and not yet closed. */
  let hostedSessions = 0;

  /** Closed at once, before any byte is read, when over the connection rate: the launcher runs its own server. */
  const admitRate = (socket: BrokerSocket): boolean => {
    if (connectionRate.admit()) return true;
    const now = Date.now();
    if (now - rateLogged >= 1000) {
      rateLogged = now;
      console.error(`[wmux-mcp-broker] over ${BROKER_MAX_NEW_CONNECTIONS_PER_SEC} new connections in a second; closing the rest of this second's`);
    }
    socket.destroy();
    return false;
  };

  /**
   * One connection, from its handshake line to the hosted session. `decide`
   * names the peer: every refusal closes the connection with no ack line.
   */
  const serveConnection = (socket: BrokerSocket, decide: DecideHost): void => {
    // Accumulate until the handshake line; hand the remainder back to the
    // socket so the MCP transport sees a clean stream from byte 0.
    let buffer = Buffer.alloc(0);
    const MAX_HANDSHAKE = 8 * 1024;

    // Auth deadline: a local client can connect and send nothing, holding the
    // socket open forever. Destroy any socket that hasn't delivered its
    // handshake line within the window; cleared the moment the line arrives.
    const authTimer = setTimeout(() => {
      console.error('[wmux-mcp-broker] handshake timeout, dropping connection');
      socket.destroy();
    }, HANDSHAKE_TIMEOUT_MS);
    socket.once('close', () => clearTimeout(authTimer));

    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const nl = buffer.indexOf(0x0a);
      if (nl === -1) {
        if (buffer.length > MAX_HANDSHAKE) {
          console.error('[wmux-mcp-broker] oversized handshake, dropping connection');
          socket.destroy();
        }
        return;
      }

      socket.removeListener('data', onData);
      clearTimeout(authTimer); // handshake line received — deadline satisfied
      socket.pause();

      let handshake: ShimHandshake | null = null;
      try {
        handshake = JSON.parse(buffer.subarray(0, nl).toString('utf8')) as ShimHandshake;
      } catch { /* fall through to reject */ }

      if (!handshake || handshake.wmuxShim !== 1) {
        console.error('[wmux-mcp-broker] malformed handshake, dropping connection');
        socket.destroy();
        return;
      }
      const wantsAck = handshake.ack === 1;
      const expected = expectedToken();
      if (!expected.ok) {
        // Closed with no ack line, as for a refused peer: the shim runs its
        // own full server. The token file is read again for the next session.
        console.error(`[wmux-mcp-broker] auth token file not usable (${expected.problem}); session refused`);
        socket.destroy();
        return;
      }
      if (!tokenMatches(handshake.authToken, expected.token)) {
        console.error('[wmux-mcp-broker] auth failed, dropping connection');
        if (wantsAck) socket.end(brokerAckLine(false, 'auth'), () => socket.destroy());
        else socket.destroy();
        return;
      }

      const rest = buffer.subarray(nl + 1);
      const claimed = handshake;
      decide(claimed)
        .then(async (decision) => {
          if (socket.destroyed) return;
          if (!decision.ok) {
            // Closed with no ack line: every shim generation takes a close
            // before the ack as "no session" and runs the full bundle. The
            // reason stays in this log.
            console.error(`[wmux-mcp-broker] peer refused (${decision.reason}): ${decision.detail}`);
            socket.destroy();
            return;
          }
          // Refused before the ack, naming the setting: the shim runs its own
          // full server.
          const refusal = admissionRefusal(limits, { sessions: hostedSessions, rssBytes: process.memoryUsage.rss() });
          if (refusal) {
            console.error(`[wmux-mcp-broker] session refused: ${refusal}`);
            socket.destroy();
            return;
          }
          hostedSessions++;
          socket.once('close', () => { hostedSessions--; });
          if (claimed.callerPpid !== decision.callerPpid) {
            console.error(`[wmux-mcp-broker] callerPpid ${String(claimed.callerPpid)} differs from the OS parent ${decision.callerPpid}; using the OS parent`);
          }
          await hostConnection(socket, { ...claimed, callerPid: decision.callerPid, callerPpid: decision.callerPpid });
          // Replay any MCP bytes that arrived glued to the handshake, then
          // resume flow into the transport's data listener.
          if (rest.length > 0) socket.unshift(rest);
          socket.resume();
        })
        .catch((err) => {
          console.error('[wmux-mcp-broker] failed to host connection:', err);
          socket.destroy();
        });
    };

    socket.on('data', onData);
    socket.on('error', () => { /* per-connection errors logged in hostConnection */ });
  };

  let closeServer: () => void = () => undefined;
  const shutdown = (code = 0) => {
    peerSelfCheck.stop();
    closeServer();
    process.exit(code);
  };
  process.on('SIGTERM', () => shutdown());
  process.on('SIGINT', () => shutdown());
  // Started by main with an IPC channel: when main goes (a crash, a kill), the
  // channel closes and the broker goes too, rather than living on without a
  // supervisor. A broker started by hand has no channel and is unaffected.
  if (process.send) process.on('disconnect', () => shutdown());

  if (pipeModule) {
    closeServer = listenWin32(pipeModule, pipeName, admitRate, serveConnection, () => peerSelfCheck.verdict(), (reason) => {
      console.error(`[wmux-mcp-broker] the pipe listener stopped accepting (${reason}); exiting (exit ${EXIT_LISTENER_STOPPED})`);
      shutdown(EXIT_LISTENER_STOPPED);
    });
    return;
  }

  const server = net.createServer((socket) => {
    // Read here, before anything else can close and reuse the descriptor.
    const peer = peerPidOf(socket);
    if (!admitRate(socket)) return;
    serveConnection(socket, (claimed) => peerSelfCheck.verdict()
      .then((verdict) => decidePeer({ selfCheckOk: verdict === 'available', peer, claimedPid: claimed.callerPid, ownUid })));
  });
  closeServer = () => server.close();

  let staleRetried = false;
  server.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EADDRINUSE') {
      console.error(`[wmux-mcp-broker] server error: ${err.message}`);
      process.exit(1);
      return;
    }
    // EADDRINUSE has two causes on the Unix domain socket: a LIVE broker owns
    // the pipe (stand down — the supervisor reads 75 as "already running"), or
    // a crashed broker left a STALE socket file (domain sockets are not
    // auto-removed). Probe by connecting: a successful connect proves a live
    // listener; a refused connect means the file is stale, so unlink and retry
    // listen once. Windows named pipes vanish with their owner (no stale file),
    // so there the only cause is a live broker — stand down directly.
    if (process.platform === 'win32' || staleRetried) {
      console.error('[wmux-mcp-broker] pipe in use by a live broker; standing down');
      process.exit(75);
      return;
    }
    // What is at the path before the probe: the unlink below must remove this
    // same socket, not one another broker bound while the probe ran.
    const before = socketIdentity(pipeName);
    const probe = net.connect(pipeName);
    probe.once('connect', () => {
      probe.destroy();
      console.error('[wmux-mcp-broker] another broker is live; standing down');
      process.exit(75);
    });
    probe.once('error', (err: NodeJS.ErrnoException) => {
      probe.destroy();
      staleRetried = true;
      // Remove only a socket: a regular file, a link or a folder at this path
      // is not a broker's leftover, so the broker stops and says so instead
      // (an exit the supervisor does not restart). Only ECONNREFUSED counts
      // as stale; another error (a timeout, EAGAIN) may be a live broker.
      // ECONNREFUSED is not proof on its own: on macOS a live listener whose
      // backlog is full refuses too, which the identity recheck below cannot
      // tell apart either, so that case stays a known gap.
      const kind = staleSocketKind(pipeName);
      const decision = staleSocketAction({
        pipeName,
        kind,
        errCode: err.code,
        before,
        now: kind === 'socket' ? socketIdentity(pipeName) : null,
        pathOccupiedCode: BROKER_EXIT_PATH_OCCUPIED,
      });
      if (decision.action === 'exit') {
        console.error(`[wmux-mcp-broker] ${decision.message}`);
        process.exit(decision.code);
        return;
      }
      try {
        if (decision.unlink) fs.unlinkSync(pipeName);
      } catch { /* already gone — listen retry decides */ }
      server.listen(pipeName, () => {
        // The stamp follows the bind by one tick: a check that lands between
        // the two can still read bind-time values only (a known, narrow gap).
        stampSocket(pipeName);
        console.error(`[wmux-mcp-broker] listening on ${pipeName} pid=${process.pid} (after stale-socket cleanup)`);
      });
    });
  });

  server.listen(pipeName, () => {
    // A named pipe has no file to stamp.
    if (process.platform !== 'win32') stampSocket(pipeName);
    console.error(`[wmux-mcp-broker] listening on ${pipeName} pid=${process.pid}`);
  });
}

/**
 * Windows: listen on the broker's pipe with the native listener and return
 * how to close it. A name already taken ends the broker: 75 when this user
 * holds it (another broker; the supervisor stands down and probes), 78 when
 * another owner does (a restart cannot fix that), and a crash exit when the
 * name went away meanwhile (the supervisor restarts the broker).
 */
function listenWin32(
  module: NativePipeModule,
  pipeName: string,
  admitRate: (socket: BrokerSocket) => boolean,
  serveConnection: (socket: BrokerSocket, decide: DecideHost) => void,
  selfCheckVerdict: () => Promise<string | null>,
  onFailure: (reason: string) => void,
): () => void {
  // Idle clients that never send a handshake cannot hold the pipe's
  // instances: past this many waiting, a new connection is closed at once.
  const preAuth = new PreAuthGate();
  let capLogged = 0;
  const onConnection = (socket: NativePipeSocket): void => {
    if (!admitRate(socket)) return;
    const release = preAuth.admit();
    if (!release) {
      const now = Date.now();
      if (now - capLogged >= 1000) {
        capLogged = now;
        console.error(`[wmux-mcp-broker] ${preAuth.size} connections are waiting for their handshake; closing new ones`);
      }
      socket.destroy();
      return;
    }
    socket.once('close', release);
    serveConnection(socket, async (claimed) => {
      try {
        const verdict = await selfCheckVerdict();
        const selfCheckOk = verdict === 'available';
        // Asked only after the handshake line was read: the client's token
        // can be read once it has sent something.
        const facts: Win32TokenFacts = selfCheckOk
          ? await socket.tokenFacts(TOKEN_FACTS_TIMEOUT_MS)
          : { ok: false, reason: 'not read' };
        return decideWin32Peer({ selfCheckOk, peer: socket.peer, facts, claimedPid: claimed.callerPid });
      } finally {
        release();
      }
    });
  };

  try {
    const server = listenNativePipe(pipeName, {
      maxInstances: NATIVE_PIPE_MAX_INSTANCES,
      module,
      onConnection,
      onFailure,
      onConnectionError: (error) => console.error('[wmux-mcp-broker] connection handler failed:', error),
    });
    console.error(`[wmux-mcp-broker] listening on ${pipeName} pid=${process.pid}`);
    return () => server.close();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    let owner: PipeOwnerVerdict | 'unknown';
    try {
      owner = module.nativePipeOwnedByUs(pipeName);
    } catch {
      owner = 'unknown';
    }
    if (owner === 'foreign') {
      console.error(`[wmux-mcp-broker] the broker pipe is held by another owner; stopping (exit ${BROKER_EXIT_PATH_OCCUPIED})`);
      process.exit(BROKER_EXIT_PATH_OCCUPIED);
    } else if (code === 'EADDRINUSE' && owner !== 'none') {
      console.error('[wmux-mcp-broker] pipe in use by a live broker; standing down');
      process.exit(75);
    } else {
      console.error(`[wmux-mcp-broker] could not listen on ${pipeName} (${err instanceof Error ? err.message : String(err)}; owner ${owner}); exiting`);
      process.exit(EXIT_LISTENER_STOPPED);
    }
    return () => undefined;
  }
}

main();
