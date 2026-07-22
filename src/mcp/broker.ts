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

async function hostConnection(socket: net.Socket, handshake: ShimHandshake): Promise<void> {
  const connId = ++connSeq;
  const scope: ConnectionScope = createConnectionScope();

  const log = (msg: string) => console.error(`[wmux-mcp-broker] #${connId} ${msg}`);
  log(
    `shim connected pid=${handshake.callerPid} ` +
      `commander=${handshake.commanderMode ? 'yes' : 'no'} ` +
      `envHints=${handshake.envWorkspaceHint ? 'ws' : ''}${handshake.envPtyHint ? '+pty' : ''}`,
  );

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
    const transport = new StdioServerTransport(socket, socket);
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
        log('transport closed');
        // Tear down THIS caller's browser session only. The engine is
        // per-connection (scope.playwright), so no other agent is touched.
        const engine = scope.playwright as PlaywrightEngine | undefined;
        if (engine) {
          void engine.disconnect().catch(() => { /* best-effort */ });
        }
        onclose?.();
      });
  });

  socket.on('error', (err) => log(`socket error: ${err.message}`));
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

  server.on('error', (err) => {
    // EADDRINUSE = another broker (stale or racing) owns the pipe. The
    // supervisor treats a fast exit as "already running" via this code.
    console.error(`[wmux-mcp-broker] server error: ${err.message}`);
    process.exit((err as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 75 : 1);
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
