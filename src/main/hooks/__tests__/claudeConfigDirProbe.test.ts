// @wmux-lane unit
// process.platform is stubbed and the shell runner is injected: nothing here reaches the OS.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROBE_TIMEOUT_MS, claudeConfigDirEnv, parseProbeOutput, resetClaudeConfigDirProbe } from '../claudeConfigDirProbe';

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
    expect(parseProbeOutput(out)).toBe('/home/u/.claude-work');
  });

  it('reads an empty mark or no mark as unset', () => {
    expect(parseProbeOutput('\n__WMUX_CLAUDE_CONFIG_DIR__=\n')).toBeUndefined();
    expect(parseProbeOutput('nothing here')).toBeUndefined();
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
    await expect(claudeConfigDirEnv(runner)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it('on macOS asks the login shell once, bounded, and caches the answer', async () => {
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

  it('a shell that fails or times out (the runner gives no output) reads as unset', async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '');
    onPlatform('linux');
    await expect(claudeConfigDirEnv(async () => '')).resolves.toBeUndefined();
  });
});
