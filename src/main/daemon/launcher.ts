import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getWmuxDir } from '../../daemon/config';
import { getDaemonPipeName, readDaemonAuthToken } from '../DaemonClient';

export interface DaemonInfo {
  pid: number;
  authToken: string;
  pipeName: string;
  spawned: boolean;
}

function isProcessAlive(pid: number): boolean {
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = path.join(systemRoot, 'System32', 'tasklist.exe');
      const result = execFileSync(tasklist, ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf-8', timeout: 3000, windowsHide: true,
      });
      return result.includes(`"${pid}"`);
    } catch { return false; }
  }
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Look up the process image name (executable basename) for a PID, so the
 * launcher can verify a PID actually belongs to wmux before sending SIGKILL.
 *
 * Critical for the "alive but unresponsive" branch: after a crash, the OS
 * may reuse the daemon's PID for an unrelated user process (Chrome, an
 * IDE, anything). Killing whichever process owns the recycled PID is a
 * tier-1 "wtf is wmux doing" bug.
 *
 * Returns null when lookup fails — callers must treat null as "don't kill".
 */
function getProcessImageName(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const tasklist = path.join(systemRoot, 'System32', 'tasklist.exe');
      const result = execFileSync(tasklist, ['/fi', `PID eq ${pid}`, '/fo', 'csv', '/nh'], {
        encoding: 'utf-8', timeout: 3000, windowsHide: true,
      });
      // tasklist /fo csv /nh format:
      //   "image.exe","PID","sessionName","sessionNum","memUsage"
      const match = result.match(/^"([^"]+)"/);
      return match ? match[1] : null;
    } catch { return null; }
  }
  // POSIX: /proc/<pid>/comm carries the executable name (truncated to 15
  // bytes on Linux, full name on macOS-with-procfs-mounted, otherwise null).
  try {
    return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
  } catch { return null; }
}

/**
 * Read a process's full command line, so callers can verify it actually
 * carries the daemon-script path before treating it as a wmux daemon.
 *
 * This is the second safety net for the kill path: image basename alone
 * ("electron.exe" in dev) collides with the main process itself and with
 * any other Electron-based app the user happens to be running. Adding
 * "did this process get spawned with the daemon script as argv[1]"
 * narrows the false-positive surface dramatically.
 *
 * On Windows uses PowerShell + CIM (WMI replacement) — wmic is being
 * deprecated and this path runs at most once per ensureDaemon() call.
 * Returns null on any failure; callers must treat null as "can't verify".
 */
function getProcessCommandLine(pid: number): string | null {
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const systemRoot = process.env.SystemRoot || 'C:\\Windows';
      const powershell = path.join(
        systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe',
      );
      // Single quotes around the filter so the parser doesn't expand
      // anything; -NoProfile keeps startup cheap.
      const result = execFileSync(
        powershell,
        [
          '-NoProfile', '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue).CommandLine`,
        ],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true },
      );
      const trimmed = result.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch { return null; }
  }
  // POSIX: /proc/<pid>/cmdline carries the argv joined by NUL.
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    return raw.replace(/\0/g, ' ').trim() || null;
  } catch { return null; }
}

function pingDaemon(pipeName: string, token: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(pipeName);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; socket.destroy(); resolve(false); }
    }, timeoutMs);
    timer.unref();

    socket.on('connect', () => {
      const id = crypto.randomUUID();
      socket.write(JSON.stringify({ id, method: 'daemon.ping', params: {}, token }) + '\n');
    });

    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line.trim());
          if (resp.ok || (resp.result && resp.result.status === 'ok')) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(true);
            return;
          }
        } catch {}
      }
    });

    socket.on('error', () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(false); }
    });
  });
}

function findNodePath(): string {
  // Prefer Electron's bundled node (via ELECTRON_RUN_AS_NODE) — it's a GUI
  // subsystem executable, so it won't flash a console window on Windows.
  // System node.exe is a console app and briefly shows a window even with
  // windowsHide: true.
  return process.execPath;
}

function spawnDaemon(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Find daemon script
    // In dev: app.getAppPath() = project root → dist/daemon/daemon/index.js
    // In production: extraResource → process.resourcesPath/daemon/daemon/index.js
    const projectRoot = app.getAppPath();
    const resourcesRoot = process.resourcesPath;
    console.log(`[launcher] projectRoot = ${projectRoot}, resourcesPath = ${resourcesRoot}`);

    const candidates = [
      // Production (extraResource) — esbuild bundle
      path.join(resourcesRoot, 'daemon-bundle', 'index.js'),
      // Production fallback (old layout)
      path.join(resourcesRoot, 'daemon', 'daemon', 'index.js'),
      path.join(resourcesRoot, 'daemon', 'index.js'),
      // Development — esbuild bundle
      path.join(projectRoot, 'dist', 'daemon-bundle', 'index.js'),
      // Development fallback (tsc output)
      path.join(projectRoot, 'dist', 'daemon', 'daemon', 'index.js'),
      path.join(projectRoot, 'dist', 'daemon', 'index.js'),
    ];
    console.log(`[launcher] Daemon script candidates:`, candidates);
    console.log(`[launcher] Exists:`, candidates.map(c => fs.existsSync(c)));
    const daemonScript = candidates.find(c => fs.existsSync(c));
    if (!daemonScript) {
      reject(new Error(`Daemon script not found in: ${candidates.join(', ')}. Run 'npm run build:daemon' first.`));
      return;
    }

    const nodePath = findNodePath();
    const isElectron = nodePath === process.execPath && !nodePath.toLowerCase().includes('node.exe');

    console.log(`[launcher] Spawning daemon: ${nodePath} ${daemonScript}`);

    const env: Record<string, string | undefined> = { ...process.env };
    if (isElectron) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    // Clear Electron-specific vars that interfere with plain Node
    delete env.ELECTRON_NO_ASAR;

    const child = spawn(nodePath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env,
    });

    child.unref();

    if (!child.pid) {
      reject(new Error('Failed to spawn daemon — no PID'));
      return;
    }

    console.log(`[launcher] Daemon spawned with PID: ${child.pid}`);

    // Wait for daemon to be ready.
    // Only ping once the daemon-pipe file exists — this means the daemon has
    // finished starting its pipe server and written the actual pipe name.
    // Without this guard, early polls connect to a zombie Windows named pipe
    // left by a crashed predecessor, wasting time on 1s timeouts.
    let attempts = 0;
    const maxAttempts = 75; // 75 * 200ms = 15 seconds
    let pinging = false; // prevent concurrent pings

    const poll = setInterval(async () => {
      attempts++;
      if (pinging) return; // previous ping still in-flight

      const wmuxDir = getWmuxDir();
      const pipeName = readPipeNameFromFile(wmuxDir);

      // Wait for daemon to write its pipe name file before attempting ping
      if (!pipeName) {
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error('Daemon spawned but pipe name file not created after 15 seconds'));
        }
        return;
      }

      const token = readDaemonAuthToken();
      if (!token) {
        if (attempts >= maxAttempts) {
          clearInterval(poll);
          reject(new Error('Daemon spawned but auth token not found after 15 seconds'));
        }
        return;
      }

      pinging = true;
      const alive = await pingDaemon(pipeName, token, 2000);
      pinging = false;

      if (alive) {
        clearInterval(poll);
        resolve(child.pid!);
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(poll);
        reject(new Error('Daemon spawned but not responding after 15 seconds'));
      }
    }, 200);
  });
}

function readPipeNameFromFile(wmuxDir: string): string | null {
  try {
    return fs.readFileSync(path.join(wmuxDir, 'daemon-pipe'), 'utf-8').trim();
  } catch {
    return null;
  }
}

export async function ensureDaemon(): Promise<DaemonInfo> {
  const wmuxDir = getWmuxDir();
  const pidFile = path.join(wmuxDir, 'daemon.pid');

  // 1. Check PID file
  let existingPid: number | null = null;
  try {
    const pidStr = fs.readFileSync(pidFile, 'utf8').trim();
    existingPid = parseInt(pidStr, 10);
  } catch {}

  // 2. If PID exists and process alive, try to ping
  if (existingPid && isProcessAlive(existingPid)) {
    const token = readDaemonAuthToken();
    const pipeName = readPipeNameFromFile(wmuxDir) || getDaemonPipeName();

    if (token) {
      const alive = await pingDaemon(pipeName, token);
      if (alive) {
        console.log(`[launcher] Daemon already running (PID: ${existingPid})`);
        return { pid: existingPid, authToken: token, pipeName, spawned: false };
      }
    }

    // PID is alive but we cannot talk to it: either the auth token is
    // missing or the daemon's event loop is wedged (the `DaemonRespawnController`
    // health-probe path lands here after `client.disconnectSync()`).
    //
    // Without terminating it first, the "clean stale files + spawn"
    // branch below would leave the original daemon process running,
    // still holding every PTY child it owns, while a second daemon
    // spawns and races for the same lock/pipe state.
    //
    // BUT — after a crash, daemon.pid may be stale and the OS may have
    // reused that PID for an unrelated user process (Chrome, an IDE,
    // an unrelated Electron app). Sending SIGKILL blindly would take
    // out whatever now owns the recycled PID. Verify the process image
    // matches the wmux executable before killing. wmux daemons always
    // run via `process.execPath` (Electron in dev, the packaged exe in
    // prod with `ELECTRON_RUN_AS_NODE=1`), so the image basename of a
    // genuine daemon equals `path.basename(process.execPath)`. If it
    // doesn't match, treat the PID as a stale-reuse victim and skip
    // the kill — the launcher still cleans the stale files below and
    // spawns a fresh daemon, so the user-visible recovery is unchanged.
    //
    // (Codex review #2 found the original issue #54 fix would PID-reuse-kill
    // unrelated processes; this image+cmdline check is the safety net.)
    //
    // Three gates, all required, in increasing cost order:
    //   1. NOT process.pid — never kill ourselves. In dev mode the main
    //      process and daemon both run via electron.exe, so the basename
    //      check below cannot distinguish them. Codex review #3 finding.
    //   2. Image basename matches `process.execPath` — wmux daemons spawn
    //      via the same exe (`ELECTRON_RUN_AS_NODE=1` in prod, plain
    //      Electron in dev) so a genuine daemon shares the basename.
    //   3. Command line contains the daemon script path — narrows the
    //      surviving false-positive (another Electron app on the same
    //      basename) to near-zero. Daemons are spawned with the
    //      `daemon-bundle/index.js` (or fallback) path as argv[1].
    //
    // If any gate fails, treat as a stale-reuse victim and skip the kill;
    // the cleanup + spawn path below still produces a working daemon.
    const isSelf = existingPid === process.pid;
    const imageName = getProcessImageName(existingPid);
    const expectedImage = path.basename(process.execPath);
    const imageMatches = !!imageName &&
      imageName.toLowerCase() === expectedImage.toLowerCase();
    let cmdlineMatches = false;
    let cmdline: string | null = null;
    if (!isSelf && imageMatches) {
      cmdline = getProcessCommandLine(existingPid);
      // Recognize either the production bundle path or any of the dev
      // tsc-output paths the launcher would spawn from. A precise
      // substring match keeps us from false-positive-ing on unrelated
      // Electron apps that happen to share the basename.
      const daemonMarkers = ['daemon-bundle', 'daemon/daemon/index.js', 'daemon\\daemon\\index.js'];
      cmdlineMatches = !!cmdline && daemonMarkers.some((m) => cmdline!.includes(m));
    }
    if (!isSelf && imageMatches && cmdlineMatches) {
      console.warn(
        `[launcher] PID ${existingPid} verified wmux daemon (image="${imageName}", cmdline matched) but unresponsive — terminating before respawn`,
      );
      try {
        process.kill(existingPid, 'SIGKILL');
      } catch (err: unknown) {
        // ESRCH = process died between isProcessAlive and kill. That's
        // the benign race — we wanted it gone and it is.
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ESRCH') {
          console.warn(`[launcher] failed to terminate PID ${existingPid}:`, err);
        }
      }
      // Brief settle so the named-pipe handle on the dying daemon's side
      // releases before spawnDaemon's first `createServer` listen attempt.
      await new Promise((resolve) => setTimeout(resolve, 200));
    } else {
      const why = isSelf
        ? `equals current main process pid`
        : !imageMatches
          ? `image "${imageName ?? 'unknown'}" != "${expectedImage}"`
          : `cmdline does not reference daemon script`;
      console.warn(
        `[launcher] PID ${existingPid} alive but NOT verified as wmux daemon (${why}) — assuming stale-PID reuse, NOT killing`,
      );
      // Fall through to the stale-files + spawn path. The actual
      // wmux daemon that wrote daemon.pid is gone; the live PID is
      // either ourselves, another app, or an Electron sibling — must
      // not be touched.
    }
  }

  // 3. Clean stale files before spawning — prevents new daemon from seeing
  //    zombie lock/pipe state left by a crashed predecessor.
  console.log('[launcher] No running daemon found. Cleaning stale files...');
  const staleFiles = ['daemon.lock', 'daemon.pid', 'daemon-pipe'];
  for (const name of staleFiles) {
    try { fs.unlinkSync(path.join(wmuxDir, name)); } catch { /* ignore */ }
  }

  const pid = await spawnDaemon();

  // Read connection info after spawn
  const token = readDaemonAuthToken();
  const pipeName = readPipeNameFromFile(wmuxDir) || getDaemonPipeName();

  if (!token) {
    throw new Error('Daemon spawned but auth token not found');
  }

  return { pid, authToken: token, pipeName, spawned: true };
}
