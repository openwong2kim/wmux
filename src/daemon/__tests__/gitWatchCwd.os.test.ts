import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { gitDirMapperFor, gitWatchCwdFor } from '../gitWatchCwd';

// #2407: the git watcher runs on the Windows side and must be handed a path
// it can read, while the session keeps its Linux cwd.
describe('gitWatchCwdFor', () => {
  const wsl = { cmd: 'C:\\Windows\\System32\\wsl.exe', wslTarget: { distribution: 'Ubuntu-24.04' } };

  it('a drive-mount path is the host folder it names', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/wmux-work/repo' }, 'win32')).toBe('D:\\wmux-work\\repo');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/c' }, 'win32')).toBe('C:\\');
  });

  it('a path inside the distro is that distro\'s share', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/e2e-wsl-2403' }, 'win32')).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\e2e-wsl-2403');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/' }, 'win32')).toBe('\\\\wsl$\\Ubuntu-24.04\\');
    // A pane spawned without `-d` has its wslTarget from the cwd probe's
    // $WSL_DISTRO_NAME, so the default distro is a named one here too.
    expect(gitWatchCwdFor({ wslTarget: { distribution: 'Debian' }, cwd: '/home/me/repo' }, 'win32')).toBe('\\\\wsl$\\Debian\\home\\me\\repo');
  });

  it('a distro path with no valid distro recorded is passed as given', () => {
    expect(gitWatchCwdFor({ cmd: 'wsl.exe', cwd: '/home/me/repo' }, 'win32')).toBe('/home/me/repo');
    expect(gitWatchCwdFor({ wslTarget: { distribution: '-x' }, cwd: '/home/me/repo' }, 'win32')).toBe('/home/me/repo');
  });

  it('a wsl.exe session with no distro recorded maps the drive mount too', () => {
    expect(gitWatchCwdFor({ cmd: 'wsl.exe', cwd: '/mnt/c/repo' }, 'win32')).toBe('C:\\repo');
  });

  it('a Windows shell\'s path is never touched', () => {
    expect(gitWatchCwdFor({ cmd: 'pwsh.exe', cwd: 'D:\\repo' }, 'win32')).toBe('D:\\repo');
    expect(gitWatchCwdFor({ cmd: 'C:\\Program Files\\Git\\bin\\bash.exe', cwd: '/c/repo' }, 'win32')).toBe('/c/repo');
    expect(gitWatchCwdFor({ cmd: 'pwsh.exe', cwd: '/mnt/d/repo' }, 'win32')).toBe('/mnt/d/repo');
  });

  it('a path Windows would read as another directory is passed as given rather than translated', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/repo/..\\other' }, 'win32')).toBe('/mnt/d/repo/..\\other');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/x/repo.' }, 'win32')).toBe('/mnt/d/x/repo.');
    for (const cwd of ['~', '~/repo', 'relative/dir', '//server/share', 'D:\\already\\host', '\\\\wsl$\\Ubuntu-24.04\\home']) {
      expect(gitWatchCwdFor({ ...wsl, cwd }, 'win32')).toBe(cwd);
    }
  });

  it('off win32 every cwd is the identity', () => {
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/repo' }, 'linux')).toBe('/mnt/d/repo');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/mnt/d/repo' }, 'darwin')).toBe('/mnt/d/repo');
    expect(gitWatchCwdFor({ ...wsl, cwd: '/home/dev/repo' }, 'linux')).toBe('/home/dev/repo');
  });
});

describe('gitDirMapperFor', () => {
  it('maps a WSL session\'s worktree gitdirs by the same rule as its cwd', () => {
    const map = gitDirMapperFor({ wslTarget: { distribution: 'Ubuntu-24.04' }, cwd: '/mnt/d/wt' }, 'win32');
    expect(map?.('/home/dev/repo/.git/worktrees/wt')).toBe('\\\\wsl$\\Ubuntu-24.04\\home\\dev\\repo\\.git\\worktrees\\wt');
    expect(map?.('/mnt/d/repo/.git/worktrees/wt')).toBe('D:\\repo\\.git\\worktrees\\wt');
    expect(map?.('/home/dev/a\\b')).toBe('/home/dev/a\\b');
  });

  it('is undefined without a known distro, or off WSL, or off win32', () => {
    expect(gitDirMapperFor({ cmd: 'wsl.exe', cwd: '/mnt/c/repo' }, 'win32')).toBeUndefined();
    expect(gitDirMapperFor({ cmd: 'pwsh.exe', cwd: 'D:\\repo' }, 'win32')).toBeUndefined();
    expect(gitDirMapperFor({ wslTarget: { distribution: 'Ubuntu' }, cwd: '/home/me' }, 'linux')).toBeUndefined();
  });
});

describe('daemon git watcher wiring (#2407)', () => {
  // wireContextWatchers is a closure inside the daemon entry module, which a
  // unit test cannot import; assert its call sites instead (see
  // agentStateReaderWiring.test.ts for the same approach).
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf-8');

  it('hands every git watcher update the mapped cwd and the gitdir mapper', () => {
    const all = src.match(/gitWatcher\.update\(/g) ?? [];
    const mapped = src.match(/gitWatcher\.update\([^,]+, gitWatchCwdFor\(([^)]+)\), gitDirMapperFor\(\1\)\)/g) ?? [];
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(mapped).toHaveLength(all.length);
  });

  // A WSL pane's share is polled, and the pane's own wsl.exe is what keeps its
  // distro running. These pin the argument that no poll ever runs against a
  // stopped distro: a watch starts only for a live session and goes with it.
  it('watches only live sessions, and drops a session on every way it stops', () => {
    const start = src.indexOf('function wireContextWatchers(');
    const body = src.slice(start, src.indexOf('\n}', start));
    for (const event of ['session:died', 'session:interrupted', 'session:destroyed']) {
      expect(body).toContain(`sessionManager.on('${event}', onGone);`);
      expect(body).toContain(`sessionManager.off('${event}', onGone);`);
    }
    expect(body).toContain('for (const s of sessionManager.listLiveSessions()) {');
    const onCwd = body.slice(body.indexOf('const onCwd ='), body.indexOf('const onGone ='));
    expect(onCwd).toMatch(/if \(meta\?\.state !== 'attached' && meta\?\.state !== 'detached'\) return;\s+const session/);
    // No other path starts a watch.
    expect(body.match(/gitWatcher\.update\(/g)).toHaveLength(3);
  });

  it('reads the session\'s WSL target for a cwd change', () => {
    const start = src.indexOf('const onCwd = (payload: { sessionId: string; cwd: string }) => {');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('};', start));
    expect(body).toContain('const meta = sessionManager.getSession(payload.sessionId)?.meta;');
    expect(body).toContain('wslTarget: meta?.wslTarget');
  });
});
