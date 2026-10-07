// The MCP-side switch for moa_ask: `enabled` in ~/.wmux{suffix}/moa-ask.json.
//
// Same split as computer use (shared/computer/config.ts): main owns the write
// and keeps the file in step with the owner's ask mode (Settings › Moa;
// MoaConfig.askMode, absent = 'off'); the MCP server reads it once when it
// builds its tool list, so the two tools do not exist for anyone who has not
// opted in and the published surface stays byte-identical. Main never trusts
// this file: it re-checks its own config on every call.
//
// With the mode off main writes nothing (no file is created). Fail-closed: a
// missing, unreadable or malformed file, or anything but a literal `true`,
// means off.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dataSuffix } from './constants';

export const MOA_ASK_SWITCH_FILENAME = 'moa-ask.json';

export function moaAskSwitchPath(): string {
  return path.join(os.homedir(), `.wmux${dataSuffix()}`, MOA_ASK_SWITCH_FILENAME);
}

export function readMoaAskEnabled(switchPath: string = moaAskSwitchPath()): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(switchPath, 'utf-8');
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
