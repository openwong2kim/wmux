import * as fs from 'node:fs';
import { normalizeResumeCwd } from '../shared/agentResume';
import { isWslShell } from '../shared/wsl';

/**
 * A resume binding whose folder is the pane's folder reached through a
 * symlink takes the pane's spelling. Agent hooks report the real path
 * (`/Volumes/disk/git/app`), the shell its logical one (`~/git/app`), and every
 * resume check compares the two as strings, so without this a symlinked
 * project never resumes its exact conversation after a restart. A WSL pane's
 * folder is a Linux path that means nothing on this host, so it is left alone.
 */
export function alignResumeCwd<T extends { cwd?: unknown }>(
  binding: T,
  pane: { cwd?: string; cmd?: string; wslTarget?: unknown },
  realpath: (p: string) => string = fs.realpathSync.native,
): T {
  const cwd = binding.cwd;
  const paneCwd = pane.cwd;
  if (typeof cwd !== 'string' || !cwd || !paneCwd || normalizeResumeCwd(cwd) === normalizeResumeCwd(paneCwd)) return binding;
  if (pane.wslTarget || isWslShell(pane.cmd)) return binding;
  try {
    return realpath(cwd) === realpath(paneCwd) ? { ...binding, cwd: paneCwd } : binding;
  } catch {
    return binding; // a folder gone: leave the mismatch to the existing checks
  }
}
