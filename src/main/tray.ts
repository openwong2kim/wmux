import { app, Tray, Menu, nativeImage, BrowserWindow, shell, dialog } from 'electron';
import fs from 'fs';
import path from 'path';
import { platformChoice } from '../shared/platform';

let tray: Tray | null = null;
// Retained so updateTraySessionCount() can rebuild the context menu (and so
// the tooltip nudge stays in sync) without the caller re-passing them.
let trayWindow: BrowserWindow | null = null;
let trayCallbacks: TrayCallbacks | null = null;

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

/**
 * Build the tray context menu. When `sessionCount` is a positive number we
 * insert a disabled info row above the quit items so a user who has quit-to-
 * tray can see, without opening the window, that the daemon is still holding
 * N live sessions (each potentially a heavyweight agent process). This is the
 * visibility half of the "don't auto-kill, make accumulation visible" fix —
 * the user stays in control and reaches for "Shut down" when they see the count.
 */
function buildContextMenu(
  mainWindow: BrowserWindow,
  callbacks: TrayCallbacks,
  sessionCount: number | null,
): Menu {
  const openOrReveal = async (file: string | null): Promise<void> => {
    if (!file) {
      dialog.showErrorBox('wmux', 'License file is missing from this build.');
      return;
    }
    const err = await shell.openPath(file);
    if (err) shell.showItemInFolder(file);
  };

  const template: Electron.MenuItemConstructorOptions[] = [
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
  ];

  if (typeof sessionCount === 'number' && sessionCount > 0) {
    template.push({
      label: `${sessionCount} background session${sessionCount === 1 ? '' : 's'} running`,
      enabled: false,
    });
  }

  template.push(
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
  );

  return Menu.buildFromTemplate(template);
}

/**
 * Update the tray to reflect how many live sessions the daemon is holding.
 * Pass the count when hiding to tray (the accumulation blind spot) and `null`
 * when the window is shown (the panes are visible, so no nudge needed). Safe
 * no-op before the tray exists. Best-effort cosmetic surface — never throws.
 */
export function updateTraySessionCount(sessionCount: number | null): void {
  if (!tray || !trayWindow || !trayCallbacks) return;
  tray.setToolTip(
    typeof sessionCount === 'number' && sessionCount > 0
      ? `wmux — ${sessionCount} background session${sessionCount === 1 ? '' : 's'} running`
      : 'wmux',
  );
  tray.setContextMenu(buildContextMenu(trayWindow, trayCallbacks, sessionCount));
}

export function createTray(mainWindow: BrowserWindow, callbacks: TrayCallbacks): Tray {
  // In packaged app, extraResource files land in <exe_dir>/resources/
  // In dev, assets are at project root: <__dirname>/../../assets/
  //
  // OS-aware extension: Windows -> .ico, macOS -> .icns, Linux/other -> .png.
  // The actual non-Windows image files are produced by a separate asset pipeline
  // (Phase 1.1 generate-icon.js). If the resolved file is missing on a given
  // platform, Electron falls back to a default tray image rather than throwing.
  // macOS gets a dedicated menu bar asset instead of the app icon: trayTemplate.png
  // (22x22, with an @2x sibling Electron picks up automatically) is alpha-only, so
  // the OS paints it black on a light menu bar and white on a dark one. Reusing
  // icon.icns here — a 1024px art board with an opaque black plate — collapsed into
  // a black blob once downscaled (owner-reported 2026-07-20).
  const iconExt = platformChoice<string>({ win: 'ico', mac: 'icns', linux: 'png', default: 'png' });
  const isMac = process.platform === 'darwin';
  const iconFile = isMac ? 'trayTemplate.png' : `icon.${iconExt}`;
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, iconFile)
    : path.join(__dirname, '..', '..', 'assets', iconFile);

  const trayImage = nativeImage.createFromPath(iconPath);
  if (isMac) {
    trayImage.setTemplateImage(true);
  }
  tray = new Tray(trayImage);
  trayWindow = mainWindow;
  trayCallbacks = callbacks;
  tray.setToolTip('wmux');

  // License / About handlers — surface the MIT notice for wmux itself
  // and the bundled THIRD_PARTY_NOTICES so users (and downstream
  // distributors) can find the attribution that ships next to wmux.exe.
  // `shell.openPath` opens the file in the user's default text app;
  // failure (missing file in a stripped build, no associated app, etc.)
  // falls back to revealing the containing folder so the file is still
  // discoverable. (See buildContextMenu for the menu template.)
  tray.setContextMenu(buildContextMenu(mainWindow, callbacks, null));

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
  trayWindow = null;
  trayCallbacks = null;
}
