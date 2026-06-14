import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { platformChoice } from '../../shared/platform';
import { attachFlashFrameAutoClear } from './flashFrame';

// OS-aware window-icon extension. Mirrors tray.ts so the same generated asset
// set (icon.ico / icon.icns / icon.png) is used in both places.
const iconExt = platformChoice<string>({ win: 'ico', mac: 'icns', linux: 'png', default: 'png' });
const iconFile = `icon.${iconExt}`;

/**
 * Load the main renderer (Vite dev server in development, packaged HTML file
 * in production) into an existing BrowserWindow.
 *
 * Exposed as a standalone export so the first-launch path in `app.on('ready')`
 * controls WHEN navigation starts: since S-A Step 1 it fires in parallel with
 * `DaemonRespawnController.bootstrap()` (the renderer leg is the longer one,
 * so the daemon spawn hides behind it). History: dda4c0c originally deferred
 * this until after bootstrap because a renderer mounting in LOCAL mode
 * (pty-N ids) while the IPC handler swap to DAEMON mode happened mid-mount
 * sent LOCAL-prefix ids into the DAEMON handler, which silently dropped them
 * inside `DaemonClient.writeToSession` ("first keystroke doesn't register"
 * on cold installs). That race is closed structurally today: the renderer's
 * first `daemon.whenReady()` parks in the get-ready-state resolver queue
 * until the bootstrap settles, and paneGate keeps every `pty.create` path
 * shut until the startup reconcile completes — ordering is no longer the
 * defense.
 */
export function loadMainRenderer(mainWindow: BrowserWindow): void {
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

/**
 * Create the main BrowserWindow with all wmux-specific webPreferences,
 * security hardening, and event wiring.
 *
 * Pass `opts.deferLoad: true` to skip the renderer navigation. The caller
 * MUST then call `loadMainRenderer(window)` itself once its window wiring
 * (console relay, recovery hooks) is attached — see `loadMainRenderer` for
 * the load-timing rationale. The macOS `app.on('activate')` re-open path
 * leaves `deferLoad` unset because the daemon is already healthy by the
 * time activate fires.
 */
export function createWindow(opts: { deferLoad?: boolean } = {}): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'wmux',
    // Resolve via app.isPackaged (mirrors tray.ts) — not NODE_ENV, which isn't
    // reliably set and could send an unpackaged build to the packaged path.
    icon: app.isPackaged
      ? path.join(process.resourcesPath, iconFile)
      : path.join(__dirname, '../../assets', iconFile),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  if (!opts.deferLoad) {
    loadMainRenderer(mainWindow);
  }

  // CSP header — production only.
  // In development, Vite serves scripts from localhost with inline module loaders,
  // which are incompatible with strict CSP. We only enforce CSP in production builds.
  // 'unsafe-inline' in style-src is required because Tailwind CSS and xterm.js
  // inject inline styles at runtime; removing it breaks UI rendering.
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    const cspPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'self' https: http:";

    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [cspPolicy],
        },
      });
    });
  }

  // Harden webview security: strip preload, enforce contextIsolation
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences) => {
    delete webPreferences.preload;
    delete (webPreferences as Record<string, unknown>)['preloadURL'];
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    // Ensure web security (same-origin policy) is not accidentally disabled
    (webPreferences as Record<string, unknown>)['webSecurity'] = true;
  });

  // Block all navigations except dev server — prevents file drag opening in window
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)) return;
    event.preventDefault();
  });

  // Block all window.open() calls by default.
  // External URLs (http/https) are opened in the user's default browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // T6 Notification System Expansion — clear any active taskbar attention
  // flash when the user focuses the window. The renderer is therefore not
  // required to send a matching `flashFrame(false)` after the user reacts.
  attachFlashFrameAutoClear(mainWindow);

  return mainWindow;
}
