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

/**
 * Substrate 3.0 lifecycle clamp bounds. Tier-2 resource floors stay
 * configurable, but can't be set to self-defeating values: a 0/negative
 * threshold, or a memory threshold above physical RAM, would silently
 * disable the protection (codex #9 — silent boot brick). Each knob clamps
 * to `[floor, cap]`; an absent or non-numeric value falls back to the
 * `createDefaultConfig` default PER-FIELD, without resetting the rest of
 * the file (codex #13 — a maxSessions typo must not nuke pipeName).
 */
const MAX_SESSIONS_FLOOR = 1;
const MAX_SESSIONS_CAP = 10_000;
const SUSPENDED_TTL_FLOOR_HOURS = 1;
const SUSPENDED_TTL_CAP_HOURS = 24 * 365; // 1 year — "permanent" = large, not 0
const MEM_WARN_FLOOR_MB = 128;
const MEM_REAP_FLOOR_MB = 192;
const MEM_BLOCK_FLOOR_MB = 256;

/**
 * Coerce a lifecycle knob to a finite integer within `[min, max]`. An
 * absent (`undefined`) or non-numeric/`NaN`/`Infinity` value falls back to
 * `def` — this is the per-field backfill. A finite out-of-range value is
 * clamped (floored toward `min`, capped at `max`); `0`/negative therefore
 * lands on `min`, never "off" (these floors have no disable, unlike
 * `idleShutdownMinutes`).
 */
function clampLifecycle(raw: unknown, def: number, min: number, max: number): number {
  // Fall back to the default for an absent/non-numeric value, then clamp the
  // RESULT — default included — to [min, max]. Clamping the fallback matters
  // on a box with less RAM than a memory default: an omitted memBlockMb must
  // still cap at physical RAM, not sit above it and silently disable the
  // guard (codex P3).
  const v = typeof raw === 'number' && Number.isFinite(raw) ? raw : def;
  return Math.min(Math.max(Math.floor(v), min), max);
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
      memWarnMb: 500,
      memReapMb: 750,
      memBlockMb: 1024,
    },
    session: {
      defaultShell: getDefaultShell(),
      defaultCols: 120,
      defaultRows: 30,
      bufferSizeMb: 8,
      bufferMaxMb: 64,
      deadSessionTtlHours: 24,
      deadSessionDumpBuffer: true,
      maxSessions: 200,
      suspendedTtlHours: 7 * 24,
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

    // ── Substrate 3.0 lifecycle knobs: per-field backfill + clamp ──
    // validateConfig deliberately ignores these fields, so a garbage value
    // here can never trigger the whole-file reset above (that path stays
    // reserved for core-structure breakage). Here: absent (old config.json)
    // → default; out-of-range → clamped; valid → preserved. Defaults come
    // from `defaults` (createDefaultConfig) — the single source of truth.
    config.session.maxSessions = clampLifecycle(
      config.session.maxSessions, defaults.session.maxSessions,
      MAX_SESSIONS_FLOOR, MAX_SESSIONS_CAP,
    );
    config.session.suspendedTtlHours = clampLifecycle(
      config.session.suspendedTtlHours, defaults.session.suspendedTtlHours,
      SUSPENDED_TTL_FLOOR_HOURS, SUSPENDED_TTL_CAP_HOURS,
    );

    // Memory triple: floor + absolute upper cap (physical RAM). A threshold
    // above total RAM can never trip, silently disabling the protection;
    // clamp it to RAM. The cap never drops below the block floor so a tiny
    // box (RAM < floor) still keeps the floor.
    const totalMemMb = Math.floor(os.totalmem() / 1024 / 1024);
    const memCap = Math.max(MEM_BLOCK_FLOOR_MB, totalMemMb);
    // codex #9: a block threshold below the sane floor would permanently
    // refuse new sessions on boot (RSS never drops under it) — and silently.
    // Detect BEFORE clampLifecycle rewrites it, then warn loudly.
    if (
      typeof config.daemon.memBlockMb === 'number' &&
      Number.isFinite(config.daemon.memBlockMb) &&
      config.daemon.memBlockMb < MEM_BLOCK_FLOOR_MB
    ) {
      console.warn(
        `[daemon/config] memBlockMb (${config.daemon.memBlockMb}MB) is below the safe floor ` +
          `${MEM_BLOCK_FLOOR_MB}MB — clamping to ${MEM_BLOCK_FLOOR_MB}MB to avoid silently ` +
          `bricking new-session creation.`,
      );
    }
    const memWarn = clampLifecycle(config.daemon.memWarnMb, defaults.daemon.memWarnMb, MEM_WARN_FLOOR_MB, memCap);
    let memReap = clampLifecycle(config.daemon.memReapMb, defaults.daemon.memReapMb, MEM_REAP_FLOOR_MB, memCap);
    let memBlock = clampLifecycle(config.daemon.memBlockMb, defaults.daemon.memBlockMb, MEM_BLOCK_FLOOR_MB, memCap);
    // Order invariant warn ≤ reap ≤ block, corrected AFTER per-field clamp
    // (a per-field floor can invert a user's ordering). Raise reap/block to
    // preserve the escalation ladder rather than lowering warn.
    memReap = Math.max(memReap, memWarn);
    memBlock = Math.max(memBlock, memReap);
    config.daemon.memWarnMb = memWarn;
    config.daemon.memReapMb = memReap;
    config.daemon.memBlockMb = memBlock;

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
