import { BrowserWindow, shell } from 'electron';
import path from 'node:path';

export function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'wmux',
    icon: path.join(__dirname, '../../assets/icon.ico'),
    backgroundColor: '#1e1e2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
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

  return mainWindow;
}
