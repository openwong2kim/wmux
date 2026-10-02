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

/** What Settings › Computer use shows, over IPC. */
export interface ComputerUseSettingsPayload {
  enabled: boolean;
  /**
   * `missing`: this build has no helper binary yet; `unsupported`: no helper
   * exists for this OS; `elevated`: wmux runs as administrator and the helper
   * refuses to (Windows).
   */
  helper: 'ready' | 'missing' | 'unsupported' | 'elevated';
  /** The global stop key, as an Electron accelerator. */
  stopKey: string;
  /**
   * Whether main holds the stop key: `off` while computer use is off,
   * `unavailable` when another app owns the chord (input is then refused).
   */
  stopKeyStatus: 'off' | 'held' | 'unavailable';
  /** Set when the last write failed; the switch shows the state on disk. */
  error?: string;
}
