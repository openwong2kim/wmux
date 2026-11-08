// @wmux-lane unit
// process.platform is stubbed and the shell runner is injected: nothing here reaches the OS.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INSTALL_PROBE_TIMEOUT_MS,
  PROBE_TIMEOUT_MS,
  claudeConfigDirEnv,
  parseProbeOutput,
  readClaudeConfigDirEnv,
  resetClaudeConfigDirProbe,
} from '../claudeConfigDirProbe';

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  vi.unstubAllEnvs();
  resetClaudeConfigDirProbe();
});

describe('parseProbeOutput', () => {
  it('reads only the marked line, so rc-file output cannot leak in', () => {
    const out = 'Welcome back!\nCLAUDE_CONFIG_DIR=/wrong\n\n__WMUX_CLAUDE_CONFIG_DIR__=/home/u/.claude-work\nbye\n';
    expect(parseProbeOutput(out)).toEqual({ marked: true, value: '/home/u/.claude-work' });
  });

  it('tells an empty answer (unset) from no answer', () => {
    expect(parseProbeOutput('\n__WMUX_CLAUDE_CONFIG_DIR__=\n')).toEqual({ marked: true, value: undefined });
    expect(parseProbeOutput('nothing here\n')).toEqual({ marked: false, value: undefined });
  });

  it('reads only a complete line that starts with the mark', () => {
    expect(parseProbeOutput('echo __WMUX_CLAUDE_CONFIG_DIR__=/x\n').marked).toBe(false);
    expect(parseProbeOutput('\n__WMUX_CLAUDE_CONFIG_DIR__=/half-writ').marked).toBe(false);
  });
});

describe('claudeConfigDirEnv', () => {
  it("uses this process's own CLAUDE_CONFIG_DIR without asking a shell", async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/own/dir');
    const runner = vi.fn(async () => '');
    await expect(claudeConfigDirEnv(runner)).resolves.toBe('/own/dir');
    expect(runner).not.toHaveBeenCalled();
  });

  it('asks no shell on Windows, which inherits the user environment', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    onPlatform('win32');
    const runner = vi.fn(async () => '');
    await expect(readClaudeConfigDirEnv({ runner })).resolves.toEqual({ value: undefined, read: true });
    expect(runner).not.toHaveBeenCalled();
  });

  it('on macOS asks the login shell once, bounded, and keeps the answer', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    vi.stubEnv('SHELL', '/bin/zsh');
    onPlatform('darwin');
    const runner = vi.fn(async () => 'motd\n__WMUX_CLAUDE_CONFIG_DIR__=/Users/u/.claude-alt\n');
    await expect(claudeConfigDirEnv(runner)).resolves.toBe('/Users/u/.claude-alt');
    await expect(claudeConfigDirEnv(runner)).resolves.toBe('/Users/u/.claude-alt');
    expect(runner).toHaveBeenCalledTimes(1);
    const [shell, args, timeout] = runner.mock.calls[0] as unknown as [string, string[], number];
    expect(shell).toBe('/bin/zsh');
    expect(args[0]).toBe('-lic');
    expect(timeout).toBe(PROBE_TIMEOUT_MS);
  });

  it('a shell that never printed the mark (the bound, a crash) reads as unknown, and is asked again', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    onPlatform('linux');
    const runner = vi.fn<(shell: string, args: string[], timeoutMs: number) => Promise<string>>()
      .mockResolvedValueOnce('rc noise, then the bound\n')
      .mockResolvedValueOnce('\n__WMUX_CLAUDE_CONFIG_DIR__=/home/u/.claude-env\n');
    await expect(readClaudeConfigDirEnv({ runner })).resolves.toEqual({ value: undefined, read: false });
    await expect(readClaudeConfigDirEnv({ runner, timeoutMs: INSTALL_PROBE_TIMEOUT_MS }))
      .resolves.toEqual({ value: '/home/u/.claude-env', read: true });
    expect(runner.mock.calls.map((c) => c[2])).toEqual([PROBE_TIMEOUT_MS, INSTALL_PROBE_TIMEOUT_MS]);
    // Answered now, so kept for the session.
    await expect(claudeConfigDirEnv(runner)).resolves.toBe('/home/u/.claude-env');
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('an empty answer is an answer: unset, read, and kept', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    onPlatform('linux');
    const runner = vi.fn(async () => '\n__WMUX_CLAUDE_CONFIG_DIR__=\n');
    await expect(readClaudeConfigDirEnv({ runner })).resolves.toEqual({ value: undefined, read: true });
    await expect(readClaudeConfigDirEnv({ runner })).resolves.toEqual({ value: undefined, read: true });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('a caller that finds a probe running waits for it, and asks again with its own bound when that got no answer', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    onPlatform('darwin');
    let releaseBoot: (out: string) => void = () => undefined;
    const runner = vi.fn<(shell: string, args: string[], timeoutMs: number) => Promise<string>>()
      .mockImplementationOnce(() => new Promise<string>((resolve) => { releaseBoot = resolve; }))
      .mockResolvedValueOnce('\n__WMUX_CLAUDE_CONFIG_DIR__=/Users/u/.claude-env\n');
    const boot = readClaudeConfigDirEnv({ runner });
    const install = readClaudeConfigDirEnv({ runner, timeoutMs: INSTALL_PROBE_TIMEOUT_MS });
    releaseBoot('');
    await expect(boot).resolves.toEqual({ value: undefined, read: false });
    await expect(install).resolves.toEqual({ value: '/Users/u/.claude-env', read: true });
    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[1][2]).toBe(INSTALL_PROBE_TIMEOUT_MS);
  });
});
