import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';

// Hoisted mutable state shared between the vi.mock factory and the tests.
const platformState = vi.hoisted(() => {
  const state = {
    isWindows: process.platform === 'win32',
    isMac: process.platform === 'darwin',
    isLinux: process.platform === 'linux',
  };
  return {
    state,
    set(p: 'win32' | 'darwin' | 'linux'): void {
      state.isWindows = p === 'win32';
      state.isMac = p === 'darwin';
      state.isLinux = p === 'linux';
    },
  };
});

vi.mock('../platform', () => ({
  get isWindows() { return platformState.state.isWindows; },
  get isMac() { return platformState.state.isMac; },
  get isLinux() { return platformState.state.isLinux; },
  get isUnix() { return !platformState.state.isWindows; },
  platformChoice<T>(choices: { win?: T; mac?: T; linux?: T; default: T }): T {
    if (platformState.state.isWindows && choices.win !== undefined) return choices.win;
    if (platformState.state.isMac && choices.mac !== undefined) return choices.mac;
    if (platformState.state.isLinux && choices.linux !== undefined) return choices.linux;
    return choices.default;
  },
}));

import { ShellDetector } from '../ShellDetector';

describe('ShellDetector', () => {
  let existsSpy: ReturnType<typeof vi.spyOn>;
  let originalShell: string | undefined;

  beforeEach(() => {
    existsSpy = vi.spyOn(fs, 'existsSync');
    originalShell = process.env.SHELL;
  });

  afterEach(() => {
    existsSpy.mockRestore();
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  });

  describe('mac', () => {
    beforeEach(() => {
      platformState.set('darwin');
    });

    it('prefers $SHELL when it exists', () => {
      process.env.SHELL = '/bin/zsh';
      existsSpy.mockImplementation((p: fs.PathLike) => p === '/bin/zsh' || p === '/bin/bash');
      const detector = new ShellDetector();
      const shells = detector.detect();
      expect(shells[0].path).toBe('/bin/zsh');
      expect(shells[0].name).toBe('Zsh');
    });

    it('finds /bin/bash and homebrew pwsh', () => {
      delete process.env.SHELL;
      existsSpy.mockImplementation((p: fs.PathLike) =>
        p === '/bin/bash' || p === '/opt/homebrew/bin/pwsh',
      );
      const detector = new ShellDetector();
      const shells = detector.detect();
      const paths = shells.map((s) => s.path);
      expect(paths).toContain('/bin/bash');
      expect(paths).toContain('/opt/homebrew/bin/pwsh');
      expect(shells.find((s) => s.path === '/opt/homebrew/bin/pwsh')?.name).toBe('PowerShell 7');
    });

    it('does not include windows-only shells', () => {
      delete process.env.SHELL;
      existsSpy.mockReturnValue(true);
      const detector = new ShellDetector();
      const shells = detector.detect();
      for (const s of shells) {
        expect(s.path.toLowerCase()).not.toContain('cmd.exe');
        expect(s.path.toLowerCase()).not.toContain('powershell.exe');
        expect(s.path.toLowerCase()).not.toContain('wsl.exe');
      }
    });

    it('getDefault falls back to /bin/zsh when nothing found', () => {
      delete process.env.SHELL;
      existsSpy.mockReturnValue(false);
      const detector = new ShellDetector();
      expect(detector.getDefault()).toBe('/bin/zsh');
    });
  });

  describe('linux', () => {
    beforeEach(() => {
      platformState.set('linux');
    });

    it('prefers $SHELL when it exists', () => {
      process.env.SHELL = '/usr/bin/fish';
      existsSpy.mockImplementation((p: fs.PathLike) => p === '/usr/bin/fish' || p === '/bin/bash');
      const detector = new ShellDetector();
      const shells = detector.detect();
      expect(shells[0].path).toBe('/usr/bin/fish');
      expect(shells[0].name).toBe('Fish');
    });

    it('detects bash, zsh, fish, pwsh from canonical paths', () => {
      delete process.env.SHELL;
      const present = new Set([
        '/bin/bash',
        '/bin/zsh',
        '/usr/bin/fish',
        '/usr/bin/pwsh',
      ]);
      existsSpy.mockImplementation((p: fs.PathLike) => present.has(String(p)));
      const detector = new ShellDetector();
      const shells = detector.detect();
      const paths = shells.map((s) => s.path);
      expect(paths).toEqual(expect.arrayContaining([
        '/bin/bash',
        '/bin/zsh',
        '/usr/bin/fish',
        '/usr/bin/pwsh',
      ]));
    });

    it('getDefault falls back to /bin/bash when nothing found', () => {
      delete process.env.SHELL;
      existsSpy.mockReturnValue(false);
      const detector = new ShellDetector();
      expect(detector.getDefault()).toBe('/bin/bash');
    });
  });

  describe('windows', () => {
    let origSystemRoot: string | undefined;
    let origProgramFiles: string | undefined;

    beforeEach(() => {
      platformState.set('win32');
      // The shared candidate table (shellResolution.ts) composes paths from
      // these env vars via template literals — pin them so the constants
      // below match the source's exact strings on any CI OS.
      origSystemRoot = process.env.SystemRoot;
      origProgramFiles = process.env.ProgramFiles;
      process.env.SystemRoot = 'C:\\Windows';
      process.env.ProgramFiles = 'C:\\Program Files';
    });

    afterEach(() => {
      if (origSystemRoot === undefined) delete process.env.SystemRoot;
      else process.env.SystemRoot = origSystemRoot;
      if (origProgramFiles === undefined) delete process.env.ProgramFiles;
      else process.env.ProgramFiles = origProgramFiles;
    });

    it('does not include unix-only shells', () => {
      existsSpy.mockReturnValue(true);
      const detector = new ShellDetector();
      const shells = detector.detect();
      for (const s of shells) {
        expect(s.path).not.toBe('/bin/bash');
        expect(s.path).not.toBe('/bin/zsh');
        expect(s.path).not.toBe('/usr/bin/fish');
      }
    });

    // Issue #176: when both PowerShell 7 and Windows PowerShell 5.1 are
    // installed, the default must be PowerShell 7. 5.1 is present on every
    // Windows box, so a 5.1-first ordering would mask pwsh 7 forever.
    it('lists PowerShell 7 before Windows PowerShell 5.1 and picks it as default', () => {
      const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
      // shellResolution.ts builds candidate paths with backslash template
      // literals (env pinned above), so plain literals match on any CI OS.
      const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      existsSpy.mockImplementation((p: fs.PathLike) => p === pwsh7 || p === ps5);
      const detector = new ShellDetector();
      const shells = detector.detect();
      const i7 = shells.findIndex((s) => s.path === pwsh7);
      const i5 = shells.findIndex((s) => s.path === ps5);
      expect(i7).toBeGreaterThanOrEqual(0);
      expect(i5).toBeGreaterThan(i7);
      expect(detector.getDefault()).toBe(pwsh7);
    });

    // Issue #179: Store-installed pwsh 7 lives behind an App Execution Alias
    // (a reparse-point symlink) that fs.existsSync() does not follow, so an
    // existsSync-only gate misses it and 5.1 wins despite pwsh being usable.
    // Dogfood found a second trap: node-pty cannot spawn the alias stub
    // directly (it falls back to 5.1), so the detector must hand back the
    // RESOLVED package target, not the alias path itself.
    describe('Store-build pwsh App Execution Alias (#179)', () => {
      const aliasPath = 'C:\\Users\\test\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe';
      const aliasTarget = 'C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.5.0.0_x64__8wekyb3d8bbwe\\pwsh.exe';
      const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      let originalLocalAppData: string | undefined;
      let lstatSpy: ReturnType<typeof vi.spyOn>;
      let readlinkSpy: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        originalLocalAppData = process.env.LOCALAPPDATA;
        process.env.LOCALAPPDATA = 'C:\\Users\\test\\AppData\\Local';
        lstatSpy = vi.spyOn(fs, 'lstatSync');
        readlinkSpy = vi.spyOn(fs, 'readlinkSync');
      });

      afterEach(() => {
        lstatSpy.mockRestore();
        readlinkSpy.mockRestore();
        if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = originalLocalAppData;
      });

      it('resolves the alias to its package target (not the alias path) so node-pty can spawn it', () => {
        existsSpy.mockImplementation((p: fs.PathLike) => p === aliasTarget || p === ps5);
        lstatSpy.mockImplementation((p: fs.PathLike) => {
          if (p === aliasPath) return { isSymbolicLink: () => true } as fs.Stats;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        readlinkSpy.mockImplementation((p: fs.PathLike) => {
          if (p === aliasPath) return aliasTarget;
          throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
        });
        const detector = new ShellDetector();
        const shells = detector.detect();
        const pwsh = shells.find((s) => s.name === 'PowerShell 7');
        // The resolved target, NOT the alias — the alias stub is unspawnable.
        expect(pwsh?.path).toBe(aliasTarget);
        expect(detector.getDefault()).toBe(aliasTarget);
      });

      it('skips a dead alias stub whose target package is gone', () => {
        existsSpy.mockImplementation((p: fs.PathLike) => p === ps5);
        lstatSpy.mockImplementation((p: fs.PathLike) => {
          if (p === aliasPath) return { isSymbolicLink: () => true } as fs.Stats;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        readlinkSpy.mockImplementation((p: fs.PathLike) => {
          if (p === aliasPath) return aliasTarget;
          throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
        });
        const detector = new ShellDetector();
        const shells = detector.detect();
        expect(shells.find((s) => s.name === 'PowerShell 7')).toBeUndefined();
        expect(detector.getDefault()).toBe(ps5);
      });

      it('skips the alias path when readlink fails', () => {
        existsSpy.mockImplementation((p: fs.PathLike) => p === ps5);
        lstatSpy.mockImplementation((p: fs.PathLike) => {
          if (p === aliasPath) return { isSymbolicLink: () => true } as fs.Stats;
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        });
        readlinkSpy.mockImplementation(() => {
          throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
        });
        const detector = new ShellDetector();
        expect(detector.getDefault()).toBe(ps5);
      });
    });

    it('getDefault falls back to Windows PowerShell 5.1 when pwsh 7 is absent', () => {
      const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
      existsSpy.mockImplementation((p: fs.PathLike) => p === ps5);
      const detector = new ShellDetector();
      expect(detector.getDefault()).toBe(ps5);
    });
  });
});
