import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordedNativeVerdict } from '../doctor';
import { NATIVE_SELF_TEST_LINE, approvedInstalledNative, nativeLauncherPath } from '../../../shared/mcpLauncher';
import { fileSha256, probeKey, recordProbe } from '../../../shared/probedNative';

// The doctor's MCP section reads the launcher's self-test verdict from the
// record the app writes (shared/probedNative.ts), on disk.
describe('recordedNativeVerdict', () => {
  it('reads the verdict the app records for these bytes and the self-test line', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-native-'));
    const binary = nativeLauncherPath(dir);
    fs.writeFileSync(binary, 'launcher bytes');
    expect(recordedNativeVerdict(binary)).toBeUndefined();
    const hash = fileSha256(binary) as string;
    recordProbe(dir, probeKey(hash, NATIVE_SELF_TEST_LINE), 'pass');
    expect(recordedNativeVerdict(binary)).toBe('pass');
    // The same record approvedInstalledNative reads.
    fs.writeFileSync(path.join(dir, 'index.js'), '');
    expect(approvedInstalledNative(dir)).toBe(binary);
    // Other bytes in place: their verdict is not the recorded one.
    fs.writeFileSync(binary, 'other bytes');
    expect(recordedNativeVerdict(binary)).toBeUndefined();
  });
});
