#!/usr/bin/env node
/**
 * Helper probe for workspace-identity-dynamic.mjs.
 *
 * Mirrors the resolveWorkspaceId algorithm from src/mcp/index.ts and
 * reports telemetry on stdout (single JSON object). The chain:
 *
 *   1. Call a2a.resolve.identity RPC for the PID → (live) workspaceId map.
 *   2. Walk PPID chain up to 10 levels looking for a match (path B).
 *   3. Only if that finds nothing, fall back to the WMUX_WORKSPACE_ID env
 *      hint (path A). The env is NO LONGER a short-circuit: it is frozen at
 *      PTY-create time and goes stale when the workspace id is re-minted, so
 *      the live PID map is always preferred over it.
 *
 * Inputs (env):
 *   WMUX_WSID_PROBE_PIPE   pipe / socket name of the bundled daemon
 *   WMUX_WSID_PROBE_TOKEN  auth token for the daemon
 *   WMUX_WORKSPACE_ID      env hint (may be stale); used only as last resort
 *
 * Output (single line JSON to stdout):
 *   {
 *     resolved: string,    // the resolved workspaceId, or "" on failure
 *     rpcCalls: number,    // 0 if path A, 1 if path B was attempted
 *     walkDepth: number,   // 0 if path A, >=1 if walk ran
 *   }
 */
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const pipeName = process.env.WMUX_WSID_PROBE_PIPE;
const authToken = process.env.WMUX_WSID_PROBE_TOKEN;
const envWorkspaceId = process.env.WMUX_WORKSPACE_ID || '';

if (!pipeName || !authToken) {
  console.error('probe: missing WMUX_WSID_PROBE_PIPE or WMUX_WSID_PROBE_TOKEN');
  process.exit(2);
}

let rpcCalls = 0;
let walkDepth = 0;

function connectSocket() {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });
}

function rpc(socket, method, params, timeoutMs = 5000) {
  rpcCalls++;
  return new Promise((resolve, reject) => {
    const id = `req-${Math.random().toString(36).slice(2, 10)}`;
    let buffer = '';
    const handler = (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === id) {
            socket.removeListener('data', handler);
            if (msg.ok) resolve(msg.result); else reject(new Error(msg.error ?? 'rpc error'));
            return;
          }
        } catch { /* ignore */ }
      }
    };
    socket.on('data', handler);
    socket.write(JSON.stringify({ id, method, params, token: authToken }) + '\n');
    setTimeout(() => {
      socket.removeListener('data', handler);
      reject(new Error(`rpc timeout: ${method}`));
    }, timeoutMs);
  });
}

function getParentPid(pid) {
  try {
    if (process.platform === 'win32') {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = execFileSync(ps, [
        '-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
      ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const parsed = parseInt(out.trim(), 10);
      return Number.isNaN(parsed) ? null : parsed;
    }
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000 });
    return parseInt(out.trim(), 10) || null;
  } catch {
    return null;
  }
}

async function resolveWorkspaceId() {
  // Path B/C first — RPC for the live PID map, then walk the PPID chain.
  // The env hint is deliberately NOT consulted up front: trusting it forever
  // is what produced stale identities ("no workspace found for ws-…").
  let socket;
  try {
    socket = await connectSocket();
    const result = await rpc(socket, 'a2a.resolve.identity', {});
    const mappings = result?.mappings ?? {};
    if (Object.keys(mappings).length > 0) {
      const known = new Map();
      for (const [pidStr, wsId] of Object.entries(mappings)) {
        const pid = parseInt(pidStr, 10);
        if (!Number.isNaN(pid)) known.set(pid, wsId);
      }

      let currentPid = process.ppid;
      for (let depth = 0; depth < 10; depth++) {
        walkDepth = depth + 1;
        const wsId = known.get(currentPid);
        if (wsId) return wsId;
        const parent = getParentPid(currentPid);
        if (!parent || parent === currentPid || parent <= 1) break;
        currentPid = parent;
      }
    }
  } catch {
    /* fall through to the env hint */
  } finally {
    if (socket) socket.end();
  }

  // Path A (last resort) — unconfirmed, possibly-stale env hint.
  if (envWorkspaceId) return envWorkspaceId;
  return '';
}

(async () => {
  try {
    const resolved = await resolveWorkspaceId();
    process.stdout.write(JSON.stringify({ resolved, rpcCalls, walkDepth }) + '\n');
    process.exit(0);
  } catch (err) {
    console.error('probe failure:', err);
    process.exit(1);
  }
})();
