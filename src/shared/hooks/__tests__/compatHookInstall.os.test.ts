// The opt-in installer, against a throwaway home. Nothing here may touch the
// real ~/.copilot or ~/.wmux: every path is derived from the temp `home`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOwnedHookFile,
  compatHookConfigPath,
  findNativeHooksSource,
  installCompatHooks,
  removeCompatHooks,
  resolveCompatHookPaths,
  statusCompatHooks,
  type CompatHookPaths,
} from '../compatHookInstall';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

let home: string;
let paths: CompatHookPaths;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-compat-hooks-'));
  // An empty env: a COPILOT_HOME on the machine running the tests must not
  // move the file these cases look for. No native bridge: whether this
  // checkout has one staged must not change the Node-form cases.
  paths = { ...resolveCompatHookPaths(home, REPO_ROOT, {}), nativeHooks: null };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const configFile = () => compatHookConfigPath('copilot', paths) as string;
const readConfig = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));

describe('resolveCompatHookPaths', () => {
  it('finds the shared bridge in a source checkout and targets ~/.wmux/hooks', () => {
    expect(paths.bridge.sourcePath).toBe(path.join(REPO_ROOT, 'integrations', 'shared', 'bin', 'wmux-hooks-bridge.mjs'));
    expect(paths.bridge.destinationPath).toBe(path.join(home, '.wmux', 'hooks', 'wmux-hooks-bridge.mjs'));
  });

  it('puts Copilot hooks in a wmux-owned file under ~/.copilot/hooks', () => {
    expect(configFile()).toBe(path.join(home, '.copilot', 'hooks', 'wmux.json'));
  });

  it('has no installer for flavours that stay manual or unverified', () => {
    expect(compatHookConfigPath('kiro', paths)).toBeNull();
    expect(compatHookConfigPath('gemini', paths)).toBeNull();
  });
});

// #1918: "If COPILOT_HOME is set, it is $COPILOT_HOME/hooks/" (Copilot CLI
// hooks reference). COPILOT_HOME replaces the whole ~/.copilot path.
describe('COPILOT_HOME', () => {
  let copilotHome: string;
  beforeEach(() => {
    copilotHome = path.join(home, 'elsewhere', 'copilot-config');
  });

  it('puts the hook file under $COPILOT_HOME/hooks, not ~/.copilot', () => {
    const moved = resolveCompatHookPaths(home, REPO_ROOT, { COPILOT_HOME: copilotHome });
    expect(compatHookConfigPath('copilot', moved)).toBe(path.join(copilotHome, 'hooks', 'wmux.json'));
    expect(moved.configDirs.copilot).toEqual({ dir: copilotHome, source: 'env' });
    // The bridge copy stays under ~/.wmux: COPILOT_HOME is Copilot's, not wmux's.
    expect(moved.bridge.destinationPath).toBe(path.join(home, '.wmux', 'hooks', 'wmux-hooks-bridge.mjs'));
  });

  it('treats a blank COPILOT_HOME as unset', () => {
    for (const blank of ['', '   ']) {
      const p = resolveCompatHookPaths(home, REPO_ROOT, { COPILOT_HOME: blank });
      expect(compatHookConfigPath('copilot', p)).toBe(path.join(home, '.copilot', 'hooks', 'wmux.json'));
      expect(p.configDirs.copilot?.source).toBe('home');
    }
  });

  it('resolves a relative COPILOT_HOME to an absolute path', () => {
    const p = resolveCompatHookPaths(home, REPO_ROOT, { COPILOT_HOME: 'rel-copilot' });
    expect(p.configDirs.copilot?.dir).toBe(path.resolve('rel-copilot'));
  });

  it('installs, reports and removes in the directory Copilot reads', () => {
    const moved = resolveCompatHookPaths(home, REPO_ROOT, { COPILOT_HOME: copilotHome });
    const target = path.join(copilotHome, 'hooks', 'wmux.json');
    expect(installCompatHooks('copilot', moved)).toMatchObject({ ok: true, action: 'installed', configPath: target });
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(path.join(home, '.copilot'))).toBe(false);
    expect(statusCompatHooks('copilot', moved)).toMatchObject({ config: 'current', configPath: target, configDirSource: 'env' });
    // The same machine without COPILOT_HOME sees nothing at the default path:
    // a file Copilot does not read is never reported as current.
    expect(statusCompatHooks('copilot', paths)).toMatchObject({ config: 'absent', configDirSource: 'home' });
    expect(removeCompatHooks('copilot', moved)).toMatchObject({ ok: true, removed: true, configPath: target });
    expect(fs.existsSync(target)).toBe(false);
  });

  it('a hook file under ~/.copilot does not count once COPILOT_HOME points elsewhere', () => {
    installCompatHooks('copilot', paths);
    const moved = resolveCompatHookPaths(home, REPO_ROOT, { COPILOT_HOME: copilotHome });
    expect(statusCompatHooks('copilot', moved).config).toBe('absent');
  });
});

describe('buildOwnedHookFile', () => {
  // Exec form: no shell, so no quoting for PowerShell or cmd to misread.
  it('writes exec-form entries with the event in argv', () => {
    const bridge = 'C:\\Users\\Jane Doe\\.wmux\\hooks\\wmux-hooks-bridge.mjs';
    expect(buildOwnedHookFile('copilot', bridge)).toEqual({
      version: 1,
      hooks: {
        SessionStart: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'SessionStart'], timeoutSec: 5 }],
        UserPromptSubmit: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'UserPromptSubmit'], timeoutSec: 5 }],
        Stop: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'Stop'], timeoutSec: 5 }],
        PermissionRequest: [{ type: 'command', exec: 'node', args: [bridge, 'copilot', 'PermissionRequest'], timeoutSec: 5 }],
      },
    });
  });

  it('refuses a flavour without an owned-file installer', () => {
    expect(() => buildOwnedHookFile('gemini', '/b.mjs')).toThrow();
  });
});

describe('installCompatHooks', () => {
  it('copies the bridge and writes the hook file on a fresh home', () => {
    const outcome = installCompatHooks('copilot', paths);
    expect(outcome).toMatchObject({ ok: true, before: 'absent', action: 'installed' });
    expect(outcome.bridge.state).toBe('current');
    expect(fs.existsSync(paths.bridge.destinationPath)).toBe(true);
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
  });

  it('is idempotent: a second run writes nothing', () => {
    installCompatHooks('copilot', paths);
    const mtime = fs.statSync(configFile()).mtimeMs;
    const again = installCompatHooks('copilot', paths);
    expect(again).toMatchObject({ ok: true, before: 'current', action: 'none' });
    expect(fs.statSync(configFile()).mtimeMs).toBe(mtime);
  });

  it('refreshes its own file when the bridge path moved', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(buildOwnedHookFile('copilot', '/old/place/wmux-hooks-bridge.mjs')));
    const outcome = installCompatHooks('copilot', paths);
    expect(outcome).toMatchObject({ ok: true, before: 'stale', action: 'refreshed' });
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
  });

  it('never overwrites a file the user wrote', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    const theirs = JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: './mine.sh' }] } });
    fs.writeFileSync(configFile(), theirs);
    const outcome = installCompatHooks('copilot', paths);
    expect(outcome).toMatchObject({ ok: false, before: 'foreign', action: 'none' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe(theirs);
  });

  // One foreign entry beside ours makes the whole file the user's.
  it('treats a file with our entry plus one of theirs as foreign', () => {
    const mixed = buildOwnedHookFile('copilot', paths.bridge.destinationPath) as { hooks: Record<string, unknown[]> };
    mixed.hooks.Stop.push({ type: 'command', bash: './mine.sh' });
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify(mixed));
    expect(installCompatHooks('copilot', paths).before).toBe('foreign');
  });

  it('leaves a malformed file alone', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), '{ not json');
    expect(installCompatHooks('copilot', paths)).toMatchObject({ ok: false, before: 'malformed', action: 'none' });
    expect(fs.readFileSync(configFile(), 'utf8')).toBe('{ not json');
  });

  it('writes no config when the bridge cannot be installed', () => {
    const missing = { ...paths, bridge: { ...paths.bridge, sourcePath: null } };
    const outcome = installCompatHooks('copilot', missing);
    expect(outcome.ok).toBe(false);
    expect(outcome.bridge.state).toBe('source-missing');
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('reports flavours without an installer as unsupported', () => {
    expect(installCompatHooks('gemini', paths)).toMatchObject({ ok: false, before: 'unsupported', action: 'none' });
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
  });
});

describe('removeCompatHooks / statusCompatHooks', () => {
  it('removes its own file and keeps the shared bridge', () => {
    installCompatHooks('copilot', paths);
    expect(removeCompatHooks('copilot', paths)).toMatchObject({ ok: true, removed: true, before: 'current' });
    expect(fs.existsSync(configFile())).toBe(false);
    expect(fs.existsSync(paths.bridge.destinationPath)).toBe(true);
    expect(removeCompatHooks('copilot', paths)).toMatchObject({ ok: true, removed: false, before: 'absent' });
  });

  it('does not remove a file it did not write', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), '{"version":1,"hooks":{}}');
    expect(removeCompatHooks('copilot', paths)).toMatchObject({ removed: false, before: 'foreign' });
    expect(fs.existsSync(configFile())).toBe(true);
  });

  it('reports written state and that the flavour was verified live', () => {
    expect(statusCompatHooks('copilot', paths)).toMatchObject({ config: 'absent', verified: 'live', configDirSource: 'home' });
    installCompatHooks('copilot', paths);
    const status = statusCompatHooks('copilot', paths);
    expect(status.config).toBe('current');
    expect(status.bridge.state).toBe('current');
  });
});

// The native bridge, when the build ships one: the entries run its copy under
// ~/.wmux/hooks/ directly, and fall back to `node <bridge>` without it.
const NATIVE_EXE = process.platform === 'win32' ? 'wmux-native.exe' : 'wmux-native';

/** Something that runs and answers `--version` with the marker: a real build
 *  when there is one, else (POSIX) a script standing in for it. */
function runnableNative(): Buffer | null {
  const builds = [
    process.env.WMUX_NATIVE_HOOKS_BIN,
    path.join(REPO_ROOT, 'dist', 'native-hooks', NATIVE_EXE),
    path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'release', NATIVE_EXE),
    path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'debug', NATIVE_EXE),
  ].filter((p): p is string => !!p && fs.existsSync(p));
  if (builds[0]) return fs.readFileSync(builds[0]);
  if (process.platform === 'win32') return null;
  return Buffer.from("#!/bin/sh\necho 'wmux-native 0.0.0 (wmux-managed: native-hooks)'\n");
}

const NATIVE_BYTES = runnableNative();

describe.skipIf(!NATIVE_BYTES)('native bridge command form', () => {
  const exe = NATIVE_EXE;
  let staged: string;
  let withNative: CompatHookPaths;

  beforeEach(() => {
    staged = path.join(home, 'app', 'resources', 'native-hooks', exe);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, NATIVE_BYTES as Buffer, { mode: 0o755 });
    withNative = {
      ...paths,
      nativeHooks: {
        sourcePath: staged,
        destinationPath: path.join(home, '.wmux', 'hooks', exe),
        ownershipMarkers: ['wmux-managed: native-hooks'],
        mode: 0o700,
      },
    };
  });

  it('resolves the copy as executable by its owner only', () => {
    const cliDir = path.join(home, 'app', 'resources', 'cli-bundle');
    fs.mkdirSync(cliDir, { recursive: true });
    expect(resolveCompatHookPaths(home, cliDir, {}).nativeHooks).toEqual({
      sourcePath: staged,
      destinationPath: path.join(home, '.wmux', 'hooks', exe),
      ownershipMarkers: ['wmux-managed: native-hooks'],
      mode: 0o700,
    });
  });

  it('finds the staged binary from the packaged CLI directory', () => {
    const cliDir = path.join(home, 'app', 'resources', 'cli-bundle');
    fs.mkdirSync(cliDir, { recursive: true });
    expect(findNativeHooksSource(cliDir)).toBe(staged);
    expect(findNativeHooksSource(path.join(home, 'elsewhere'))).toBeNull();
  });

  it('finds the cargo build of a source checkout from its root or its dist/cli-bundle', () => {
    const repo = path.join(home, 'repo');
    const build = path.join(repo, 'core', 'wmux-native', 'target', 'release', exe);
    fs.mkdirSync(path.dirname(build), { recursive: true });
    fs.mkdirSync(path.join(repo, 'dist', 'cli-bundle'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'core', 'wmux-native', 'Cargo.toml'), '');
    fs.writeFileSync(build, 'x');
    expect(findNativeHooksSource(repo)).toBe(build);
    expect(findNativeHooksSource(path.join(repo, 'dist', 'cli-bundle'))).toBe(build);
  });

  // dist/native-hooks is packaging input and target/<triple>/release a
  // cross-build output: neither may be what a hook command runs (#3129 counts
  // wmux-native as wmux's own only under .wmux/, resources/ or
  // core/<crate>/target/(debug|release)/).
  it('never picks the forge stage or a cross-build directory', () => {
    const repo = path.join(home, 'repo');
    fs.mkdirSync(path.join(repo, 'core', 'wmux-native'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'core', 'wmux-native', 'Cargo.toml'), '');
    for (const dir of [['dist', 'native-hooks'], ['core', 'wmux-native', 'target', 'aarch64-apple-darwin', 'release']]) {
      fs.mkdirSync(path.join(repo, ...dir), { recursive: true });
      fs.writeFileSync(path.join(repo, ...dir, exe), 'x');
    }
    fs.mkdirSync(path.join(repo, 'dist', 'cli-bundle'), { recursive: true });
    expect(findNativeHooksSource(repo)).toBeNull();
    expect(findNativeHooksSource(path.join(repo, 'dist', 'cli-bundle'))).toBeNull();
    expect(resolveCompatHookPaths(home, path.join(repo, 'dist', 'cli-bundle'), {}).nativeHooks).toBeNull();
  });

  // The installer copies and runs what it finds, so only the two known roots
  // count: nothing planted further up the tree is ever picked up.
  it('ignores a binary planted in an ancestor directory', () => {
    const deep = path.join(home, 'a', 'b', 'c');
    fs.mkdirSync(deep, { recursive: true });
    for (const dir of [home, path.join(home, 'a'), path.join(home, 'a', 'b')]) {
      fs.mkdirSync(path.join(dir, 'native-hooks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'native-hooks', exe), 'planted');
      fs.mkdirSync(path.join(dir, 'dist', 'native-hooks'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'native-hooks', exe), 'planted');
    }
    expect(findNativeHooksSource(deep)).toBeNull();
    // A resources directory is only trusted from the CLI bundle inside it.
    const notCli = path.join(home, 'app', 'resources', 'something-else');
    fs.mkdirSync(notCli, { recursive: true });
    expect(findNativeHooksSource(notCli)).toBeNull();
  });

  it('says which command the entries run, and why', () => {
    expect(installCompatHooks('copilot', paths).nativeSummary).toMatch(/not shipped with this build.*node/);
    const installed = installCompatHooks('copilot', withNative);
    const dest = path.join(home, '.wmux', 'hooks', exe);
    expect(installed.nativeSummary).toBe(`native hook bridge: installed → ${dest}; hooks run it`);
    expect(statusCompatHooks('copilot', withNative).nativeSummary).toBe(`native hook bridge: ${dest} (up to date); hooks run it`);
    expect(statusCompatHooks('copilot', paths).nativeSummary).toBe('native hook bridge: not shipped with this build; hooks run `node <bridge>`');
  });

  it('writes entries that exec the installed native copy', () => {
    const outcome = installCompatHooks('copilot', withNative);
    expect(outcome).toMatchObject({ ok: true, action: 'installed' });
    expect(outcome.native?.state).toBe('current');
    const dest = path.join(home, '.wmux', 'hooks', exe);
    expect(readConfig().hooks.Stop).toEqual([{ type: 'command', exec: dest, args: ['hook', 'copilot', 'Stop'], timeoutSec: 5 }]);
    if (process.platform !== 'win32') expect(fs.statSync(dest).mode & 0o777).toBe(0o700);
    expect(statusCompatHooks('copilot', withNative)).toMatchObject({ config: 'current', native: { state: 'current' } });
    // The Node bridge is still installed: other flavours and the fallback use it.
    expect(fs.existsSync(paths.bridge.destinationPath)).toBe(true);
  });

  it('moves between the Node and native forms as a refresh, both ways', () => {
    installCompatHooks('copilot', paths);
    expect(installCompatHooks('copilot', withNative)).toMatchObject({ ok: true, before: 'stale', action: 'refreshed' });
    expect(readConfig().hooks.Stop[0].args[0]).toBe('hook');
    expect(installCompatHooks('copilot', paths)).toMatchObject({ ok: true, before: 'stale', action: 'refreshed' });
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
    expect(removeCompatHooks('copilot', withNative)).toMatchObject({ ok: true, removed: true });
  });

  it('stays on Node when the native copy cannot be installed', () => {
    // Something wmux did not write sits where the copy would go.
    fs.mkdirSync(path.join(home, '.wmux', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, '.wmux', 'hooks', exe), 'not ours');
    const outcome = installCompatHooks('copilot', withNative);
    expect(outcome).toMatchObject({ ok: true, action: 'installed', native: { state: 'foreign' } });
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
    expect(statusCompatHooks('copilot', withNative).config).toBe('current');
  });

  // A binary this machine will not run (noexec home, application control, a
  // foreign libc) would fail every event; `node <bridge>` would not.
  it('stays on Node when the installed copy does not run here', () => {
    fs.writeFileSync(staged, 'not a program, though it says wmux-managed: native-hooks');
    const outcome = installCompatHooks('copilot', withNative);
    expect(outcome).toMatchObject({ ok: true, action: 'installed', native: { state: 'error' } });
    expect(outcome.nativeSummary).toMatch(/not used \(.*does not run.*\).*node/);
    // The copy that does not run is not left behind for status to mistake.
    expect(fs.existsSync(path.join(home, '.wmux', 'hooks', exe))).toBe(false);
    expect(readConfig()).toEqual(buildOwnedHookFile('copilot', paths.bridge.destinationPath));
    expect(statusCompatHooks('copilot', withNative).config).toBe('current');
  });

  it('treats a native entry for another flavour, or not running `hook`, as foreign', () => {
    const dest = path.join(home, '.wmux', 'hooks', exe);
    for (const args of [['hook', 'qwen', 'Stop'], ['mcp-shim', 'copilot', 'Stop']]) {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true });
      fs.writeFileSync(configFile(), JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', exec: dest, args, timeoutSec: 5 }] } }));
      expect(installCompatHooks('copilot', withNative).before, args.join(' ')).toBe('foreign');
    }
  });
});

// What install may do before it has decided to write anything, and what
// status and remove may never do: run the binary. A script stands in for it
// and counts its runs.
describe.skipIf(process.platform === 'win32')('native bridge side effects', () => {
  let counter: string;
  let withNative: CompatHookPaths;
  const dest = () => path.join(home, '.wmux', 'hooks', NATIVE_EXE);
  const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0);

  beforeEach(() => {
    counter = path.join(home, 'runs');
    const staged = path.join(home, 'app', 'resources', 'native-hooks', NATIVE_EXE);
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, `#!/bin/sh\nprintf x >> '${counter}'\necho 'wmux-native 0.0.0 (wmux-managed: native-hooks)'\n`, { mode: 0o755 });
    withNative = {
      ...paths,
      nativeHooks: { sourcePath: staged, destinationPath: dest(), ownershipMarkers: ['wmux-managed: native-hooks'], mode: 0o700 },
    };
  });

  it('decides a foreign config before copying or running the binary', () => {
    fs.mkdirSync(path.dirname(configFile()), { recursive: true });
    fs.writeFileSync(configFile(), JSON.stringify({ version: 1, hooks: { Stop: [{ type: 'command', bash: './mine.sh' }] } }));
    expect(installCompatHooks('copilot', withNative)).toMatchObject({ ok: false, before: 'foreign' });
    expect(fs.existsSync(dest())).toBe(false);
    expect(runs()).toBe(0);
  });

  it('copies nothing when the Node bridge cannot be installed', () => {
    const missing = { ...withNative, bridge: { ...withNative.bridge, sourcePath: null } };
    expect(installCompatHooks('copilot', missing).ok).toBe(false);
    expect(fs.existsSync(dest())).toBe(false);
    expect(runs()).toBe(0);
  });

  it('runs the binary once to install it, and never for status or remove', () => {
    expect(installCompatHooks('copilot', withNative).native?.state).toBe('current');
    expect(runs()).toBe(1);
    expect(statusCompatHooks('copilot', withNative).config).toBe('current');
    expect(removeCompatHooks('copilot', withNative).removed).toBe(true);
    expect(runs()).toBe(1);
  });
});
