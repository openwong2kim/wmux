import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
const { spawnSync, spawn } = vi.hoisted(() => ({ spawnSync: vi.fn(), spawn: vi.fn() }));
vi.mock('cross-spawn', () => ({ default: Object.assign(spawn, { sync: spawnSync }) }));
// cross-spawn is mocked, so whether opencode is really on this machine's PATH
// must not decide whether it gets called.
vi.mock('../exeSearch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../exeSearch')>()),
  findExecutable: (name: string) => name,
}));
import { getExecEnv } from '../execEnv';
import { installOpenCodeTerminalChat, openCodeTerminalChatIntegration, probeOpenCodeVersion, OPENCODE_PROBE_RETRY_MS, type OpenCodeVersionProbe } from '../openCodeTerminalChatIntegration';
async function fixture(run: (dir: string, options: Parameters<typeof openCodeTerminalChatIntegration>[0]) => void | Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-tui-install-'));
  const sourcePath = path.join(dir, 'source.mjs'); fs.writeFileSync(sourcePath, '// wmux-managed: opencode-terminal-chat\n');
  try { await run(dir, { configRoot: dir, startDir: dir, sourcePath, install: true, version: '1.18.30' }); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
describe('OpenCode TUI installation', () => {
  it('keeps existing settings and plugins, and is idempotent', () => fixture((dir, options) => {
    fs.writeFileSync(path.join(dir, 'tui.json'), JSON.stringify({ theme: 'mine', plugin: ['other-plugin'] }));
    const result = openCodeTerminalChatIntegration(options); expect(result.state).toBe('current');
    const text = fs.readFileSync(result.configPath, 'utf8');
    expect(JSON.parse(text)).toEqual({ theme: 'mine', plugin: ['other-plugin', result.pluginUrl] });
    expect(openCodeTerminalChatIntegration(options).state).toBe('current');
    expect(fs.readFileSync(result.configPath, 'utf8')).toBe(text);
  }));
  it('never rewrites commented, malformed or conflicting configuration', () => fixture((dir, options) => {
    const file = path.join(dir, 'tui.json'); fs.writeFileSync(file, '{ // keep this comment\n}');
    expect(openCodeTerminalChatIntegration(options).state).toBe('manual-config');
    expect(fs.readFileSync(file, 'utf8')).toContain('// keep');
    fs.writeFileSync(file, '{"theme":"mine"}'); fs.writeFileSync(path.join(dir, 'tui.jsonc'), '{}');
    expect(openCodeTerminalChatIntegration(options).state).toBe('manual-config');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"theme":"mine"}');
  }));
  it('does not install an unverified API generation or overwrite a foreign asset', () => fixture((dir, options) => {
    expect(openCodeTerminalChatIntegration({ ...options, version: '1.17.0' }).state).toBe('unsupported-version');
    expect(openCodeTerminalChatIntegration({ ...options, version: '2.0.0' }).state).toBe('unsupported-version');
    expect(fs.existsSync(path.join(dir, 'tui.json'))).toBe(false);
    fs.writeFileSync(path.join(dir, 'wmux-chat-tui.mjs'), '// user-owned');
    expect(openCodeTerminalChatIntegration(options).state).toBe('unavailable');
    expect(fs.readFileSync(path.join(dir, 'wmux-chat-tui.mjs'), 'utf8')).toBe('// user-owned');
  }));
  it('probes opencode with the GUI exec env and reports a missing binary as not-found', () => fixture((dir, options) => {
    const probe = { ...options, version: undefined };
    spawnSync.mockReturnValue({ status: null, stdout: '', error: Object.assign(new Error('spawnSync opencode ENOENT'), { code: 'ENOENT' }) });
    expect(openCodeTerminalChatIntegration(probe).state).toBe('not-found');
    expect(spawnSync.mock.calls[0][2].env).toBe(getExecEnv());
    expect(fs.existsSync(path.join(dir, 'tui.json'))).toBe(false);
    spawnSync.mockReturnValue({ status: null, stdout: '', error: Object.assign(new Error('spawnSync opencode ETIMEDOUT'), { code: 'ETIMEDOUT' }) });
    expect(openCodeTerminalChatIntegration(probe)).toMatchObject({ state: 'timeout', error: expect.stringContaining('ETIMEDOUT') });
    spawnSync.mockReturnValue({ status: 0, stdout: '1.18.30\n' });
    expect(openCodeTerminalChatIntegration(probe).state).toBe('current');
  }));
  it('the async probe reports a timeout only once the timed-out child has closed', async () => {
    vi.useFakeTimers();
    try {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough() });
      spawn.mockReturnValue(child);
      let settled = false;
      const pending = probeOpenCodeVersion(10_000).finally(() => { settled = true; });
      expect(spawn.mock.calls.at(-1)?.[2].env).toBe(getExecEnv());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(settled).toBe(false); // not before the child has closed
      child.emit('close', null);
      expect(await pending).toMatchObject({ state: 'timeout' });
    } finally { vi.useRealTimers(); }
  });
  it('retries a timed-out probe once in the same session, and never retries a missing binary', () => fixture(async (dir, { configRoot, startDir, sourcePath }) => {
    const options = { configRoot, startDir, sourcePath };
    const timeout: OpenCodeVersionProbe = { state: 'timeout', error: 'timed out' };
    const wait = vi.fn(async () => undefined); const onRetry = vi.fn();
    const probe = vi.fn<() => Promise<OpenCodeVersionProbe>>().mockResolvedValueOnce(timeout).mockResolvedValueOnce({ version: '1.18.30' });
    expect((await installOpenCodeTerminalChat(options, { probe, wait, onRetry })).state).toBe('current');
    expect(wait).toHaveBeenCalledWith(OPENCODE_PROBE_RETRY_MS); expect(onRetry).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(dir, 'tui.json'))).toBe(true);
    const twice = vi.fn(async () => timeout);
    expect((await installOpenCodeTerminalChat(options, { probe: twice, wait })).state).toBe('timeout');
    expect(twice).toHaveBeenCalledTimes(2);
    const missing = vi.fn(async (): Promise<OpenCodeVersionProbe> => ({ state: 'not-found', error: 'ENOENT' }));
    expect((await installOpenCodeTerminalChat(options, { probe: missing, wait })).state).toBe('not-found');
    expect(missing).toHaveBeenCalledTimes(1);
  }));
});
