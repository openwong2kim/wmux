// Real-process verification of the verified tree kill (#2388) on Windows: a
// shell whose grandchild sits in a temp folder holding a file there open with
// no sharing, the way an agent's tool process keeps a task worktree. Killing
// only the shell leaves the folder undeletable; the verified kill must leave
// no process of the tree and a folder that can be removed.
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { killProcessTreeVerified } from '../verifiedTreeKill';
import { tryNativeSnapshot } from '../../../main/pty/winSnapshotNative';

const onWindows = process.platform === 'win32';

/** Only processes this file started; each is killed by pid in afterEach. */
const started: number[] = [];
const dirs: string[] = [];

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return check();
}

/** cmd.exe → cmd.exe → powershell.exe, all in `dir`; the powershell holds
 *  `lock.bin` open with no sharing and writes its pid to `ready.txt`. */
async function startHolder(dir: string): Promise<{ root: ChildProcess; holderPid: number }> {
  const ps = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "$f=[IO.File]::Open('lock.bin','OpenOrCreate','ReadWrite','None'); Set-Content -Path ready.txt -Value $PID; Start-Sleep -Seconds 120";
  const root = spawn('cmd.exe', ['/d', '/c', `cmd.exe /d /c ""${ps}" -NoProfile -NonInteractive -Command "${script}""`], {
    cwd: dir,
    windowsHide: true,
    windowsVerbatimArguments: true,
    stdio: 'ignore',
  });
  started.push(root.pid!);
  const ready = path.join(dir, 'ready.txt');
  expect(await waitFor(() => fs.existsSync(ready) && fs.readFileSync(ready, 'utf8').trim().length > 0, 30_000)).toBe(true);
  const holderPid = Number(fs.readFileSync(ready, 'utf8').trim());
  started.push(holderPid);
  return { root, holderPid };
}

/** Every pid of the tree under `root` (root included), from the native table. */
function treeOf(root: number): number[] {
  const procs = tryNativeSnapshot()?.procs ?? [];
  const found = new Set([root]);
  for (let changed = true; changed;) {
    changed = false;
    for (const p of procs) {
      if (found.has(p.ppid) && !found.has(p.pid) && p.pid !== p.ppid) {
        found.add(p.pid);
        changed = true;
      }
    }
  }
  return [...found];
}

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-treekill-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  }
  for (const dir of dirs.splice(0)) {
    await waitFor(() => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }, 10_000);
  }
});

describe.skipIf(!onWindows)('verified tree kill (real Windows processes)', () => {
  it('killing only the shell leaves its grandchild holding the folder', async () => {
    const dir = tempDir();
    const { root, holderPid } = await startHolder(dir);
    process.kill(root.pid!);
    expect(await waitFor(() => !isAlive(root.pid!), 5000)).toBe(true);
    expect(isAlive(holderPid)).toBe(true);
    expect(() => fs.rmSync(dir, { recursive: true, force: true })).toThrow();
  }, 60_000);

  it('kills every descendant, verifies each exited, and the folder can be removed', async () => {
    const dir = tempDir();
    const { root, holderPid } = await startHolder(dir);
    const before = treeOf(root.pid!);
    expect(before).toContain(holderPid);
    expect(before.length).toBeGreaterThanOrEqual(3);

    const result = await killProcessTreeVerified(root.pid!);

    // The whole result on failure: which process survived, and why.
    expect(result).toMatchObject({ ok: true });
    // A process of the tree that ended by itself before the kill is not in
    // `killed`; every one is gone either way.
    expect(result.killed).toEqual(expect.arrayContaining([root.pid, holderPid]));
    for (const pid of before) expect(isAlive(pid)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(dir)).toBe(false);
  }, 60_000);
});
