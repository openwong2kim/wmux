// ─── Whether a screen reader is running ─────────────────────────────────────
//
// wmux changes behaviour for screen-reader users only (xterm's screen-reader
// mode, agents' own screen-reader output, spoken agent state), so the signal
// must not fire for anyone else. Chromium's accessibility support
// (app.accessibilitySupportEnabled) is not enough on its own: any program that
// reads the accessibility tree turns it on (window managers, writing tools,
// wmux's own computer-use helper), and it stays on after the screen reader
// quits. So a screen reader counts as on only while Chromium's support is on
// AND a known screen-reader process runs. The process list is read when the
// support turns on and every few seconds while it stays on, never otherwise.
//
// Pure apart from the injected dependencies; screenReaderService.ts wires it
// to Electron.

import { execFile } from 'child_process';
import path from 'path';

/** Process names of the screen readers wmux recognizes, per platform. The
 *  Windows names are unverified on a Windows machine so far. */
export const SCREEN_READER_PROCESSES: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['VoiceOver'],
  win32: ['nvda.exe', 'jfw.exe', 'Narrator.exe'],
  linux: ['orca'],
};

/** How often the process list is read while Chromium's support is on. */
export const SCREEN_READER_POLL_MS = 5_000;

/** Windows, while no screen reader is found: each read spawns tasklist.exe,
 *  which is not cheap (daemon/ProcessMonitor.ts), and support that another
 *  program turned on can stay on all session. */
export const SCREEN_READER_IDLE_POLL_MS_WIN32 = 30_000;

/** Whether `running` (process names) includes a screen reader of `platform`.
 *  Windows names compare without case. */
export function includesScreenReader(platform: NodeJS.Platform, running: readonly string[]): boolean {
  const known = SCREEN_READER_PROCESSES[platform] ?? [];
  if (platform === 'win32') {
    const names = new Set(running.map((n) => n.toLowerCase()));
    return known.some((k) => names.has(k.toLowerCase()));
  }
  const names = new Set(running);
  return known.some((k) => names.has(k));
}

/** Process names from `ps -axco comm=` (macOS), `ps -eo comm=` (Linux) or
 *  `tasklist /FO CSV /NH` (Windows). */
export function parseProcessNames(platform: NodeJS.Platform, output: string): string[] {
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (platform !== 'win32') return lines;
  return lines.map((l) => /^"([^"]*)"/.exec(l)?.[1] ?? '').filter(Boolean);
}

/** The running processes' names; null when they cannot be read. tasklist by
 *  its System32 path: Windows looks in the current folder first for a bare
 *  name. */
export function listProcessNames(platform: NodeJS.Platform): Promise<string[] | null> {
  const [cmd, args] = platform === 'win32'
    ? [path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FO', 'CSV', '/NH']]
    : platform === 'darwin'
      ? ['ps', ['-axco', 'comm=']]
      : ['ps', ['-eo', 'comm=']];
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : parseProcessNames(platform, String(stdout)));
    });
  });
}

/** `WMUX_TEST_SCREEN_READER=1` reports a screen reader as on, for tests
 *  driving an isolated instance (a data suffix) only, never the real one. */
export function screenReaderForcedForTest(env: NodeJS.ProcessEnv, suffix: string): boolean {
  return env.WMUX_TEST_SCREEN_READER === '1' && suffix !== '';
}

export interface ScreenReaderMonitorDeps {
  platform: NodeJS.Platform;
  /** Chromium's accessibility support now. */
  accessibilitySupport: () => boolean;
  /** Registers for Chromium's support turning on or off. */
  onAccessibilitySupportChanged: (fn: (enabled: boolean) => void) => void;
  /** Null when the list cannot be read: the state stays as it was. */
  listProcesses: () => Promise<string[] | null>;
  /** Test-only: report a screen reader as on, whatever runs. */
  forceOn?: boolean;
  pollMs?: number;
  /** The interval while no screen reader is found; pollMs when absent. */
  idlePollMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

export interface ScreenReaderMonitor {
  start(): void;
  stop(): void;
  isOn(): boolean;
  /** Calls `fn` with the new state on every change. Returns the unsubscribe. */
  onChange(fn: (on: boolean) => void): () => void;
  /** Reads the state again now (tests, and the support-changed event). */
  refresh(): Promise<void>;
}

export function createScreenReaderMonitor(deps: ScreenReaderMonitorDeps): ScreenReaderMonitor {
  const setTimer = deps.setInterval ?? ((fn, ms) => {
    const t = setInterval(fn, ms);
    t.unref?.();
    return t;
  });
  const clearTimer = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const listeners = new Set<(on: boolean) => void>();
  let on = deps.forceOn === true;
  let timer: unknown = null;
  let timerMs = 0;
  let started = false;
  let generation = 0;

  const set = (next: boolean) => {
    if (next === on) return;
    on = next;
    for (const fn of [...listeners]) fn(on);
  };
  const stopPolling = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  // At the interval the current state asks for.
  const poll = () => {
    const ms = on ? deps.pollMs ?? SCREEN_READER_POLL_MS : deps.idlePollMs ?? deps.pollMs ?? SCREEN_READER_POLL_MS;
    if (timer !== null && timerMs === ms) return;
    stopPolling();
    timerMs = ms;
    timer = setTimer(() => { void refresh(); }, ms);
  };
  const refresh = async () => {
    if (deps.forceOn) return set(true);
    const run = ++generation;
    if (!deps.accessibilitySupport()) {
      stopPolling();
      return set(false);
    }
    if (started) poll();
    const names = await deps.listProcesses();
    // A newer read started meanwhile (the support changed): it decides.
    if (run !== generation) return;
    // One failed read is not a screen reader quitting: every pane would drop
    // its accessibility tree and build it again 5 s later.
    if (names === null) return;
    set(includesScreenReader(deps.platform, names));
    if (started) poll();
  };

  return {
    start() {
      if (started) return;
      started = true;
      deps.onAccessibilitySupportChanged(() => { if (started) void refresh(); });
      void refresh();
    },
    stop() {
      started = false;
      stopPolling();
    },
    isOn: () => on,
    onChange(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    refresh,
  };
}
