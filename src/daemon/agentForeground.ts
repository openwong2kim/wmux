/**
 * Whether a process holds its terminal's foreground: its process group is
 * the terminal's foreground process group, the one the terminal's keys go
 * to. An agent stopped and put in the background (Ctrl+Z), or left running
 * behind a shell job, does not; text typed into the pane then reaches the
 * shell, not the agent.
 *
 * Linux reads /proc/<pid>/stat; macOS asks ps for the two columns. Windows
 * has no process groups on a console, so the answer is undefined there, and
 * undefined too whenever the read fails: the caller decides what unknown
 * means.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { foregroundGroupFromStat } from './shellPrompt/foregroundTtyWait';

/** Budget for one ps run. */
const PS_TIMEOUT_MS = 1_500;

/** pgrp and tpgid from a /proc/<pid>/stat line (fields 5 and 8). */
export function foregroundFromProcStat(stat: string): boolean | undefined {
  // The command name (field 2) may hold spaces and parentheses: read after its last ')'.
  const close = stat.lastIndexOf(')');
  if (close < 0) return undefined;
  const pgrp = Number(stat.slice(close + 1).trim().split(/\s+/)[2]);
  if (!Number.isSafeInteger(pgrp) || pgrp <= 0) return undefined;
  return foregroundGroupFromStat(stat) === pgrp;
}

/** `ps -o pgid=,tpgid=` output for one process. */
export function foregroundFromPs(out: string): boolean | undefined {
  const [pgid, tpgid] = out.trim().split(/\s+/).map(Number);
  if (!Number.isInteger(pgid) || !Number.isInteger(tpgid) || pgid <= 0) return undefined;
  return tpgid > 0 && pgid === tpgid;
}

export async function processHoldsForeground(pid: number, platform: NodeJS.Platform = process.platform): Promise<boolean | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === 'linux') {
    try {
      return foregroundFromProcStat(await fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'));
    } catch {
      return undefined;
    }
  }
  if (platform !== 'darwin') return undefined;
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pgid=,tpgid=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      resolve(err ? undefined : foregroundFromPs(String(stdout)));
    });
  });
}
