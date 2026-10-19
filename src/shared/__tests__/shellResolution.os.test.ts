import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  resolveLaunchableWindowsExe,
  windowsPwsh7Candidates,
  findWindowsPwsh7,
  windowsPowerShell51Path,
  getWindowsDefaultShell,
  bareShellCandidates,
  resolveBareShellName,
} from '../shellResolution';

// Single source of truth for Windows shell candidate paths (#183) — shared
// by ShellDetector (main) and DaemonSessionManager / daemon config (daemon).
describe('shellResolution', () => {
  let origSystemRoot: string | undefined;
  let origProgramFiles: string | undefined;
  let origLocalAppData: string | undefined;
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let lstatSpy: ReturnType<typeof vi.spyOn>;
  let readlinkSpy: ReturnType<typeof vi.spyOn>;

  const PWSH7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const PS5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const ALIAS = 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
  const ALIAS_TARGET = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.0.0_x64__8wekyb3d8bbwe\\pwsh.exe';

  beforeEach(() => {
    origSystemRoot = process.env.SystemRoot;
    origProgramFiles = process.env.ProgramFiles;
    origLocalAppData = process.env.LOCALAPPDATA;
    process.env.SystemRoot = 'C:\\Windows';
    process.env.ProgramFiles = 'C:\\Program Files';
    process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
    existsSpy = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    readlinkSpy = vi.spyOn(fs, 'readlinkSync').mockImplementation(() => {
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    });
  });

  afterEach(() => {
    if (origSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = origSystemRoot;
    if (origProgramFiles === undefined) delete process.env.ProgramFiles;
    else process.env.ProgramFiles = origProgramFiles;
    if (origLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = origLocalAppData;
    existsSpy.mockRestore();
    lstatSpy.mockRestore();
    readlinkSpy.mockRestore();
  });

  const mockAlias = (targetExists: boolean): void => {
    existsSpy.mockImplementation((p: fs.PathLike) => targetExists && p === ALIAS_TARGET);
    lstatSpy.mockImplementation((p: fs.PathLike) => {
      if (p === ALIAS) return { isSymbolicLink: () => true } as fs.Stats;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    readlinkSpy.mockImplementation((p: fs.PathLike) => {
      if (p === ALIAS) return ALIAS_TARGET;
      throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    });
  };

  it('lists the traditional install before the Store alias', () => {
    expect(windowsPwsh7Candidates()).toEqual([PWSH7, ALIAS]);
  });

  it('windowsPowerShell51Path composes from SystemRoot', () => {
    expect(windowsPowerShell51Path()).toBe(PS5);
  });

  describe('resolveLaunchableWindowsExe', () => {
    it('returns a regular file as-is', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === PWSH7);
      expect(resolveLaunchableWindowsExe(PWSH7)).toBe(PWSH7);
    });

    it('resolves a Store alias to its package target', () => {
      mockAlias(true);
      expect(resolveLaunchableWindowsExe(ALIAS)).toBe(ALIAS_TARGET);
    });

    it('rejects a dead alias whose target package is gone', () => {
      mockAlias(false);
      expect(resolveLaunchableWindowsExe(ALIAS)).toBeNull();
    });

    it('rejects a missing path and an empty path', () => {
      expect(resolveLaunchableWindowsExe('C:\\nope.exe')).toBeNull();
      expect(resolveLaunchableWindowsExe('')).toBeNull();
    });
  });

  describe('findWindowsPwsh7', () => {
    it('prefers the traditional install when both flavors exist', () => {
      mockAlias(true);
      existsSpy.mockImplementation((p: fs.PathLike) => p === PWSH7 || p === ALIAS_TARGET);
      expect(findWindowsPwsh7()).toBe(PWSH7);
    });

    it('falls back to the resolved Store alias when only the Store flavor exists', () => {
      mockAlias(true);
      expect(findWindowsPwsh7()).toBe(ALIAS_TARGET);
    });

    it('returns null when no pwsh 7 is usable', () => {
      expect(findWindowsPwsh7()).toBeNull();
    });
  });

  // Bare-name resolution (#185) — the per-platform well-known location
  // tables that previously lived inside DaemonSessionManager.resolveShellPath.
  // Platform is read at CALL time, so redefining process.platform works.
  describe('bare shell name resolution', () => {
    let origPlatform: PropertyDescriptor | undefined;

    const setPlatform = (p: string): void => {
      origPlatform = origPlatform ?? Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: p, configurable: true });
    };

    afterEach(() => {
      if (origPlatform) {
        Object.defineProperty(process, 'platform', origPlatform);
        origPlatform = undefined;
      }
    });

    it('win32: resolves bare "pwsh.exe" through the Store alias (#179/#183)', () => {
      setPlatform('win32');
      mockAlias(true);
      expect(resolveBareShellName('pwsh.exe')).toBe(ALIAS_TARGET);
    });

    it('win32: resolves "powershell.exe" and "cmd.exe" to System32 paths', () => {
      setPlatform('win32');
      existsSpy.mockImplementation((p: fs.PathLike) =>
        p === PS5 || p === 'C:\\Windows\\System32\\cmd.exe',
      );
      expect(resolveBareShellName('powershell.exe')).toBe(PS5);
      expect(resolveBareShellName('cmd.exe')).toBe('C:\\Windows\\System32\\cmd.exe');
    });

    it('darwin: resolves zsh/pwsh from canonical locations', () => {
      setPlatform('darwin');
      existsSpy.mockImplementation((p: fs.PathLike) =>
        p === '/bin/zsh' || p === '/usr/local/bin/pwsh',
      );
      expect(resolveBareShellName('zsh')).toBe('/bin/zsh');
      // First homebrew candidate absent → falls through to /usr/local.
      expect(resolveBareShellName('pwsh')).toBe('/usr/local/bin/pwsh');
    });

    it('linux: resolves bash/pwsh from canonical locations', () => {
      setPlatform('linux');
      existsSpy.mockImplementation((p: fs.PathLike) =>
        p === '/bin/bash' || p === '/snap/bin/pwsh',
      );
      expect(resolveBareShellName('bash')).toBe('/bin/bash');
      expect(resolveBareShellName('pwsh')).toBe('/snap/bin/pwsh');
    });

    it('returns null for an unknown name or when nothing exists', () => {
      setPlatform('win32');
      expect(resolveBareShellName('mystery.exe')).toBeNull();
      expect(resolveBareShellName('pwsh.exe')).toBeNull();
    });

    it('candidate tables are platform-scoped', () => {
      setPlatform('darwin');
      expect(bareShellCandidates('pwsh.exe')).toEqual([]);
      expect(bareShellCandidates('pwsh')).toEqual(['/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh']);
      setPlatform('win32');
      expect(bareShellCandidates('pwsh')).toEqual([]);
      expect(bareShellCandidates('pwsh.exe')).toEqual([PWSH7, ALIAS]);
    });
  });

  describe('getWindowsDefaultShell', () => {
    it('prefers pwsh 7 over Windows PowerShell 5.1', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === PWSH7 || p === PS5);
      expect(getWindowsDefaultShell()).toBe(PWSH7);
    });

    it('prefers Store pwsh 7 over 5.1 when the traditional install is absent (#183)', () => {
      mockAlias(true);
      existsSpy.mockImplementation((p: fs.PathLike) => p === ALIAS_TARGET || p === PS5);
      expect(getWindowsDefaultShell()).toBe(ALIAS_TARGET);
    });

    it('falls back to 5.1, then cmd.exe, when pwsh 7 is absent', () => {
      existsSpy.mockImplementation((p: fs.PathLike) => p === PS5);
      expect(getWindowsDefaultShell()).toBe(PS5);
      existsSpy.mockReturnValue(false);
      expect(getWindowsDefaultShell()).toBe('cmd.exe');
    });
  });
});
