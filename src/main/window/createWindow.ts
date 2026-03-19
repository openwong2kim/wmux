import { BrowserWindow } from 'electron';
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

  // CSP header — production only (dev needs full access for Vite HMR)
  if (!MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
          ],
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

  // Block webview navigations to dangerous URL schemes
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const normalized = url.trim().toLowerCase();
    if (
      normalized.startsWith('javascript:') ||
      normalized.startsWith('vbscript:') ||
      normalized.startsWith('data:')
    ) {
      event.preventDefault();
    }
  });

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}
