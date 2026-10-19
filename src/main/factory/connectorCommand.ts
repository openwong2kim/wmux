// ─── A connection's command, resolved once when the owner saves it ─────────
//
// A stdio connection is stored with an absolute command path: a bare name is
// looked up now, on the PATH the owner's login shell sets (a GUI-launched app
// misses it), in absolute PATH entries only. A worker's launch then never
// looks the program up again, so nothing in the worker's checkout (a `bin`
// folder, a relative PATH entry) can stand in for it.

import fs from 'node:fs';
import path from 'node:path';
import { agentExecEnv } from '../../shared/execEnv';
import { findExecutable } from '../../shared/exeSearch';

export interface ResolveCommandDeps {
  platform?: NodeJS.Platform;
  /** The PATH to search (default: the login shell's, then the app's). */
  pathVar?: () => Promise<string>;
  isExecutable?: (p: string) => boolean;
}

function defaultIsExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function defaultPathVar(): Promise<string> {
  const env = await agentExecEnv({ ...process.env });
  return env.PATH ?? env.Path ?? '';
}

/** The absolute path `command` runs, or null when there is none. `command`
 *  passed commandRefusal (a bare name or an absolute path). */
export async function resolveConnectorCommand(command: string, deps: ResolveCommandDeps = {}): Promise<string | null> {
  const platform = deps.platform ?? process.platform;
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (p.isAbsolute(command)) return isExecutable(command) ? p.normalize(command) : null;
  const pathVar = await (deps.pathVar ?? defaultPathVar)();
  if (platform === 'win32') {
    const hit = findExecutable(command, { platform, env: { PATH: pathVar }, extensions: 'pathext', isFile: isExecutable });
    return hit && p.isAbsolute(hit) ? hit : null;
  }
  for (const dir of pathVar.split(':')) {
    if (!dir || !p.isAbsolute(dir)) continue;
    const full = p.join(dir, command);
    if (isExecutable(full)) return full;
  }
  return null;
}
