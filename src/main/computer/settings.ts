// Settings-side reads and writes for computer use. The switch lives in
// ~/.wmux/config.json (computerUse.enabled) because the MCP server process
// reads it too (src/shared/computer/config.ts) and has no other channel to
// main's settings at the time it builds its tool list.

import * as fs from 'fs';
import * as path from 'path';
import { computerUseConfigPath, readComputerUseEnabled } from '../../shared/computer/config';

export type ComputerHelperStatus = 'ready' | 'missing' | 'unsupported';

export interface ComputerUseSettings {
  enabled: boolean;
  helper: ComputerHelperStatus;
}

export function helperStatus(helperPath: string | null): ComputerHelperStatus {
  if (!helperPath) return 'unsupported';
  return fs.existsSync(helperPath) ? 'ready' : 'missing';
}

function readConfigObject(configPath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw, (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Sets computerUse.enabled, keeping every other key in the file as it was.
 *
 * The daemon owns this file's shape and resets a file it cannot validate to
 * defaults — which would silently drop our key. So when the file is missing or
 * unparseable we refuse instead of writing a fragment the daemon would
 * discard; the daemon creates the file at boot, so this only happens when
 * something is already wrong.
 *
 * Atomic (temp file + rename), mirroring the daemon's own saveConfig.
 */
export function writeComputerUseEnabled(enabled: boolean, configPath: string = computerUseConfigPath()): boolean {
  const config = readConfigObject(configPath);
  if (!config) throw new Error(`cannot update ${configPath}: the file is missing or not valid JSON`);
  const section = config.computerUse && typeof config.computerUse === 'object' && !Array.isArray(config.computerUse)
    ? (config.computerUse as Record<string, unknown>)
    : {};
  config.computerUse = { ...section, enabled };
  const tmpPath = `${configPath}.tmp`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  return readComputerUseEnabled(configPath);
}
