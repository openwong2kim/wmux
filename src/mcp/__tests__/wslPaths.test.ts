import { describe, expect, it } from 'vitest';
import { fromAgentPath, toAgentPath, wslMountRoot } from '../wslPaths';

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

  it('passes relative and Windows paths through for a WSL caller', () => {
    const env = wsl('/mnt/c/');
    expect(fromAgentPath('a.png', env)).toBe('a.png');
    expect(fromAgentPath('C:\\x\\a.png', env)).toBe('C:\\x\\a.png');
  });
});
