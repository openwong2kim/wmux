import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNotLiveWmuxDataDir, dataSuffix } from './constants';
import { loadNativeTerminalCore } from './nativeTerminalCore';

/** The terminal engine. Rust is the only one: the Node engine is removed. The
 *  type keeps 'node' because older daemons still report it (daemon.ping). */
export type TerminalEngine = 'node' | 'rust';

/** daemon.ping `terminalCore`. Additive only: `requested`, `effective`,
 *  `rustAvailable` and `environmentOverride` keep their meaning for readers of
 *  older daemons (scripts/prove-server-artifact.mjs, twenty-pane-stability,
 *  labs.handler). An older daemon has no `available`. */
export interface TerminalCoreRuntime {
  requested: TerminalEngine;
  effective: TerminalEngine;
  rustAvailable: boolean;
  environmentOverride: boolean;
  /** Whether the Rust module loads. Without it no terminal starts. */
  available?: boolean;
  /** Why it does not load, when it does not. */
  reason?: string;
}

/** Settings > Performance: read-only, what the terminal host runs. */
export interface TerminalCoreSettings {
  runtime: TerminalCoreRuntime | null;
  host: 'daemon' | 'app';
}

/** Where earlier versions saved the engine choice. Never written or deleted
 *  now: an older version installed again still finds the choice it saved. */
export function terminalCoreSettingsPath(): string {
  assertNotLiveWmuxDataDir(os.homedir());
  return path.join(os.homedir(), `.wmux${dataSuffix()}`, 'terminal-core.json');
}

/** The engine choices that no longer apply, for the one line logged at startup. */
export function ignoredEngineChoices(file = terminalCoreSettingsPath(), env = process.env): string[] {
  const ignored: string[] = [];
  if (env.WMUX_TERMINAL_CORE !== undefined) ignored.push(`WMUX_TERMINAL_CORE=${env.WMUX_TERMINAL_CORE}`);
  try {
    const engine: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))?.engine;
    if (engine === 'node') ignored.push(`${path.basename(file)} {"engine":"node"}`);
  } catch {
    // No saved choice, or an unreadable one: nothing to ignore.
  }
  return ignored;
}

/** Called at startup, after the instance suffix is set: logs, once, the
 *  engine choices that no longer apply. Always 'rust'. */
let startupLogged = false;
export function terminalCoreSelection(log?: (line: string) => void): TerminalEngine {
  if (!startupLogged && log) {
    startupLogged = true;
    const ignored = ignoredEngineChoices();
    if (ignored.length) log(`[terminal-core] the Node engine is removed; ignoring ${ignored.join(', ')} (the file is kept for an older version)`);
  }
  return 'rust';
}

/** Why the Rust module does not load, or null when it does. */
export function terminalCoreLoadError(): string | null {
  try {
    loadNativeTerminalCore('pty-v1');
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function rustTerminalCoreAvailable(): boolean {
  return terminalCoreLoadError() === null;
}

export function terminalCoreRuntime(): TerminalCoreRuntime {
  const reason = terminalCoreLoadError();
  return {
    requested: 'rust',
    // An older reader treats anything but 'rust' as a fallback; with no module
    // nothing runs at all, which `available` says.
    effective: 'rust',
    rustAvailable: reason === null,
    environmentOverride: false,
    available: reason === null,
    ...(reason === null ? {} : { reason }),
  };
}

/** Scope the manual stop to this instance, including an explicitly empty suffix. */
export function terminalCoreStopCommand(): string {
  const suffix = dataSuffix();
  return process.platform === 'win32'
    ? `$env:WMUX_DATA_SUFFIX='${suffix.replace(/'/g, "''")}'; wmux daemon stop`
    : `WMUX_DATA_SUFFIX='${suffix.replace(/'/g, "'\"'\"'")}' wmux daemon stop`;
}
