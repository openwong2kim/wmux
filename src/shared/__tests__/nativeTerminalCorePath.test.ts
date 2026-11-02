import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('loads a module under the working directory only when it is named', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-core-cwd-'));
  try {
    const local = path.join(dir, 'core/wmux-term/dist/native-core/index.cjs');
    const marker = path.join(dir, 'loaded');
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, [
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1');`,
      "module.exports = { nativeCoreAbiVersion: () => 1, nativeCoreCapabilities: () => ['ring-v1'], NativeRing: function NativeRing() {} };",
    ].join('\n'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('WMUX_TERMINAL_CORE_MODULE', undefined);
    vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', undefined);
    vi.resetModules();
    const native = await import('../nativeTerminalCore');

    expect(native.nativeCorePath()).not.toBe(local);
    try {
      native.loadNativeTerminalCore('ring-v1');
    } catch {
      // No install location holds a module in a checkout's test run.
    }
    expect(fs.existsSync(marker)).toBe(false);

    vi.stubEnv('WMUX_TERMINAL_CORE_MODULE', local);
    expect(native.nativeCorePath()).toBe(local);
    native.loadNativeTerminalCore('ring-v1');
    expect(fs.existsSync(marker)).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
