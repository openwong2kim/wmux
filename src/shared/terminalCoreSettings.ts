import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNotLiveWmuxDataDir, dataSuffix } from './constants';
import { writeJsonAtomic } from './settingsFile';
import { loadNativeTerminalCore } from './nativeTerminalCore';

export type TerminalEngine = 'node' | 'rust';
export interface TerminalCoreRuntime {
  requested: TerminalEngine;
  effective: TerminalEngine;
  rustAvailable: boolean;
  environmentOverride: boolean;
}
export interface TerminalCoreSettings {
  selected: TerminalEngine;
  runtime: TerminalCoreRuntime | null;
  rustAvailable: boolean;
  environmentOverride: boolean;
  restartRequired: boolean;
  host: 'daemon' | 'app';
  stopCommand: string;
}

export function terminalCoreSettingsPath(): string {
  assertNotLiveWmuxDataDir(os.homedir());
  return path.join(os.homedir(), `.wmux${dataSuffix()}`, 'terminal-core.json');
}

/** The engine when no valid choice is saved: Rust on Windows and macOS when
 * this build ships a loadable Rust module (it measured flatter memory and no
 * worse latency than Node there), Node on Linux. */
export function defaultTerminalEngine(
  platform: NodeJS.Platform = process.platform,
  rustAvailable: () => boolean = rustTerminalCoreAvailable,
): TerminalEngine {
  return (platform === 'win32' || platform === 'darwin') && rustAvailable() ? 'rust' : 'node';
}

export function readTerminalEngine(
  file = terminalCoreSettingsPath(),
  fallback: () => TerminalEngine = defaultTerminalEngine,
): TerminalEngine {
  let engine: unknown;
  try {
    engine = JSON.parse(fs.readFileSync(file, 'utf8'))?.engine;
  } catch {
    return fallback();
  }
  return engine === 'rust' || engine === 'node' ? engine : fallback();
}

export function writeTerminalEngine(engine: unknown, file = terminalCoreSettingsPath()): void {
  if (engine !== 'node' && engine !== 'rust') throw new Error('Invalid terminal engine');
  writeJsonAtomic(file, { engine });
}

let startupEngine: TerminalEngine | undefined;
/** Called at startup, after the instance suffix is set. Settings writes never
 * change a live host's PTY, buffer or snapshot backend. Environment flags keep
 * their explicit precedence and are not injected into child daemon launches. */
export function terminalCoreSelection(): TerminalEngine {
  // An override decides alone: forcing node must not load the native module
  // just to probe the default.
  const override = process.env.WMUX_TERMINAL_CORE;
  if (override !== undefined) return override === 'rust' ? 'rust' : 'node';
  return startupEngine ??= readTerminalEngine();
}

export function rustTerminalCoreAvailable(): boolean {
  try {
    loadNativeTerminalCore('pty-v1');
    return true;
  } catch {
    return false;
  }
}

export function terminalCoreRuntime(): TerminalCoreRuntime {
  const requested = terminalCoreSelection();
  const rustAvailable = rustTerminalCoreAvailable();
  return {
    requested,
    effective: requested === 'rust' && rustAvailable ? 'rust' : 'node',
    rustAvailable,
    environmentOverride: process.env.WMUX_TERMINAL_CORE !== undefined,
  };
}

/** Scope the manual stop to this instance, including an explicitly empty suffix. */
export function terminalCoreStopCommand(): string {
  const suffix = dataSuffix();
  return process.platform === 'win32'
    ? `$env:WMUX_DATA_SUFFIX='${suffix.replace(/'/g, "''")}'; wmux daemon stop`
    : `WMUX_DATA_SUFFIX='${suffix.replace(/'/g, "'\"'\"'")}' wmux daemon stop`;
}
