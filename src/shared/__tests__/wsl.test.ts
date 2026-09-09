import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { isLinuxCwd, isWslShell, recoveryCwd, mergeWslEnv, resolveWslCwd, WSL_CWD_PROBE, wslTargetArgs } from '../wsl';

const target = { distribution: 'Ubuntu-24.04', user: 'developer' };

describe('WSL execution target', () => {
  it('recognizes wsl.exe only on Windows, independent of path separators', () => {
    expect(isWslShell('C:\\Windows\\System32\\WSL.EXE', 'win32')).toBe(true);
    expect(isWslShell('C:/Windows/System32/wsl.exe', 'win32')).toBe(true);
    expect(isWslShell('/usr/bin/wsl.exe', 'linux')).toBe(false);
    expect(isWslShell('powershell.exe', 'win32')).toBe(false);
  });

  it('keeps the requested path and pinned target out of shell source', () => {
    const requested = "/home/developer/project ' $(not-a-command) ; 日本語";
    const probe = vi.fn((_args: string[]) => `Ubuntu-24.04\0developer\0${requested}\0`);
    expect(resolveWslCwd('wsl.exe', requested, target, probe)).toEqual({ cwd: requested, target });
    const args = probe.mock.calls[0][0];
    expect(args).toEqual(['--distribution', 'Ubuntu-24.04', '--user', 'developer', '--exec', '/bin/sh', '-c', WSL_CWD_PROBE, 'wmux-cwd', requested]);
    expect(WSL_CWD_PROBE).not.toContain(requested);
  });

  it('resolves home in Linux rather than using the Windows home', () => {
    const probe = vi.fn((_args: string[]) => 'Ubuntu-24.04\0developer\0/home/developer/project\0');
    expect(resolveWslCwd('wsl.exe', '~/project', undefined, probe).cwd).toBe('/home/developer/project');
    expect(probe.mock.calls[0][0].at(-1)).toBe('~/project');
    expect(resolveWslCwd('wsl.exe', undefined, undefined, probe).target).toEqual(target);
    expect(probe.mock.calls[1][0].at(-1)).toBe('~');
  });

  it('refuses invalid paths/targets and fails visibly when Linux rejects the directory', () => {
    const probe = vi.fn((_args: string[]) => 'malformed');
    for (const cwd of ['relative', '\\\\server\\share', '/home/x\ncommand', '/x\0y']) {
      expect(() => resolveWslCwd('wsl.exe', cwd, undefined, probe)).toThrow();
    }
    expect(probe).not.toHaveBeenCalled();
    expect(() => wslTargetArgs({ ...target, distribution: '--help' })).toThrow();
    expect(() => resolveWslCwd('wsl.exe', '/missing', target, () => { throw new Error('directory missing'); })).toThrow('directory missing');
    expect(() => resolveWslCwd('wsl.exe', '/home', target, probe)).toThrow('valid distribution');
  });

  it('restores Linux directories without Windows stat and retains native home fallback', () => {
    const stat = vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    try {
      expect(recoveryCwd({ cmd: 'wsl.exe', cwd: '~/project' }, 'win32')).toBe('~/project');
      expect(stat).not.toHaveBeenCalled();
      expect(recoveryCwd({ cmd: 'powershell.exe', cwd: 'C:\\gone' }, 'win32')).toBe(os.homedir());
    } finally { stat.mockRestore(); }
  });

  it('transfers pane identity in both directions and translates only designated paths', () => {
    expect(mergeWslEnv('USER_VAR/p:WMUX_PTY_ID/u:wmux_data_suffix/w:OTHER/l', ['WMUX_PTY_ID', 'WMUX_DATA_SUFFIX', 'WMUX_WSL_NODE/p']))
      .toBe('USER_VAR/p:OTHER/l:WMUX_PTY_ID:WMUX_DATA_SUFFIX:WMUX_WSL_NODE/p');
  });

  it('recognizes Linux paths without converting tilde or allowing network paths', () => {
    expect(isLinuxCwd('~/project')).toBe(true);
    expect(isLinuxCwd('/home/user/project')).toBe(true);
    expect(isLinuxCwd('//server/share')).toBe(false);
    expect(isLinuxCwd('C:\\home')).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('the Linux probe expands tilde inside the chosen home', () => {
    const output = execFileSync('/bin/sh', ['-c', WSL_CWD_PROBE, 'probe', '~/'], {
      encoding: 'utf8', env: { ...process.env, WSL_DISTRO_NAME: 'test-distro' },
    });
    expect(output.split('\0')[0]).toBe('test-distro');
    expect(output.split('\0')[2]).toBe(process.env.HOME);
  });
});
