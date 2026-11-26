// The A2A task retention setting (#3068): a number of days, or off (null, the
// default). Written here from Settings only; the daemon reads the same file on
// each sweep (daemon/index.ts sweepA2aRetention), so no agent on the pipe can
// change it.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSON } from '../../daemon/util/atomicWrite';
import { A2A_TASK_RETENTION_FILE, clampRetentionDays, parseRetentionFile } from '../../shared/a2aTaskCleanup';

export function getA2aTaskRetentionPath(dir: string = getWmuxDir()): string {
  return path.join(dir, A2A_TASK_RETENTION_FILE);
}

export function loadA2aTaskRetentionDays(dir?: string): number | null {
  try {
    return parseRetentionFile(fs.readFileSync(getA2aTaskRetentionPath(dir), 'utf-8'));
  } catch {
    return null;
  }
}

/** Store `value` (whole days 1..365, or null for off) and return what is now in force. */
export async function setA2aTaskRetentionDays(value: unknown, dir?: string): Promise<number | null> {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) return loadA2aTaskRetentionDays(dir);
  const days = clampRetentionDays(value);
  await atomicWriteJSON(getA2aTaskRetentionPath(dir), { days });
  return days;
}
