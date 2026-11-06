// @wmux-lane integration — the launcher installs through shared/probedNative.ts, which stages, links and renames real files in a temp dir.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A packaged build in a temp dir: resourcesPath holds the bundle and the
// native launcher, home is a temp dir. Nothing here reads or writes the real
// home, and no test opts into external registration.
let tmpHome = '';
let resources = '';

vi.mock('electron', () => ({
  app: {
    getPath: (key: string) => {
      if (key === 'home') return tmpHome;
      throw new Error(`unexpected getPath(${key}) in test`);
    },
    isPackaged: true,
    getVersion: () => '9.9.9',
    getAppPath: () => tmpHome,
  },
}));
vi.mock('../../../shared/security', () => ({ secureWriteTokenFile: vi.fn() }));
vi.mock('../../../shared/errors/macos', () => ({
  formatMacosError: vi.fn(() => ''),
  MACOS_ERRORS: { mcpPermissionDenied: { code: 'TEST', summary: '', remedy: '' } },
}));
vi.mock('../../../shared/platform', () => ({ isMac: false }));
vi.mock('../brokerProbe', () => ({ canConnectBrokerPipe: vi.fn(async () => false) }));
vi.mock('../stabilizeBundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../stabilizeBundle')>();
  return { ...actual, stabilizeMcpBundle: vi.fn(actual.stabilizeMcpBundle) };
});

import { McpRegistrar } from '../McpRegistrar';
import { stabilizeMcpBundle } from '../stabilizeBundle';
import { nativeLauncherPath, type SelfTestVerdict } from '../../../shared/mcpLauncher';

const stableDir = () => path.join(tmpHome, '.wmux', 'mcp');
const nativeCopy = () => nativeLauncherPath(stableDir());
const nativeSource = () => path.join(resources, 'native-hooks', path.basename(nativeCopy()));
const ship = (text: string) => fs.writeFileSync(nativeSource(), `${text} wmux-managed: native-hooks`);
const runsIfGood = async (binary: string): Promise<SelfTestVerdict> => (fs.readFileSync(binary, 'utf8').includes('good') ? 'pass' : 'fail');
const agyJson = () => path.join(tmpHome, '.gemini', 'config', 'mcp_config.json');
const claudeEntry = (): { command: string; args: string[] } | undefined =>
  JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8')).mcpServers?.wmux;

let saved: { suffix?: string; broker?: string; resourcesPath?: string };

beforeEach(() => {
  saved = { suffix: process.env.WMUX_DATA_SUFFIX, broker: process.env.WMUX_MCP_BROKER, resourcesPath: process.resourcesPath };
  delete process.env.WMUX_DATA_SUFFIX;
  process.env.WMUX_MCP_BROKER = '1';
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-mcp-native-'));
  resources = path.join(tmpHome, 'app', 'resources');
  fs.mkdirSync(path.join(resources, 'mcp-bundle'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'native-hooks'), { recursive: true });
  fs.writeFileSync(path.join(resources, 'mcp-bundle', 'index.js'), '// bundle');
  fs.writeFileSync(path.join(resources, 'mcp-bundle', 'shim.js'), '// shim');
  Object.defineProperty(process, 'resourcesPath', { value: resources, configurable: true, writable: true });
});
afterEach(() => {
  for (const [key, value] of [['WMUX_DATA_SUFFIX', saved.suffix], ['WMUX_MCP_BROKER', saved.broker]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.defineProperty(process, 'resourcesPath', { value: saved.resourcesPath, configurable: true, writable: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('McpRegistrar — the native launcher (broker flag on, packaged)', () => {
  it('registers the native launcher beside the stable bundle, without waiting for the broker', async () => {
    ship('good');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    expect(claudeEntry()).toEqual({ command: nativeCopy(), args: ['mcp-shim'] });
    expect(fs.existsSync(path.join(stableDir(), 'index.js'))).toBe(true);
  });

  it('an isolated instance never writes the stable directory, the launcher or any agent config', async () => {
    ship('good');
    process.env.WMUX_DATA_SUFFIX = '-isolated';
    const selfTest = vi.fn(runsIfGood);
    await new McpRegistrar({ nativeSelfTest: selfTest }).register('tok', { useShim: true });
    expect(fs.existsSync(nativeCopy())).toBe(false);
    expect(fs.existsSync(stableDir())).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, '.claude.json'))).toBe(false);
    expect(selfTest).not.toHaveBeenCalled();
  });

  it('falls to the bundle when the launcher fails, even with the broker ready: never the node shim', async () => {
    ship('broken');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: true });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'index.js')] });
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'index.js')] });
    // A copy that fails is never put in place.
    expect(fs.existsSync(nativeCopy())).toBe(false);
  });

  it('a downgrade whose launcher fails keeps the working one in place, and it stays registered', async () => {
    ship('good v1');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    expect(claudeEntry()?.command).toBe(nativeCopy());
    ship('broken v0');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: true });
    expect(claudeEntry()?.command).toBe(nativeCopy());
    expect(fs.readFileSync(nativeCopy(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  it('a failing refresh over a copy with no recorded pass registers the bundle and leaves that copy alone', async () => {
    ship('good v1');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    fs.rmSync(path.join(stableDir(), '.wmux-native-health.json'));
    ship('broken v2');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: true });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'index.js')] });
    expect(fs.readFileSync(nativeCopy(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  it('runs the self-test once per build: later boots read the recorded pass', async () => {
    ship('good');
    const selfTest = vi.fn(runsIfGood);
    await new McpRegistrar({ nativeSelfTest: selfTest }).register('tok', { useShim: false });
    await new McpRegistrar({ nativeSelfTest: selfTest }).register('tok', { useShim: false });
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(claudeEntry()?.command).toBe(nativeCopy());
  });

  it('a timeout registers node this boot without condemning the copy, and the next boot tests again', async () => {
    ship('good');
    await new McpRegistrar({ nativeSelfTest: async () => 'timeout' }).register('tok', { useShim: false });
    expect(claudeEntry()?.command).toBe('node');
    const selfTest = vi.fn(runsIfGood);
    await new McpRegistrar({ nativeSelfTest: selfTest }).register('tok', { useShim: false });
    expect(selfTest).toHaveBeenCalledTimes(1);
    expect(claudeEntry()?.command).toBe(nativeCopy());
  });

  it('moves every entry off the launcher when it is not offered, an explicitly registered target included', async () => {
    ship('good');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    // agy is registered only on request, so a boot never rewrites it on its own.
    fs.mkdirSync(path.dirname(agyJson()), { recursive: true });
    fs.writeFileSync(agyJson(), JSON.stringify({ mcpServers: { wmux: { command: nativeCopy(), args: ['mcp-shim'] } } }));
    // Nothing recorded for the copy in place, and the newer build proves nothing.
    fs.rmSync(path.join(stableDir(), '.wmux-native-health.json'));
    ship('newer, but it will not run');
    await new McpRegistrar({ nativeSelfTest: async () => 'timeout' }).register('tok', { useShim: true });
    const bundle = { command: 'node', args: [path.join(stableDir(), 'index.js')] };
    expect(claudeEntry()).toEqual(bundle);
    expect(JSON.parse(fs.readFileSync(agyJson(), 'utf8')).mcpServers.wmux).toEqual(bundle);
  });

  it('hashes the bundle once per registration', async () => {
    ship('good');
    vi.mocked(stabilizeMcpBundle).mockClear();
    await new McpRegistrar({ nativeSelfTest: async () => 'fail' }).register('tok', { useShim: true });
    expect(stabilizeMcpBundle).toHaveBeenCalledTimes(1);
  });

  it('does not use the launcher when the bundle could not be stabilized beside it', async () => {
    ship('good');
    fs.mkdirSync(path.dirname(stableDir()), { recursive: true });
    fs.writeFileSync(stableDir(), 'a file where the directory should be');
    const selfTest = vi.fn(runsIfGood);
    await new McpRegistrar({ nativeSelfTest: selfTest }).register('tok', { useShim: false });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(resources, 'mcp-bundle', 'index.js')] });
    expect(selfTest).not.toHaveBeenCalled();
  });

  it('with the broker flag off, never installs or runs the launcher', async () => {
    ship('good');
    delete process.env.WMUX_MCP_BROKER;
    const selfTest = vi.fn(runsIfGood);
    await new McpRegistrar({ nativeSelfTest: selfTest }).register('tok');
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'index.js')] });
    expect(fs.existsSync(nativeCopy())).toBe(false);
    expect(selfTest).not.toHaveBeenCalled();
  });

  it('keeps the profile flags when it moves an entry from node to native', async () => {
    ship('good');
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { wmux: { command: 'node', args: ['/old/index.js', '--core'] } } }));
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    expect(claudeEntry()).toEqual({ command: nativeCopy(), args: ['mcp-shim', '--core'] });
  });
});
