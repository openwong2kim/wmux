// Before a protected launch the launcher turns chrome://inspect's "Allow
// remote debugging for this browser instance" off in the profile's Local
// State, where Chrome keeps it across restarts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));
const { failRename } = vi.hoisted(() => ({ failRename: { on: false } }));
vi.mock('node:fs', async (orig) => {
  const real = (await orig()) as typeof import('node:fs');
  return {
    ...real,
    renameSync: (from: string, to: string) => {
      if (failRename.on) throw Object.assign(new Error('EXDEV (unit test)'), { code: 'EXDEV' });
      return real.renameSync(from, to);
    },
  };
});

import { clearRemoteDebuggingToggle } from '../ChromeLauncher';

const dirs: string[] = [];
function profile(localState?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'wmux-localstate-'));
  dirs.push(dir);
  if (localState !== undefined) writeFileSync(join(dir, 'Local State'), localState);
  return dir;
}
const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')) as Record<string, unknown>;

afterEach(() => {
  failRename.on = false;
  for (const dir of dirs.splice(0)) {
    try { chmodSync(join(dir, 'Local State'), 0o600); } catch { /* none */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('clearRemoteDebuggingToggle', () => {
  it('removes devtools.remote_debugging.user-enabled and keeps everything else', () => {
    const dir = profile(JSON.stringify({ browser: { enabled_labs_experiments: ['x'] }, devtools: { remote_debugging: { 'user-enabled': true, other: 1 }, keep: 2 } }));
    clearRemoteDebuggingToggle(dir);
    expect(read(dir)).toEqual({ browser: { enabled_labs_experiments: ['x'] }, devtools: { remote_debugging: { other: 1 }, keep: 2 } });
    expect(existsSync(join(dir, 'Local State.wmux-tmp'))).toBe(false);
  });

  it('leaves a Local State without the setting byte for byte', () => {
    const text = '{"devtools":{"keep":true},"a":1}';
    const dir = profile(text);
    clearRemoteDebuggingToggle(dir);
    expect(readFileSync(join(dir, 'Local State'), 'utf8')).toBe(text);
  });

  it('does nothing for a missing or unparsable Local State', () => {
    const missing = profile();
    expect(() => clearRemoteDebuggingToggle(missing)).not.toThrow();
    expect(existsSync(join(missing, 'Local State'))).toBe(false);
    const broken = profile('{not json');
    clearRemoteDebuggingToggle(broken);
    expect(readFileSync(join(broken, 'Local State'), 'utf8')).toBe('{not json');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('throws on a Local State it cannot read, so the launch does not go on with the setting unknown', () => {
    const dir = profile(JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }));
    chmodSync(join(dir, 'Local State'), 0o000);
    expect(() => clearRemoteDebuggingToggle(dir)).toThrow(/EACCES/);
  });

  it.skipIf(process.platform === 'win32')('keeps the file mode on rewrite', () => {
    const dir = profile(JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }));
    chmodSync(join(dir, 'Local State'), 0o640);
    clearRemoteDebuggingToggle(dir);
    expect(statSync(join(dir, 'Local State')).mode & 0o777).toBe(0o640);
  });

  it('leaves no temp file when the rename fails, and says so', () => {
    const dir = profile(JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }));
    failRename.on = true;
    expect(() => clearRemoteDebuggingToggle(dir)).toThrow(/EXDEV/);
    expect(readdirSync(dir)).toEqual(['Local State']);
  });
});
