import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NATIVE_SELF_TEST_LINE, nativeLauncherPath, runNativeSelfTest, usableInstalledNative } from '../mcpLauncher';

// The self-test runs a real process. A shell script stands in for the binary
// on POSIX; the real build (when there is one) answers for itself everywhere.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const EXE = process.platform === 'win32' ? 'wmux-native.exe' : 'wmux-native';
const realBuild = [
  process.env.WMUX_NATIVE_HOOKS_BIN,
  path.join(REPO_ROOT, 'dist', 'native-hooks', EXE),
  path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'release', EXE),
  path.join(REPO_ROOT, 'core', 'wmux-native', 'target', 'debug', EXE),
].find((p): p is string => !!p && fs.existsSync(p));

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-native-selftest-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

describe.skipIf(process.platform === 'win32')('runNativeSelfTest (stand-in scripts)', () => {
  it('passes only on the exact protocol line', async () => {
    expect(await runNativeSelfTest(script('ok', `[ "$1 $2" = "mcp-shim --self-test" ] && echo '${NATIVE_SELF_TEST_LINE}'`))).toBe(true);
    expect(await runNativeSelfTest(script('other-protocol', "echo 'wmux-mcp-shim protocol 2'"))).toBe(false);
    expect(await runNativeSelfTest(script('marker-only', "echo 'wmux-native 0.0.0 (wmux-managed: native-hooks)'"))).toBe(false);
    expect(await runNativeSelfTest(script('fails', `echo '${NATIVE_SELF_TEST_LINE}'; exit 3`))).toBe(false);
  });

  it('gives up on a hung binary at the timeout, and on one that is not there', async () => {
    const started = Date.now();
    expect(await runNativeSelfTest(script('hangs', 'sleep 5'), 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(await runNativeSelfTest(path.join(dir, 'missing'))).toBe(false);
  });

  it('offers an installed launcher only beside a stable bundle and only when it passes', async () => {
    const stable = path.join(dir, 'mcp');
    fs.mkdirSync(stable);
    fs.writeFileSync(nativeLauncherPath(stable), `#!/bin/sh\necho '${NATIVE_SELF_TEST_LINE}'\n`, { mode: 0o755 });
    expect(await usableInstalledNative(stable)).toBeNull(); // no index.js beside it
    fs.writeFileSync(path.join(stable, 'index.js'), '// bundle');
    expect(await usableInstalledNative(stable)).toBe(nativeLauncherPath(stable));
    expect(await usableInstalledNative(stable, async () => false)).toBeNull();
  });
});

describe.skipIf(!realBuild)('runNativeSelfTest (the real build)', () => {
  it('passes on the binary this checkout builds', async () => {
    expect(await runNativeSelfTest(realBuild as string)).toBe(true);
  });
});
