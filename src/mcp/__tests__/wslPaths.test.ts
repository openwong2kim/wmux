import { describe, expect, it } from 'vitest';
import { fromAgentPath, toAgentPath, wslMountRoot, wslPathToHost } from '../wslPaths';

const wsl = (mount?: string): NodeJS.ProcessEnv => ({
  WMUX_WSL_DISTRO: 'Ubuntu',
  ...(mount === undefined ? {} : { WMUX_WSL_MOUNT: mount }),
});

describe('wslMountRoot', () => {
  it('is null without a WSL distro, whatever the mount says', () => {
    expect(wslMountRoot({})).toBeNull();
    expect(wslMountRoot({ WMUX_WSL_DISTRO: '', WMUX_WSL_MOUNT: '/mnt/c/' })).toBeNull();
  });

  it('derives the automount root from the C: drive mount', () => {
    expect(wslMountRoot(wsl('/mnt/c/'))).toBe('/mnt/');
    expect(wslMountRoot(wsl('/mnt/c'))).toBe('/mnt/');
    expect(wslMountRoot(wsl('/c/'))).toBe('/');
    expect(wslMountRoot(wsl('/windows/c/\n'))).toBe('/windows/');
  });

  it('falls back to /mnt/ when the mount is empty, missing or unparseable', () => {
    expect(wslMountRoot(wsl(''))).toBe('/mnt/');
    expect(wslMountRoot(wsl())).toBe('/mnt/');
    expect(wslMountRoot(wsl('wslpath: C:\\: not found'))).toBe('/mnt/');
  });
});

describe('toAgentPath', () => {
  it('is the identity for a non-WSL caller', () => {
    expect(toAgentPath('C:\\Users\\me\\.wmux\\uploads', {})).toBe('C:\\Users\\me\\.wmux\\uploads');
  });

  it('maps drive paths under the mount root, lowercasing the drive', () => {
    expect(toAgentPath('C:\\Users\\me\\.wmux\\uploads', wsl('/mnt/c/'))).toBe('/mnt/c/Users/me/.wmux/uploads');
    expect(toAgentPath('d:/tmp/x.pdf', wsl(''))).toBe('/mnt/d/tmp/x.pdf');
    expect(toAgentPath('E:\\a b\\c.zip', wsl('/c/'))).toBe('/e/a b/c.zip');
    expect(toAgentPath('C:\\', wsl('/mnt/c/'))).toBe('/mnt/c/');
  });

  it('passes UNC, relative and POSIX paths through', () => {
    const env = wsl('/mnt/c/');
    expect(toAgentPath('\\\\server\\share\\x.png', env)).toBe('\\\\server\\share\\x.png');
    expect(toAgentPath('relative\\x.png', env)).toBe('relative\\x.png');
    expect(toAgentPath('/tmp/x.png', env)).toBe('/tmp/x.png');
    expect(toAgentPath('(pending)', env)).toBe('(pending)');
    expect(toAgentPath('C:relative', env)).toBe('C:relative');
  });
});

describe('fromAgentPath', () => {
  it('is the identity for a non-WSL caller, POSIX paths included', () => {
    expect(fromAgentPath('/mnt/c/Users/me/a.png', {})).toBe('/mnt/c/Users/me/a.png');
    expect(fromAgentPath('/home/me/a.png', {})).toBe('/home/me/a.png');
  });

  it('maps drive-mount paths to Windows paths, uppercasing the drive', () => {
    expect(fromAgentPath('/mnt/c/Users/me/.wmux/uploads/a.png', wsl('/mnt/c/')))
      .toBe('C:\\Users\\me\\.wmux\\uploads\\a.png');
    expect(fromAgentPath('/mnt/d', wsl(''))).toBe('D:\\');
    expect(fromAgentPath('/c/Users/me', wsl('/c/'))).toBe('C:\\Users\\me');
  });

  it('leaves .. segments for the caller to resolve', () => {
    expect(fromAgentPath('/mnt/c/up/../../x', wsl('/mnt/c/'))).toBe('C:\\up\\..\\..\\x');
  });

  it('round-trips with toAgentPath', () => {
    const env = wsl('/mnt/c/');
    expect(toAgentPath(fromAgentPath('/mnt/c/Users/me/x.txt', env) as string, env)).toBe('/mnt/c/Users/me/x.txt');
  });

  it('returns null for distro paths with no drive equivalent', () => {
    expect(fromAgentPath('/home/me/a.png', wsl('/mnt/c/'))).toBeNull();
    expect(fromAgentPath('/mnt/wsl/x', wsl('/mnt/c/'))).toBeNull();
    expect(fromAgentPath('/mnt/', wsl('/mnt/c/'))).toBeNull();
    // With a `/` root a drive is a single-letter top-level segment only.
    expect(fromAgentPath('/home/me', wsl('/c/'))).toBeNull();
    expect(fromAgentPath('/cfoo/x', wsl('/c/'))).toBeNull();
  });

  it('passes Windows paths through and refuses relative ones for a WSL caller', () => {
    const env = wsl('/mnt/c/');
    expect(fromAgentPath('C:\\x\\a.png', env)).toBe('C:\\x\\a.png');
    expect(fromAgentPath('\\\\server\\share\\a.png', env)).toBe('\\\\server\\share\\a.png');
    // Relative to the agent's Linux cwd, which the Windows server cannot know.
    expect(fromAgentPath('a.png', env)).toBeNull();
    expect(fromAgentPath('./proj', env)).toBeNull();
    expect(fromAgentPath('a.png', {})).toBe('a.png');
  });
});

describe('wslPathToHost', () => {
  it('maps the drive mount without needing a distro, keeping spaces and dots', () => {
    expect(wslPathToHost('/mnt/d/2026/1. coding/1. coding/260618.ax-tm', undefined))
      .toEqual({ path: 'D:\\2026\\1. coding\\1. coding\\260618.ax-tm' });
    expect(wslPathToHost('/mnt/c', undefined)).toEqual({ path: 'C:\\' });
  });

  it('honours a known automount root', () => {
    expect(wslPathToHost('/e/x', 'Ubuntu', '/c/')).toEqual({ path: 'E:\\x' });
  });

  it("maps a distro-internal path into the distro's \\\\wsl$ share", () => {
    expect(wslPathToHost('/home/me/my repo', 'Ubuntu-24.04')).toEqual({ path: '\\\\wsl$\\Ubuntu-24.04\\home\\me\\my repo' });
    // `/mnt/cfoo` is not a drive.
    expect(wslPathToHost('/mnt/cfoo', 'Ubuntu')).toEqual({ path: '\\\\wsl$\\Ubuntu\\mnt\\cfoo' });
  });

  it('refuses rather than guesses without a valid distro, or for a non-absolute path', () => {
    expect(wslPathToHost('/home/me/repo', undefined)).toMatchObject({ error: expect.stringMatching(/distro is unknown/) });
    expect(wslPathToHost('/home/me/repo', 'bad\\name')).toHaveProperty('error');
    expect(wslPathToHost('repo', 'Ubuntu')).toHaveProperty('error');
    expect(wslPathToHost('//server/share', 'Ubuntu')).toHaveProperty('error');
  });
});

describe('wslPathToHost refuses Linux names Windows would read differently', () => {
  it('refuses a backslash segment that would climb to a sibling directory', () => {
    // One directory named `..\other` inside repo, not repo's parent.
    const res = wslPathToHost('/home/me/repo/..\\other', 'Ubuntu');
    expect(res).toMatchObject({ error: expect.stringMatching(/cannot be translated safely/) });
    expect(wslPathToHost('/mnt/d/repo/..\\other', undefined)).toHaveProperty('error');
  });

  it('refuses a colon and the rest of the Windows-reserved set', () => {
    for (const ch of [':', '*', '?', '"', '<', '>', '|']) {
      expect(wslPathToHost(`/home/me/a${ch}b`, 'Ubuntu')).toHaveProperty('error');
    }
  });

  it('refuses a trailing dot or space, which Win32 strips onto a sibling', () => {
    // Seen live on Windows 11: a WSL pane in /mnt/d/x/alias. (not a repo) was
    // fanned out from D:\x\alias, a different repository.
    for (const p of ['/mnt/d/x/alias.', '/mnt/d/x/alias ', '/mnt/d/x/alias./sub', '/home/me/repo.', '/home/me/repo..']) {
      expect(wslPathToHost(p, 'Ubuntu')).toMatchObject({ error: expect.stringMatching(/cannot be translated safely/) });
    }
  });

  it('refuses a device name, with or without an extension', () => {
    for (const name of ['con', 'NUL', 'aux.txt', 'com1', 'LPT9.log', 'com¹']) {
      expect(wslPathToHost(`/mnt/d/x/${name}`, 'Ubuntu')).toHaveProperty('error');
    }
  });

  it('keeps names that only resemble those', () => {
    for (const p of ['/mnt/d/x/.git', '/mnt/d/x/a.b', '/mnt/d/x/console', '/mnt/d/x/com10', '/mnt/d/x/nul_', '/mnt/d/x/..', '/mnt/d/x/./y']) {
      expect(wslPathToHost(p, 'Ubuntu')).toHaveProperty('path');
    }
  });
});
