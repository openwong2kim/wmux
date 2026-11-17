import * as fs from 'fs';
import * as path from 'path';
import { getWmuxHomeDir } from './constants';
import { stripBom } from './stripBom';
import { writeJsonAtomic } from './settingsFile';
import { isBrokerSetting, type BrokerSetting } from './mcpBroker';

/**
 * The Settings choice for the shared MCP broker (shared/mcpBroker.ts):
 * `~/.wmux{suffix}/mcp-broker.json`, `{v: 1, broker: 'on' | 'off' | 'default'}`.
 *
 * Its own file, not a key of config.json: the daemon loads config.json once
 * and writes the whole object back, so a key written beside it later would be
 * lost at the daemon's next save. The app writes it from Settings; the app and
 * `wmux mcp register` read it. No file means `default`, and so does a file that
 * cannot be read or parsed, which also says why (`problem`).
 */
export const BROKER_SETTING_FILE = 'mcp-broker.json';

export interface BrokerSettingRead {
  setting: BrokerSetting;
  /** Set when a file is there but was not used. */
  problem?: string;
}

export function brokerSettingPath(dir: string = getWmuxHomeDir()): string {
  return path.join(dir, BROKER_SETTING_FILE);
}

export function readBrokerSetting(dir?: string): BrokerSettingRead {
  let file: string;
  try {
    file = brokerSettingPath(dir);
  } catch (err) {
    return { setting: 'default', problem: `${BROKER_SETTING_FILE}: no data folder (${err instanceof Error ? err.message : String(err)})` };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { setting: 'default' };
    return { setting: 'default', problem: `${BROKER_SETTING_FILE}: could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(raw), (key, value) =>
      key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value);
  } catch {
    return { setting: 'default', problem: `${BROKER_SETTING_FILE}: not valid JSON` };
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  if (!record || record['v'] !== 1 || !isBrokerSetting(record['broker'])) {
    return { setting: 'default', problem: `${BROKER_SETTING_FILE}: not a v1 setting` };
  }
  return { setting: record['broker'] };
}

/** Write the choice atomically (temp file and rename). Throws when it did not land. */
export function writeBrokerSetting(setting: BrokerSetting, dir?: string): void {
  writeJsonAtomic(brokerSettingPath(dir), { v: 1, broker: setting });
}
