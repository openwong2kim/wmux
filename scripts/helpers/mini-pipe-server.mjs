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
 *     DROPPED (file deleted) — not passed through — mirroring the fix that
 *     stopped legacy debris from resurfacing as ghost workspaces. ptyIds with
 *     no live owner are omitted but their files are left on disk (the read path
 *     is non-destructive for current-format entries).
 *
 *   workspace.list
 *     Returns the simulated live workspace array from WMUX_MINISERVER_WORKSPACES
 *     (JSON array of { id }). Used by the probe to gate the env hint: a hint
 *     absent from this list is a confirmed ghost and must be dropped.
 *
 *   mcp.claimWorkspace
 *     Returns an explicit "no window" error to mirror what the real
 *     sendToRenderer would emit when no renderer is attached. The real
 *     handler delegates to renderer; this stub proves that path C in
 *     §6.1 does not silently fall through to substrate state.
 *
 * Inputs (env):
 *   WMUX_MINISERVER_PIPE        pipe / socket name to listen on
 *   WMUX_MINISERVER_TOKEN       expected auth token
 *   WMUX_MINISERVER_OWNERS      JSON { ptyId: workspaceId } live-owner table
 *   WMUX_MINISERVER_WORKSPACES  JSON [{ id }] live workspace list
 *   USERPROFILE / HOME          override for pid-map directory location
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

function getSimulatedWorkspaces() {
  // Simulates the renderer's workspace.list response (live workspace array).
  try {
    const parsed = JSON.parse(process.env.WMUX_MINISERVER_WORKSPACES || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// First-call-only mode: when WMUX_MINISERVER_RESOLVE_ONCE is set, the PID map
// resolves on the FIRST a2a.resolve.identity call and returns empty afterward.
// Models a workspace that resolved successfully once, then had its pid-map entry
// vanish (pane closed / re-minted) — used to exercise the stale-cache fallback
// gate (resolveWorkspaceId must not return a confirmed-dead cached id).
let resolveCallCount = 0;

function handleA2aResolveIdentity() {
  const dir = getPidMapDir();
  const owners = getSimulatedOwners();
  const mappings = {};
  resolveCallCount += 1;
  if (process.env.WMUX_MINISERVER_RESOLVE_ONCE && resolveCallCount > 1) {
    return { mappings }; // empty on subsequent calls
  }
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
          // Legacy PID → workspaceId entry: DROP it (delete the file), mirroring
          // src/main/pipe/handlers/a2a.rpc.ts. Passing it through is what let a
          // re-minted/recycled legacy id resurface as a ghost workspace.
          try { fs.unlinkSync(path.join(dir, file)); } catch { /* best-effort */ }
          continue;
        }
        // Current format: PID → ptyId. Resolve the live owning workspace; a
        // dead ptyId (no owner) is omitted but its file is left on disk.
        const wsId = owners[value];
        if (typeof wsId === 'string' && wsId) mappings[file] = wsId;
      }
    }
  } catch { /* best-effort */ }
  return { mappings };
}

function handleWorkspaceList() {
  return getSimulatedWorkspaces();
}

function handleMcpClaimWorkspace() {
  // Mirrors the real sendToRenderer behavior when no window is attached.
  // The error shape is what the substrate consumer will actually see.
  throw new Error('window not available — renderer not attached');
}

function dispatch(method, params) {
  switch (method) {
    case 'a2a.resolve.identity': return handleA2aResolveIdentity();
    case 'workspace.list':       return handleWorkspaceList();
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
