// The default engine's readiness (no model turn) and the Claude sign-in tab.

import { describe, expect, it, vi } from 'vitest';
import { botClaudeConfigDir, claudeLoginLine, engineReadiness, startEngineLogin, type EngineLoginDeps } from '../engineReadiness';

describe('engineReadiness', () => {
  it('no claude executable: not installed, and the credential is never read', async () => {
    const credential = vi.fn(async () => ({ ok: true as const }));
    const r = await engineReadiness({ claudeExecutable: () => null, credential });
    expect(r).toMatchObject({ ready: false, reason: 'claude-not-installed' });
    expect(credential).not.toHaveBeenCalled();
  });

  it('installed and signed in: ready', async () => {
    expect(await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => ({ ok: true }) })).toEqual({ ready: true });
  });

  it('no stored sign-in: not logged in; an unreadable one: unknown with the sanitized detail', async () => {
    expect(await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => ({ ok: false, reason: 'not-found' }) }))
      .toMatchObject({ ready: false, reason: 'claude-not-logged-in' });
    const r = await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => ({ ok: false, reason: 'read-error', detail: 'Error EACCES' }) });
    expect(r).toMatchObject({ ready: false, reason: 'unknown' });
    expect(r.message).toContain('EACCES');
  });

  it('a throwing lookup reads as unknown, never as ready', async () => {
    const r = await engineReadiness({ claudeExecutable: () => '/bin/claude', credential: async () => { throw new Error('boom'); } });
    expect(r).toMatchObject({ ready: false, reason: 'unknown' });
  });
});

describe('startEngineLogin', () => {
  const deps = (over: Partial<EngineLoginDeps> = {}): EngineLoginDeps => ({
    openTab: vi.fn(async () => ({ ptyId: 'pty-1' })),
    windowsShell: () => 'pwsh.exe',
    platform: 'darwin',
    ...over,
  });

  it('opens a tab with the default shell running the sign-in line as its startup command', async () => {
    const d = deps();
    await expect(startEngineLogin(d)).resolves.toBeUndefined();
    expect(d.openTab).toHaveBeenCalledTimes(1);
    expect(d.openTab).toHaveBeenCalledWith(undefined, 'env -u CLAUDE_CONFIG_DIR claude auth login');
  });

  it('on Windows the tab runs the native shell (a WSL default would sign in a Linux claude)', async () => {
    const d = deps({ platform: 'win32' });
    await startEngineLogin(d);
    expect(d.openTab).toHaveBeenCalledWith('pwsh.exe', '$env:CLAUDE_CONFIG_DIR=$null; claude auth login');
  });

  it('the line clears CLAUDE_CONFIG_DIR in the syntax of the tab\'s shell', () => {
    expect(claudeLoginLine('darwin', undefined)).toBe('env -u CLAUDE_CONFIG_DIR claude auth login');
    expect(claudeLoginLine('win32', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('$env:CLAUDE_CONFIG_DIR=$null; claude auth login');
    expect(claudeLoginLine('win32', 'powershell.exe')).toBe('$env:CLAUDE_CONFIG_DIR=$null; claude auth login');
    expect(claudeLoginLine('win32', 'C:\\Windows\\System32\\cmd.exe')).toBe('set "CLAUDE_CONFIG_DIR=" & claude auth login');
    expect(claudeLoginLine('win32', 'C:\\Program Files\\Git\\bin\\bash.exe')).toBe('env -u CLAUDE_CONFIG_DIR claude auth login');
  });

  it('with a Claude config folder, the sign-in goes to that exact folder (the one readiness reads and the bots run on), quoted for the shell', () => {
    const dir = "/Users/o'brien/claude cfg";
    expect(claudeLoginLine('darwin', undefined, dir)).toBe(`CLAUDE_CONFIG_DIR='/Users/o'\\''brien/claude cfg' claude auth login`);
    expect(claudeLoginLine('win32', 'pwsh.exe', "C:\\o'b\\cfg")).toBe("$env:CLAUDE_CONFIG_DIR='C:\\o''b\\cfg'; claude auth login");
    expect(claudeLoginLine('win32', 'cmd.exe', 'C:\\cfg')).toBe('set "CLAUDE_CONFIG_DIR=C:\\cfg" & claude auth login');
    // cmd cannot quote " or %; a newline ends any shell's line: not typed.
    expect(claudeLoginLine('win32', 'cmd.exe', 'C:\\a" & calc & rem "')).toBeNull();
    expect(claudeLoginLine('win32', 'cmd.exe', 'C:\\%USERPROFILE%')).toBeNull();
    expect(claudeLoginLine('darwin', undefined, '/x\nrm -rf ~')).toBeNull();
    // PowerShell doubles every single-quote form it accepts, keeping the folder's own characters.
    expect(claudeLoginLine('win32', 'pwsh.exe', 'C:\\a\u2019b')).toBe("$env:CLAUDE_CONFIG_DIR='C:\\a\u2019\u2019b'; claude auth login");
    expect(botClaudeConfigDir({ CLAUDE_CONFIG_DIR: '/x/cfg' })).toBe('/x/cfg');
    expect(botClaudeConfigDir({ CLAUDE_CONFIG_DIR: '  ' })).toBeUndefined();
    expect(botClaudeConfigDir({})).toBeUndefined();
  });

  it('a folder the shell cannot quote opens no tab and says how to sign in by hand', async () => {
    const d = deps({ platform: 'win32', windowsShell: () => 'cmd.exe' });
    await expect(startEngineLogin({ ...d, configDir: 'C:\\%X%' })).rejects.toThrow('CLAUDE_CONFIG_DIR');
    expect(d.openTab).not.toHaveBeenCalled();
  });

  it('startEngineLogin types the folder it was given', async () => {
    const d = deps({ platform: 'darwin' });
    await startEngineLogin({ ...d, configDir: '/x/cfg' });
    expect(d.openTab).toHaveBeenCalledWith(undefined, "CLAUDE_CONFIG_DIR='/x/cfg' claude auth login");
  });

  it('no tab: rejects with the command to run by hand', async () => {
    const d = deps({ openTab: vi.fn(async () => ({ error: 'surface.new: no active workspace' })) });
    await expect(startEngineLogin(d)).rejects.toThrow('claude auth login');
    await expect(startEngineLogin(deps({ openTab: vi.fn(async () => { throw new Error('RPC timeout'); }) }))).rejects.toThrow('claude auth login');
  });

  it('a second call while one is opening shares it (one tab)', async () => {
    let release!: (v: { ptyId: string }) => void;
    const d = deps({ openTab: vi.fn(() => new Promise<{ ptyId: string }>((r) => { release = r; })) });
    const a = startEngineLogin(d);
    const b = startEngineLogin(d);
    release({ ptyId: 'pty-2' });
    await Promise.all([a, b]);
    expect(d.openTab).toHaveBeenCalledTimes(1);
  });
});
