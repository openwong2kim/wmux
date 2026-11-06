import { execFileSync, spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareNativeLauncher } from '../nativeLauncher';
import { nativeLauncherPath, runNativeSelfTest } from '../../../shared/mcpLauncher';
import { deliberateSleep } from '../../../test-utils/waitFor';

// A refresh while an agent is running the launcher: Windows cannot replace a
// running exe, only rename it, so the copy goes aside, the new one takes its
// name, and the aside is swept once nothing runs it. Needs a real build (the
// native-hooks workflow provides one on every OS).
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const EXE = process.platform === 'win32' ? 'wmux-native.exe' : 'wmux-native';
const realBuild = [
  process.env.WMUX_NATIVE_HOOKS_BIN,
  path.join(REPO_ROOT, 'dist', 'native-hooks', EXE),
  path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'release', EXE),
  path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'debug', EXE),
].find((p): p is string => !!p && fs.existsSync(p));
if (!realBuild && process.env.WMUX_REQUIRE_NATIVE_HOOKS === '1') {
  throw new Error('WMUX_REQUIRE_NATIVE_HOOKS=1 but no wmux-native build was found (set WMUX_NATIVE_HOOKS_BIN)');
}

let root = '';
let child: ChildProcess | null = null;

/** Stop the launcher and wait for it, whether or not it already exited. */
async function stop(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill();
  await exited;
}
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-refresh-')));
});
afterEach(async () => {
  if (child) await stop(child);
  child = null;
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A second build of the same program, with other bytes that still run: a
 * trailer after the image, or on macOS (where that breaks the signature) the
 * same image signed ad hoc under another identifier.
 */
function writeNewerBuild(file: string): void {
  if (process.platform === 'darwin') {
    fs.copyFileSync(realBuild as string, file);
    execFileSync('codesign', ['--force', '--sign', '-', '--identifier', 'wmux-native-newer', file], { stdio: 'ignore' });
    return;
  }
  fs.writeFileSync(file, Buffer.concat([fs.readFileSync(realBuild as string), Buffer.from('\nwmux-managed: native-hooks newer\n')]), { mode: 0o755 });
}

describe.skipIf(!realBuild)('prepareNativeLauncher — a refresh while the launcher runs', () => {
  it('moves the running copy aside, installs the new one, and sweeps the aside on the next boot', async () => {
    const stableDir = path.join(root, '.wmux', 'mcp');
    fs.mkdirSync(stableDir, { recursive: true });
    const source = path.join(root, 'resources', 'native-hooks', EXE);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.copyFileSync(realBuild as string, source);
    const first = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runNativeSelfTest });
    expect(first.binary).toBe(nativeLauncherPath(stableDir));

    // An agent's launcher, retrying a broker that never comes (about 3 s):
    // a token is present and the pipe name is this test's own.
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    child = spawn(first.binary as string, ['mcp-shim'], {
      env: { ...process.env, HOME: home, USERPROFILE: home, WMUX_DATA_SUFFIX: `-refresh-${process.pid}`, WMUX_AUTH_TOKEN: 't' },
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
    });
    // Nothing to wait for: it only needs to be running, and it stays so for ~3 s.
    await deliberateSleep(300, 'let the launcher start; it then retries for about 3 s');
    expect(child.exitCode).toBeNull();

    writeNewerBuild(source);
    const refreshed = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runNativeSelfTest });
    expect(refreshed).toEqual({ binary: nativeLauncherPath(stableDir) });
    expect(fs.readFileSync(nativeLauncherPath(stableDir)).equals(fs.readFileSync(source))).toBe(true);
    if (process.platform === 'win32') {
      // Still running, so the aside could not be deleted yet.
      expect(child.exitCode).toBeNull();
      expect(fs.readdirSync(stableDir).filter((f) => f.includes('.previous'))).toHaveLength(1);
    }

    await stop(child);
    const nextBoot = await prepareNativeLauncher({ sourcePath: source, stableDir, selfTest: runNativeSelfTest });
    expect(nextBoot.binary).toBe(nativeLauncherPath(stableDir));
    expect(fs.readdirSync(stableDir).filter((f) => f.includes('.previous'))).toEqual([]);
  }, 30_000);
});
