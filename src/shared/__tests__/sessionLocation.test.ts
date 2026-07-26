import { describe, expect, it } from 'vitest';
import {
  classifySessionLocation,
  locationIdentity,
  locationsEqual,
  prepareLocationCommand,
  resolveReplayLocation,
  toHostAccessiblePath,
} from '../sessionLocation';

describe('session location classification and identity', () => {
  it.each([
    ['pwsh.exe', 'C:\\Repo', undefined, 'host'],
    ['/bin/bash', '/home/me/Repo', undefined, 'host'],
    ['wsl.exe', '/home/me/Repo', 'Ubuntu', 'wsl'],
    ['wsl.exe', '\\\\wsl.localhost\\Debian\\home\\me', undefined, 'wsl'],
  ] as const)('classifies %s %s as %s', (shell, cwd, distro, domain) => {
    expect(classifySessionLocation(shell, cwd, distro).domain).toBe(domain);
  });

  it('keeps Linux case sensitivity and isolates domains and distros', () => {
    const ubuntu = classifySessionLocation('wsl.exe', '/Repo', 'Ubuntu');
    const debian = classifySessionLocation('wsl.exe', '/Repo', 'Debian');
    expect(locationsEqual(ubuntu, classifySessionLocation('wsl.exe', '/repo', 'Ubuntu'))).toBe(false);
    expect(locationIdentity(ubuntu)).not.toBe(locationIdentity(debian));
    expect(locationIdentity(ubuntu)).not.toBe(
      locationIdentity(classifySessionLocation('bash.exe', '/Repo')),
    );
  });

  it('applies Windows drive casing rules only to host locations', () => {
    expect(locationsEqual(
      classifySessionLocation('pwsh.exe', 'C:\\Repo\\'),
      classifySessionLocation('pwsh.exe', 'c:/Repo'),
    )).toBe(true);
  });
});

describe('session location operations', () => {
  it('preserves a guest cwd during replay without asking Windows fs', () => {
    const existsCalls: string[] = [];
    const result = resolveReplayLocation('wsl.exe', '/home/me/project', 'C:\\Users\\me', (cwd) => {
      existsCalls.push(cwd);
      return false;
    }, 'Ubuntu');
    expect(result.location.cwd).toBe('/home/me/project');
    expect(result.spawnCwd).toBe('C:\\Users\\me');
    expect(result.prefixArgs).toEqual(['--cd', '/home/me/project']);
    expect(result.degraded).toBe(false);
    expect(existsCalls).toEqual([]);
  });

  it('falls back only for a missing host cwd', () => {
    const result = resolveReplayLocation(
      'pwsh.exe',
      'C:\\missing',
      'C:\\Users\\me',
      () => false,
    );
    expect(result.location.cwd).toBe('C:\\Users\\me');
    expect(result.degraded).toBe(true);
    expect(result.originalCwd).toBe('C:\\missing');
  });

  it('builds explicit host paths and refuses unresolved guest paths', () => {
    expect(toHostAccessiblePath(
      classifySessionLocation('wsl.exe', '/mnt/c/dev/x', 'Ubuntu'),
      '/mnt/c/dev/x/a.ts',
    )).toEqual({ ok: true, path: 'C:\\dev\\x\\a.ts' });
    expect(toHostAccessiblePath(
      classifySessionLocation('wsl.exe', '/home/me/x'),
      '/home/me/x/a.ts',
    )).toEqual({ ok: false, error: 'WSL_DISTRO_REQUIRED' });
    expect(toHostAccessiblePath(
      classifySessionLocation('wsl.exe', '/home/me/x', 'Ubuntu'),
      '/home/me/x/a.ts',
    )).toEqual({ ok: true, path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\x\\a.ts' });
  });

  it('requires a matching active pane context before preparing passive WSL work', () => {
    const location = classifySessionLocation('wsl.exe', '/home/me/x', 'Ubuntu');
    expect(prepareLocationCommand(location, 'git', ['status'], undefined)).toEqual({
      ok: false,
      error: 'ACTIVE_CONTEXT_REQUIRED',
    });
    expect(prepareLocationCommand(location, 'git', ['status'], {
      sessionId: 'pty-1',
      active: true,
      distro: 'Ubuntu',
    })).toEqual({
      ok: true,
      file: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--cd', '/home/me/x', '--exec', 'git', 'status'],
    });
  });
});
