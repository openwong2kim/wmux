import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { DaemonConfig } from './types';

/** ~/.wmux directory */
export function getWmuxDir(): string {
  return path.join(os.homedir(), '.wmux');
}

/** Path to daemon config file */
export function getConfigPath(): string {
  return path.join(getWmuxDir(), 'config.json');
}

/** Resolve default shell for current platform */
function getDefaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe';
  }
  return process.env.SHELL || '/bin/sh';
}

/** Generate default pipe name for current platform */
function getDefaultPipeName(): string {
  const username = os.userInfo().username || 'default';
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wmux-daemon-${username}`;
  }
  return path.join(os.homedir(), '.wmux-daemon.sock');
}

/** Build a DaemonConfig with all defaults */
export function createDefaultConfig(): DaemonConfig {
  return {
    version: 1,
    daemon: {
      pipeName: getDefaultPipeName(),
      logLevel: 'info',
      autoStart: true,
      idleShutdownMinutes: 5,
    },
    session: {
      defaultShell: getDefaultShell(),
      defaultCols: 120,
      defaultRows: 30,
      bufferSizeMb: 8,
      bufferMaxMb: 64,
      deadSessionTtlHours: 24,
      deadSessionDumpBuffer: true,
    },
  };
}

/**
 * Ensure ~/.wmux directory exists, then load config.json.
 * If the file is missing or malformed, a default config is written and returned.
 */
export function loadConfig(): DaemonConfig {
  const dir = getWmuxDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const configPath = getConfigPath();
  const defaults = createDefaultConfig();

  if (!fs.existsSync(configPath)) {
    saveConfig(defaults);
    return defaults;
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw, (key, value) => {
      // Prototype pollution guard (mirrors SessionManager pattern)
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });

    if (!validateConfig(parsed)) {
      console.warn('[daemon/config] Invalid config — resetting to defaults');
      saveConfig(defaults);
      return defaults;
    }

    const config = parsed as DaemonConfig;

    // Enforce upper bound on buffer size to prevent excessive memory usage.
    // Hard cap at 256 MB regardless of bufferMaxMb setting.
    const HARD_CAP_MB = 256;
    const effectiveMax = Math.min(config.session.bufferMaxMb, HARD_CAP_MB);
    if (config.session.bufferSizeMb > effectiveMax) {
      console.warn(`[daemon/config] bufferSizeMb (${config.session.bufferSizeMb}) exceeds max (${effectiveMax}), capping`);
      config.session.bufferSizeMb = effectiveMax;
    }

    return config;
  } catch (err) {
    console.warn('[daemon/config] Failed to read config.json — resetting to defaults:', err);
    saveConfig(defaults);
    return defaults;
  }
}

/** Atomic write: .tmp then rename (mirrors SessionManager pattern) */
export function saveConfig(config: DaemonConfig): void {
  const configPath = getConfigPath();
  const tmpPath = configPath + '.tmp';
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  try {
    // Note: mode is no-op on Windows; use icacls for NTFS ACLs
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    console.error('[daemon/config] Failed to save config:', err);
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}

/** Structural validation — checks required fields exist with correct types */
function validateConfig(parsed: unknown): parsed is DaemonConfig {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;

  if (typeof obj['version'] !== 'number') return false;

  // daemon section
  const daemon = obj['daemon'];
  if (typeof daemon !== 'object' || daemon === null) return false;
  const d = daemon as Record<string, unknown>;
  if (typeof d['pipeName'] !== 'string') return false;
  if (typeof d['logLevel'] !== 'string') return false;
  if (typeof d['autoStart'] !== 'boolean') return false;
  // idleShutdownMinutes is optional, but if present must be a finite number.
  // The post-validate path below still clamps to a sensible range — this
  // gate just rejects garbage like {"idleShutdownMinutes": "five"}.
  if (
    d['idleShutdownMinutes'] !== undefined &&
    (typeof d['idleShutdownMinutes'] !== 'number' || !Number.isFinite(d['idleShutdownMinutes'] as number))
  ) return false;

  // session section
  const session = obj['session'];
  if (typeof session !== 'object' || session === null) return false;
  const s = session as Record<string, unknown>;
  if (typeof s['defaultShell'] !== 'string') return false;
  if (typeof s['defaultCols'] !== 'number') return false;
  if (typeof s['defaultRows'] !== 'number') return false;
  if (typeof s['bufferSizeMb'] !== 'number') return false;
  if (typeof s['bufferMaxMb'] !== 'number') return false;
  if (typeof s['deadSessionTtlHours'] !== 'number') return false;
  if (typeof s['deadSessionDumpBuffer'] !== 'boolean') return false;

  return true;
}
