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
import * as net from 'net';
import * as fs from 'fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getMcpBrokerPipeName, getAuthTokenPath } from '../shared/constants';
import { createWmuxServer } from './index';
import {
  createConnectionScope,
  runInConnectionScope,
  type ConnectionScope,
} from './connectionScope';
import type { PlaywrightEngine } from './playwright/PlaywrightEngine';

interface ShimHandshake {
  wmuxShim: number;
  authToken?: string;
  callerPid?: number;
  callerPpid?: number;
  envWorkspaceHint?: string;
  envPtyHint?: string;
  commanderToken?: string;
  commanderMode?: boolean;
}

function readAuthToken(): string | undefined {
  try {
    const fromFile = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* file doesn't exist */ }
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN;
  return undefined;
}

/** Constant-time-ish token compare; length leak is fine for a local pipe. */
function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= presented.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

let connSeq = 0;

/** How long a connection may sit without completing the wmuxShim handshake. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

async function hostConnection(socket: net.Socket, handshake: ShimHandshake): Promise<void> {
  const connId = ++connSeq;
  const scope: ConnectionScope = createConnectionScope();

  const log = (msg: string) => console.error(`[wmux-mcp-broker] #${connId} ${msg}`);
  log(
    `shim connected pid=${handshake.callerPid} ` +
      `commander=${handshake.commanderMode ? 'yes' : 'no'} ` +
      `envHints=${handshake.envWorkspaceHint ? 'ws' : ''}${handshake.envPtyHint ? '+pty' : ''}`,
  );

  // Hoisted so the socket lifecycle handlers below can close the transport when
  // the shim exits. StdioServerTransport.onclose does NOT fire from the socket
  // closing on its own, so without this the per-connection server and its
  // Playwright/CDP session would leak on every shim disconnect.
  let transport: StdioServerTransport | null = null;
  // Guards the onclose teardown against the re-entry that server.close() causes.
  let connClosed = false;

  await runInConnectionScope(scope, async () => {
    const server = createWmuxServer({
      envWorkspaceHint: handshake.envWorkspaceHint || '',
      envPtyHint: handshake.envPtyHint || '',
      commanderToken: handshake.commanderToken,
      commanderMode: handshake.commanderMode === true,
      // Identity walks start at the SHIM's pid — it sits in the agent's
      // process tree exactly where the old full child sat, so both the
      // server-side walk (a2a.resolve.identity { callerPid }) and the
      // client-side upward walk see the same ancestry as before.
      callerPid: handshake.callerPid ?? -1,
      callerPpid: handshake.callerPpid ?? null,
    });

    // The remaining socket bytes are line-framed MCP JSON-RPC — exactly what
    // StdioServerTransport speaks; it accepts any Readable/Writable pair.
    transport = new StdioServerTransport(socket, socket);
    await server.connect(transport);

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
        // Tear down THIS caller's browser session only. The engine is
        // per-connection (scope.playwright), so no other agent is touched.
        const engine = scope.playwright as PlaywrightEngine | undefined;
        if (engine) {
          void engine.disconnect().catch(() => { /* best-effort */ });
        }
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
}

function main(): void {
  const expectedToken = readAuthToken();
  if (!expectedToken) {
    console.error('[wmux-mcp-broker] auth token not found; refusing to serve. Is wmux running?');
    process.exit(1);
  }

  const pipeName = getMcpBrokerPipeName();

  const server = net.createServer((socket) => {
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
      if (!tokenMatches(handshake.authToken, expectedToken)) {
        console.error('[wmux-mcp-broker] auth failed, dropping connection');
        socket.destroy();
        return;
      }

      const rest = buffer.subarray(nl + 1);
      hostConnection(socket, handshake)
        .then(() => {
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
  });

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
    const probe = net.connect(pipeName);
    probe.once('connect', () => {
      probe.destroy();
      console.error('[wmux-mcp-broker] another broker is live; standing down');
      process.exit(75);
    });
    probe.once('error', () => {
      probe.destroy();
      staleRetried = true;
      try {
        fs.unlinkSync(pipeName);
      } catch { /* already gone / not a filesystem path — listen retry decides */ }
      server.listen(pipeName, () => {
        console.error(`[wmux-mcp-broker] listening on ${pipeName} pid=${process.pid} (after stale-socket cleanup)`);
      });
    });
  });

  server.listen(pipeName, () => {
    console.error(`[wmux-mcp-broker] listening on ${pipeName} pid=${process.pid}`);
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
