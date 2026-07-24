// wmux-rpc.mjs — a reusable, dependency-free JSON-RPC client for the wmux
// substrate. Node >= 18, no runtime dependencies.
//
// This module is the transport layer for the reference event-recorder plugin.
// It encapsulates everything in docs/PROTOCOL.md §5 / §5.1 (Named Pipe security
// model + auth envelope); the newline framing and rate caps are not in
// PROTOCOL.md and are sourced from src/main/pipe/PipeServer.ts. The plugin
// entrypoint (recorder.mjs) can then speak in terms of
// `client.rpc(method, params)` instead of raw sockets.
//
// Everything here is verified against the wmux source:
//   - src/shared/constants.ts   — getPipeName / getAuthTokenPath / getTcpPortPath / ENV_KEYS
//   - src/main/pipe/PipeServer.ts — newline-delimited JSON framing, auth, caps
//   - src/shared/rpc.ts          — RpcRequest / RpcResponse / RpcRejection shapes
//
// === Wire contract (envelope/auth: PROTOCOL.md §5.1; framing/caps:
// === src/main/pipe/PipeServer.ts) ===
//
//   Transport : a single duplex stream socket (Windows named pipe, POSIX unix
//               socket, or — Windows fallback only — a TCP loopback socket).
//   Framing   : newline-delimited JSON. Exactly one JSON object per line,
//               terminated by '\n'. The server buffers up to MAX_LINE_BUFFER
//               (1 MB) per line before it destroys the socket.
//   Request   : { id, method, params, token, clientName?, clientVersion? }
//   Response  : { id, ok: true,  result }
//          or : { id, ok: false, error, rejection? }
//   Auth      : every request MUST carry `token`. An unauthenticated request
//               gets a single { id, ok: false, error: 'unauthorized' } reply
//               and the server then destroys the socket (PipeServer.ts).
//   Caps      : MAX_CONNECTIONS=50; 50 rpc/s per socket; 200 rpc/s global;
//               30 new connections/s pre-auth. Stay well under these — the
//               recorder polls at >=1s intervals, one socket, one in-flight
//               request family at a time.

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

// === Endpoint / token resolution (src/shared/constants.ts, VERBATIM logic) ===
//
// An *in-pane* plugin (spawned by wmux into one of its own PTYs) inherits the
// endpoint + token from the environment — see ENV_KEYS in constants.ts, which
// injects WMUX_AUTH_TOKEN and WMUX_SOCKET_PATH into every wmux PTY. An
// *external-terminal* plugin (this recorder, run from any shell) has neither,
// so it derives the pipe name the same way wmux does and reads the token file.

function homeDir() {
  // constants.ts getAuthTokenPath / getTcpPortPath use USERPROFILE || HOME
  // (with an empty-string last resort). We add os.homedir() as a friendlier
  // fallback for env-stripped shells; in any normal session all three agree.
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function defaultPipeName() {
  // === src/shared/constants.ts getPipeName() ===
  // Windows : \\.\pipe\fmux-<username>  (os.userInfo().username, NOT $USERNAME —
  //           env vars may not propagate to subprocesses spawned by an MCP host)
  // POSIX   : <homedir>/.fmux.sock
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\fmux-${os.userInfo().username || 'default'}`;
  }
  return `${os.homedir()}/.fmux.sock`;
}

/**
 * Resolve the wmux auth token. In-pane plugins get it from WMUX_AUTH_TOKEN;
 * external plugins read the plain-UUID token file `~/.fmux-auth-token`
 * (src/shared/constants.ts getAuthTokenPath — the file is a bare UUID string,
 * NOT JSON). Throws if neither is available (wmux not running, or token not
 * yet written).
 */
export function loadToken() {
  if (process.env[ 'WMUX_AUTH_TOKEN' ]) {
    return process.env[ 'WMUX_AUTH_TOKEN' ].trim();
  }
  const tokenPath = `${homeDir()}/.fmux-auth-token`;
  return fs.readFileSync(tokenPath, 'utf8').trim();
}

/**
 * Resolve the primary endpoint. WMUX_SOCKET_PATH (injected into wmux PTYs)
 * wins when present; otherwise we derive the platform default pipe/socket
 * name. Returned as a string path that `net.connect(path)` accepts directly.
 */
export function endpoint() {
  return process.env[ 'WMUX_SOCKET_PATH' ] || defaultPipeName();
}

/**
 * Windows-only TCP fallback (src/shared/constants.ts getTcpPortPath). When the
 * named pipe rejects the connection with EPERM (a known Windows pipe-ACL
 * edge case), wmux's PipeServer also listens on 127.0.0.1:<port> and writes
 * the chosen port to `~/.fmux-tcp-port`. Returns { host, port } or null.
 *
 * Caveat: the port file is removed only on clean daemon shutdown, so after a
 * crash (or when wmux simply isn't running — pipe ENOENT) a STALE file can
 * linger, and the client would offer the auth token to whatever local process
 * now owns that loopback port. On a single-user machine this matches wmux's
 * threat model (and the bundled client behaves the same way); on shared
 * machines treat the fallback as advisory — the named pipe is the
 * authenticated path.
 */
function tcpFallback() {
  try {
    const portPath = `${homeDir()}/.fmux-tcp-port`;
    const port = Number(fs.readFileSync(portPath, 'utf8').trim());
    if (port > 0) return { host: '127.0.0.1', port };
  } catch {
    /* no port file → no fallback */
  }
  return null;
}

/**
 * A wmux RPC failure surfaced as a thrown Error. Carries the structured
 * `rejection` object (src/shared/rpc.ts RpcRejection) when the server attached
 * one, so callers can branch on `err.rejection.reason` (e.g. 'identity-status'
 * for the approval-retry idiom — docs/api/mcp-plugin-spec.md §4.4)
 * without re-parsing the human-readable `error` string.
 */
export class WmuxRpcError extends Error {
  constructor(message, rejection) {
    super(message);
    this.name = 'WmuxRpcError';
    /** Structured RpcRejection from the server, or undefined. @type {object | undefined} */
    this.rejection = rejection;
  }
}

/**
 * One persistent socket to wmux, multiplexing many concurrent RPCs by `id`.
 *
 * Design (PROTOCOL.md §5; newline framing per src/main/pipe/PipeServer.ts):
 *   - ONE socket for the whole session (not one-per-RPC). The 50-connection
 *     server cap is for the whole machine; a well-behaved plugin uses a single
 *     long-lived connection.
 *   - Incoming bytes are buffered and split on '\n'; each complete line is
 *     JSON.parse'd and correlated to a pending request by `id`.
 *   - Every outbound envelope carries `token`, and (unless legacy mode)
 *     `clientName` + `clientVersion` so the substrate can attribute the call
 *     to this plugin's trust-DB entry (src/shared/rpc.ts RpcRequest).
 *   - On socket 'close' we reject all in-flight requests and (if configured)
 *     transparently reconnect on the next rpc() call.
 */
export class WmuxClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.token]          auth token; defaults to loadToken()
   * @param {string} [opts.endpoint]       pipe/socket path; defaults to endpoint()
   * @param {string} [opts.clientName]     identity stamped on every envelope; omit for legacy mode
   * @param {string} [opts.clientVersion]  identity version
   * @param {number} [opts.rpcTimeoutMs]   per-request timeout (default 8000)
   * @param {(line: string) => void} [opts.onLog]  optional diagnostic sink
   */
  constructor(opts = {}) {
    this.token = opts.token ?? loadToken();
    this.endpoint = opts.endpoint ?? endpoint();
    this.clientName = opts.clientName;       // undefined ⇒ legacy (no envelope identity)
    this.clientVersion = opts.clientVersion;
    this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 8000;
    this.onLog = opts.onLog ?? (() => {});

    /** @type {net.Socket | null} */
    this.sock = null;
    this.buf = '';
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    this.connecting = null;     // in-flight connect promise (dedupes concurrent rpc() calls)
    this.closed = false;        // set by close() — suppresses auto-reconnect
    this.usedTcpFallback = false;
  }

  /** Open the socket if not already connected. Idempotent / dedup-safe. */
  async connect() {
    if (this.sock && !this.sock.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._openSocket();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  _openSocket() {
    return new Promise((resolve, reject) => {
      const tryConnect = (target, isFallback) => {
        const sock = target.port
          ? net.createConnection({ host: target.host, port: target.port })
          : net.createConnection(target.path);

        const onConnectError = (err) => {
          sock.removeListener('connect', onConnect);
          // Windows pipe EPERM/ENOENT → try the TCP loopback fallback once
          // (PROTOCOL.md §5; src/shared/constants.ts getTcpPortPath).
          if (
            !isFallback &&
            process.platform === 'win32' &&
            (err.code === 'EPERM' || err.code === 'ENOENT')
          ) {
            const fb = tcpFallback();
            if (fb) {
              this.onLog(`pipe ${err.code} — retrying via TCP fallback 127.0.0.1:${fb.port}`);
              this.usedTcpFallback = true;
              tryConnect(fb, true);
              return;
            }
          }
          reject(err);
        };

        const onConnect = () => {
          sock.removeListener('error', onConnectError);
          this.sock = sock;
          this.buf = '';
          sock.setEncoding('utf8');
          sock.on('data', (chunk) => this._onData(chunk));
          sock.on('close', () => this._onClose());
          sock.on('error', (e) => this.onLog(`socket error: ${e.message}`));
          resolve();
        };

        sock.once('error', onConnectError);
        sock.once('connect', onConnect);
      };

      tryConnect({ path: this.endpoint }, false);
    });
  }

  // Buffer + split on '\n', JSON.parse each complete line, correlate by id.
  // (Wire framing per src/main/pipe/PipeServer.ts; identical to
  // scripts/m0-dynamic-verify.mjs.)
  _onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf('\n')) !== -1) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.ok === false) {
        // Surface the structured rejection (src/shared/rpc.ts RpcRejection)
        // alongside the human-readable error so callers can drive the
        // approval-retry idiom off `rejection.reason`.
        waiter.reject(new WmuxRpcError(msg.error || 'rpc error', msg.rejection));
      } else {
        // Successful responses always carry `result`. Some handlers return a
        // bare value; pass `result` through verbatim.
        waiter.resolve(msg.result);
      }
    }
  }

  _onClose() {
    this.sock = null;
    const err = new Error('Forge Mux socket closed');
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
    this.pending.clear();
    if (!this.closed) this.onLog('socket closed — will reconnect on next rpc');
  }

  /**
   * Issue one RPC and resolve with its `result` (or reject with a
   * WmuxRpcError carrying `.rejection`). Reconnects transparently if the
   * socket dropped since the last call.
   *
   * @param {string} method  an RpcMethod from src/shared/rpc.ts
   * @param {object} [params]
   */
  async rpc(method, params = {}) {
    if (this.closed) throw new Error('client is closed');
    await this.connect();

    const id = randomUUID();
    const envelope = { id, method, params, token: this.token };
    // Stamp declared identity on every envelope when running in identity mode
    // (src/shared/rpc.ts RpcRequest.clientName / clientVersion). Omitting it
    // makes the substrate treat the caller as `legacy` (grandfathered).
    if (this.clientName) {
      envelope.clientName = this.clientName;
      if (this.clientVersion) envelope.clientVersion = this.clientVersion;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc timeout: ${method}`));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sock.write(JSON.stringify(envelope) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  /** Close the socket and stop auto-reconnecting. */
  close() {
    this.closed = true;
    if (this.sock && !this.sock.destroyed) {
      try {
        this.sock.destroy();
      } catch {
        /* ignore */
      }
    }
    this.sock = null;
  }
}

/**
 * Convenience: construct + connect in one call.
 * @param {ConstructorParameters<typeof WmuxClient>[0]} [opts]
 */
export async function connect(opts) {
  const client = new WmuxClient(opts);
  await client.connect();
  return client;
}
