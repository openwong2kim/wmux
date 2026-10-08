// Opt-in switch for computer use: `enabled` in ~/.wmux/computer-use.json.
//
// Its own file, owned by main, rather than a key in the daemon's config.json:
// the daemon rewrites config.json from the copy it loaded at boot (LanLink
// settings), which silently dropped the key or, worse, turned a switch the
// user had just turned off back on.
//
// Read by two processes on purpose. The MCP server reads it when it builds its
// tool list, so the `computer` tool does not exist for anyone who has not opted
// in (and the published tool surface stays unchanged). Main reads it on every
// call, so a stale MCP server cannot keep driving the desktop after the user
// turns it off.
//
// Fail-closed like firstPartyConfig.ts: a missing, unreadable or malformed
// file, or anything but a literal `true`, means off.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataSuffix } from '../constants';

export function computerUseConfigPath(): string {
  return path.join(os.homedir(), `.wmux${dataSuffix()}`, 'computer-use.json');
}

export function readComputerUseEnabled(configPath: string = computerUseConfigPath()): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  return (parsed as Record<string, unknown>).enabled === true;
}

/**
 * The per-app consent prompt is opt-in (owner decision 2026-10-08): with
 * `askPerApp` absent or anything but a literal `true`, an agent may drive any
 * unblocked app once computer use is on. Same file and fail-closed parsing as
 * `enabled`, but "closed" here means "do not ask".
 */
export function readComputerUseAskPerApp(configPath: string = computerUseConfigPath()): boolean {
  return readBooleanKey(configPath, 'askPerApp') === true;
}

/** The agent cursor and window halo. On unless the file says literal `false`. */
export function readComputerUseOverlay(configPath: string = computerUseConfigPath()): boolean {
  return readBooleanKey(configPath, 'overlay') !== false;
}

function readBooleanKey(configPath: string, key: 'askPerApp' | 'overlay'): boolean | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'), (k, value) =>
      k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : value,
    );
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** What Settings › Computer use shows, over IPC. */
export interface ComputerUseSettingsPayload {
  enabled: boolean;
  /**
   * `missing`: this build has no helper binary yet; `unsupported`: no helper
   * exists for this OS; `elevated`: wmux runs as administrator and the helper
   * refuses to (Windows).
   */
  helper: 'ready' | 'missing' | 'unsupported' | 'elevated';
  /**
   * A packaged Windows build whose helper is not code-signed. It still runs
   * (its SHA-256 pin is checked); Settings only notes that Defender or
   * SmartScreen may warn about it.
   */
  helperUnsigned?: boolean;
  /** The global stop key, as an Electron accelerator. */
  stopKey: string;
  /**
   * Whether main holds the stop key: `off` while computer use is off,
   * `unavailable` when another app owns the chord (input is then refused).
   */
  stopKeyStatus: 'off' | 'held' | 'unavailable';
  /** Ask before an agent drives each app (opt-in; default off). */
  askPerApp?: boolean;
  /** Agent cursor and window halo while an agent drives (default on). */
  overlay?: boolean;
  /**
   * The helper's OS grants, from its last hello or capabilities read. Absent
   * when the helper could not be asked (off, missing, unsupported).
   */
  permissions?: { accessibility: boolean; screenRecording: boolean };
  /**
   * macOS: the helper's .app bundle, the entry the person looks for in the
   * Privacy & Security lists. Absent where the helper is not a bundle.
   */
  helperAppPath?: string;
  /** Set when the last write failed; the switch shows the state on disk. */
  error?: string;
}
