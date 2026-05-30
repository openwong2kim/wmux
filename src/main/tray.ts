import { app, Tray, Menu, nativeImage, BrowserWindow, shell, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { platformChoice } from '../shared/platform';

let tray: Tray | null = null;

/**
 * Resolve a license-style file that ships in <exe>/resources/ when packaged
 * and lives at the repo root in dev. Returns null if the file is missing
 * (e.g. running the daemon-only build), so callers can no-op gracefully.
 */
function resolveResource(name: string): string | null {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(__dirname, '..', '..', name);
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Tray quit callbacks. wmux follows tmux-style persistence: the default
 * "Quit" only detaches the UI (the daemon keeps every PTY session running and
 * the next launch reattaches), while "Shut down completely" tears the daemon
 * and all sessions down.
 */
export interface TrayCallbacks {
  /** Default Quit — detach from the daemon; live sessions keep running. */
  onQuit: () => void;
  /** Full teardown — close every session and stop the daemon. */
  onShutdownAll: () => void;
}

export function createTray(mainWindow: BrowserWindow, callbacks: TrayCallbacks): Tray {
  // In packaged app, extraResource files land in <exe_dir>/resources/
  // In dev, assets are at project root: <__dirname>/../../assets/
  //
  // OS-aware extension: Windows -> .ico, macOS -> .icns, Linux/other -> .png.
  // The actual non-Windows image files are produced by a separate asset pipeline
  // (Phase 1.1 generate-icon.js). If the resolved file is missing on a given
  // platform, Electron falls back to a default tray image rather than throwing.
  const iconExt = platformChoice<string>({ win: 'ico', mac: 'icns', linux: 'png', default: 'png' });
  const iconFile = `icon.${iconExt}`;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, iconFile)
    : path.join(__dirname, '..', '..', 'assets', iconFile);

  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip('wmux');

  // License / About handlers — surface the MIT notice for wmux itself
  // and the bundled THIRD_PARTY_NOTICES so users (and downstream
  // distributors) can find the attribution that ships next to wmux.exe.
  // `shell.openPath` opens the file in the user's default text app;
  // failure (missing file in a stripped build, no associated app, etc.)
  // falls back to revealing the containing folder so the file is still
  // discoverable.
  const openOrReveal = async (file: string | null): Promise<void> => {
    if (!file) {
      dialog.showErrorBox('wmux', 'License file is missing from this build.');
      return;
    }
    const err = await shell.openPath(file);
    if (err) shell.showItemInFolder(file);
  };

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open wmux',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'About wmux',
      click: () => {
        app.showAboutPanel();
      },
    },
    {
      label: 'License (wmux)',
      click: () => void openOrReveal(resolveResource('LICENSE')),
    },
    {
      label: 'Third-party licenses',
      click: () => void openOrReveal(resolveResource('THIRD_PARTY_NOTICES')),
    },
    { type: 'separator' },
    {
      label: 'Quit (keep sessions running)',
      click: () => {
        callbacks.onQuit();
        app.quit();
      },
    },
    {
      label: 'Shut down wmux (close all sessions)',
      click: () => {
        callbacks.onShutdownAll();
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);

  tray.on('double-click', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  return tray;
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
