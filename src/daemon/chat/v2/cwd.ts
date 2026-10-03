import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The working directory a process really has, or undefined when it cannot be
 * read. darwin: the `cwd` name lsof reports (absolute lsof path, no PATH
 * trust); linux: `/proc/<pid>/cwd`. Other platforms: undefined.
 */
export async function readProcessCwd(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === 'linux') return await fs.promises.readlink(`/proc/${pid}/cwd`);
    if (platform !== 'darwin') return undefined;
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf-8', timeout: 5_000 });
    const name = (stdout as string).split('\n').find((line) => line.startsWith('n') && line.length > 1);
    return name?.slice(1);
  } catch {
    return undefined;
  }
}

export interface DriverCwdDeps {
  platform: NodeJS.Platform;
  /** The shell's working directory as the OS reports it. */
  processCwd: (pid: number) => Promise<string | undefined>;
  realpath: (dir: string) => Promise<string>;
}

const defaultDeps: DriverCwdDeps = {
  platform: process.platform,
  processCwd: (pid) => readProcessCwd(pid),
  realpath: (dir) => fs.promises.realpath(dir),
};

/**
 * Where a new driver runs. The pane's reported current directory (shell
 * integration / OSC 7) is used only when it is the shell's verified working
 * directory: both resolve to the same real path. Otherwise, when either cannot
 * be read, and on platforms without a way to read a process's directory, the
 * driver runs where the pane started (`spawnCwd`), which also stays the diff
 * route's root.
 */
export async function driverCwd(
  meta: { cwd?: string; spawnCwd?: string; pid?: number },
  deps: DriverCwdDeps = defaultDeps,
): Promise<string | undefined> {
  const fallback = meta.spawnCwd || undefined;
  const reported = meta.cwd;
  if (!reported || !path.isAbsolute(reported) || deps.platform === 'win32' || !meta.pid) return fallback;
  try {
    const actual = await deps.processCwd(meta.pid);
    if (!actual) return fallback;
    const [reportedReal, actualReal] = await Promise.all([deps.realpath(reported), deps.realpath(actual)]);
    return reportedReal === actualReal ? reported : fallback;
  } catch {
    return fallback;
  }
}
