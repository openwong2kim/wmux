/** #2407 — opt in with WMUX_TEST_WSL=1 and optionally WMUX_TEST_WSL_DISTRO.
 * Makes a throwaway repository (and a linked worktree) in the distro's /tmp
 * and removes it afterwards; commits pass identity with `-c`, so no git
 * configuration in the distro is read or changed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { gitDirMapperFor, gitWatchCwdFor } from '../gitWatchCwd';
import { GitContextWatcher, REMOTE_POLL_MS, readGitContext, resolveRepoState } from '../../main/pty/gitContextWatch';

const enabled = process.platform === 'win32' && process.env.WMUX_TEST_WSL === '1';

/** What the daemon hands GitContextWatcher.update for this session's cwd. */
function watchArgs(cwd: string, wslTarget: { distribution: string; user: string }) {
  return [gitWatchCwdFor({ cwd, wslTarget }), gitDirMapperFor({ cwd, wslTarget })] as const;
}

const SETUP = `
set -eu
dir=$(mktemp -d /tmp/wmux-2407.XXXXXX)
cd "$dir"
git init -q -b main repo
cd repo
mkdir sub
git -c user.name=wmux-test -c user.email=wmux-test@example.invalid commit -q --allow-empty -m init
git worktree add -q -b feat ../wt
printf '%s\\0%s\\0%s' "$WSL_DISTRO_NAME" "$(id -un)" "$dir"
`;

describe.runIf(enabled)('daemon git watcher over a WSL pane cwd (#2407)', () => {
  const wsl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wsl.exe');
  const distroArgs = process.env.WMUX_TEST_WSL_DISTRO ? ['-d', process.env.WMUX_TEST_WSL_DISTRO] : [];
  const execute = (args: string[]) => execFileSync(wsl, [...distroArgs, '--exec', ...args], {
    encoding: 'utf8', timeout: 30_000, windowsHide: true,
  });

  it('reads the branch of a distro-internal repo and its linked worktree', async () => {
    const [distribution, user, dir] = execute(['/bin/sh', '-c', SETUP]).split('\0');
    const wslTarget = { distribution, user };
    const watcher = new GitContextWatcher();
    try {
      const [repoCwd] = watchArgs(`${dir}/repo/sub`, wslTarget);
      expect(repoCwd).toBe(`\\\\wsl$\\${distribution}${dir.replace(/\//g, '\\')}\\repo\\sub`);
      const repo = resolveRepoState(repoCwd);
      expect(repo.repo).not.toBeNull();
      expect(readGitContext(repo.repo!)).toEqual({ branch: 'main', isWorktree: false });

      // `.git` here is a file whose gitdir is a Linux path.
      const [wtCwd, mapGitDir] = watchArgs(`${dir}/wt`, wslTarget);
      const wt = resolveRepoState(wtCwd, mapGitDir);
      expect(readGitContext(wt.repo!)).toEqual({ branch: 'feat', isWorktree: true });

      // The daemon's own path: update() resolves off the event loop and
      // emits the branch, then the poll sees a checkout made without a cd.
      const events: Array<{ branch: string | null }> = [];
      // Bounded below the test timeout, so `finally` still removes the repo.
      const branch = (name: string) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${name} branch within 20s`)), 20_000);
        const check = () => { if (events.some((e) => e.branch === name)) { clearTimeout(timer); resolve(); } };
        watcher.on('git', check);
        check();
      });
      watcher.on('git', (e) => events.push(e));
      watcher.update('s', ...watchArgs(`${dir}/wt`, wslTarget));
      await branch('feat');
      expect(events).toEqual([{ sessionId: 's', branch: 'feat', isWorktree: true }]);
      execute(['git', '-C', `${dir}/wt`, 'checkout', '-q', '-b', 'switched']);
      const started = Date.now();
      await branch('switched');
      expect(Date.now() - started).toBeLessThan(REMOTE_POLL_MS * 2 + 1_000);
    } finally {
      watcher.dispose();
      if (dir.startsWith('/tmp/wmux-2407.')) execute(['rm', '-rf', '--', dir]);
    }
  }, 60_000);

  it('reads the branch of a host-drive repo and its worktree through /mnt/<drive>', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-2407-')));
    try {
      const linuxRoot = execute(['wslpath', '-u', root]).trim();
      // Made by git inside the distro, so the worktree's gitdir is `/mnt/…`.
      const [distribution, user] = execute(['/bin/sh', '-c', `
set -eu
cd "$1"
git init -q -b host repo
cd repo
git -c user.name=wmux-test -c user.email=wmux-test@example.invalid commit -q --allow-empty -m init
git worktree add -q -b side ../wt
printf '%s\\0%s' "$WSL_DISTRO_NAME" "$(id -un)"
`, 'wmux-2407', linuxRoot]).split('\0');
      const wslTarget = { distribution, user };
      expect(fs.readFileSync(path.join(root, 'wt', '.git'), 'utf8')).toMatch(/^gitdir: \/mnt\//);

      const [repoCwd] = watchArgs(`${linuxRoot}/repo`, wslTarget);
      expect(repoCwd.toLowerCase()).toBe(path.join(root, 'repo').toLowerCase());
      expect(readGitContext(resolveRepoState(repoCwd).repo!)).toEqual({ branch: 'host', isWorktree: false });

      const [wtCwd, mapGitDir] = watchArgs(`${linuxRoot}/wt`, wslTarget);
      expect(readGitContext(resolveRepoState(wtCwd, mapGitDir).repo!)).toEqual({ branch: 'side', isWorktree: true });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }, 60_000);
});
