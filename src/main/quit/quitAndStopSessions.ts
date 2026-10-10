import { app, BrowserWindow, dialog } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import { killDaemonByPidFile } from '../daemon/launcher';
import { raceDaemonShutdown } from '../daemonShutdownRace';
import {
  buildQuitAndStopCopy,
  buildQuitAndStopNotice,
  readUiLocale,
  type QuitAndStopCopy,
  type QuitAndStopNoticeKind,
  type SessionCounts,
} from './quitAndStopCopy';

/**
 * "Quit and Stop Sessions" — the menu twin of the tray's "Shut down wmux
 * (close all sessions)".
 *
 * A plain Quit only detaches: the daemon keeps every terminal and agent
 * running and the next launch reattaches. This item asks first, then stops the
 * daemon with the same two steps before-quit's full-shutdown branch uses
 * (daemon.shutdown race, then the verified pid-kill backstop) and only then
 * flips main's full-shutdown flag and quits. The stop runs BEFORE app.quit()
 * because before-quit has already torn the app down by the time it learns the
 * outcome, so it can only exit; running it here means a failed stop can keep
 * the app open and say how to recover instead of quitting with the daemon
 * still alive.
 */
export interface QuitAndStopCallbacks {
  /** Same contract as `TrayCallbacks.onShutdownAll`: request the full teardown. */
  onShutdownAll: () => void;
  /** The live daemon client, or null in local mode / mid-respawn. */
  getDaemonClient: () => DaemonClient | null;
  /** True once before-quit has started (a plain Quit may already be running). */
  isQuitting: () => boolean;
  /** Stop the respawn loop, so the daemon this stops is not brought straight back. */
  prepareStop: () => void;
}

/** Same budget as before-quit's full-shutdown race (daemon-side guard is 10 s). */
const SHUTDOWN_TIMEOUT_MS = 8_000;
const COUNT_TIMEOUT_MS = 2_000;

/**
 * Count live sessions the way the tray's background-session nudge does
 * (attached or detached; dead and suspended tombstones hold no process), and
 * narrow to the ones running an agent: `liveAgent` is the daemon's process-
 * truth slug, and an exec unit is its own agent process for as long as it
 * lives. Null when the daemon
 * cannot be asked — the caller must not turn that into "0".
 */
export async function countLiveSessions(client: DaemonClient | null): Promise<SessionCounts | null> {
  if (!client?.isConnected) return null;
  try {
    // Short budget: a hung daemon must not hold the dialog back for the
    // default RPC timeout. A miss just drops the numbers from the copy.
    const rows = (await client.rpc('daemon.listSessions', {}, { timeoutMs: COUNT_TIMEOUT_MS })) as Array<{ state?: string; liveAgent?: string; exec?: { command: string } }>;
    if (!Array.isArray(rows)) return null;
    const live = rows.filter((s) => s.state === 'attached' || s.state === 'detached');
    return { sessions: live.length, agents: live.filter((s) => Boolean(s.exec) || (typeof s.liveAgent === 'string' && s.liveAgent)).length };
  } catch {
    return null;
  }
}

/**
 * Stop the daemon: graceful daemon.shutdown first, then the verified pid-kill.
 * True only when the daemon acked or is known gone — an unverifiable or failed
 * kill, or a PID that is not the daemon, all mean it may still be running.
 */
export async function stopDaemon(client: DaemonClient | null): Promise<boolean> {
  if (client?.isConnected) {
    const race = await raceDaemonShutdown(client, SHUTDOWN_TIMEOUT_MS);
    if (race.ok) return true;
    console.warn(`[Main] Quit and Stop Sessions: daemon.shutdown did not complete (${race.error}) — pid-kill backstop`);
  }
  const outcome = killDaemonByPidFile();
  console.warn(`[Main] Quit and Stop Sessions: pid-kill backstop → ${outcome}`);
  return outcome === 'killed' || outcome === 'dead';
}

export interface QuitAndStopDeps {
  countSessions: () => Promise<SessionCounts | null>;
  buildCopy: (counts: SessionCounts | null) => Promise<QuitAndStopCopy>;
  confirm: (copy: QuitAndStopCopy) => Promise<boolean>;
  isQuitting: () => boolean;
  stopDaemon: () => Promise<boolean>;
  showNotice: (kind: QuitAndStopNoticeKind) => Promise<void>;
  onShutdownAll: () => void;
  quit: () => void;
}

export type QuitAndStopResult = 'cancelled' | 'refused' | 'failed' | 'quit';

/** Ask; on yes stop the daemon, and quit only once it is stopped. */
export async function runQuitAndStopSessions(deps: QuitAndStopDeps): Promise<QuitAndStopResult> {
  // A plain Quit that is already past its first before-quit pass has chosen to
  // detach; it will not read the flag again. Say so rather than pretend.
  if (deps.isQuitting()) {
    await deps.showNotice('alreadyQuitting');
    return 'refused';
  }
  const counts = await deps.countSessions();
  const confirmed = await deps.confirm(await deps.buildCopy(counts));
  if (!confirmed) return 'cancelled';
  // The dialog may have sat open while the user pressed Cmd+Q.
  if (deps.isQuitting()) {
    await deps.showNotice('alreadyQuitting');
    return 'refused';
  }
  if (!(await deps.stopDaemon())) {
    await deps.showNotice('stopFailed');
    return 'failed';
  }
  // before-quit still runs its full-shutdown branch; against a daemon that is
  // already gone that is a no-op backstop.
  deps.onShutdownAll();
  deps.quit();
  return 'quit';
}

function focusedWindow(): BrowserWindow | null {
  const win = BrowserWindow.getFocusedWindow();
  return win && !win.isDestroyed() ? win : null;
}

async function confirmNatively(copy: QuitAndStopCopy): Promise<boolean> {
  const opts = {
    type: 'warning' as const,
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  };
  const win = focusedWindow();
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

async function showNoticeNatively(locale: string, kind: QuitAndStopNoticeKind): Promise<void> {
  const { message, detail } = await buildQuitAndStopNotice(locale, kind);
  if (process.env.WMUX_NO_DIALOG === '1') {
    console.warn(`[Main] Quit and Stop Sessions: ${message} ${detail}`);
    return;
  }
  if (kind === 'alreadyQuitting') {
    // Synchronous on purpose: it holds the plain Quit's teardown until the
    // user has read that the sessions are staying.
    dialog.showErrorBox(message, detail);
    return;
  }
  const opts = { type: 'error' as const, message, detail, noLink: true };
  const win = focusedWindow();
  if (win) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

let inFlight = false;

/**
 * Menu click handler. Once confirmed the request stays in flight until the
 * process exits: a second click must never reach app.quit() while the first
 * one's daemon stop is still running.
 */
export async function quitAndStopSessions(callbacks: QuitAndStopCallbacks): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  let result: QuitAndStopResult | 'error' = 'error';
  try {
    const locale = readUiLocale(app.getPath('userData'), app.getLocale());
    result = await runQuitAndStopSessions({
      countSessions: () => countLiveSessions(callbacks.getDaemonClient()),
      buildCopy: (counts) => buildQuitAndStopCopy(locale, counts),
      confirm: confirmNatively,
      isQuitting: callbacks.isQuitting,
      stopDaemon: () => {
        callbacks.prepareStop();
        return stopDaemon(callbacks.getDaemonClient());
      },
      showNotice: (kind) => showNoticeNatively(locale, kind),
      onShutdownAll: callbacks.onShutdownAll,
      quit: () => app.quit(),
    });
  } catch (err) {
    console.error('[Main] Quit and Stop Sessions failed:', err);
  } finally {
    if (result !== 'quit') inFlight = false;
  }
}

/** Test-only: release the in-flight latch. */
export function __resetQuitAndStopForTest(): void {
  inFlight = false;
}
