import { describe, it, expect, vi, afterEach } from 'vitest';
import { withLaunchEnv } from '../launchEnv';
import { cmdPromptFileArgument, promptFileArgument } from '../../../shared/promptFileArgument';
import { MODEL_ENV_MARKER } from '../../../shared/workerLaunch';

const env = { CLAUDE_CODE_SANDBOXED: '1' };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('withLaunchEnv', () => {
  it('sets the env on the command alone in a POSIX shell, a WSL pane and fish', () => {
    const line = `claude ${promptFileArgument('/w/brief.md', 'darwin')}`;
    for (const shell of ['/bin/zsh', '/bin/bash', 'C:\\Windows\\System32\\wsl.exe', '/opt/homebrew/bin/fish']) {
      expect(withLaunchEnv(line, env, shell)).toBe(`CLAUDE_CODE_SANDBOXED=1 ${line}`);
    }
  });

  it('puts the assignment after the model-env marker, on the agent itself', () => {
    expect(withLaunchEnv(`${MODEL_ENV_MARKER}claude`, env, '/bin/zsh')).toBe(`${MODEL_ENV_MARKER}CLAUDE_CODE_SANDBOXED=1 claude`);
  });

  it('sets and removes it around the command in PowerShell, so the shell never keeps it', () => {
    const line = `claude ${promptFileArgument('C:\\w\\brief.md', 'win32')}`;
    const want = `try { $env:CLAUDE_CODE_SANDBOXED='1'; ${line} } finally { Remove-Item Env:CLAUDE_CODE_SANDBOXED -ErrorAction SilentlyContinue }`;
    expect(withLaunchEnv(line, env, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(want);
    expect(withLaunchEnv(line, env, 'powershell.exe')).toBe(want);
  });

  it('sets it in a child cmd that ends with the command, leaving the line\'s quoting as it was', () => {
    const line = `claude ${cmdPromptFileArgument('C:/w/brief.md')}`;
    expect(withLaunchEnv(line, env, 'C:\\Windows\\System32\\cmd.exe')).toBe(`cmd /c set CLAUDE_CODE_SANDBOXED=1^&^& ${line}`);
  });

  it('leaves the line alone, and says so, where it cannot scope the env to the command', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(withLaunchEnv('claude', env, '/bin/tcsh')).toBe('claude');
    expect(withLaunchEnv('claude & echo x', env, 'cmd.exe')).toBe('claude & echo x');
    expect(withLaunchEnv('claude', { CLAUDE_CODE_SANDBOXED: "1' x" }, '/bin/zsh')).toBe('claude');
    expect(withLaunchEnv('claude', { 'A B': '1' }, '/bin/zsh')).toBe('claude');
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('changes nothing with no env', () => {
    expect(withLaunchEnv('claude', undefined, '/bin/zsh')).toBe('claude');
    expect(withLaunchEnv('claude', {}, 'cmd.exe')).toBe('claude');
  });
});
