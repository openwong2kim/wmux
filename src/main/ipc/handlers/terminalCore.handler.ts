import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import {
  terminalCoreRuntime, type TerminalCoreRuntime, type TerminalCoreSettings,
} from '../../../shared/terminalCoreSettings';
import type { DaemonClient } from '../../DaemonClient';
import { wrapHandler } from '../wrapHandler';

/** Settings > Performance shows what the terminal host runs. Read-only: the
 *  Node engine is removed, so there is no choice to save. */
export function registerTerminalCoreHandlers(daemonClient?: DaemonClient): () => void {
  const status = async (): Promise<TerminalCoreSettings> => {
    // Main's own load only answers for main's own terminals (no daemon): in
    // daemon mode it would load the module into main for nothing.
    if (!daemonClient) return { runtime: terminalCoreRuntime(), host: 'app' };
    let runtime: TerminalCoreRuntime | null;
    try {
      const ping = await daemonClient.rpc('daemon.ping', { includeTerminalCore: true }) as {
        terminalCore?: TerminalCoreRuntime;
      };
      // Older daemons do not report their backend. Never guess from main's env.
      runtime = ping.terminalCore ?? null;
    } catch {
      runtime = null;
    }
    return { runtime, host: 'daemon' };
  };
  ipcMain.removeHandler(IPC.TERMINAL_CORE_SETTINGS_GET);
  ipcMain.handle(IPC.TERMINAL_CORE_SETTINGS_GET, wrapHandler(IPC.TERMINAL_CORE_SETTINGS_GET, status));
  return () => {
    ipcMain.removeHandler(IPC.TERMINAL_CORE_SETTINGS_GET);
  };
}
