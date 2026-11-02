import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import {
  readLabsSettings, ringCompressionInConfig, writeLabsSettings, type LabsSettings, type LabsStatus,
} from '../../../shared/labsSettings';
import {
  terminalCoreStopCommand, type TerminalCoreRuntime, type TerminalEngine,
} from '../../../shared/terminalCoreSettings';
import type { DaemonClient } from '../../DaemonClient';
import { wrapHandler } from '../wrapHandler';

export function registerLabsHandlers(daemonClient?: DaemonClient): () => void {
  const status = async (): Promise<LabsStatus> => {
    let running: LabsSettings | null = null;
    let engine: TerminalEngine | null = null;
    if (daemonClient) {
      try {
        const ping = await daemonClient.rpc('daemon.ping', { includeLabs: true, includeTerminalCore: true }) as {
          labs?: LabsSettings; terminalCore?: TerminalCoreRuntime;
        };
        // Older daemons do not report these; never guess.
        running = ping.labs ?? null;
        engine = ping.terminalCore?.effective ?? null;
      } catch {
        running = null;
      }
    }
    const saved = readLabsSettings();
    const inConfig = ringCompressionInConfig();
    // The next daemon compresses when either switch is on.
    const wanted = saved.ringCompression || inConfig;
    const applies = engine === null ? null : engine === 'node';
    return {
      saved, running,
      ringCompressionInConfig: inConfig,
      ringCompressionApplies: applies,
      // A Rust host ignores the switch, so a restart changes nothing. No daemon
      // answer (local mode, a ping failure, an older daemon): only an opt-in
      // can be waiting for a restart; an off switch never is.
      restartRequired: applies === false ? false : running === null ? wanted : wanted !== running.ringCompression,
      stopCommand: terminalCoreStopCommand(),
    };
  };
  ipcMain.removeHandler(IPC.LABS_SETTINGS_GET);
  ipcMain.removeHandler(IPC.LABS_SETTINGS_SET);
  ipcMain.handle(IPC.LABS_SETTINGS_GET, wrapHandler(IPC.LABS_SETTINGS_GET, status));
  ipcMain.handle(IPC.LABS_SETTINGS_SET, wrapHandler(IPC.LABS_SETTINGS_SET, async (_event, settings: LabsSettings) => {
    writeLabsSettings(settings);
    return status();
  }));
  return () => {
    ipcMain.removeHandler(IPC.LABS_SETTINGS_GET);
    ipcMain.removeHandler(IPC.LABS_SETTINGS_SET);
  };
}
