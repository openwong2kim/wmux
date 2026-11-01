// The screen-reader monitor (screenReader.ts) wired to Electron: Chromium's
// accessibility support, its change event, and every window told of a change.

import { app, BrowserWindow } from 'electron';
import { dataSuffix } from '../shared/constants';
import { parseAgentVersion } from '../shared/agentSetup';
import { SCREEN_READER_IPC } from '../shared/screenReader';
import { isWslShell } from '../shared/wsl';
import { createScreenReaderMonitor, listProcessNames, screenReaderForcedForTest, SCREEN_READER_IDLE_POLL_MS_WIN32 } from './screenReader';
import { resolveClaudeExecutable } from './claude/resolveClaudeExecutable';
import { probeClaudeExecutable } from './factory/claudeProbe';

const monitor = createScreenReaderMonitor({
  platform: process.platform,
  accessibilitySupport: () => app.accessibilitySupportEnabled,
  onAccessibilitySupportChanged: (fn) => { app.on('accessibility-support-changed', (_event, enabled) => fn(enabled)); },
  listProcesses: () => listProcessNames(process.platform),
  forceOn: screenReaderForcedForTest(process.env, dataSuffix()),
  ...(process.platform === 'win32' ? { idlePollMs: SCREEN_READER_IDLE_POLL_MS_WIN32 } : {}),
});

/** Whether a screen reader is on (screenReader.ts). */
export function isScreenReaderOn(): boolean {
  return monitor.isOn();
}

/** claude's `x.y.z`, read in the background, so a launch never waits on it:
 *  null until a read answers, and when claude does not run. The probe caches
 *  by path and mtime, so a read again is a stat. */
let claudeVersion: string | null = null;

function readClaudeVersion(): void {
  const exe = resolveClaudeExecutable();
  if (!exe) {
    claudeVersion = null;
    return;
  }
  void probeClaudeExecutable(exe).then((r) => { claudeVersion = r.ok ? parseAgentVersion(r.version) : null; });
}

/** The launchers whose version wmux can read: claude's flag is the one with
 *  a minimum version (agentLaunchOptions.ts). Each answers its last read at
 *  once and reads again for the next launch. */
const VERSION_READS = new Map<string, () => string | null>([
  ['claude', () => {
    readClaudeVersion();
    return claudeVersion;
  }],
]);

/** The versions a launch line's screen-reader flag is checked against
 *  (screenReaderLaunch.ts), for a pane running `shell`: the launcher's on
 *  main's PATH. A WSL pane runs the distro's own agent and a launcher given
 *  by path may be another install, so theirs are unknown (no flag), as is any
 *  launcher wmux cannot read. Never waits. */
export function launcherVersionsIn(shell: string | null | undefined): (launcher: string, typed: string) => string | null {
  if (isWslShell(shell ?? undefined)) return () => null;
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
}
