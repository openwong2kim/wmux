// Before a protected launch the launcher turns chrome://inspect's "Allow
// remote debugging for this browser instance" off in the profile's Local
// State, where Chrome keeps it across restarts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));

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
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
});
