#!/usr/bin/env node
/**
 * Thin stdio shim — the per-agent MCP process under the broker topology
 * (plans/mcp-broker-design-2026-07-16.md Option A).
 *
 * The agent CLI spawns this instead of the full MCP bundle. It does exactly
 * two things:
 *   1. asserts who it is to the broker (one JSON handshake line carrying
 *      its pid/ppid, the pane env hints, and the pipe auth token), and
 *   2. pumps bytes: stdin → broker pipe, broker pipe → stdout.
 *
 * It deliberately imports NO MCP SDK, no zod, no tools — its whole value is
 * weighing ~bare-node instead of ~32 MB. Identity stays sound because this
 * process sits in the agent's own process tree exactly where the old child
 * sat: the broker starts its PID walk from the pid asserted here, and the
 * ancestry chain it walks is this shim's.
 *
 * Failure contract: if the broker connection drops mid-session, the shim
 * EXITS (non-zero). MCP servers are stateful per session (initialize
 * handshake), so a silent reconnect would leave the host talking to a
 * server that has forgotten the handshake. Exiting surfaces the standard
 * "server died" path that hosts already know how to restart. At STARTUP,
 * connect retries briefly with backoff so a broker that is still booting
 * (app launch race) doesn't fail the first agent spawn.
 */
import * as net from 'net';
import * as fs from 'fs';
import { getMcpBrokerPipeName, getAuthTokenPath } from '../shared/constants';
import { COMMANDER_MODE_ARG } from '../shared/commanderSurface';

const CONNECT_RETRIES = 10;
const CONNECT_RETRY_DELAY_MS = 300;

function readAuthToken(): string | undefined {
  try {
    const fromFile = fs.readFileSync(getAuthTokenPath(), 'utf8').trim();
    if (fromFile) return fromFile;
  } catch { /* file doesn't exist */ }
  if (process.env.WMUX_AUTH_TOKEN) return process.env.WMUX_AUTH_TOKEN;
  return undefined;
}

function connectOnce(pipeName: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });
    socket.once('error', (err) => reject(err));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const token = readAuthToken();
  if (!token) {
    console.error('[wmux-mcp-shim] auth token not found. Is wmux running?');
    process.exit(1);
  }

  const pipeName = getMcpBrokerPipeName();
  let socket: net.Socket | null = null;
  let lastErr: unknown;
  for (let i = 0; i < CONNECT_RETRIES; i++) {
    try {
      socket = await connectOnce(pipeName);
      break;
    } catch (err) {
      lastErr = err;
      await sleep(CONNECT_RETRY_DELAY_MS);
    }
  }
  if (!socket) {
    console.error(
      `[wmux-mcp-shim] cannot reach broker at ${pipeName}: ` +
        `${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
    process.exit(1);
  }

  // Handshake: one JSON line, then the stream is pure MCP traffic. The
  // broker validates the token before hosting a server for us; pid/ppid
  // seed its identity walk, and the env hints ride along because codex
  // strips env from ITS children — but this shim IS the child the agent
  // spawned, so whatever hints survived to us are exactly what the old
  // full child would have seen.
  socket.write(
    JSON.stringify({
      wmuxShim: 1,
      authToken: token,
      callerPid: process.pid,
      callerPpid: process.ppid,
      envWorkspaceHint: process.env.WMUX_WORKSPACE_ID || '',
      envPtyHint: process.env.WMUX_PTY_ID || '',
      commanderToken: process.env.WMUX_COMMANDER_TOKEN,
      commanderMode: process.argv.includes(COMMANDER_MODE_ARG),
    }) + '\n',
  );

  // Byte pumps. No parsing: MCP stdio framing is newline-delimited JSON and
  // the broker consumes it as a stream, so pass-through preserves framing.
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  // Host closed our stdin → normal end of session. Mirror the old child:
  // exit cleanly so the host doesn't report a server crash.
  process.stdin.on('end', () => {
    socket?.end();
    process.exit(0);
  });
  process.stdin.on('error', () => {
    socket?.destroy();
    process.exit(0);
  });

  // Broker went away mid-session → exit non-zero (see failure contract).
  socket.on('close', () => {
    console.error('[wmux-mcp-shim] broker connection closed');
    process.exit(1);
  });
  socket.on('error', (err) => {
    console.error(`[wmux-mcp-shim] broker connection error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    socket?.destroy();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[wmux-mcp-shim] failed to start:', err);
  process.exit(1);
});
