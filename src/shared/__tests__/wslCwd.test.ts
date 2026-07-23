import { describe, it, expect } from 'vitest';
import { applyWslPromptIntegration, isWslShell, isLinuxLikeCwd, splitWslCwd } from '../wslCwd';

// Track B (WSL/Ubuntu cwd) — a Linux-style cwd handed to a WSL pane must
// launch via `wsl.exe --cd <linuxpath>` rather than node-pty's `cwd` spawn
// option, which can only ever resolve a Windows path. See wslCwd.ts's module
// doc for why ConPTY/CreateProcess can't take the Linux path directly.
describe('isWslShell', () => {
  it('recognizes an absolute Windows path to wsl.exe', () => {
    expect(isWslShell('C:\\Windows\\System32\\wsl.exe')).toBe(true);
  });

  it('recognizes a bare wsl.exe', () => {
    expect(isWslShell('wsl.exe')).toBe(true);
  });

  it('recognizes a bare wsl (no extension)', () => {
    expect(isWslShell('wsl')).toBe(true);
  });

  it('recognizes a forward-slash path to wsl.exe', () => {
    expect(isWslShell('C:/Windows/System32/wsl.exe')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isWslShell('C:\\Windows\\System32\\WSL.EXE')).toBe(true);
  });

  it('returns false for other shells', () => {
    expect(isWslShell('cmd.exe')).toBe(false);
    expect(isWslShell('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(false);
  });
});

describe('isLinuxLikeCwd', () => {
  it('recognizes an absolute Linux path', () => {
    expect(isLinuxLikeCwd('/home/geoffrey/projects/x')).toBe(true);
  });

  it('recognizes a ~-relative path', () => {
    expect(isLinuxLikeCwd('~/projects/x')).toBe(true);
    expect(isLinuxLikeCwd('~')).toBe(true);
  });

  it('recognizes \\\\wsl$\\ UNC paths, case-insensitively', () => {
    expect(isLinuxLikeCwd('\\\\wsl$\\Ubuntu\\home\\geoffrey')).toBe(true);
    expect(isLinuxLikeCwd('\\\\WSL$\\Ubuntu\\home\\geoffrey')).toBe(true);
  });

  it('recognizes \\\\wsl.localhost\\ UNC paths, case-insensitively', () => {
    expect(isLinuxLikeCwd('\\\\wsl.localhost\\Ubuntu\\home\\geoffrey')).toBe(true);
    expect(isLinuxLikeCwd('\\\\WSL.LOCALHOST\\Ubuntu\\home\\geoffrey')).toBe(true);
  });

  it('rejects a Windows path', () => {
    expect(isLinuxLikeCwd('C:\\Users\\geoffrey\\projects\\x')).toBe(false);
  });
});

describe('splitWslCwd', () => {
  const home = 'C:\\Users\\geoffrey';

  it('splits an absolute Linux path under wsl.exe', () => {
    expect(splitWslCwd('wsl.exe', '/home/x', home)).toEqual({
      spawnCwd: home,
      prefixArgs: ['--cd', '/home/x'],
    });
  });

  it('passes a Windows path through unchanged under wsl.exe', () => {
    expect(splitWslCwd('wsl.exe', 'C:\\Users\\x', home)).toEqual({
      spawnCwd: 'C:\\Users\\x',
      prefixArgs: [],
    });
  });

  it('passes a Linux path through unchanged under a non-WSL shell', () => {
    expect(splitWslCwd('pwsh.exe', '/home/x', home)).toEqual({
      spawnCwd: '/home/x',
      prefixArgs: [],
    });
  });

  it('splits a ~-relative path under wsl.exe', () => {
    expect(splitWslCwd('wsl.exe', '~/p', home)).toEqual({
      spawnCwd: home,
      prefixArgs: ['--cd', '~/p'],
    });
  });

  it('splits a \\\\wsl.localhost\\ UNC path under wsl.exe', () => {
    expect(splitWslCwd('wsl.exe', '\\\\wsl.localhost\\Ubuntu\\home\\x', home)).toEqual({
      spawnCwd: home,
      prefixArgs: ['--cd', '\\\\wsl.localhost\\Ubuntu\\home\\x'],
    });
  });

  it('passes undefined cwd through unchanged', () => {
    expect(splitWslCwd('wsl.exe', undefined, home)).toEqual({
      spawnCwd: undefined,
      prefixArgs: [],
    });
  });
});

describe('applyWslPromptIntegration', () => {
  it('gives wsl.exe Bash authoritative command start/end markers', () => {
    const result = applyWslPromptIntegration('C:\\Windows\\System32\\wsl.exe', {
      WSLENV: 'EXISTING/u:WMUX_BASH_INIT',
    }, 'C:\\Users\\g\\.wmux\\wmux-shell-init.bash');
    const { env } = result;

    expect(env.WMUX_SHELL_INTEGRATION).toBe('1');
    expect(env.WMUX_BASH_INIT).toBe('C:\\Users\\g\\.wmux\\wmux-shell-init.bash');
    expect(env.WSLENV?.split(':')).toEqual([
      'EXISTING/u', 'WMUX_BASH_INIT/p', 'WMUX_SHELL_INTEGRATION', 'TERM',
    ]);
    expect(env.TERM).toBe('xterm-256color');
    expect(result.args.slice(0, 3)).toEqual(['--exec', '/bin/sh', '-c']);
    expect(result.args[3]).toContain('--rcfile "$WMUX_BASH_INIT" -i');
  });

  it('adds path translation while preserving flags on an existing rcfile entry', () => {
    const { env } = applyWslPromptIntegration('wsl.exe', {
      WSLENV: 'WMUX_BASH_INIT/u',
    }, 'C:\\wmux-init.bash');
    expect(env.WSLENV).toContain('WMUX_BASH_INIT/up');
  });

  it('preserves an explicit terminal type', () => {
    const { env } = applyWslPromptIntegration('wsl.exe', {
      TERM: 'screen-256color',
    }, 'C:\\wmux-init.bash');
    expect(env.TERM).toBe('screen-256color');
  });

  it('does not alter non-WSL shells or an explicit integration opt-out', () => {
    const pwsh = { KEEP: 'yes' };
    expect(applyWslPromptIntegration('pwsh.exe', pwsh, 'init')).toEqual({ env: pwsh, args: [] });
    const optedOut = { WMUX_SHELL_INTEGRATION: '0' };
    expect(applyWslPromptIntegration('wsl.exe', optedOut, 'init')).toEqual({ env: optedOut, args: [] });
  });
});
