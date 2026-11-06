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

import { McpRegistrar } from '../McpRegistrar';
import { nativeLauncherPath } from '../../../shared/mcpLauncher';

const stableDir = () => path.join(tmpHome, '.wmux', 'mcp');
const nativeCopy = () => nativeLauncherPath(stableDir());
const nativeSource = () => path.join(resources, 'native-hooks', path.basename(nativeCopy()));
const ship = (text: string) => fs.writeFileSync(nativeSource(), `${text} wmux-managed: native-hooks`);
const runsIfGood = async (binary: string) => fs.readFileSync(binary, 'utf8').includes('good');
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

  it('falls to the node shim when the broker answers and the launcher fails, else to the bundle', async () => {
    ship('broken');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: true });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'shim.js')] });
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'index.js')] });
    expect(fs.existsSync(nativeCopy())).toBe(false);
  });

  it('a downgrade whose launcher fails keeps a working one: the old copy is put back and node runs this boot', async () => {
    ship('good v1');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    expect(claudeEntry()?.command).toBe(nativeCopy());
    ship('broken v0');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: true });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'shim.js')] });
    expect(fs.readFileSync(nativeCopy(), 'utf8')).toBe('good v1 wmux-managed: native-hooks');
  });

  it('after a failed self-test whose restore also failed, the next boot registers node and removes the copy', async () => {
    ship('good v1');
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: false });
    ship('broken v2');
    const loseTheAside = async (binary: string) => {
      for (const f of fs.readdirSync(stableDir()).filter((n) => n.includes('.previous'))) fs.unlinkSync(path.join(stableDir(), f));
      return runsIfGood(binary);
    };
    await new McpRegistrar({ nativeSelfTest: loseTheAside }).register('tok', { useShim: true });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'shim.js')] });
    expect(fs.readFileSync(nativeCopy(), 'utf8')).toBe('broken v2 wmux-managed: native-hooks');
    // Next boot: the copy matches the source, so only its self-test can tell.
    await new McpRegistrar({ nativeSelfTest: runsIfGood }).register('tok', { useShim: true });
    expect(claudeEntry()).toEqual({ command: 'node', args: [path.join(stableDir(), 'shim.js')] });
    expect(fs.existsSync(nativeCopy())).toBe(false);
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
