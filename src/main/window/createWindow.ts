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
/**
 * Normalize the Vite dev-server URL to the IPv4 loopback.
 *
 * electron-forge injects `MAIN_WINDOW_VITE_DEV_SERVER_URL` as
 * `http://localhost:5173/`, but the Vite server is pinned to `127.0.0.1` (see
 * `vite.renderer.config.ts`). On macOS `localhost` resolves to `::1` (IPv6)
 * first, so `loadURL('http://localhost:5173')` hits ERR_CONNECTION_REFUSED and
 * the window renders blank and flickers as Electron retries. Rewriting the
 * loopback host to `127.0.0.1` keeps the loaded URL on the same interface the
 * server actually listens on. Only `localhost` is rewritten (a `--host` override
 * or a real IP is left untouched). Returns the input unchanged in production
 * (undefined → the packaged `loadFile` path) or if the URL can't be parsed.
 */
export function normalizeDevServerUrl(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return url;
  }
}

export function loadMainRenderer(mainWindow: BrowserWindow): void {
  const devUrl = normalizeDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  if (devUrl) {
    mainWindow.loadURL(devUrl);
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
    // Bridge redesign chrome (DESIGN.md "Window Chrome"). The default-frame +
    // visible File/Edit menu strip was the #1 "web page in an OS window"
    // offender. The renderer draws a 36px custom titlebar (Titlebar.tsx);
    // the OS keeps drawing its own window controls:
    //   - Windows: titleBarOverlay → native, snap-layout-capable min/max/close
    //     drawn over the custom bar. Colors follow the theme via the
    //     window:setTitleBarOverlay IPC (registerHandlers.ts).
    //   - macOS: 'hidden' keeps the traffic lights, nudged to center in 36px.
    //   - Linux: keep the native frame (titleBarStyle is ignored there; a
    //     frameless window would lose drag/resize with no replacement).
    // The menu itself is NOT removed — autoHideMenuBar keeps every
    // accelerator working and Alt still reveals the menu on demand.
    autoHideMenuBar: true,
    ...platformChoice<Partial<Electron.BrowserWindowConstructorOptions>>({
      win: {
        titleBarStyle: 'hidden',
        // bgBase (not mantle): the overlay strip sits on the titlebar's right
        // half, which is bgBase — the renderer re-pushes the live theme's
        // value on boot/theme-change via window:setTitleBarOverlay anyway.
        titleBarOverlay: { color: '#151517', symbolColor: '#A5A29C', height: 36 },
      },
      mac: {
        titleBarStyle: 'hidden',
        trafficLightPosition: { x: 12, y: 11 },
      },
      default: {},
    }),
    // Matches the amber (default) theme's bgBase so the first paint doesn't
    // flash a foreign color behind the renderer (was catppuccin '#1e1e2e').
    backgroundColor: '#151517',
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

  // Block all navigations except dev server — prevents file drag opening in
  // window. Compare against the SAME normalized (127.0.0.1) URL the renderer was
  // loaded from, else the dev server's own HMR/router navigations would be
  // treated as external and blocked.
  const devUrl = normalizeDevServerUrl(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (devUrl && url.startsWith(devUrl)) return;
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
