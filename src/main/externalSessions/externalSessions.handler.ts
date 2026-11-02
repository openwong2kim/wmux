// IPC for external sessions (shared/externalSessions.ts): agents running
// outside wmux, shown as status rows only. The daemon owns the rows; this
// relays its change events to the renderer, answers the renderer's list and
// forwards a hide.

import { ipcMain, type BrowserWindow } from 'electron';
import {
  EXTERNAL_SESSIONS_CHANGED_EVENT,
  EXTERNAL_SESSIONS_IPC,
  EXTERNAL_SESSIONS_RPC,
  type ExternalSession,
} from '../../shared/externalSessions';
import type { DaemonClient } from '../DaemonClient';
import { isAgentSlug } from '../../shared/agentIdentity';

const STATES = new Set(['running', 'needs-you', 'idle', 'ended']);
const ID_MAX = 256;
const OPTIONAL_TEXT = ['title', 'pendingQuestion', 'lastActivity'] as const;
const WHERE_TEXT = ['session', 'window', 'label', 'wslDistro'] as const;

/** Absent, or a string: the renderer reads these as text. */
function optionalText(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((k) => obj[k] === undefined || typeof obj[k] === 'string');
}

/** The daemon's rows, shape-checked before they cross into the renderer; a malformed row is dropped. */
export function parseExternalSessions(data: unknown): ExternalSession[] | null {
  if (!Array.isArray(data)) return null;
  return data.filter((row): row is ExternalSession => {
    if (!row || typeof row !== 'object') return false;
    const r = row as Record<string, unknown>;
    const where = r['where'] as Record<string, unknown> | null | undefined;
    // An agent this app does not know (a newer daemon) has no name to show.
    return typeof r['id'] === 'string' && isAgentSlug(r['agent']) && typeof r['agentSessionId'] === 'string'
      && typeof r['cwd'] === 'string' && typeof r['state'] === 'string' && STATES.has(r['state'])
      && typeof r['lastSignalAt'] === 'number' && typeof r['startedAt'] === 'number'
      && optionalText(r, OPTIONAL_TEXT)
      && !!where && typeof where === 'object' && typeof where['kind'] === 'string' && optionalText(where, WHERE_TEXT);
  });
}

export function registerExternalSessionsHandlers(
  daemonClient: DaemonClient | undefined,
  getWindow: () => BrowserWindow | null,
): () => void {
  const push = (sessions: ExternalSession[]): void => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send(EXTERNAL_SESSIONS_IPC.changed, sessions);
  };
  const list = async (): Promise<ExternalSession[]> => {
    if (!daemonClient?.isConnected) return [];
    try {
      return parseExternalSessions(await daemonClient.rpc(EXTERNAL_SESSIONS_RPC.list)) ?? [];
    } catch {
      // An older daemon answers Unknown method: it has no rows.
      return [];
    }
  };
  const onEvent = (ev: { type?: unknown; data?: unknown }): void => {
    if (ev?.type !== EXTERNAL_SESSIONS_CHANGED_EVENT) return;
    const sessions = parseExternalSessions(ev.data);
    if (sessions) push(sessions);
  };

  ipcMain.removeHandler(EXTERNAL_SESSIONS_IPC.list);
  ipcMain.handle(EXTERNAL_SESSIONS_IPC.list, () => list());
  ipcMain.removeHandler(EXTERNAL_SESSIONS_IPC.hide);
  ipcMain.handle(EXTERNAL_SESSIONS_IPC.hide, async (_event, id: unknown): Promise<void> => {
    if (typeof id !== 'string' || id.length === 0 || id.length > ID_MAX || !daemonClient?.isConnected) return;
    try {
      await daemonClient.rpc(EXTERNAL_SESSIONS_RPC.hide, { id });
    } catch {
      // The row stays; the next change event is the truth either way.
    }
  });

  if (daemonClient) {
    daemonClient.on('event', onEvent);
    // A reconnect (or a main restart over a living daemon) starts from the daemon's rows.
    void list().then(push);
  } else {
    // Only the daemon hears these hooks: without it no row is current.
    push([]);
  }

  return () => {
    ipcMain.removeHandler(EXTERNAL_SESSIONS_IPC.list);
    ipcMain.removeHandler(EXTERNAL_SESSIONS_IPC.hide);
    daemonClient?.removeListener('event', onEvent);
  };
}
