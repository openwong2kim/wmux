import { ipcMain } from 'electron';
import { IPC } from '../../../shared/constants';
import {
  readLabsSettings, ringCompressionInConfig, writeLabsSettings, type LabsSettings, type LabsStatus,
} from '../../../shared/labsSettings';
import { terminalCoreStopCommand } from '../../../shared/terminalCoreSettings';
import type { DaemonClient } from '../../DaemonClient';
import { wrapHandler } from '../wrapHandler';

export function registerLabsHandlers(daemonClient?: DaemonClient): () => void {
  const status = async (): Promise<LabsStatus> => {
    let running: LabsSettings | null = null;
    if (daemonClient) {
      try {
        const ping = await daemonClient.rpc('daemon.ping', { includeLabs: true }) as { labs?: LabsSettings };
        // Older daemons do not report it; never guess.
        running = ping.labs ?? null;
      } catch {
        running = null;
      }
    }
    const saved = readLabsSettings();
    return {
      saved, running,
      ringCompressionInConfig: ringCompressionInConfig(),
      restartRequired: running === null || saved.ringCompression !== running.ringCompression,
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
