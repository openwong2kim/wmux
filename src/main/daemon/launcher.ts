import * as path from 'path';
import { app, dialog } from 'electron';
import {
  classifyTasklistOutput,
  classifyKillOutcome,
  checkProcessLiveness,
  tryEscalatedReping,
  parseBootMarker,
  BOOT_WAIT_POLL_MS,
  waitOutRecoveringDaemon,
  recoverFromBlockedProbe,
  nextPollDelayMs,
  DAEMON_READY_HARD_CEILING_MS,
  pollDaemonReady,
  isDaemonPipeGone,
  ensureDaemon as ensureDaemonCore,
  killDaemonByPidFile,
  killVerifiedDaemonPid,
  type DaemonInfo,
  type DaemonLauncherDeps,
  type ProcessLiveness,
  type DaemonPingResult,
  type RecoveringWaitOutcome,
  type RecoveringWaitDeps,
  type DaemonReadinessPollOptions,
} from '../../shared/daemon/daemonLauncherCore';

// Re-exported so existing importers (main/index.ts, the launcher.*.test.ts
// suite) keep resolving everything from '../launcher' — the extraction for
// #1001 (headless `wmux daemon`) moved the shared spawn/readiness chain to
// src/shared/daemon/daemonLauncherCore.ts, which has zero import of
// `electron`, so src/cli/commands/daemon.ts can consume it directly without
// pulling in a runtime that doesn't exist outside the app. Only the two
// genuinely Electron-specific pieces stay here: the script-path resolution
// (below, using app.getAppPath()/process.resourcesPath) and the stale-PID
// recovery dialog.
export {
  classifyTasklistOutput,
  classifyKillOutcome,
  checkProcessLiveness,
  tryEscalatedReping,
  parseBootMarker,
  BOOT_WAIT_POLL_MS,
  waitOutRecoveringDaemon,
  recoverFromBlockedProbe,
  nextPollDelayMs,
  DAEMON_READY_HARD_CEILING_MS,
  pollDaemonReady,
  isDaemonPipeGone,
  killDaemonByPidFile,
  killVerifiedDaemonPid,
};
export type {
  DaemonInfo,
  ProcessLiveness,
  DaemonPingResult,
  RecoveringWaitOutcome,
  RecoveringWaitDeps,
  DaemonReadinessPollOptions,
};

/**
 * Ask the user whether to recover from an unverified-live daemon PID.
 * Returns `true` if the user accepts the stale-cleanup + spawn path,
 * `false` if they cancel (we re-throw).
 *
 * This dialog is ASYNCHRONOUS on purpose. It used to call
 * `dialog.showMessageBoxSync`, which blocks the entire Electron main-process
 * event loop for as long as the dialog stays open — freezing the pipe server,
 * the PTY relay, and all IPC. At fleet scale (many concurrent sessions) a
 * modal nobody has clicked yet reads as "the whole app just died". The async
 * `dialog.showMessageBox` keeps the main process live while the user decides,
 * so panes keep streaming behind the dialog.
 *
 * Dialog is suppressed (and the function resolves `false`) when:
 *  - `WMUX_NO_DIALOG=1` is set in the environment (test / headless runs)
 *  - the Electron `app` module is unavailable or not ready yet
 *
 * In those cases the caller falls back to the legacy throw so the
 * automation path is preserved exactly. `wmux daemon` (the CLI verb, #1001)
 * takes the same "refuse" branch unconditionally via its own deps — see
 * src/cli/commands/daemon.ts — rather than relying on this env var, since it
 * never has a window to put a dialog in regardless of how it's invoked.
 */
async function askUserToRecoverFromStalePid(opts: {
  reason: string;
  pid: number;
  pidFile: string;
}): Promise<boolean> {
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

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: 'wmux daemon recovery',
    message: 'Could not verify the existing daemon process.',
    detail,
    buttons: ['Clean up and start fresh', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  return response === 0;
}

/**
 * Candidate paths for the daemon entry script — production (extraResource),
 * production fallback (old layout), development (esbuild bundle),
 * development fallback (tsc output). Unchanged from the pre-#1001 launcher;
 * only relocated behind the `DaemonLauncherDeps` seam so the CLI can supply
 * its own resolution (src/cli/commands/daemon.ts) without touching Electron.
 */
function resolveDaemonScriptCandidates(): string[] {
  // In dev: app.getAppPath() = project root → dist/daemon/daemon/index.js
  // In production: extraResource → process.resourcesPath/daemon/daemon/index.js
  const projectRoot = app.getAppPath();
  const resourcesRoot = process.resourcesPath;
  console.log(`[launcher] projectRoot = ${projectRoot}, resourcesPath = ${resourcesRoot}`);
  return [
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
}

const electronDeps: DaemonLauncherDeps = {
  resolveDaemonScriptCandidates,
  resolveSpawnedByVersion: () => app.getVersion(),
  askUserToRecoverFromStalePid,
  isElectronHost: () => true,
};

/**
 * `ensureDaemon()` — same zero-argument signature every existing caller
 * (main/index.ts, DaemonRespawnController) already uses, now delegating to
 * the shared, Electron-free implementation bound with the real app's deps.
 */
export async function ensureDaemon(): Promise<DaemonInfo> {
  return ensureDaemonCore(electronDeps);
}
