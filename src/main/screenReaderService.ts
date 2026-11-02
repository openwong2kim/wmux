// The screen-reader monitor (screenReader.ts) wired to Electron: Chromium's
// accessibility support, its change event, the signals that an assistive
// client is at work, and every window told of a change.

import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import { dataSuffix } from '../shared/constants';
import { isOlderVersion, parseAgentVersion } from '../shared/agentSetup';
import { SCREEN_READER_IPC } from '../shared/screenReader';
import { isWslShell } from '../shared/wsl';
import { createScreenReaderMonitor, listProcessNames, screenReaderForcedForTest, SCREEN_READER_IDLE_POLL_MS_WIN32 } from './screenReader';
import { claudeInstalls } from './claude/resolveClaudeExecutable';
import { probeClaudeExecutable } from './factory/claudeProbe';

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

/** The oldest claude `x.y.z` among every install a pane's shell might run
 *  (claudeInstalls), read in the background, so a launch never waits on it:
 *  null until a read answers, when no claude is found, and when any install's
 *  version cannot be read. The probe caches by path and mtime, so a read
 *  again is a stat. `exes` are the installs it read, and `stamp` their mtimes
 *  as it began. */
let claudeVersion: { version: string; exes: string[]; stamp: string } | null = null;
let reading: Promise<void> | null = null;

/** The installs' paths and mtimes, compared to tell an unchanged set. */
function installStamp(exes: readonly string[]): string {
  return JSON.stringify(exes.map((exe) => {
    try {
      return [exe, fs.statSync(exe).mtimeMs];
    } catch {
      return [exe, null];
    }
  }));
}

function readClaudeVersion(): void {
  if (reading) return;
  reading = (async () => {
    const exes = await claudeInstalls();
    const stamp = installStamp(exes);
    const versions = await Promise.all(exes.map(async (exe) => {
      const r = await probeClaudeExecutable(exe);
      return r.ok ? parseAgentVersion(r.version) : null;
    }));
    const known = versions.filter((v): v is string => v !== null);
    claudeVersion = known.length > 0 && known.length === versions.length
      ? { version: known.reduce((oldest, v) => (isOlderVersion(v, oldest) ? v : oldest)), exes, stamp }
      : null;
  })().catch(() => { claudeVersion = null; }).finally(() => { reading = null; });
}

/** The launchers whose version wmux can read: claude's flag is the one with
 *  a minimum version (agentLaunchOptions.ts). Each answers its last read at
 *  once and reads again for the next launch. A read answers only while the
 *  installs it read are unchanged: one replaced since (an older claude
 *  reinstalled in its place) is unknown until the new read lands. */
const VERSION_READS = new Map<string, () => string | null>([
  ['claude', () => {
    readClaudeVersion();
    const last = claudeVersion;
    return last && installStamp(last.exes) === last.stamp ? last.version : null;
  }],
]);

/** The versions a launch line's screen-reader flag is checked against
 *  (screenReaderLaunch.ts), for a pane running `shell`: the oldest of the
 *  launcher's installs. A WSL pane runs the distro's own agent, a pane whose
 *  shell is not known may be one, and a launcher given by path may be another
 *  install, so theirs are unknown (no flag), as is any launcher wmux cannot
 *  read. Never waits. */
export function launcherVersionsIn(shell: string | null | undefined): (launcher: string, typed: string) => string | null {
  if (!shell || isWslShell(shell)) return () => null;
  return (launcher, typed) => (/[\\/]/.test(typed) ? null : VERSION_READS.get(launcher)?.() ?? null);
}

/** Starts watching (once the app is ready); every window hears a change. */
export function startScreenReaderMonitor(): void {
  monitor.onChange((on) => {
    console.log(`[screen-reader] ${on ? 'on' : 'off'}`);
    // Ready before the first launch a screen reader's user makes.
    if (on) readClaudeVersion();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(SCREEN_READER_IPC.changed, on);
    }
  });
  monitor.start();
  // A monitor that starts on (forced for a test) never reports a change.
  if (monitor.isOn()) readClaudeVersion();
}
