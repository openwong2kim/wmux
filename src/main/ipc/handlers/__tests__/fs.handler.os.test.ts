import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSensitivePath, localSpelling, resolveAccessiblePath } from '../fs.handler';

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
  BrowserWindow: {
    getFocusedWindow: vi.fn(),
    getAllWindows: vi.fn(() => []),
  },
}));

describe('fs.handler security helpers', () => {
  // Use an OS-native absolute home path. The previous Windows-only hardcode
  // (`path.join('C:', 'Users', 'tester')`) produced "C:/Users/tester" on
  // Unix, which path.resolve treats as a relative segment under cwd. The
  // resulting absolute path no longer prefix-matches `home`, so
  // isSensitivePath returned false and realpath was unexpectedly called.
  const home = process.platform === 'win32'
    ? path.join('C:', 'Users', 'tester')
    : path.join('/home', 'tester');
  let realpathSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    realpathSpy = vi.spyOn(fs.promises, 'realpath');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats the daemon auth token path as sensitive', () => {
    expect(isSensitivePath(path.join(home, '.wmux', 'daemon-auth-token'))).toBe(true);
  });

  it('rejects a symlink whose canonical target is sensitive', async () => {
    realpathSpy.mockResolvedValue(path.join(home, '.ssh', 'id_rsa'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'link-to-secret'))).resolves.toBeNull();
  });

  it('rejects a direct sensitive path before canonical lookup', async () => {
    await expect(resolveAccessiblePath(path.join(home, '.wmux-auth-token'))).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('returns the canonical path for an allowed target', async () => {
    const canonical = path.join(home, 'project', 'src', 'index.ts');
    realpathSpy.mockResolvedValue(canonical);

    await expect(resolveAccessiblePath(path.join(home, 'project', 'src', '..', 'src', 'index.ts'))).resolves.toBe(canonical);
  });

  it.each(['//host/share', '\\\\host\\share', '\\\\server\\share\\repo', '\\\\?\\UNC\\host\\share', '\\\\.\\pipe\\x', '\\\\?\\C:\\x'])(
    'refuses the network or device path %s before canonical lookup',
    async (p) => {
      await expect(resolveAccessiblePath(p)).resolves.toBeNull();
      expect(realpathSpy).not.toHaveBeenCalled();
    },
  );

  it('refuses a non-drive spelling whose real path is a network share', async () => {
    realpathSpy.mockResolvedValue('\\\\server\\share\\repo');
    // Relative, so it is not a drive path on any platform.
    await expect(resolveAccessiblePath(path.join('project', 'link-to-share'))).resolves.toBeNull();
  });

  it('keeps a mapped drive working, spelled from its drive', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\server\\share\\repo'));
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBe('Z:\\repo');
    // The answer and a folder below it pass the check when a caller hands them back.
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBe('Z:\\repo');
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\server\\share\\repo\\src'));
    await expect(resolveAccessiblePath('Z:\\repo\\src')).resolves.toBe('Z:\\repo\\src');
  });

  it('refuses a junction on a local drive whose real path is a share', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'C:\\' ? 'C:\\' : '\\\\host\\share'));
    await expect(resolveAccessiblePath('C:\\link')).resolves.toBeNull();
    await expect(resolveAccessiblePath('C:\\link\\child')).resolves.toBeNull();
  });

  it('refuses a link on a mapped drive whose real path is another share', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\other\\share\\repo'));
    await expect(resolveAccessiblePath('Z:\\link')).resolves.toBeNull();
    // The share-prefix check is per segment.
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\server\\shared\\repo'));
    await expect(resolveAccessiblePath('Z:\\link')).resolves.toBeNull();
  });

  it('refuses a drive path on a share when the drive root cannot be read', async () => {
    // Mapped first, so the unreadable root must also drop that mapping.
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'Z:\\' ? '\\\\server\\share\\' : '\\\\server\\share\\repo'));
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBe('Z:\\repo');
    realpathSpy.mockImplementation(async (p: fs.PathLike) => {
      if (p === 'Z:\\') throw new Error('EACCES');
      return '\\\\server\\share\\repo';
    });
    await expect(resolveAccessiblePath('Z:\\repo')).resolves.toBeNull();
    expect(localSpelling('//server/share/repo', 'Z:\\repo')).toBeNull();
  });

  it("spells git's paths on a mapped drive from that drive, and no other share", async () => {
    const onDrive = (real: string) => async (p: fs.PathLike) => (p === 'Y:\\' ? '\\\\nas\\team\\' : real);
    realpathSpy.mockImplementation(onDrive('\\\\nas\\team\\repo'));
    await expect(resolveAccessiblePath('Y:\\repo')).resolves.toBe('Y:\\repo');
    expect(localSpelling('//nas/team/repo/alpha', 'Y:\\repo')).toBe('Y:\\repo\\alpha');
    expect(localSpelling('\\\\NAS\\Team\\repo', 'Y:\\repo')).toBe('Y:\\repo');
    expect(localSpelling('//nas/teamwork/x', 'Y:\\repo')).toBeNull();
    expect(localSpelling('//other/share/repo', 'Y:\\repo')).toBeNull();
    expect(localSpelling('\\\\?\\UNC\\nas\\team\\repo', 'Y:\\repo')).toBeNull();
    expect(localSpelling('/home/me/repo', 'Y:\\repo')).toBe('/home/me/repo');
    // Only the accepted path's own drive spells a share path.
    expect(localSpelling('//nas/team/repo', 'X:\\repo')).toBeNull();
    expect(localSpelling('//nas/team/repo', '/home/me/repo')).toBeNull();
    // An answer handed back passes.
    realpathSpy.mockImplementation(onDrive('\\\\nas\\team\\repo\\alpha'));
    await expect(resolveAccessiblePath('Y:\\repo\\alpha')).resolves.toBe('Y:\\repo\\alpha');
  });

  it('forgets a mapping once the drive leads elsewhere or nowhere', async () => {
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'W:\\' ? '\\\\a\\share\\' : '\\\\a\\share\\repo'));
    await resolveAccessiblePath('W:\\repo');
    expect(localSpelling('//a/share/repo', 'W:\\repo')).toBe('W:\\repo');
    // W: mapped to another share: the old one maps to nothing.
    realpathSpy.mockImplementation(async (p: fs.PathLike) => (p === 'W:\\' ? '\\\\b\\share\\' : '\\\\b\\share\\repo'));
    await resolveAccessiblePath('W:\\repo');
    expect(localSpelling('//a/share/repo', 'W:\\repo')).toBeNull();
    expect(localSpelling('//b/share/repo', 'W:\\repo')).toBe('W:\\repo');
    // W: now a local disk.
    realpathSpy.mockImplementation(async (p: fs.PathLike) => String(p));
    await resolveAccessiblePath('W:\\repo');
    expect(localSpelling('//b/share/repo', 'W:\\repo')).toBeNull();
  });

  it('refuses a drive path whose real path is a device path', async () => {
    realpathSpy.mockResolvedValue('\\\\?\\GLOBALROOT\\Device\\x');
    await expect(resolveAccessiblePath('Z:\\x')).resolves.toBeNull();
  });

  it('keeps a WSL share as its real path', async () => {
    realpathSpy.mockResolvedValue('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
    await expect(resolveAccessiblePath(path.join(home, 'project', 'repo'))).resolves.toBe('\\\\wsl.localhost\\Ubuntu\\home\\me\\repo');
  });

  it.each([
    '\\\\wsl$\\Ubuntu\\home\\me\\.ssh\\id_rsa',
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\.aws\\credentials',
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj\\.env',
    '//wsl$/Ubuntu/home/me/.gnupg/pubring.kbx',
    '\\\\WSL.LOCALHOST\\Ubuntu/home/me/.SSH/id_rsa',
    '\\\\wsl$\\Ubuntu\\home\\me\\.config\\gcloud\\creds.db',
    '\\\\wsl$\\Ubuntu\\home\\me\\.wmux\\daemon-auth-token',
  ])('blocks the sensitive WSL path %s', async (p) => {
    expect(isSensitivePath(p)).toBe(true);
    await expect(resolveAccessiblePath(p)).resolves.toBeNull();
    expect(realpathSpy).not.toHaveBeenCalled();
  });

  it('blocks a WSL realpath that lands on a sensitive file', async () => {
    realpathSpy.mockResolvedValue('\\\\wsl$\\Ubuntu\\home\\me\\.ssh\\id_rsa');
    await expect(resolveAccessiblePath(path.join(home, 'link'))).resolves.toBeNull();
  });

  it.each([
    '\\\\wsl$\\Ubuntu\\tmp\\x.md',
    '\\\\wsl.localhost\\Ubuntu\\home\\me\\notes.md',
    '\\\\wsl$\\Ubuntu\\home\\me\\.environment',
  ])('allows the ordinary WSL path %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });

  it('returns null when canonicalization fails', async () => {
    realpathSpy.mockRejectedValue(new Error('ENOENT'));

    await expect(resolveAccessiblePath(path.join(home, 'project', 'missing.txt'))).resolves.toBeNull();
  });
});

// Windows reaches one file through several spellings; each must hit the same
// rule. String-only, so it runs on every OS with a Windows-style home.
describe('isSensitivePath — Windows path spellings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue('C:\\Users\\tester');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    '\\\\?\\C:\\Users\\tester\\.ssh\\id_rsa',
    '\\\\.\\C:\\Users\\tester\\.ssh\\id_rsa',
    '\\\\?\\UNC\\wsl$\\Ubuntu\\home\\me\\.ssh\\id_rsa',
    'C:\\Users\\tester\\.npmrc.',
    'C:\\Users\\tester\\.npmrc . .',
    'C:\\Users\\tester\\.netrc::$DATA',
    'C:\\Users\\tester.\\.wmux-auth-token',
    '//?/c:/users/tester/.ssh/id_rsa',
    'C:\\Users\\tester\\.ssh::$INDEX_ALLOCATION\\id_rsa',
    'C:\\Users\\tester\\.ssh.\\id_rsa',
    'C:\\Users\\tester\\ \\.ssh\\id_rsa',
    '\\\\.\\UNC\\wsl$\\Ubuntu\\home\\me\\.ssh\\id_rsa',
    '\\\\localhost\\C$\\Users\\tester\\.ssh\\id_rsa',
    '\\\\127.0.0.1\\c$\\Users\\tester\\.aws\\credentials',
    '\\\\?\\Volume{0f1e2d3c}\\Users\\tester\\.ssh\\id_rsa',
    'C:\\Users\\tester\\x\\..\\.ssh\\id_rsa',
    '\\\\wsl$\\Ubuntu\\home\\me\\.git-credentials',
    '\\\\localhost\\c$\\Users\\me\\.netrc',
    '\\\\?\\UNC\\localhost\\c$\\users\\me\\.npmrc',
    '\\\\localhost\\Users\\me\\.ssh\\id_rsa',
    '\\\\wsl$\\Ubuntu\\mnt\\c\\Users\\me\\.ssh\\id_rsa',
    '\\\\.\\PhysicalDrive0',
    '\\\\.\\GLOBALROOT\\Device\\HarddiskVolume3\\Users\\tester\\notes.md',
  ])('blocks %s', (p) => {
    expect(isSensitivePath(p)).toBe(true);
  });

  it.each([
    'C:\\Users\\tester\\notes.npmrc.txt',
    'C:\\Users\\tester\\proj\\.npmrc-backup',
    '\\\\?\\C:\\Users\\tester\\proj\\readme.md',
    '\\\\?\\Volume{0f1e2d3c}\\Users\\tester\\notes.md',
    '\\\\nas\\repos\\proj\\.aws\\fixture.json',
    '\\\\nas\\repos\\proj\\.env',
    'C:\\Users\\tester\\.ssh\\..\\notes.md',
  ])('allows %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });
});

// POSIX names are taken as written: a trailing dot or a colon is part of the
// name there, and a blocked directory matches only as a whole segment.
describe('isSensitivePath — POSIX names', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(os, 'homedir').mockReturnValue('/home/tester');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    '/home/tester/.npmrc.',
    '/home/tester/a:b',
    '/home/tester/.sshfs-mounts/x',
  ])('allows %s', (p) => {
    expect(isSensitivePath(p)).toBe(false);
  });

  it('still blocks the directory itself and what is under it', () => {
    expect(isSensitivePath('/home/tester/.ssh')).toBe(true);
    expect(isSensitivePath('/home/tester/.ssh/id_rsa')).toBe(true);
  });
});

it('matches the home in either Unicode normal form', () => {
  vi.spyOn(os, 'homedir').mockReturnValue('/Users/Jos\u00e9');
  try {
    expect(isSensitivePath('/Users/Jose\u0301/.ssh/id_rsa')).toBe(true);
  } finally {
    vi.restoreAllMocks();
  }
});
