// The Claude hook entries in their native form, against a throwaway home and a
// stand-in for wmux-native. Nothing here touches the real ~/.claude or ~/.wmux.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyRuntimeFlag,
  installHooks,
  installHooksWithNative,
  isPermissionGateInstalled,
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
});
