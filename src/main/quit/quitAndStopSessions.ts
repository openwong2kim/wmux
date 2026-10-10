import { app, BrowserWindow, dialog } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import { buildQuitAndStopCopy, readUiLocale, type QuitAndStopCopy, type SessionCounts } from './quitAndStopCopy';

/**
 * "Quit and Stop Sessions" — the menu twin of the tray's "Shut down wmux
 * (close all sessions)".
 *
 * A plain Quit only detaches: the daemon keeps every terminal and agent
 * running and the next launch reattaches. This item asks first, then takes the
 * exact path the tray item takes — flip main's full-shutdown flag, then
 * `app.quit()` — so before-quit's teardown branch (daemon.shutdown race plus
 * the verified pid-kill backstop) stays the only code that stops the daemon.
 */
export interface QuitAndStopCallbacks {
  /** Same contract as `TrayCallbacks.onShutdownAll`: request the full teardown. */
  onShutdownAll: () => void;
  /** The live daemon client, or null in local mode / mid-respawn. */
  getDaemonClient: () => DaemonClient | null;
}

const COUNT_TIMEOUT_MS = 2_000;

/**
 * Count live sessions the way the tray's background-session nudge does
 * (attached or detached; dead and suspended tombstones hold no process), and
 * narrow to the ones the daemon reports a live agent in. Null when the daemon
 * cannot be asked — the caller must not turn that into "0".
 */
export async function countLiveSessions(client: DaemonClient | null): Promise<SessionCounts | null> {
  if (!client?.isConnected) return null;
  try {
    // Short budget: a hung daemon must not hold the dialog back for the
    // default RPC timeout. A miss just drops the numbers from the copy.
    const rows = (await client.rpc('daemon.listSessions', {}, { timeoutMs: COUNT_TIMEOUT_MS })) as Array<{ state?: string; liveAgent?: string }>;
    if (!Array.isArray(rows)) return null;
    const live = rows.filter((s) => s.state === 'attached' || s.state === 'detached');
    return { sessions: live.length, agents: live.filter((s) => typeof s.liveAgent === 'string' && s.liveAgent).length };
  } catch {
    return null;
  }
}

export interface QuitAndStopDeps {
  countSessions: () => Promise<SessionCounts | null>;
  buildCopy: (counts: SessionCounts | null) => Promise<QuitAndStopCopy>;
  confirm: (copy: QuitAndStopCopy) => Promise<boolean>;
  onShutdownAll: () => void;
  quit: () => void;
}

/** Ask, and on yes request the full teardown before quitting. Returns whether it quit. */
export async function runQuitAndStopSessions(deps: QuitAndStopDeps): Promise<boolean> {
  const counts = await deps.countSessions();
  const confirmed = await deps.confirm(await deps.buildCopy(counts));
  if (!confirmed) return false;
  // Order matters: before-quit reads the flag on its first pass.
  deps.onShutdownAll();
  deps.quit();
  return true;
}

async function confirmNatively(copy: QuitAndStopCopy): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow();
  const opts = {
    type: 'warning' as const,
    buttons: [copy.cancel, copy.confirm],
    defaultId: 0,
    cancelId: 0,
    message: copy.message,
    detail: copy.detail,
    noLink: true,
  };
  const r = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

let inFlight = false;

/** Menu click handler. A second click while the dialog is open is ignored. */
export async function quitAndStopSessions(callbacks: QuitAndStopCallbacks): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    await runQuitAndStopSessions({
      countSessions: () => countLiveSessions(callbacks.getDaemonClient()),
      buildCopy: (counts) => buildQuitAndStopCopy(readUiLocale(app.getPath('userData'), app.getLocale()), counts),
      confirm: confirmNatively,
      onShutdownAll: callbacks.onShutdownAll,
      quit: () => app.quit(),
    });
  } catch (err) {
    console.error('[Main] Quit and Stop Sessions failed:', err);
  } finally {
    inFlight = false;
  }
}
