import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { app, dialog } from 'electron';
import { getWmuxDir } from '../../daemon/config';
import { getDaemonPipeName, readDaemonAuthToken } from '../DaemonClient';

export interface DaemonInfo {
  pid: number;
  authToken: string;
  pipeName: string;
  spawned: boolean;
}

/**
 * Show a synchronous Electron dialog asking the user whether to recover
 * from an unverified-live daemon PID. Returns `true` if the user accepts
 * the stale-cleanup + spawn path, `false` if they cancel (we re-throw).
 *
 * Dialog is suppressed (and the function returns `false`) when:
 *  - `WMUX_NO_DIALOG=1` is set in the environment (test / headless runs)
 *  - the Electron `app` module is unavailable or not ready yet
 *
 * In those cases the caller falls back to the legacy throw so the
 * automation path is preserved exactly.
 */
function askUserToRecoverFromStalePid(opts: {
  reason: string;
  pid: number;
  pidFile: string;
}): boolean {
  if (process.env.WMUX_NO_DIALOG === '1') return false;
  // `app` may be undefined when launcher is exercised by unit tests
  // (vitest doesn't import the full Electron runtime).
  if (!app || typeof app.isReady !== 'function' || !app.isReady()) return false;

  const detail = [
    `wmux thinks a previous daemon at PID ${opts.pid} may still be alive,`,
    `but the OS will not confirm what process owns that PID.`,
    '',
    `Reason: ${opts.reason}`,
    '',
    'You can either:',
    `  • Let wmux clean up ${opts.pidFile} and start a fresh daemon.`,
    '  • Cancel — investigate manually first. To force-kill, run in an',
    `    elevated PowerShell:  taskkill /F /PID ${opts.pid}`,
  ].join('\n');

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'wmux daemon recovery',
    message: 'Could not verify the existing daemon process.',
    detail,
    buttons: ['Clean up and start fresh', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return choice === 0;
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
  // Linux: /proc/<pid>/comm carries the executable name (truncated to 15
  // bytes). Fast path because /proc reads are basically free.
  if (process.platform === 'linux') {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
    } catch { return null; }
  }
  // macOS / other POSIX without /proc: shell out to `ps`. The `comm=`
  // format spec strips the header and emits just the executable name.
  // (Codex review #5 — without this branch, Darwin lookups always
  // returned null and the launcher threw on every unresponsive daemon
  // instead of recovering.)
  try {
    const { execFileSync } = require('child_process');
    const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
      encoding: 'utf-8', timeout: 3000,
    });
    const trimmed = result.trim();
    if (!trimmed) return null;
    // `ps -o comm=` returns the full path on macOS; the basename
    // matches the expected wmux image more reliably across builds.
    return path.basename(trimmed);
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
  // Linux: /proc/<pid>/cmdline carries the argv joined by NUL.
  if (process.platform === 'linux') {
    try {
      const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return raw.replace(/\0/g, ' ').trim() || null;
    } catch { return null; }
  }
  // macOS / other POSIX without /proc: shell out to `ps`. (Codex
  // review #5 — Darwin builds need this path so the daemon verifier
  // can confirm cmdline carries the daemon-script path.)
  try {
    const { execFileSync } = require('child_process');
    const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf-8', timeout: 3000,
    });
    const trimmed = result.trim();
    return trimmed.length > 0 ? trimmed : null;
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
      // Two-shot ping: a freshly spawned daemon can briefly miss the ping
      // window while its event loop is busy on startup (recovery loop on
      // big sessions.json, Defender realtime scan on cold ASAR, ConPTY
      // cold-init). 250 ms between attempts is comfortably above observed
      // worst-case startup hiccups but well below the 15-second spawn
      // budget — so the retry doesn't push us into the verification
      // throw-or-kill branch for what is actually a transient stall.
      let alive = await pingDaemon(pipeName, token);
      if (!alive) {
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
        alive = await pingDaemon(pipeName, token);
      }
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
    // (Codex review #2/#3/#4 hardening sequence on the original issue
    // #54 fix.) Three categories the gate logic must distinguish:
    //
    //   (a) Verified-daemon → kill, then spawn. Safe because we know
    //       what we're killing.
    //   (b) Verified-stale-reuse (we are sure the PID is NOT our daemon
    //       anymore — it's ourselves, an unrelated program, or another
    //       Electron app whose cmdline doesn't carry the daemon script
    //       path) → don't kill, but the stale-files cleanup + spawn
    //       path below is safe because the actual daemon is gone.
    //   (c) Unverified-live (process is alive AND has the wmux image
    //       basename, but we couldn't read its image or command line at
    //       all) → refuse to act. Spawning over an unverified live
    //       daemon would orphan its PTYs and produce duplicate sessions.
    //       Throw so the respawn controller surfaces the failure via
    //       its budget + IPC, instead of silently corrupting state.
    const expectedImage = path.basename(process.execPath);
    // Markers must cover ALL the daemon-script candidate paths
    // spawnDaemon() picks from, in both `/` and `\\` form (Windows
    // command lines may carry either). Without the bare
    // `daemon/index.js` variant, a daemon spawned from the fallback
    // tsc-output layout would fail cmdline verification and the
    // launcher would silently spawn a second daemon over the live one.
    // (Codex review #5 finding.)
    const daemonScriptMarkers = [
      'daemon-bundle',
      'daemon/daemon/index.js',
      'daemon\\daemon\\index.js',
      'daemon/index.js',
      'daemon\\index.js',
    ];
    if (existingPid === process.pid) {
      // (b) PID file points back at ourselves — the real daemon must be
      // gone (the OS recycled its PID into us). Safe to clean + spawn.
      console.warn(
        `[launcher] daemon.pid=${existingPid} equals current process pid — stale, cleaning + spawning fresh`,
      );
    } else {
      const imageName = getProcessImageName(existingPid);
      if (imageName === null) {
        // (c) Could not even read the image — ask the user whether to
        // recover. Refusing outright used to leave the user stranded
        // when AV blocked tasklist.exe or PowerShell. The user keeps
        // ultimate authority (cancel re-throws the same error), but
        // the common case — yes, it really is a stale pid file — now
        // resolves without manual filesystem work.
        const recovered = askUserToRecoverFromStalePid({
          reason: `image lookup for PID ${existingPid} failed (anti-virus may be blocking tasklist.exe / ps / WMI)`,
          pid: existingPid,
          pidFile,
        });
        if (!recovered) {
          throw new Error(
            `[launcher] daemon.pid=${existingPid} alive but image lookup failed; refusing to spawn over an unverified live process. Manually delete ${pidFile} if you have verified the daemon is gone (or in elevated PowerShell: taskkill /F /PID ${existingPid}).`,
          );
        }
        console.warn(
          `[launcher] user approved cleanup of unverified PID ${existingPid} (image lookup failed)`,
        );
      } else if (imageName.toLowerCase() !== expectedImage.toLowerCase()) {
        // (b) Different program owns this PID now — daemon is gone.
        console.warn(
          `[launcher] PID ${existingPid} image "${imageName}" != "${expectedImage}" — stale-PID reuse by another program, cleaning + spawning fresh`,
        );
      } else {
        // Image matches — could be the real daemon or another Electron
        // app. Use the command line to decide.
        const cmdline = getProcessCommandLine(existingPid);
        if (cmdline === null) {
          // (c) Lookup failed — same recovery dance as the image
          // path: ask the user, treat cancel as the legacy throw.
          const recovered = askUserToRecoverFromStalePid({
            reason: `command-line lookup for PID ${existingPid} (image "${imageName}") failed (anti-virus may be blocking PowerShell / Get-CimInstance)`,
            pid: existingPid,
            pidFile,
          });
          if (!recovered) {
            throw new Error(
              `[launcher] daemon.pid=${existingPid} alive (image "${imageName}" matches wmux) but command-line lookup failed; refusing to spawn over an unverified live process. Manually delete ${pidFile} if you have verified the daemon is gone (or in elevated PowerShell: taskkill /F /PID ${existingPid}).`,
            );
          }
          console.warn(
            `[launcher] user approved cleanup of unverified PID ${existingPid} (cmdline lookup failed)`,
          );
        } else {
          const cmdlineMatches = daemonScriptMarkers.some((m) => cmdline.includes(m));
          if (!cmdlineMatches) {
            // (b) Same image but different app (e.g. another Electron
            // tool). Don't kill, but the cleanup path below is safe.
            console.warn(
              `[launcher] PID ${existingPid} image matches but cmdline does not reference daemon script — stale-PID reuse by sibling Electron app, cleaning + spawning fresh`,
            );
          } else {
            // (a) Verified wmux daemon → kill before respawning.
            console.warn(
              `[launcher] PID ${existingPid} verified wmux daemon (image+cmdline) but unresponsive — terminating before respawn`,
            );
            let killSucceeded = true;
            try {
              process.kill(existingPid, 'SIGKILL');
            } catch (err: unknown) {
              const code = (err as NodeJS.ErrnoException | undefined)?.code;
              if (code === 'ESRCH') {
                // ESRCH = process died between isProcessAlive and kill.
                // Benign race — we wanted it gone and it is.
              } else {
                // EPERM (Windows: Access Denied), EINVAL, anything else:
                // we asked the OS to kill the verified daemon and it
                // refused. taskkill /F travels the same TerminateProcess
                // path with the same user token, so we don't auto-retry —
                // we surface the failure with the exact command the user
                // needs to run in an elevated shell. RespawnController
                // catches the throw and burns a budget unit.
                killSucceeded = false;
                console.warn(`[launcher] failed to terminate PID ${existingPid}:`, err);
                throw new Error(
                  `[launcher] verified wmux daemon at PID ${existingPid} alive but SIGKILL failed (${code ?? 'unknown'}); refusing to spawn a second daemon. Run in an elevated PowerShell:  taskkill /F /PID ${existingPid}  — then retry.`,
                );
              }
            }
            if (killSucceeded) {
              // Brief settle so the named-pipe handle on the dying daemon's
              // side releases before spawnDaemon's first `createServer`
              // listen attempt.
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        }
      }
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

/**
 * Force-kill the daemon recorded in `daemon.pid` — but ONLY if the live
 * process at that PID verifiably still belongs to wmux (image basename +
 * cmdline carry the daemon script). This is the explicit-full-shutdown
 * backstop for main's before-quit: when the user picks "Shut down wmux
 * completely" and the graceful `daemon.shutdown` RPC times out, this
 * guarantees a wedged daemon can't survive the teardown the user explicitly
 * asked for.
 *
 * The PID-reuse guards mirror ensureDaemon()'s verify-before-kill logic so we
 * never SIGKILL an unrelated process that recycled the daemon's old PID. We
 * only abort the kill when a check returns a DEFINITIVE mismatch; an
 * indeterminate result (null image/cmdline, e.g. AV blocking tasklist) still
 * proceeds, because this path runs at most a few seconds after we were
 * actively talking to that PID, so reuse is near-impossible and leaving an
 * orphan is the worse outcome here.
 *
 * Best-effort: never throws. Returns true only when a verified daemon was
 * signalled.
 */
export function killDaemonByPidFile(): boolean {
  try {
    const wmuxDir = getWmuxDir();
    const pidStr = fs.readFileSync(path.join(wmuxDir, 'daemon.pid'), 'utf8').trim();
    const pid = parseInt(pidStr, 10);
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return false;
    if (!isProcessAlive(pid)) return false;

    const expectedImage = path.basename(process.execPath);
    const image = getProcessImageName(pid);
    if (image !== null && image.toLowerCase() !== expectedImage.toLowerCase()) {
      return false; // definitive: a different program owns this PID now
    }
    const cmdline = getProcessCommandLine(pid);
    const markers = [
      'daemon-bundle',
      'daemon/daemon/index.js',
      'daemon\\daemon\\index.js',
      'daemon/index.js',
      'daemon\\index.js',
    ];
    if (cmdline !== null && !markers.some((m) => cmdline.includes(m))) {
      return false; // definitive: same image but not our daemon script
    }

    process.kill(pid, 'SIGKILL');
    return true;
  } catch {
    return false;
  }
}
