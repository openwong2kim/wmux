import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NATIVE_SELF_TEST_LINE, approvedInstalledNative, nativeLauncherPath, runNativeSelfTest } from '../mcpLauncher';
import { fileSha256, probeKey, recordProbe } from '../probedNative';

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
    expect(await runNativeSelfTest(script('ok', `[ "$1 $2" = "mcp-shim --self-test" ] && echo '${NATIVE_SELF_TEST_LINE}'`))).toBe('pass');
    expect(await runNativeSelfTest(script('other-protocol', "echo 'wmux-mcp-shim protocol 2'"))).toBe('fail');
    expect(await runNativeSelfTest(script('marker-only', "echo 'wmux-native 0.0.0 (wmux-managed: native-hooks)'"))).toBe('fail');
    expect(await runNativeSelfTest(script('fails', `echo '${NATIVE_SELF_TEST_LINE}'; exit 3`))).toBe('fail');
  });

  it('reports a hung binary as a timeout, not a failure', async () => {
    const started = Date.now();
    expect(await runNativeSelfTest(script('hangs', 'sleep 5'), 300)).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // A spawn error (access denied, a scanner holding the file, the file gone)
  // says nothing about the bytes, so it must not become a recorded failure.
  it('reports a copy that cannot be started as unstartable, not a failure', async () => {
    expect(await runNativeSelfTest(path.join(dir, 'missing'))).toBe('unstartable');
    const notExecutable = script('not-executable', `echo '${NATIVE_SELF_TEST_LINE}'`);
    fs.chmodSync(notExecutable, 0o644);
    expect(await runNativeSelfTest(notExecutable)).toBe('unstartable');
  });
});

describe.skipIf(!realBuild)('runNativeSelfTest (the real build)', () => {
  it('passes on the binary this checkout builds', async () => {
    expect(await runNativeSelfTest(realBuild as string)).toBe('pass');
  });
});

describe('approvedInstalledNative', () => {
  it('offers the installed launcher only beside a stable bundle and with a recorded pass for its bytes', () => {
    const stable = path.join(dir, 'mcp');
    fs.mkdirSync(stable);
    const binary = nativeLauncherPath(stable);
    fs.writeFileSync(binary, 'build 1 wmux-managed: native-hooks');
    const hash = fileSha256(binary) as string;
    recordProbe(stable, probeKey(hash, NATIVE_SELF_TEST_LINE), 'pass');
    expect(approvedInstalledNative(stable)).toBeNull(); // no index.js beside it
    fs.writeFileSync(path.join(stable, 'index.js'), '// bundle');
    expect(approvedInstalledNative(stable)).toBe(binary);
    // Other bytes in its place are not what was approved.
    fs.writeFileSync(binary, 'build 2 wmux-managed: native-hooks');
    expect(approvedInstalledNative(stable)).toBeNull();
    recordProbe(stable, probeKey(fileSha256(binary) as string, NATIVE_SELF_TEST_LINE), 'fail');
    expect(approvedInstalledNative(stable)).toBeNull();
  });
});
