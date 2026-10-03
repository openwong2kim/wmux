import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * lsof's `-F` output escapes bytes outside printable ASCII as `\xNN` when its
 * locale cannot print them (a daemon started from the Dock has no LANG). Turn
 * runs of those escapes back into UTF-8 text; other backslashes stay as they are.
 */
export function decodeLsofName(name: string): string {
  return name.replace(/(?:\\x[0-9a-fA-F]{2})+/g, (run) => {
    const bytes = Buffer.from(run.split('\\x').filter(Boolean).map((hex) => parseInt(hex, 16)));
    const text = bytes.toString('utf8');
    return text.includes('�') ? run : text;
  });
}

/**
 * The working directory a process really has, or undefined when it cannot be
 * read. darwin: the `cwd` name lsof reports (absolute lsof path, no PATH
 * trust, UTF-8 locale); linux: `/proc/<pid>/cwd`. Other platforms: undefined.
 */
export async function readProcessCwd(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    if (platform === 'linux') return await fs.promises.readlink(`/proc/${pid}/cwd`);
    if (platform !== 'darwin') return undefined;
    const { stdout } = await execFileAsync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      encoding: 'utf-8',
      timeout: 5_000,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'en_US.UTF-8', LANG: 'en_US.UTF-8' },
    });
    const name = (stdout as string).split('\n').find((line) => line.startsWith('n') && line.length > 1);
    return name ? decodeLsofName(name.slice(1)) : undefined;
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
 * Where a new driver runs: the shell's verified working directory, i.e. the
 * real path of the directory the operating system reports for the pane's
 * shell process. When it cannot be read, and on Windows, the driver runs where
 * the pane started (`spawnCwd`), which also stays the diff route's root.
 */
export async function driverCwd(
  meta: { spawnCwd?: string; pid?: number },
  deps: DriverCwdDeps = defaultDeps,
): Promise<string | undefined> {
  const fallback = meta.spawnCwd || undefined;
  if (deps.platform === 'win32' || !meta.pid) return fallback;
  try {
    const actual = await deps.processCwd(meta.pid);
    if (!actual) return fallback;
    // The canonical path is what runs and what is stored, so a later change of
    // a link along the way cannot move the chat.
    return await deps.realpath(actual);
  } catch {
    return fallback;
  }
}
