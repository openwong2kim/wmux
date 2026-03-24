import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getWmuxDir } from '../../daemon/config';
import { getDaemonPipeName, readDaemonAuthToken } from '../DaemonClient';

interface DaemonInfo {
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
  // Try system node first
  if (process.platform === 'win32') {
    const candidates = [
      `${process.env.ProgramFiles}\\nodejs\\node.exe`,
      `${process.env.LOCALAPPDATA}\\Programs\\node\\node.exe`,
      `${process.env.ProgramFiles}\\fnm\\node.exe`,
    ];
    for (const c of candidates) {
      try { if (c && fs.existsSync(c)) return c; } catch {}
    }
  }
  // Fallback to Electron's bundled node (with ELECTRON_RUN_AS_NODE)
  return process.execPath;
}

function spawnDaemon(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Find daemon script — use app.getAppPath() which gives the real project root
    const projectRoot = app.getAppPath();
    console.log(`[launcher] projectRoot = ${projectRoot}`);

    const candidates = [
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
      env,
    });

    child.unref();

    if (!child.pid) {
      reject(new Error('Failed to spawn daemon — no PID'));
      return;
    }

    console.log(`[launcher] Daemon spawned with PID: ${child.pid}`);

    // Wait for daemon to be ready
    let attempts = 0;
    const maxAttempts = 30; // 30 * 200ms = 6 seconds

    const poll = setInterval(async () => {
      attempts++;

      // Read pipe name and auth token from files
      const wmuxDir = getWmuxDir();
      const pipeName = readPipeNameFromFile(wmuxDir) || getDaemonPipeName();
      const token = readDaemonAuthToken();

      if (token) {
        const alive = await pingDaemon(pipeName, token, 1000);
        if (alive) {
          clearInterval(poll);
          resolve(child.pid!);
          return;
        }
      }

      if (attempts >= maxAttempts) {
        clearInterval(poll);
        reject(new Error('Daemon spawned but not responding after 6 seconds'));
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
  }

  // 3. Spawn new daemon
  console.log('[launcher] No running daemon found. Spawning...');
  const pid = await spawnDaemon();

  // Read connection info after spawn
  const token = readDaemonAuthToken();
  const pipeName = readPipeNameFromFile(wmuxDir) || getDaemonPipeName();

  if (!token) {
    throw new Error('Daemon spawned but auth token not found');
  }

  return { pid, authToken: token, pipeName, spawned: true };
}
