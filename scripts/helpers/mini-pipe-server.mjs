#!/usr/bin/env node
/**
 * Mini JSON-RPC server that reproduces the §6.1-relevant subset of
 * wmux's main-process PipeServer — just enough to drive the workspace
 * identity dynamic test against. The full PipeServer lives in
 * src/main/pipe/PipeServer.ts but depends on Electron BrowserWindow /
 * ClaudeWorker / RpcRouter wiring that can't be spawned in isolation.
 *
 * Handlers reproduced:
 *
 *   a2a.resolve.identity
 *     Reads ~/.wmux/pid-map/ (via HOME/USERPROFILE override). Each entry is
 *     PID → ptyId; the handler resolves the CURRENT owning workspace for that
 *     ptyId, mirroring src/main/pipe/handlers/a2a.rpc.ts. The live pty →
 *     workspace lookup (real handler: input.findOwnerWorkspace on the
 *     renderer) is simulated here via WMUX_MINISERVER_OWNERS, a JSON
 *     { <ptyId>: <workspaceId> } map. Legacy "ws-"-prefixed entries are
 *     passed through; ptyIds with no live owner are omitted.
 *
 *   mcp.claimWorkspace
 *     Returns an explicit "no window" error to mirror what the real
 *     sendToRenderer would emit when no renderer is attached. The real
 *     handler delegates to renderer; this stub proves that path C in
 *     §6.1 does not silently fall through to substrate state.
 *
 * Inputs (env):
 *   WMUX_MINISERVER_PIPE   pipe / socket name to listen on
 *   WMUX_MINISERVER_TOKEN  expected auth token
 *   USERPROFILE / HOME     override for pid-map directory location
 *
 * Stdout: emits "READY" on a single line once listening, so the test
 * runner can synchronize without polling a pipe file.
 */
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const pipeName = process.env.WMUX_MINISERVER_PIPE;
const expectedToken = process.env.WMUX_MINISERVER_TOKEN;

if (!pipeName || !expectedToken) {
  console.error('mini-pipe-server: missing WMUX_MINISERVER_PIPE or WMUX_MINISERVER_TOKEN');
  process.exit(2);
}

function getPidMapDir() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  return path.join(home, '.wmux', 'pid-map');
}

function getSimulatedOwners() {
  // Simulates the renderer's live ptyId → workspaceId ownership table that the
  // real handler reaches via sendToRenderer('input.findOwnerWorkspace').
  try {
    const parsed = JSON.parse(process.env.WMUX_MINISERVER_OWNERS || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function handleA2aResolveIdentity() {
  const dir = getPidMapDir();
  const owners = getSimulatedOwners();
  const mappings = {};
  try {
    if (fs.existsSync(dir)) {
      for (const file of fs.readdirSync(dir)) {
        let value;
        try {
          value = fs.readFileSync(path.join(dir, file), 'utf-8').trim();
        } catch {
          continue;
        }
        if (!value) continue;
        if (value.startsWith('ws-')) {
          // Legacy PID → workspaceId entry: pass through.
          mappings[file] = value;
          continue;
        }
        // Current format: PID → ptyId. Resolve the live owning workspace.
        const wsId = owners[value];
        if (typeof wsId === 'string' && wsId) mappings[file] = wsId;
      }
    }
  } catch { /* best-effort */ }
  return { mappings };
}

function handleMcpClaimWorkspace() {
  // Mirrors the real sendToRenderer behavior when no window is attached.
  // The error shape is what the substrate consumer will actually see.
  throw new Error('window not available — renderer not attached');
}

function dispatch(method, params) {
  switch (method) {
    case 'a2a.resolve.identity': return handleA2aResolveIdentity();
    case 'mcp.claimWorkspace':   return handleMcpClaimWorkspace();
    default: throw new Error(`Unknown method: ${method}`);
  }
}

const server = net.createServer((socket) => {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const id = msg.id;
      try {
        if (msg.token !== expectedToken) {
          socket.write(JSON.stringify({ id, ok: false, error: 'auth' }) + '\n');
          continue;
        }
        const result = dispatch(msg.method, msg.params ?? {});
        socket.write(JSON.stringify({ id, ok: true, result }) + '\n');
      } catch (err) {
        socket.write(JSON.stringify({ id, ok: false, error: err.message }) + '\n');
      }
    }
  });
});

server.listen(pipeName, () => {
  process.stdout.write('READY\n');
});

server.on('error', (err) => {
  console.error('mini-pipe-server error:', err);
  process.exit(1);
});

// Clean shutdown.
function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
