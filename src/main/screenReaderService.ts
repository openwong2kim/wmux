// The screen-reader monitor (screenReader.ts) wired to Electron: Chromium's
// accessibility support, its change event, and every window told of a change.

import { app, BrowserWindow } from 'electron';
import { dataSuffix } from '../shared/constants';
import { SCREEN_READER_IPC } from '../shared/screenReader';
import { createScreenReaderMonitor, listProcessNames, screenReaderForcedForTest } from './screenReader';

const monitor = createScreenReaderMonitor({
  platform: process.platform,
  accessibilitySupport: () => app.accessibilitySupportEnabled,
  onAccessibilitySupportChanged: (fn) => { app.on('accessibility-support-changed', (_event, enabled) => fn(enabled)); },
  listProcesses: () => listProcessNames(process.platform),
  forceOn: screenReaderForcedForTest(process.env, dataSuffix()),
});

/** Whether a screen reader is on (screenReader.ts). */
export function isScreenReaderOn(): boolean {
  return monitor.isOn();
}

/** Calls `fn` on every change. Returns the unsubscribe. */
export function onScreenReaderChange(fn: (on: boolean) => void): () => void {
  return monitor.onChange(fn);
}

/** Starts watching (once the app is ready); every window hears a change. */
export function startScreenReaderMonitor(): void {
  monitor.onChange((on) => {
    console.log(`[screen-reader] ${on ? 'on' : 'off'}`);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(SCREEN_READER_IPC.changed, on);
    }
  });
  monitor.start();
}
