import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../nativeTerminalCore', () => ({ loadNativeTerminalCore: vi.fn() }));
let dir: string;
beforeEach(async () => {
  vi.resetModules();
  // No Rust module unless a test says so, so the default is Node on every host.
  const native = await import('../nativeTerminalCore');
  vi.mocked(native.loadNativeTerminalCore).mockImplementation(() => { throw new Error('missing'); });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-engine-'));
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.stubEnv('WMUX_TERMINAL_CORE', undefined);
  vi.stubEnv('WMUX_DATA_SUFFIX', '-test');
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('default terminal engine', () => {
  it('is Rust on Windows when the Rust module loads, Node otherwise', async () => {
    const settings = await import('../terminalCoreSettings');
    expect(settings.defaultTerminalEngine('win32', () => true)).toBe('rust');
    expect(settings.defaultTerminalEngine('win32', () => false)).toBe('node');
    expect(settings.defaultTerminalEngine('darwin', () => true)).toBe('rust');
    expect(settings.defaultTerminalEngine('darwin', () => false)).toBe('node');
    expect(settings.defaultTerminalEngine('linux', () => true)).toBe('node');
  });
  it('applies only when no valid choice is saved; a saved Node stays Node', async () => {
    const settings = await import('../terminalCoreSettings');
    const file = path.join(dir, 'engine.json');
    expect(settings.readTerminalEngine(file, () => 'rust')).toBe('rust');
    fs.writeFileSync(file, '{"engine":"node"}');
    expect(settings.readTerminalEngine(file, () => 'rust')).toBe('node');
    fs.writeFileSync(file, '{"engine":"other"}');
    expect(settings.readTerminalEngine(file, () => 'rust')).toBe('rust');
  });
});

describe('persisted terminal engine', () => {
  it('defaults to Rust on Windows and macOS and Node on Linux when the packaged Rust module is available', async () => {
    const native = await import('../nativeTerminalCore');
    vi.mocked(native.loadNativeTerminalCore).mockReturnValue({} as never);
    const settings = await import('../terminalCoreSettings');
    const engine = process.platform === 'win32' || process.platform === 'darwin' ? 'rust' : 'node';
    expect(settings.terminalCoreRuntime()).toEqual({
      requested: engine, effective: engine, rustAvailable: true, environmentOverride: false,
    });
  });
  it('keeps the live host unchanged until the next boot, in both directions', async () => {
    let settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('node');
    settings.writeTerminalEngine('rust');
    expect(settings.readTerminalEngine()).toBe('rust');
    expect(settings.terminalCoreSelection()).toBe('node');
    vi.resetModules();
    settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('rust');
    settings.writeTerminalEngine('node');
    expect(settings.terminalCoreSelection()).toBe('rust');
    vi.resetModules();
    settings = await import('../terminalCoreSettings');
    expect(settings.terminalCoreSelection()).toBe('node');
  });
  it('fails back to Node for malformed preferences and rejects invalid writes', async () => {
    const settings = await import('../terminalCoreSettings');
    const file = path.join(dir, 'invalid.json');
    for (const content of ['{', 'null', '{"engine":true}', '{"engine":"other"}']) {
      fs.writeFileSync(file, content);
      expect(settings.readTerminalEngine(file)).toBe('node');
    }
    expect(() => settings.writeTerminalEngine('other', file)).toThrow('Invalid');
    expect(fs.readFileSync(file, 'utf8')).toBe('{"engine":"other"}');
  });
  it('isolates instances and honors explicit environment overrides', async () => {
    const settings = await import('../terminalCoreSettings');
    settings.writeTerminalEngine('rust');
    vi.stubEnv('WMUX_DATA_SUFFIX', '-other');
    expect(settings.readTerminalEngine()).toBe('node');
    vi.stubEnv('WMUX_DATA_SUFFIX', '-test');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'node');
    expect(settings.terminalCoreSelection()).toBe('node');
    vi.stubEnv('WMUX_TERMINAL_CORE', 'rust');
    const native = await import('../nativeTerminalCore');
    vi.mocked(native.loadNativeTerminalCore).mockImplementation(() => { throw new Error('missing'); });
    expect(settings.terminalCoreRuntime()).toEqual({ requested: 'rust', effective: 'node', rustAvailable: false, environmentOverride: true });
  });
});
