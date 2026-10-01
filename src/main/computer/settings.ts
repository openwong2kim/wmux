// Settings-side reads and writes for computer use. The switch lives in
// ~/.wmux/computer-use.json because the MCP server process reads it too
// (src/shared/computer/config.ts) and has no other channel to main's settings
// at the time it builds its tool list.

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

/**
 * Sets the switch in ~/.wmux/computer-use.json. Main is the only writer of
 * this file, so a missing or unreadable one is simply replaced (it already
 * reads as off). Other keys in a valid file are kept.
 *
 * Atomic (temp file + rename), so a reader never sees half a file.
 */
export function writeComputerUseEnabled(enabled: boolean, configPath: string = computerUseConfigPath()): boolean {
  let config: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'), (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value,
    );
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  } catch {
    // missing or not JSON: start fresh
  }
  config.enabled = enabled;
  const tmpPath = `${configPath}.tmp`;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmpPath, configPath);
  return readComputerUseEnabled(configPath);
}
