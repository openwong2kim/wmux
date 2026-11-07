// The Claude hook entries in their native form, against a throwaway home and a
// stand-in for wmux-native. Nothing here touches the real ~/.claude or ~/.wmux.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyRuntimeFlag,
  claudeHookRuntimeReport,
  installHooks,
  installHooksWithNative,
  isPermissionGateInstalled,
  nativeFromRefusal,
  refreshClaudeNativeAtBoot,
  statusHooks,
  updateHooksWithNative,
  type SetupHooksPaths,
} from '../setupHooks';
import { probeKey, recordProbe, sha256Of } from '../../../shared/probedNative';
import { CLAUDE_RUNTIME_FILE, claudeHookCopyPath, claudeSelfTestLine, writeClaudeRuntime } from '../../../shared/hooks/claudeNativeHook';

let root = '';
let paths: SetupHooksPaths;
let copy = '';

const settings = () => JSON.parse(fs.readFileSync(paths.settingsPath, 'utf8')) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>>; [k: string]: unknown };
const commands = () => Object.values(settings().hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));

/** A stand-in for wmux-native whose --self-test prints `line` after `delay` s. */
function shipNative(line: string | null, delay = 0): void {
  const answer = line === null ? '' : `echo '${line}'`;
  fs.writeFileSync(paths.nativeSource as string, `#!/bin/sh\n# wmux-managed: native-hooks\nif [ "$1" = --self-test ]; then sleep ${delay}; ${answer}; fi\nexit 0\n`, { mode: 0o755 });
}
const goodLine = () => claudeSelfTestLine(paths.bridgeSource) as string;

beforeEach(() => {
  // As the installed app: no data suffix (isolateDataDir sets one for every
  // test; every path here is a temp one already). Cases that need a suffix
  // stub their own.
  vi.stubEnv('WMUX_DATA_SUFFIX', '');
  // A space in the home: every path in a command must stay quoted.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux claude native-'));
  const resources = path.join(root, 'app', 'Resources');
  fs.mkdirSync(path.join(resources, 'cli-bundle'), { recursive: true });
  fs.mkdirSync(path.join(resources, 'native-hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home', '.claude'), { recursive: true });
  const bridgeSource = path.join(resources, 'cli-bundle', 'wmux-bridge.mjs');
  fs.writeFileSync(bridgeSource, '// wmux-bridge.mjs stand-in\n');
  paths = {
    settingsPath: path.join(root, 'home', '.claude', 'settings.json'),
    bridgeDest: path.join(root, 'home', '.wmux', 'hooks', 'wmux-bridge.mjs'),
    bridgeSource,
    nativeSource: path.join(resources, 'native-hooks', 'wmux-native'),
  };
  copy = claudeHookCopyPath(paths.bridgeDest);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The ownership checks as wmux shipped them before the native form
 * (src/cli/commands/setupHooks.ts on main at 138cb615c: isWmuxLeaf and
 * isWmuxLeafWithTail). An older wmux must keep reading the native entries as
 * its own: status ok, and `setup-hooks` / `--remove` strip them.
 */
const ownedAsShipped = (command: string) => command.includes('wmux-bridge.mjs');
const tailAsShipped = (command: string, tail: string) => ownedAsShipped(command) && command.trim().endsWith(tail);

describe.skipIf(process.platform === 'win32')('the native form', () => {
  it('runs the copy with the bridge as argv[1], quoted, and stays wmux\'s to an older wmux', async () => {
    shipNative(goodLine());
    const outcome = await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(outcome).toMatchObject({ ok: true, native: copy, nativeReason: null });
    expect(settings().hooks.Stop[0].hooks[0].command).toBe(`"${copy}" "${paths.bridgeDest}" Stop`);
    const gate = settings().hooks.PreToolUse.find((g) => g.matcher === '');
    expect(gate?.hooks[0].command).toBe(`"${copy}" "${paths.bridgeDest}" PreToolUse --permission-gate`);
    for (const command of commands()) expect(ownedAsShipped(command)).toBe(true);
    expect(tailAsShipped(gate?.hooks[0].command as string, 'PreToolUse --permission-gate')).toBe(true);
    expect(statusHooks(paths)).toMatchObject({ nativeAvailable: true, runtime: 'native', updateAvailable: false });
  });

  it('stays on node when the copy does not pass, and says why', async () => {
    shipNative(`wmux-claude-hook protocol 1 pin ${'0'.repeat(64)}`);
    const outcome = await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(outcome.native).toBeNull();
    expect(outcome.nativeReason).toMatch(/self-test failed/);
    for (const command of commands()) expect(command.startsWith('node "')).toBe(true);
    expect(statusHooks(paths)).toMatchObject({ nativeAvailable: false, updateAvailable: false });
  });

  it('writes the node form from an isolated instance, even with a passing copy in place', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    const outcome = await installHooksWithNative(paths, undefined, { suffixed: true });
    expect(outcome).toMatchObject({ native: null, nativeReason: 'an isolated instance writes the node form' });
    for (const command of commands()) expect(command.startsWith('node "')).toBe(true);
  });

  it('prepares the copy before settings.json is read: a write made meanwhile is kept', async () => {
    shipNative(goodLine(), 1);
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ model: 'before' }));
    const pending = installHooksWithNative(paths, undefined, { suffixed: false });
    const hooksDir = path.dirname(paths.bridgeDest);
    const deadline = Date.now() + 10_000;
    while (!(fs.existsSync(hooksDir) && fs.readdirSync(hooksDir).some((f) => f.includes('.staged-')))) {
      expect(Date.now()).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // Another writer (Claude Code, the user) while the self-test runs.
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ model: 'during', theme: 'dark' }));
    expect((await pending).native).toBe(copy);
    expect(settings()).toMatchObject({ model: 'during', theme: 'dark' });
    expect(settings().hooks.Stop[0].hooks[0].command.startsWith(`"${copy}"`)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('which form is current', () => {
  it('a node install reads as outdated once the copy passes, and Update moves it in place', async () => {
    installHooks(paths);
    fs.writeFileSync(paths.settingsPath, JSON.stringify({ ...settings(), hooks: { ...settings().hooks, Stop: [{ matcher: '', hooks: [{ command: 'echo theirs' }] }, ...settings().hooks.Stop] } }));
    expect(statusHooks(paths).updateAvailable).toBe(false);
    shipNative(goodLine());
    const outcome = await updateHooksWithNative(paths, { suffixed: false });
    expect(outcome.native).toBe(copy);
    expect(outcome.updated).toContain('Stop');
    // The user's group keeps its place; ours is rewritten, not duplicated.
    expect(settings().hooks.Stop.map((g) => g.hooks[0].command)).toEqual(['echo theirs', `"${copy}" "${paths.bridgeDest}" Stop`]);
    expect(statusHooks(paths)).toMatchObject({ nativeAvailable: true, updateAvailable: false });
  });

  it('native entries whose copy is gone read as outdated, and Update puts them back on node', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    fs.unlinkSync(copy);
    fs.unlinkSync(paths.nativeSource as string);
    const status = statusHooks(paths);
    expect(status).toMatchObject({ nativeAvailable: false, updateAvailable: true });
    expect(status.hooks.every((h) => h.state === 'outdated')).toBe(true);
    const outcome = await updateHooksWithNative(paths, { suffixed: false });
    expect(outcome).toMatchObject({ ok: true, native: null });
    for (const command of commands()) expect(command.startsWith('node "')).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('rollback: --runtime node', () => {
  it('moves the entries back to node on the next install and keeps them there; native brings them back', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(applyRuntimeFlag(paths, 'node', false)).toBeNull();
    const outcome = await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(outcome.nativeReason).toMatch(/runtime set to node/);
    for (const command of commands()) expect(command.startsWith('node "')).toBe(true);
    // The copy stays on disk; status does not offer an update back to it.
    expect(fs.existsSync(copy)).toBe(true);
    expect(statusHooks(paths)).toMatchObject({ runtime: 'node', nativeAvailable: true, updateAvailable: false });
    expect(applyRuntimeFlag(paths, 'native', false)).toBeNull();
    expect((await installHooksWithNative(paths, undefined, { suffixed: false })).native).toBe(copy);
  });

  it('is written only by an installed wmux\'s CLI, not suffixed', () => {
    const runtimeFile = path.join(path.dirname(paths.bridgeDest), CLAUDE_RUNTIME_FILE);
    expect(applyRuntimeFlag(paths, 'node', true)).toMatch(/ignored: an isolated instance/);
    const checkout = { ...paths, bridgeSource: path.join(root, 'repo', 'integrations', 'claude', 'bin', 'wmux-bridge.mjs') };
    expect(applyRuntimeFlag(checkout, 'node', false)).toMatch(/ignored: a CLI that is not an installed wmux's/);
    expect(fs.existsSync(runtimeFile)).toBe(false);
    writeClaudeRuntime(path.dirname(paths.bridgeDest), 'native');
    expect(applyRuntimeFlag(checkout, 'node', false)).not.toBeNull();
    expect(fs.readFileSync(runtimeFile, 'utf8')).toBe('native\n');
  });
});

// #970's guard for `wmux web --allow-input`: a gate entry that cannot run
// raises no approval, so it must not read as installed.
describe.skipIf(process.platform === 'win32')('isPermissionGateInstalled with the native form', () => {
  it('is true while the copy passes for the bridge beside it, false once it is missing or failed', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(true);
    // The self-test recorded as failing for these bytes.
    recordProbe(path.dirname(copy), probeKey(sha256Of(fs.readFileSync(copy)), goodLine()), 'fail');
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(false);
    fs.unlinkSync(copy);
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(false);
  });

  // A copy never checked against the bridge beside it hands each run to node
  // (its pin differs), where the gate still raises: nothing proves it broken.
  it('stays true when the bridge beside the copy is not one it was checked against', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    fs.writeFileSync(paths.bridgeDest, '// another bridge\n');
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(true);
  });

  // A decision is answered by the node bridge the copy hands over to: with
  // no bridge beside it, nothing can answer.
  it('is false when no bridge is beside a copy that passed', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    fs.unlinkSync(paths.bridgeDest);
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(false);
  });

  // Bytes with no recorded self-test: not known to run, so the guard warns.
  it('is false for a copy with no recorded self-test', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    fs.appendFileSync(copy, '# other bytes\n');
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(false);
  });

  it('is false for a copy that passed but can no longer be executed', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    fs.chmodSync(copy, 0o600);
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(false);
  });
});

// An app update ships a new binary: the copy the entries run follows it at
// boot, as the bridge beside it does, and settings.json is never written.
describe.skipIf(process.platform === 'win32')('refreshClaudeNativeAtBoot', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const settingsSnapshot = () => ({ bytes: fs.readFileSync(paths.settingsPath, 'utf8'), mtime: fs.statSync(paths.settingsPath).mtimeMs });

  it('refreshes an installed copy to the shipped build once it passes, and writes no settings', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '');
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    const before = settingsSnapshot();
    expect(await refreshClaudeNativeAtBoot(paths, 'up-to-date')).toBe('up-to-date');
    fs.appendFileSync(paths.nativeSource as string, '# the next release\n');
    expect(await refreshClaudeNativeAtBoot(paths, 'up-to-date')).toBe('refreshed');
    expect(fs.readFileSync(copy).equals(fs.readFileSync(paths.nativeSource as string))).toBe(true);
    expect(settingsSnapshot()).toEqual(before);
  });

  it('keeps the copy in place when the shipped build does not pass', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '');
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    const working = fs.readFileSync(copy);
    shipNative('wmux-claude-hook protocol 2 pin x');
    expect(await refreshClaudeNativeAtBoot(paths, 'up-to-date')).toBe('kept');
    expect(fs.readFileSync(copy).equals(working)).toBe(true);
  });

  it('installs nothing where there is no copy, or a file wmux did not write', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '');
    shipNative(goodLine());
    expect(await refreshClaudeNativeAtBoot(paths, 'up-to-date')).toBe('not-installed');
    expect(fs.existsSync(copy)).toBe(false);
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.writeFileSync(copy, 'someone else\'s program');
    expect(await refreshClaudeNativeAtBoot(paths, 'up-to-date')).toBe('not-installed');
    expect(fs.readFileSync(copy, 'utf8')).toBe('someone else\'s program');
  });

  // A new copy pins this build's bridge: with that bridge not in place, or
  // no native entry naming the copy, the probe is not run at all.
  it('leaves the copy alone while the bridge is stale or no native entry names it', async () => {
    vi.stubEnv('WMUX_DATA_SUFFIX', '');
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    const working = fs.readFileSync(copy);
    fs.appendFileSync(paths.nativeSource as string, '# the next release\n');
    for (const bridge of ['failed', 'no-source'] as const) {
      expect(await refreshClaudeNativeAtBoot(paths, bridge)).toBe('stale-bridge');
    }
    installHooks(paths);
    expect(commands().every((c) => c.startsWith('node '))).toBe(true);
    expect(await refreshClaudeNativeAtBoot(paths, 'refreshed')).toBe('not-in-use');
    expect(fs.readFileSync(copy).equals(working)).toBe(true);
  });

  it('touches nothing from an isolated instance', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    const working = fs.readFileSync(copy);
    fs.appendFileSync(paths.nativeSource as string, '# the next release\n');
    vi.stubEnv('WMUX_DATA_SUFFIX', '-dogfood');
    expect(await refreshClaudeNativeAtBoot(paths, 'up-to-date')).toBe('isolated');
    expect(fs.readFileSync(copy).equals(working)).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('claudeHookRuntimeReport: the states doctor and --status show', () => {
  const state = (opts: { hasNode?: boolean; platform?: NodeJS.Platform } = {}) =>
    claudeHookRuntimeReport(paths, { hasNode: () => opts.hasNode ?? true, platform: opts.platform });
  const installNative = async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
  };

  it('native, node, runtime node, Windows and none', async () => {
    expect(state()).toMatchObject({ state: 'none', severity: 'ok' });
    installHooks(paths);
    expect(state()).toMatchObject({ state: 'node', severity: 'ok', detail: 'node' });
    expect(state({ platform: 'win32' })).toMatchObject({ state: 'windows', severity: 'ok' });
    writeClaudeRuntime(path.dirname(paths.bridgeDest), 'node');
    expect(state()).toMatchObject({ state: 'runtime-node', severity: 'ok' });
    writeClaudeRuntime(path.dirname(paths.bridgeDest), 'native');
    await installNative();
    expect(state()).toMatchObject({ state: 'native', severity: 'ok', detail: `native: ${copy}` });
  });

  it('mixed, a missing copy and a failed one', async () => {
    await installNative();
    const raw = settings();
    raw.hooks.Stop[0].hooks[0].command = `node "${paths.bridgeDest}" Stop`;
    fs.writeFileSync(paths.settingsPath, JSON.stringify(raw));
    expect(state()).toMatchObject({ state: 'mixed', severity: 'warn' });
    await installHooksWithNative(paths, undefined, { suffixed: false });
    recordProbe(path.dirname(copy), probeKey(sha256Of(fs.readFileSync(copy)), goodLine()), 'fail');
    expect(state()).toMatchObject({ state: 'copy-failed', severity: 'fail' });
    fs.unlinkSync(copy);
    expect(state()).toMatchObject({ state: 'copy-missing', severity: 'fail' });
  });

  // A failure recorded for the bridge beside the copy, by bytes that passed
  // for another bridge, is a pin mismatch: each run hands over to node, where
  // the hooks and the gate still work.
  it('a failure for this bridge after a pass for another reads as a pin mismatch, and the gate stays installed', async () => {
    await installNative();
    fs.writeFileSync(paths.bridgeDest, '// a newer bridge\n');
    const besideLine = claudeSelfTestLine(paths.bridgeDest) as string;
    recordProbe(path.dirname(copy), probeKey(sha256Of(fs.readFileSync(copy)), besideLine), 'fail');
    expect(state()).toMatchObject({ state: 'pin-mismatch', severity: 'warn' });
    expect(isPermissionGateInstalled(paths.settingsPath)).toBe(true);
  });

  it('no bridge beside a copy that passed: the runs stay native, and nothing can hand them over', async () => {
    await installNative();
    fs.unlinkSync(paths.bridgeDest);
    const report = state();
    expect(report).toMatchObject({ state: 'native', severity: 'warn' });
    expect(report.detail).toMatch(/no bridge beside it/);
    fs.writeFileSync(path.join(path.dirname(copy), 'native-disabled'), '');
    expect(state()).toMatchObject({ state: 'node-missing', severity: 'warn' });
  });

  // New bytes in place with no record (a hand copy, a record cleared): not
  // known to fail, nor to hand over; the self-test checks them.
  it('a copy with no recorded self-test: native, unchecked, and how to check it', async () => {
    await installNative();
    fs.appendFileSync(copy, '# other bytes\n');
    const report = state();
    expect(report).toMatchObject({ state: 'native', severity: 'warn' });
    expect(report.detail).toMatch(/no self-test is recorded/);
    expect(report.detail).toContain('wmux setup-hooks --reprobe');
  });

  it('a bridge the copy does not pin, and the kill switch: a hand-over to node, or native runs with no node', async () => {
    await installNative();
    fs.writeFileSync(paths.bridgeDest, '// an older bridge\n');
    expect(state()).toMatchObject({ state: 'pin-mismatch', severity: 'warn' });
    expect(state({ hasNode: false })).toMatchObject({ state: 'node-missing', severity: 'warn' });
    expect(state({ hasNode: false }).detail).toMatch(/not the one it was made from/);
    fs.copyFileSync(paths.bridgeSource as string, paths.bridgeDest);
    fs.writeFileSync(path.join(path.dirname(copy), 'native-disabled'), '');
    expect(state()).toMatchObject({ state: 'kill-switch', severity: 'ok' });
    expect(state({ hasNode: false })).toMatchObject({ state: 'node-missing', severity: 'warn' });
    expect(state({ hasNode: false }).detail).toMatch(/native-disabled/);
    expect(statusHooks(paths).hookRuntime.state).toMatch(/kill-switch|node-missing/);
  });
});

// An isolated instance writes the node form; its status must expect that
// form too, or its Update offer never clears.
describe.skipIf(process.platform === 'win32')('status in an isolated instance', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('expects the node form it writes, even with a passing copy in place', async () => {
    shipNative(goodLine());
    await installHooksWithNative(paths, undefined, { suffixed: false });
    vi.stubEnv('WMUX_DATA_SUFFIX', '-iso');
    await installHooksWithNative(paths);
    for (const command of commands()) expect(command.startsWith('node "')).toBe(true);
    expect(statusHooks(paths)).toMatchObject({ nativeAvailable: true, updateAvailable: false });
    expect(statusHooks(paths).hooks.every((h) => h.state === 'ok')).toBe(true);
  });
});

// Nothing to write, so nothing to copy or run: a corrupt settings.json, or a
// plugin that owns the hooks (whose hooks.json runs node).
describe.skipIf(process.platform === 'win32')('when no entries will be written', () => {
  it('copies and runs nothing, and reports no native runner', async () => {
    shipNative(goodLine());
    fs.writeFileSync(paths.settingsPath, '{ not json');
    const corrupt = await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(corrupt.ok).toBe(false);
    expect(corrupt.native).toBeUndefined();
    expect(fs.existsSync(copy)).toBe(false);
    expect((await updateHooksWithNative(paths, { suffixed: false })).ok).toBe(false);
    expect(fs.existsSync(copy)).toBe(false);

    fs.writeFileSync(paths.settingsPath, '{}');
    const manifest = path.join(path.dirname(paths.settingsPath), 'plugins', 'installed_plugins.json');
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, JSON.stringify({ plugins: { 'wmux-claude-integration@wmux': [{}] } }));
    const plugin = await installHooksWithNative(paths, undefined, { suffixed: false });
    expect(plugin).toMatchObject({ ok: true, pluginDetected: true });
    expect(plugin.native).toBeUndefined();
    expect(fs.existsSync(copy)).toBe(false);
  });
});

describe('--native-from', () => {
  it('names a file that exists, or the command stops before anything is written', () => {
    expect(nativeFromRefusal(path.join(root, 'core', 'target', 'relase', 'wmux-native'))).toMatch(/no file at/);
    expect(nativeFromRefusal(root)).toMatch(/no file at/);
    fs.writeFileSync(path.join(root, 'wmux-native'), 'x');
    expect(nativeFromRefusal(path.join(root, 'wmux-native'))).toBeNull();
  });
});
