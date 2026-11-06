// The Claude hook copy, against a throwaway home: every path is under `root`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PROBE_LOCK } from '../../probedNative';
import {
  CLAUDE_RUNTIME_FILE,
  bridgePin,
  claudeCopyVerdict,
  claudeHookCopyPath,
  claudeNativeAvailable,
  claudeSelfTestLine,
  isPackagedBridge,
  packagedClaudeNativeSource,
  prepareClaudeNative,
  readClaudeRuntime,
  writeClaudeRuntime,
} from '../claudeNativeHook';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let root = '';
let hooks = '';
let bridgeSource = '';
let bridgeDest = '';
let nativeSource = '';

/** A stand-in for wmux-native: its --self-test prints `line`, and it carries
 *  the ownership marker as every build does. */
function shipNative(line: string): void {
  fs.writeFileSync(nativeSource, `#!/bin/sh\n# wmux-managed: native-hooks\n[ "$1" = --self-test ] && echo '${line}'\nexit 0\n`, { mode: 0o755 });
}

const prepare = (over: Partial<Parameters<typeof prepareClaudeNative>[0]> = {}) => prepareClaudeNative({
  nativeSource, bridgeSource, bridgeDest, suffixed: false, ...over,
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-claude-native-'));
  const resources = path.join(root, 'app', 'Resources');
  fs.mkdirSync(path.join(resources, 'cli-bundle'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'native-hooks'), { recursive: true });
  bridgeSource = path.join(resources, 'cli-bundle', 'wmux-bridge.mjs');
  fs.writeFileSync(bridgeSource, '// the bridge\n');
  nativeSource = path.join(resources, 'native-hooks', 'wmux-native');
  hooks = path.join(root, 'home', '.wmux', 'hooks');
  bridgeDest = path.join(hooks, 'wmux-bridge.mjs');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the bridge pin', () => {
  it('is the SHA-256 the binary pins: the tree\'s bridge hashes to core/wmux-native/claude-hook.ported-from.sha256', () => {
    const bridge = fs.readFileSync(path.join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs'));
    const pinned = fs.readFileSync(path.join(REPO_ROOT, 'core', 'wmux-native', 'claude-hook.ported-from.sha256'), 'utf8').trim();
    expect(bridgePin(bridge)).toBe(pinned);
  });

  it('reads only CRLF as LF', () => {
    expect(bridgePin(Buffer.from('a\r\nb\n'))).toBe(bridgePin(Buffer.from('a\nb\n')));
    expect(bridgePin(Buffer.from('a\rb\n'))).not.toBe(bridgePin(Buffer.from('a\nb\n')));
  });
});

describe('packagedClaudeNativeSource', () => {
  it('is the binary in the resources beside a packaged bridge, and nothing else', () => {
    fs.writeFileSync(nativeSource, 'x');
    expect(packagedClaudeNativeSource(bridgeSource, 'darwin')).toBe(nativeSource);
    expect(isPackagedBridge(bridgeSource)).toBe(true);
    // A checkout's bridge: its target/release build is never picked up here.
    const checkout = path.join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs');
    expect(packagedClaudeNativeSource(checkout, 'darwin')).toBeNull();
    expect(isPackagedBridge(checkout)).toBe(false);
    expect(packagedClaudeNativeSource(path.join(REPO_ROOT, 'dist', 'cli-bundle', 'wmux-bridge.mjs'), 'darwin')).toBeNull();
    expect(packagedClaudeNativeSource(bridgeSource, 'win32')).toBeNull();
    expect(packagedClaudeNativeSource(null)).toBeNull();
  });
});

describe('the runtime file', () => {
  it('reads native unless it says node', () => {
    expect(readClaudeRuntime(hooks)).toBe('native');
    writeClaudeRuntime(hooks, 'node');
    expect(readClaudeRuntime(hooks)).toBe('node');
    expect(fs.readFileSync(path.join(hooks, CLAUDE_RUNTIME_FILE), 'utf8')).toBe('node\n');
    writeClaudeRuntime(hooks, 'native');
    expect(readClaudeRuntime(hooks)).toBe('native');
  });
});

describe.skipIf(process.platform === 'win32')('prepareClaudeNative', () => {
  it('installs the copy beside the bridge once its self-test prints this build\'s protocol and pin', async () => {
    shipNative(claudeSelfTestLine(bridgeSource) as string);
    expect(await prepare()).toEqual({ binary: claudeHookCopyPath(bridgeDest), reason: null });
    expect(path.dirname(claudeHookCopyPath(bridgeDest))).toBe(hooks);
    expect(fs.statSync(claudeHookCopyPath(bridgeDest)).mode & 0o777).toBe(0o700);
    expect(claudeNativeAvailable(bridgeDest, bridgeSource)).toBe(true);
    expect(claudeCopyVerdict(bridgeDest, bridgeSource)).toBe('pass');
  });

  it('refuses a copy that pins another bridge, or answers no self-test (an older build)', async () => {
    for (const line of [`wmux-claude-hook protocol 1 pin ${'0'.repeat(64)}`, '']) {
      shipNative(`${line}`);
      const plan = await prepare();
      expect(plan.binary).toBeNull();
      expect(claudeNativeAvailable(bridgeDest, bridgeSource)).toBe(false);
    }
  });

  it('copies nothing on Windows, from an isolated instance, or with the runtime set to node', async () => {
    shipNative(claudeSelfTestLine(bridgeSource) as string);
    expect(await prepare({ platform: 'win32' })).toEqual({ binary: null, reason: 'Windows runs the Claude hooks on node' });
    expect(await prepare({ suffixed: true })).toMatchObject({ binary: null });
    expect(fs.existsSync(hooks)).toBe(false);
    writeClaudeRuntime(hooks, 'node');
    expect((await prepare()).reason).toMatch(/runtime set to node/);
    expect(fs.readdirSync(hooks)).toEqual([CLAUDE_RUNTIME_FILE]);
    expect(fs.existsSync(path.join(hooks, PROBE_LOCK))).toBe(false);
  });

  it('says why when nothing is shipped or the bridge cannot be read', async () => {
    expect(await prepare({ nativeSource: null })).toEqual({ binary: null, reason: 'not shipped with this build' });
    shipNative('x');
    expect(await prepare({ bridgeSource: path.join(root, 'gone.mjs') })).toMatchObject({ binary: null, reason: expect.stringMatching(/could not be read/) });
  });
});

/** A real wmux-native: the native-hooks workflow's build, or this checkout's. */
const REAL_NATIVE = [
  process.env.WMUX_NATIVE_HOOKS_BIN,
  path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'release', 'wmux-native'),
].find((p): p is string => !!p && fs.existsSync(p));

describe.skipIf(process.platform === 'win32' || !REAL_NATIVE)('prepareClaudeNative — a real build', () => {
  it('passes for the bridge it was built from', async () => {
    const plan = await prepare({ nativeSource: REAL_NATIVE as string, bridgeSource: path.join(REPO_ROOT, 'integrations', 'claude', 'bin', 'wmux-bridge.mjs') });
    expect(plan).toEqual({ binary: claudeHookCopyPath(bridgeDest), reason: null });
  });
});
