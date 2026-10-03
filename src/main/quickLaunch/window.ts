// The floating quick-launch composer window.
//
// Window behaviour adapted from MonoCode (hardbeat920/monocode@6bd432ca,
// src-tauri/src/quick_composer.rs: build, show, place, toggle), MIT License,
// Copyright (c) 2026 Nick. MonoCode re-classes its window into a
// non-activating NSPanel by hand; Electron's `type: 'panel'` gives the same
// panel on macOS, so the composer takes keys while the app the person was in
// stays frontmost and wmux's main window is not brought forward.

import { BrowserWindow, screen } from 'electron';
import * as path from 'path';
import { normalizeDevServerUrl } from '../window/createWindow';
import { markAuxiliaryWindow } from '../window/auxiliaryWindows';

const WIDTH = 680;
const INITIAL_HEIGHT = 168;
const MAX_HEIGHT = 520;
/** Down from the top of the work area, like Spotlight. */
const TOP_FRACTION = 0.22;

let panel: BrowserWindow | null = null;
/**
 * main's own quitting flag. An update install quits through quitAndInstall,
 * which skips before-quit — the composer's hide-on-close would then cancel
 * the close the installer waits for, so it reads the same flag the main
 * window's close intercept does.
 */
let appQuitting: () => boolean = () => false;

export function setQuickLaunchQuitting(isQuitting: () => boolean): void {
  appQuitting = isQuitting;
}

export function quickLaunchWindow(): BrowserWindow | null {
  return panel && !panel.isDestroyed() ? panel : null;
}

function build(): BrowserWindow {
  const win = new BrowserWindow({
    width: WIDTH,
    height: INITIAL_HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    // macOS: a non-activating NSPanel. Other platforms ignore the value.
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    // Clear: the page's card is the only surface, so its rounded corners and
    // hairline are the window's edge in every theme.
    transparent: true,
    backgroundColor: '#00000000',
    title: 'wmux quick launch',
    // Its own preload exposes only the composer's calls, and the renderer is
    // sandboxed: this window can start agents, nothing else.
    webPreferences: {
      preload: path.join(__dirname, 'quickLaunchPreload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  markAuxiliaryWindow(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'floating');
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // Closing hides: the draft survives a dismiss, like Spotlight's query.
  win.on('close', (e) => {
    if (!appQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (panel === win) panel = null;
  });
  const devUrl = normalizeDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  if (devUrl) void win.loadURL(new URL('launcher.html', devUrl).toString());
  else void win.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/launcher.html`));
  return win;
}

/**
 * setBounds on a non-resizable window is ignored on some Windows and Linux
 * window managers, so the size is unlocked for the call and locked again.
 */
function setBoundsLocked(win: BrowserWindow, bounds: Electron.Rectangle): void {
  if (process.platform === 'darwin') {
    win.setBounds(bounds);
    return;
  }
  win.setResizable(true);
  win.setBounds(bounds);
  win.setResizable(false);
}

/** Centre horizontally on the display under the pointer, since that is where the person is. */
function place(win: BrowserWindow): void {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const [, height] = win.getSize();
  setBoundsLocked(win, {
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height * TOP_FRACTION),
    width: WIDTH,
    height,
  });
}

/**
 * Build the hidden panel ahead of the first press, so the page is mounted and
 * the first keystrokes after the shortcut land in the prompt instead of being
 * typed into a window that is still loading.
 */
export function prepareQuickLaunch(): void {
  if (!quickLaunchWindow()) panel = build();
}

export function showQuickLaunch(onShown: (win: BrowserWindow) => void): void {
  const win = quickLaunchWindow() ?? (panel = build());
  place(win);
  win.show();
  win.focus();
  onShown(win);
}

export function hideQuickLaunch(): void {
  quickLaunchWindow()?.hide();
}

/** The shortcut toggles: a second press dismisses. */
export function toggleQuickLaunch(onShown: (win: BrowserWindow) => void): void {
  const win = quickLaunchWindow();
  if (win?.isVisible()) win.hide();
  else showQuickLaunch(onShown);
}

/** Grow or shrink to the card, keeping the top edge where it is. */
export function fitQuickLaunch(height: number): void {
  const win = quickLaunchWindow();
  if (!win || !Number.isFinite(height)) return;
  const [x, y] = win.getPosition();
  setBoundsLocked(win, { x, y, width: WIDTH, height: Math.round(Math.min(Math.max(height, 80), MAX_HEIGHT)) });
}

export function destroyQuickLaunch(): void {
  quickLaunchWindow()?.destroy();
  panel = null;
}
