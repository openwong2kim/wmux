import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../nativeTerminalCore', () => ({ loadNativeTerminalCore: vi.fn() }));
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  const native = await import('../nativeTerminalCore');
  vi.mocked(native.loadNativeTerminalCore).mockReturnValue({} as never);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-engine-'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.stubEnv('WMUX_TERMINAL_CORE', undefined);
  vi.stubEnv('WMUX_DATA_SUFFIX', '-test');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

const savedChoice = () => path.join(dir, '.wmux-test', 'terminal-core.json');
const saveChoice = (content: string) => {
  fs.mkdirSync(path.dirname(savedChoice()), { recursive: true });
  fs.writeFileSync(savedChoice(), content);
};

describe('terminal engine selection (the Node engine is removed)', () => {
  it('is Rust with no saved choice, a saved Node choice, or WMUX_TERMINAL_CORE=node', async () => {
    const settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('rust');
    saveChoice('{"engine":"node"}');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'node');
    expect(settings.terminalCoreSelection()).toBe('rust');
  });

  it('logs the ignored choices once, and keeps the saved file for an older version', async () => {
    saveChoice('{"engine":"node"}');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'node');
    const settings = await import('../terminalCoreSettings');
    const log = vi.fn();
    settings.terminalCoreSelection(log);
    settings.terminalCoreSelection(log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('WMUX_TERMINAL_CORE=node');
    expect(log.mock.calls[0][0]).toContain('terminal-core.json {"engine":"node"}');
    expect(fs.readFileSync(savedChoice(), 'utf8')).toBe('{"engine":"node"}');
  });

  it('logs nothing for a saved Rust choice or a malformed file', async () => {
    const settings = await import('../terminalCoreSettings');
    for (const content of ['{"engine":"rust"}', '{', 'null']) {
      saveChoice(content);
      expect(settings.ignoredEngineChoices(savedChoice(), {})).toEqual([]);
    }
  });
});

describe('daemon.ping terminalCore', () => {
  it('reports Rust with the module, keeping the fields older readers use', async () => {
    const settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreRuntime()).toEqual({
      requested: 'rust', effective: 'rust', rustAvailable: true, environmentOverride: false, available: true,
    });
  });

  it('reports the module missing, and why', async () => {
    const native = await import('../nativeTerminalCore');
    vi.mocked(native.loadNativeTerminalCore).mockImplementation(() => { throw new Error('Native terminal core lacks pty-v1'); });
    const settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreRuntime()).toEqual({
      requested: 'rust', effective: 'rust', rustAvailable: false, environmentOverride: false,
      available: false, reason: 'Native terminal core lacks pty-v1',
    });
  });

  it('never reports an environment override any more', async () => {
    vi.stubEnv('WMUX_TERMINAL_CORE', 'node');
    const settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreRuntime().environmentOverride).toBe(false);
  });
});
