import fs from 'node:fs';
import path from 'node:path';
import { assignFanoutPorts, isPortFree } from '../../main/worktask/fanoutEnvironment';
import { normalizeWmuxProjectConfig, PROJECT_CONFIG_MAX_FILE_BYTES, WMUX_PROJECT_CONFIG_FILENAME } from '../../shared/wmuxProjectConfig';

/**
 * The `fanout.portRange` of a headless start's worktree (its own `wmux.json`
 * at the worktree root), or undefined when it declares none, the file is
 * missing, too large or not valid. Like the desktop fan-out, no trust gate:
 * the file picks one number, which stays inside WMUX_TASK_PORT.
 */
export function worktreePortRange(worktreePath: string): { min: number; max: number } | undefined {
  try {
    const file = path.join(worktreePath, WMUX_PROJECT_CONFIG_FILENAME);
    // A regular file only, also behind a link: a committed link to a device (/dev/zero) or a fifo would never end a read.
    const link = fs.lstatSync(file);
    const target = link.isSymbolicLink() ? fs.statSync(fs.realpathSync.native(file)) : link;
    if (!target.isFile() || target.size > PROJECT_CONFIG_MAX_FILE_BYTES) return undefined;
    return normalizeWmuxProjectConfig(JSON.parse(fs.readFileSync(file, 'utf8')))?.fanout?.portRange;
  } catch {
    return undefined;
  }
}

/**
 * One free port from the worktree's `fanout.portRange` that no port in `taken`
 * (the ports other live starts on this box hold) is, or undefined when none is
 * declared or the window has no free port left: the agent then starts without
 * WMUX_TASK_PORT, as before. The port stays reserved in the fan-out
 * allocator's table until the caller has recorded it and released it there
 * (`releaseFanoutPorts`): the start record is what holds it from then on.
 */
export async function pickHeadlessTaskPort(
  worktreePath: string,
  taken: ReadonlySet<number>,
  probe: (port: number) => Promise<boolean> = isPortFree,
): Promise<number | undefined> {
  const range = worktreePortRange(worktreePath);
  if (!range) return undefined;
  try {
    const [port] = await assignFanoutPorts(range, 1, { probe: async (p) => !taken.has(p) && probe(p) });
    return port;
  } catch {
    return undefined;
  }
}
