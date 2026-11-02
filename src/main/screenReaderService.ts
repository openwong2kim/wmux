// The screen-reader monitor (screenReader.ts) wired to Electron: Chromium's
// accessibility support, its change event, the signals that an assistive
// client is at work, and every window told of a change.

import { app, BrowserWindow } from 'electron';
import { dataSuffix } from '../shared/constants';
import { SCREEN_READER_IPC } from '../shared/screenReader';
import { createScreenReaderMonitor, listProcessNames, screenReaderForcedForTest, SCREEN_READER_IDLE_POLL_MS_WIN32 } from './screenReader';

/** Sent to a window by an accessibility client asking for its tree. */
const WM_GETOBJECT = 0x003d;
/** The WM_GETOBJECT object ids of an MSAA/IA2 client (NVDA, JAWS) and of a
 *  UI Automation client (Narrator). Other ids (caret, IME, class-name
 *  queries) are not a screen reader asking for the tree. */
const OBJID_CLIENT = -4;
const UIA_ROOT_OBJECT_ID = -25;

/** Windows: calls `signal` when an assistive client may be at work, a wmux
 *  window asked for its accessibility tree or gaining focus. */
function onAccessibilitySignal(signal: () => void): void {
  // Out of the hooked window procedure: the monitor may read the flag or start
  // a process read, neither of which belongs inside WM_GETOBJECT handling.
  // A client can send many queries at once; they make one signal.
  let pending = false;
  const later = () => {
    if (pending) return;
    pending = true;
    setImmediate(() => { pending = false; signal(); });
  };
  app.on('browser-window-focus', later);
  // Electron notifies a hook and still handles the message itself, so
  // Chromium answers the client as before. A window holds one hook per
  // message; nothing else in wmux hooks WM_GETOBJECT.
  const hook = (win: BrowserWindow) => {
    if (win.isDestroyed()) return;
    win.hookWindowMessage(WM_GETOBJECT, (_wParam: Buffer, lParam: Buffer) => {
      // The object id is the low 32 bits of lParam, read as signed.
      const id = lParam.length >= 4 ? lParam.readInt32LE(0) : 0;
      if (id === OBJID_CLIENT || id === UIA_ROOT_OBJECT_ID) later();
    });
  };
  for (const win of BrowserWindow.getAllWindows()) hook(win);
  app.on('browser-window-created', (_event, win) => hook(win));
}

const monitor = createScreenReaderMonitor({
  platform: process.platform,
  accessibilitySupport: () => app.accessibilitySupportEnabled,
  onAccessibilitySupportChanged: (fn) => { app.on('accessibility-support-changed', (_event, enabled) => fn(enabled)); },
  listProcesses: () => listProcessNames(process.platform),
  forceOn: screenReaderForcedForTest(process.env, dataSuffix()),
  // Windows only: there the support can turn on with no event (screenReader.ts).
  ...(process.platform === 'win32' ? { idlePollMs: SCREEN_READER_IDLE_POLL_MS_WIN32, onAccessibilitySignal } : {}),
});

/** Whether a screen reader is on (screenReader.ts). */
export function isScreenReaderOn(): boolean {
  return monitor.isOn();
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
