import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySessionLocation,
  hostLocation,
  locationIdentity,
  locationsEqual,
  parseSessionLocation,
  prepareLocationCommand,
  preparePtyLocation,
  resolveReplayLocation,
  resolveSessionLocation,
  toHostAccessiblePath,
  toWslGuestPath,
} from '../sessionLocation';

/**
 * The guest-path guard is Windows-only, so pin the platform rather than let
 * these cases pass for the wrong reason on whichever CI leg runs them.
 */
function onPlatform(platform: NodeJS.Platform): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}
const onWindows = () => onPlatform('win32');
afterEach(() => vi.restoreAllMocks());

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

  // CX8: a PR-creation `invalidate(worktreePath, branch)` must hit the entry
  // the metadata poll's `get(cwd, branch)` created. Casing variance between
  // the two callers is the documented way that missed.
  it('folds host path casing on case-insensitive filesystems', () => {
    expect(locationsEqual(
      hostLocation('C:\\Repo\\WT'),
      hostLocation('c:/repo/wt/'),
    )).toBe(true);
    expect(locationsEqual(
      hostLocation('/Users/Geoffrey/dev/Repo'),
      hostLocation('/users/geoffrey/dev/repo'),
      'darwin',
    )).toBe(true);
  });

  it('keeps backslash a legal filename character off Windows', () => {
    expect(locationsEqual(
      hostLocation('/x/a\\b'),
      hostLocation('/x/a/b'),
      'linux',
    )).toBe(false);
    expect(locationsEqual(
      hostLocation('/x/A'),
      hostLocation('/x/a'),
      'linux',
    )).toBe(false);
  });
});

describe('the single wire validator and legacy fallback', () => {
  it('accepts all three domains over the wire', () => {
    for (const domain of ['host', 'msys', 'wsl'] as const) {
      expect(parseSessionLocation({ domain, cwd: '/x', shell: 'sh' })?.domain).toBe(domain);
    }
  });

  it('rejects malformed payloads and reads a bare cwd as a host location', () => {
    expect(parseSessionLocation({ domain: 'nope', cwd: '/x', shell: '' })).toBeNull();
    expect(parseSessionLocation({ domain: 'host', cwd: '  ', shell: '' })).toBeNull();
    expect(parseSessionLocation({ domain: 'wsl', cwd: '/x', shell: '', distro: 7 })).toBeNull();
    expect(parseSessionLocation('')).toBeNull();
    expect(parseSessionLocation(null)).toBeNull();
    expect(parseSessionLocation(' C:\\repo ')).toEqual({ domain: 'host', cwd: 'C:\\repo', shell: '' });
  });

  it('classifies a legacy {cmd, cwd} record and prefers a stored location', () => {
    expect(resolveSessionLocation({ cmd: 'wsl.exe', cwd: '/home/me', distro: 'Ubuntu' })).toEqual({
      domain: 'wsl', cwd: '/home/me', shell: 'wsl.exe', distro: 'Ubuntu',
    });
    expect(resolveSessionLocation({
      cmd: 'wsl.exe',
      cwd: '/home/me',
      location: { domain: 'host', cwd: 'C:\\repo', shell: 'pwsh.exe' },
    }).domain).toBe('host');
  });
});

describe('the guest-path guard (issue #21 AC 6)', () => {
  it('refuses to resolve a guest path carried by a host location on Windows', () => {
    onWindows();
    // How this arises: a workspace profile with no `shell`, so nothing can
    // classify the cwd as wsl/msys, leaves `/home/me/proj` on a host location.
    const stranded = classifySessionLocation('', '/home/me/proj');
    expect(stranded.domain).toBe('host');
    expect(toHostAccessiblePath(stranded, '/home/me/proj/a.ts')).toEqual({
      ok: false, error: 'UNRESOLVED_GUEST_PATH',
    });
    expect(prepareLocationCommand(stranded, 'git', ['status'])).toEqual({
      ok: false, error: 'UNRESOLVED_GUEST_PATH',
    });
  });

  it('leaves genuine POSIX host paths alone off Windows', () => {
    onPlatform('linux');
    const posix = classifySessionLocation('/bin/bash', '/home/me/proj');
    expect(toHostAccessiblePath(posix, '/home/me/proj/a.ts')).toEqual({
      ok: true, path: '/home/me/proj/a.ts',
    });
  });

  it('still allows real Windows paths on a host location', () => {
    onWindows();
    expect(toHostAccessiblePath(hostLocation('C:\\repo'), 'C:\\repo\\a.ts')).toEqual({
      ok: true, path: 'C:\\repo\\a.ts',
    });
  });
});

describe('one spawn-cwd computation', () => {
  const split = (shell: string, cwd: string) =>
    preparePtyLocation(classifySessionLocation(shell, cwd), 'C:\\Users\\me');

  it('routes an MSYS cwd to its Windows path instead of handing node-pty /c/...', () => {
    expect(split('C:\\Program Files\\Git\\bin\\bash.exe', '/c/dev/x'))
      .toEqual({ spawnCwd: 'C:\\dev\\x', prefixArgs: [] });
  });

  it('marks an unconvertible MSYS cwd when it must use host home', () => {
    expect(split('C:\\Program Files\\Git\\bin\\bash.exe', '/usr/bin'))
      .toEqual({ spawnCwd: 'C:\\Users\\me', prefixArgs: [], degraded: true });
  });

  it('positions WSL with --cd and leaves a host path alone', () => {
    expect(split('wsl.exe', '/home/me'))
      .toEqual({ spawnCwd: 'C:\\Users\\me', prefixArgs: ['--cd', '/home/me'] });
    expect(split('pwsh.exe', 'C:\\dev\\x'))
      .toEqual({ spawnCwd: 'C:\\dev\\x', prefixArgs: [] });
  });
});

describe('session location operations', () => {
  it.each([
    ['/home/Alice/Project', '/home/Alice/Project'],
    ['\\\\wsl.localhost\\Ubuntu\\home\\Alice\\Project', '/home/Alice/Project'],
    ['\\\\wsl$\\Ubuntu', '/'],
    ['//wsl.localhost/Ubuntu/root/.ssh', '/root/.ssh'],
  ])('decomposes a WSL path through one canonical operation: %s', (input, expected) => {
    const location = classifySessionLocation('wsl.exe', '/home/Alice', 'Ubuntu');
    expect(toWslGuestPath(location, input)).toEqual({ ok: true, path: expected });
  });

  it('rejects non-WSL, malformed, and mismatched WSL paths', () => {
    const ubuntu = classifySessionLocation('wsl.exe', '/home/me', 'Ubuntu');
    expect(toWslGuestPath(undefined, '/home/me')).toEqual({
      ok: false, error: 'UNSUPPORTED_WSL_PATH',
    });
    expect(toWslGuestPath(ubuntu, 'C:\\Users\\me')).toEqual({
      ok: false, error: 'UNSUPPORTED_WSL_PATH',
    });
    expect(toWslGuestPath(ubuntu, '\\\\server\\share\\file')).toEqual({
      ok: false, error: 'UNSUPPORTED_WSL_PATH',
    });
    expect(toWslGuestPath(ubuntu, '\\\\wsl.localhost\\Debian\\home\\me')).toEqual({
      ok: false, error: 'WSL_DISTRO_MISMATCH',
    });
  });

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

  it('reports a non-convertible MSYS cwd as degraded instead of clean at host home', () => {
    const hostHome = 'C:\\Users\\me';
    const result = resolveReplayLocation(
      'C:\\Program Files\\Git\\bin\\bash.exe',
      '/usr/bin',
      hostHome,
      (cwd) => cwd === hostHome,
    );

    expect(result).toEqual({
      location: {
        domain: 'host',
        cwd: hostHome,
        shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
      },
      spawnCwd: hostHome,
      prefixArgs: [],
      degraded: true,
      originalCwd: '/usr/bin',
    });
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

  it('keeps Git Bash/MSYS conversion distinct from WSL conversion', () => {
    const msys = classifySessionLocation('C:\\Program Files\\Git\\bin\\bash.exe', '/c/dev/x');
    expect(msys.domain).toBe('msys');
    expect(toHostAccessiblePath(
      msys,
      '/c/dev/x/a.ts',
    )).toEqual({ ok: true, path: 'C:\\dev\\x\\a.ts' });
    expect(toHostAccessiblePath(msys, '/usr/bin/tool')).toEqual({
      ok: false,
      error: 'UNSUPPORTED_MSYS_PATH',
    });
    expect(toHostAccessiblePath(
      classifySessionLocation('wsl.exe', '/c/dev/x', 'Ubuntu'),
      '/c/dev/x/a.ts',
    )).toEqual({ ok: true, path: '\\\\wsl.localhost\\Ubuntu\\c\\dev\\x\\a.ts' });
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
