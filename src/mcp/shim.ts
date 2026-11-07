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
 *
 * The shim asks for the broker's ack before it forwards a byte. A broker that
 * cannot tie the connection to this process (`peer`, `peer-unverified`), or
 * sends no ack, leaves the session to the full server beside this file, run in
 * this same process, like the native launcher (core/wmux-native/src/mcp_shim.rs).
 */
import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { getMcpBrokerPipeName, getAuthTokenPath } from '../shared/constants';
import { COMMANDER_MODE_ARG } from '../shared/commanderSurface';
import { CORE_MODE_ARG } from '../shared/coreSurface';
import { roleArgValue } from '../shared/roleSurfaces';

const CONNECT_RETRIES = 10;
const CONNECT_RETRY_DELAY_MS = 300;
/** As long as the native launcher waits for the broker's ack. */
const ACK_DEADLINE_MS = 5000;
const ACK_LINE_MAX = 4096;

type Ack = { kind: 'hosted'; rest: Buffer } | { kind: 'refused'; why: string } | { kind: 'missing'; why: string };

/** The broker's ack line, read before anything is forwarded. */
function readAck(socket: net.Socket): Promise<Ack> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = (ack: Ack): void => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('close', onClose);
      socket.off('error', onClose);
      socket.pause();
      resolve(ack);
    };
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        if (buf.length > ACK_LINE_MAX) done({ kind: 'missing', why: 'the first line from the broker is not an ack' });
        return;
      }
      let line: { wmuxBroker?: unknown; ok?: unknown; error?: unknown };
      try { line = JSON.parse(buf.subarray(0, nl).toString('utf8')) as typeof line; } catch { line = {}; }
      if (line.wmuxBroker !== 1) done({ kind: 'missing', why: 'the first line from the broker is not an ack' });
      else if (line.ok === true) done({ kind: 'hosted', rest: buf.subarray(nl + 1) });
      else done({ kind: 'refused', why: typeof line.error === 'string' ? line.error : 'unknown' });
    };
    const onClose = (): void => done({ kind: 'missing', why: 'the broker closed the connection before its ack' });
    const timer = setTimeout(() => done({ kind: 'missing', why: `no ack in ${ACK_DEADLINE_MS / 1000} s` }), ACK_DEADLINE_MS);
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', onClose);
  });
}

/** Whether the full server can still take a refused session (the native launcher's rule). */
function refusalFallsBack(why: string): boolean {
  return why === 'peer' || why === 'peer-unverified';
}

/**
 * Hand the session to the full server beside this file, in this process: its
 * pid, parent, argv and env stay the ones the host gave this shim. The dev
 * build's tsc output names it entry.js (index.js there is the server module);
 * mcp-bundle names the bundled entry index.js.
 */
function runFullServer(why: string): void {
  console.error(`[wmux-mcp-shim] ${why}; running the full server`);
  const entry = [path.join(__dirname, 'entry.js'), path.join(__dirname, 'index.js')].find((f) => fs.existsSync(f));
  if (!entry) {
    console.error('[wmux-mcp-shim] no full server beside the shim');
    process.exit(1);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- a runtime path, loaded only on this branch
  require(entry);
}

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
      // Additive handshake field. An OLD broker that predates `--core` simply
      // ignores it and hosts the `full` surface — which is the pre-existing
      // default, so the fallback is WIDER, never narrower. That is safe here
      // precisely because core is an optimization profile and not a security
      // boundary (see src/shared/coreSurface.ts): nothing is being fenced off,
      // so a version skew that drops the field loses token savings, not a
      // guarantee. `commanderMode` must never be treated this way.
      coreMode: process.argv.includes(CORE_MODE_ARG),
      // Additive like coreMode: an older broker ignores it and hosts full.
      roleSurface: roleArgValue(process.argv),
      ack: 1,
    }) + '\n',
  );

  const ack = await readAck(socket);
  if (ack.kind !== 'hosted') {
    socket.destroy();
    if (ack.kind === 'refused' && !refusalFallsBack(ack.why)) {
      console.error(`[wmux-mcp-shim] broker refused the session: ${ack.why}`);
      process.exit(1);
    }
    runFullServer(ack.kind === 'refused' ? `broker refused the session: ${ack.why}` : ack.why);
    return;
  }
  if (ack.rest.length > 0) process.stdout.write(ack.rest);

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
