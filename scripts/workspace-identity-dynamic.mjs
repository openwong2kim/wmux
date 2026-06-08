#!/usr/bin/env node
/**
 * Substrate v3.0 Phase 1 M4 dynamic test — workspaceId resolution paths.
 *
 * Verifies that docs/PROTOCOL.md §6.1's claimed resolution chain
 * (paths A / B / C / D) actually behaves as documented at runtime.
 *
 * Architecture note: §6.1's RPCs (a2a.resolve.identity, mcp.claimWorkspace)
 * are registered on the main-process PipeServer, not the bundled daemon.
 * Spawning the real main process requires an Electron BrowserWindow + IPC
 * harness. Instead we spawn a mini-pipe-server (scripts/helpers/) that
 * reproduces the §6.1-relevant handler logic verbatim (PID-map fs read
 * + claim no-window stub) and exercise the full helper-probe chain
 * against it. The substrate-consumer-facing contract is the wire shape
 * and routing of these RPCs; the mini-server preserves both.
 *
 * Scenarios:
 *
 *   W1  a2a.resolve.identity resolves PID → ptyId → LIVE workspace.
 *       pid-map stores PID → ptyId; the handler returns the ptyId's
 *       current owner. Legacy "ws-" entries pass through; ptyIds with no
 *       live owner are omitted.
 *
 *   W2  REGRESSION (the identity-drift bug): stale env + live PID map.
 *       The PTY env names a workspace that no longer exists, but the live
 *       PID map resolves the PPID to the CURRENT workspace. Asserts the
 *       resolver returns the LIVE id, NOT the stale env. (Before the fix,
 *       env short-circuited and the agent was stuck on the dead id.)
 *
 *   W2b Env hint fallback. env set + no PID-map match → the resolver
 *       falls back to the (unconfirmed) env hint rather than failing.
 *
 *   W3  Path B — env empty + PID-tree walk hits a mapping.
 *       pid-map/<test-runner-pid> = ptyId, owner = "ws-walk-match" →
 *       probe's PPID is the runner, first walk step matches.
 *
 *   W4  Path B exhaustion (boundary to path C).
 *       env empty + pid-map empty. Walk runs, finds nothing, returns "".
 *
 *   W5  Path C — mcp.claimWorkspace routing.
 *       Real handler is sendToRenderer; without a renderer attached the
 *       substrate must NOT silently fall through. Asserts: claim RPC
 *       fails with a window/renderer-attribution error.
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const MINI_SERVER = path.join(REPO_ROOT, 'scripts', 'helpers', 'mini-pipe-server.mjs');
const HELPER_PROBE = path.join(REPO_ROOT, 'scripts', 'helpers', 'resolve-workspace-id-probe.mjs');

if (!fs.existsSync(MINI_SERVER) || !fs.existsSync(HELPER_PROBE)) {
  console.error('helper scripts missing');
  process.exit(2);
}

// === Test environment ===

function makeTestHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-wsid-dyn-'));
  fs.mkdirSync(path.join(home, '.wmux'), { recursive: true });
  return home;
}

function makePipeName(tag) {
  if (process.platform === 'win32') return `\\\\.\\pipe\\wmux-wsid-${tag}`;
  return path.join(os.tmpdir(), `wmux-wsid-${tag}.sock`);
}

function spawnMiniServer({ pipeName, authToken, testHome, owners, workspaces, resolveOnce }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MINI_SERVER], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        USERPROFILE: testHome,
        HOME: testHome,
        HOMEDRIVE: undefined,
        HOMEPATH: undefined,
        WMUX_MINISERVER_PIPE: pipeName,
        WMUX_MINISERVER_TOKEN: authToken,
        // Simulated renderer ptyId → workspaceId ownership table.
        WMUX_MINISERVER_OWNERS: JSON.stringify(owners ?? {}),
        // Simulated renderer workspace.list (live workspace array).
        WMUX_MINISERVER_WORKSPACES: JSON.stringify(workspaces ?? []),
        // When set, the PID map resolves only on the first call (then empty).
        WMUX_MINISERVER_RESOLVE_ONCE: resolveOnce ? '1' : undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let ready = false;
    child.stdout.on('data', (d) => {
      if (!ready && d.toString().includes('READY')) {
        ready = true;
        resolve({ child, getStderr: () => stderr });
      }
    });
    child.on('exit', (code) => {
      if (!ready) reject(new Error(`mini-server exited ${code} before READY; stderr: ${stderr.trim()}`));
    });
    setTimeout(() => {
      if (!ready) {
        child.kill('SIGKILL');
        reject(new Error('mini-server did not become READY in time'));
      }
    }, 8_000);
  });
}

function connectSocket(pipeName) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(pipeName, () => resolve(s));
    s.on('error', reject);
  });
}

function rpc(socket, method, params, authToken, timeoutMs = 8_000) {
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

async function killChild(child) {
  if (child.killed) return;
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 500));
  if (!child.killed) child.kill('SIGKILL');
}

async function withServer(label, body, owners, workspaces, extra = {}) {
  const testHome = makeTestHome();
  const wmuxDir = path.join(testHome, '.wmux');
  const pipeName = makePipeName(`${label}-${randomUUID().slice(0, 8)}`);
  const authToken = randomUUID();
  const { child, getStderr } = await spawnMiniServer({ pipeName, authToken, testHome, owners, workspaces, resolveOnce: extra.resolveOnce });
  try {
    return await body({ testHome, wmuxDir, pipeName, authToken });
  } catch (err) {
    const stderr = getStderr();
    if (stderr) console.error(`[${label}] mini-server stderr tail:\n${stderr.slice(-1500)}`);
    throw err;
  } finally {
    await killChild(child);
    try { fs.rmSync(testHome, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function runProbe({ pipeName, authToken, testHome, envWorkspaceId, double }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HELPER_PROBE], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        USERPROFILE: testHome,
        HOME: testHome,
        HOMEDRIVE: undefined,
        HOMEPATH: undefined,
        WMUX_WSID_PROBE_PIPE: pipeName,
        WMUX_WSID_PROBE_TOKEN: authToken,
        WMUX_WORKSPACE_ID: envWorkspaceId ?? '',
        // Resolve twice (cache, then force-re-resolve) to exercise the
        // stale-cache fallback gate.
        WMUX_WSID_PROBE_DOUBLE: double ? '1' : undefined,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`probe exited ${code}; stderr: ${stderr.trim() || '<empty>'}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`probe stdout not JSON: ${stdout.trim()}`));
      }
    });
    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
        reject(new Error('probe hard timeout'));
      }
    }, 30_000);
  });
}

// === Scenarios ===

async function runW1(report) {
  await withServer('W1', async ({ wmuxDir, pipeName, authToken }) => {
    // pid-map stores PID → ptyId. The handler resolves each ptyId to its live
    // owner; the legacy ws- entry is DROPPED (file deleted, the ghost-fix
    // behavior); the dead ptyId (no owner) is omitted from the map but its file
    // is left on disk (read path is non-destructive for current-format files).
    const pidMapDir = path.join(wmuxDir, 'pid-map');
    fs.mkdirSync(pidMapDir, { recursive: true });
    fs.writeFileSync(path.join(pidMapDir, '12345'), 'daemon-aaaa', 'utf-8'); // live
    fs.writeFileSync(path.join(pidMapDir, '67890'), 'ws-legacy', 'utf-8');   // legacy → dropped
    fs.writeFileSync(path.join(pidMapDir, '55555'), 'daemon-dead', 'utf-8'); // dead owner → omitted

    const socket = await connectSocket(pipeName);
    try {
      const result = await rpc(socket, 'a2a.resolve.identity', {}, authToken);
      const m = result.mappings;
      const filesAfter = fs.readdirSync(pidMapDir).sort();
      const pass =
        m &&
        m['12345'] === 'ws-alpha' &&        // live owner of daemon-aaaa
        !('67890' in m) &&                  // legacy dropped from map
        !('55555' in m) &&                  // dead ptyId omitted
        Object.keys(m).length === 1 &&
        !filesAfter.includes('67890') &&    // legacy file purged from disk
        filesAfter.includes('12345') &&     // live file kept
        filesAfter.includes('55555');       // dead current-format file kept (non-destructive read)
      report.push({ scenario: 'W1', pass, mappings: m, filesAfter });
    } finally {
      socket.end();
    }
  }, { 'daemon-aaaa': 'ws-alpha' });
}

async function runW2(report) {
  // REGRESSION for the identity-drift bug. The env names a workspace that no
  // longer exists (re-minted by a respawn/restore), but the live PID map maps
  // this runner's pid → ptyId → the CURRENT workspace. The resolver must
  // return the LIVE id, never the stale env.
  await withServer('W2', async ({ testHome, wmuxDir, pipeName, authToken }) => {
    const pidMapDir = path.join(wmuxDir, 'pid-map');
    fs.mkdirSync(pidMapDir, { recursive: true });
    fs.writeFileSync(path.join(pidMapDir, String(process.pid)), 'daemon-live', 'utf-8');

    const probe = await runProbe({
      pipeName, authToken, testHome,
      envWorkspaceId: 'ws-stale-DEAD',
    });
    const pass =
      probe.resolved === 'ws-live-current' &&
      probe.resolved !== 'ws-stale-DEAD' &&
      probe.rpcCalls === 1 &&
      probe.walkDepth === 1;
    report.push({ scenario: 'W2', pass, probe });
  }, { 'daemon-live': 'ws-live-current' });
}

async function runW2b(report) {
  // Env hint fallback — hint names a LIVE workspace. No PID-map match (empty
  // map) → the resolver falls back to the env hint, gates it on workspace.list,
  // sees it is live, and returns it. rpcCalls === 2 (resolve.identity +
  // workspace.list).
  await withServer('W2b', async ({ testHome, wmuxDir, pipeName, authToken }) => {
    fs.mkdirSync(path.join(wmuxDir, 'pid-map'), { recursive: true });

    const probe = await runProbe({
      pipeName, authToken, testHome,
      envWorkspaceId: 'ws-from-env',
    });
    const pass = probe.resolved === 'ws-from-env' && probe.rpcCalls === 2;
    report.push({ scenario: 'W2b', pass, probe });
  }, {}, [{ id: 'ws-from-env' }]);
}

async function runW2c(report) {
  // Env hint is a CONFIRMED GHOST. No PID-map match, and workspace.list does
  // NOT contain the hint → the resolver must DROP it and return "" (so the MCP
  // server raises a clear "identity unknown" rather than routing into a ghost).
  // This is the env-hint half of the ghost fix.
  await withServer('W2c', async ({ testHome, wmuxDir, pipeName, authToken }) => {
    fs.mkdirSync(path.join(wmuxDir, 'pid-map'), { recursive: true });

    const probe = await runProbe({
      pipeName, authToken, testHome,
      envWorkspaceId: 'ws-stale-ghost',
    });
    const pass =
      probe.resolved === '' &&
      probe.resolved !== 'ws-stale-ghost' &&
      probe.rpcCalls === 2;
    report.push({ scenario: 'W2c', pass, probe });
  }, {}, [{ id: 'ws-other-live' }]);
}

async function runW2d(report) {
  // Codex PR #142 R3 P2 — a stale cached identity must not outlive its
  // workspace. The first resolve hits the PID-map walk and caches
  // MY_WORKSPACE_ID = the owner. The server is in RESOLVE_ONCE mode, so the
  // forced second resolve sees an EMPTY pid-map (pane gone / re-minted) and
  // falls through. With no env hint and the cached workspace ABSENT from
  // workspace.list, the resolver must drop the cached id and return "" — not
  // keep routing to the confirmed-dead id (the ghost loop).
  await withServer('W2d', async ({ testHome, wmuxDir, pipeName, authToken }) => {
    const pidMapDir = path.join(wmuxDir, 'pid-map');
    fs.mkdirSync(pidMapDir, { recursive: true });
    fs.writeFileSync(path.join(pidMapDir, String(process.pid)), 'daemon-cache', 'utf-8');

    const probe = await runProbe({ pipeName, authToken, testHome, envWorkspaceId: '', double: true });
    const pass =
      probe.resolved === '' &&             // stale cache dropped, not returned
      probe.resolved !== 'ws-cached-DEAD';
    report.push({ scenario: 'W2d', pass, probe });
  }, { 'daemon-cache': 'ws-cached-DEAD' }, [{ id: 'ws-other-live' }], { resolveOnce: true });
}

async function runW3(report) {
  await withServer('W3', async ({ testHome, wmuxDir, pipeName, authToken }) => {
    // Map THIS test runner's pid → ptyId, owner = ws-walk-match. The probe's
    // PPID equals this process's pid, so depth=1 walk step finds the match.
    const pidMapDir = path.join(wmuxDir, 'pid-map');
    fs.mkdirSync(pidMapDir, { recursive: true });
    fs.writeFileSync(path.join(pidMapDir, String(process.pid)), 'daemon-walk', 'utf-8');

    const probe = await runProbe({ pipeName, authToken, testHome, envWorkspaceId: '' });
    const pass =
      probe.resolved === 'ws-walk-match' &&
      probe.rpcCalls === 1 &&
      probe.walkDepth === 1;
    report.push({ scenario: 'W3', pass, probe });
  }, { 'daemon-walk': 'ws-walk-match' });
}

async function runW4(report) {
  await withServer('W4', async ({ testHome, wmuxDir, pipeName, authToken }) => {
    // Empty pid-map. Walk runs but finds nothing → resolved === "".
    fs.mkdirSync(path.join(wmuxDir, 'pid-map'), { recursive: true });

    const probe = await runProbe({ pipeName, authToken, testHome, envWorkspaceId: '' });
    // Note: with an empty pid-map, the probe short-circuits AFTER the
    // RPC sees zero mappings — so walkDepth stays 0 (per the resolver's
    // early-return when mappings are empty). The substrate-level
    // contract being tested is "no fabricated workspaceId is returned".
    const pass =
      probe.resolved === '' &&
      probe.rpcCalls === 1;
    report.push({ scenario: 'W4', pass, probe });
  });
}

async function runW5(report) {
  await withServer('W5', async ({ pipeName, authToken }) => {
    const socket = await connectSocket(pipeName);
    let claimError = null;
    let claimResult = null;
    try {
      claimResult = await rpc(socket, 'mcp.claimWorkspace', {}, authToken, 4_000);
    } catch (err) {
      claimError = err.message;
    } finally {
      socket.end();
    }
    const pass =
      claimResult === null &&
      claimError !== null &&
      /window|renderer|not available/i.test(claimError);
    report.push({ scenario: 'W5', pass, claimError, claimResult });
  });
}

// === Main ===

async function main() {
  console.log(`Workspace identity dynamic test — platform=${process.platform}`);
  const report = [];
  await runW1(report);
  await runW2(report);
  await runW2b(report);
  await runW2c(report);
  await runW2d(report);
  await runW3(report);
  await runW4(report);
  await runW5(report);

  console.log('\n=== Results ===');
  for (const r of report) console.log(JSON.stringify(r, null, 2));

  const failures = report.filter((r) => r.pass === false);
  console.log(`\n${report.length - failures.length} pass, ${failures.length} fail`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
