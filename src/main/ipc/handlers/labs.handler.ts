import { app, ipcMain } from 'electron';
import { readFile } from 'fs/promises';
import * as path from 'path';
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
    const inConfig = ringCompressionInConfig();
    // What the next daemon does: config.json when it sets the flag, else
    // labs.json (DaemonSessionManager.ringCompressionEnabled), on either engine.
    const wanted = inConfig ?? saved.ringCompression;
    return {
      saved, running,
      ringCompressionInConfig: inConfig,
      // Without a daemon answer (local mode, a ping failure) nothing says a
      // restart would change anything.
      restartRequired: running !== null && wanted !== running.ringCompression,
      stopCommand: terminalCoreStopCommand(),
    };
  };
  ipcMain.removeHandler(IPC.LABS_SETTINGS_GET);
  ipcMain.removeHandler(IPC.LABS_SETTINGS_SET);
  ipcMain.removeHandler(IPC.LABS_WONGTTY_WASM);
  // The experimental wongtty front end (uiSlice.terminalWongtty): the renderer
  // cannot fetch file:// URLs, so it gets both WebAssembly modules as bytes:
  // extra resources of a packaged app (forge.config.ts), node_modules in
  // development and e2e builds. Only asked for once the switch is on.
  ipcMain.handle(IPC.LABS_WONGTTY_WASM, wrapHandler(IPC.LABS_WONGTTY_WASM, async () => {
    // The e2e of the switch's failure path (development builds only): bytes
    // that are not WebAssembly, so the renderer's load fails.
    if (!app.isPackaged && process.env.WMUX_E2E_WONGTTY_WASM === 'broken') {
      console.log('[wmux:wongtty] wasm served (broken, WMUX_E2E_WONGTTY_WASM)');
      return { engine: Buffer.from('not wasm'), frontEnd: Buffer.from('not wasm') };
    }
    const dist = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'node_modules', 'wongtty', 'dist');
    const [engine, frontEnd] = await Promise.all([
      readFile(path.join(dist, 'wongtty.wasm')),
      readFile(path.join(dist, 'xterm_web_bg.wasm')),
    ]);
    console.log(`[wmux:wongtty] wasm served engine=${engine.length} frontEnd=${frontEnd.length}`);
    return { engine, frontEnd };
  }));
  ipcMain.handle(IPC.LABS_SETTINGS_GET, wrapHandler(IPC.LABS_SETTINGS_GET, status));
  ipcMain.handle(IPC.LABS_SETTINGS_SET, wrapHandler(IPC.LABS_SETTINGS_SET, async (_event, settings: LabsSettings) => {
    writeLabsSettings(settings);
    return status();
  }));
  return () => {
    ipcMain.removeHandler(IPC.LABS_SETTINGS_GET);
    ipcMain.removeHandler(IPC.LABS_SETTINGS_SET);
    ipcMain.removeHandler(IPC.LABS_WONGTTY_WASM);
  };
}
