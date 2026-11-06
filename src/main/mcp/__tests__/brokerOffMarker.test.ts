import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { brokerOffEffects } from '../brokerOffMarker';

// The broker supervisor's filesystem steps, on a real temp directory. Each is
// best effort: nothing here may throw into the main process.

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'broker-off-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('broker-off effects', () => {
  it('marks the broker off on a trip only when nothing answers on its pipe, and clears it', async () => {
    const marker = path.join(tempDir(), '.wmux-x', 'mcp-broker-off');
    // Another instance's broker serves the pipe: no marker.
    await brokerOffEffects(() => marker, async () => true).tripped();
    expect(fs.existsSync(marker)).toBe(false);
    const off = brokerOffEffects(() => marker, async () => false);
    await off.tripped();
    expect(fs.existsSync(marker)).toBe(true);
    off.clear();
    expect(fs.existsSync(marker)).toBe(false);
    // Clearing what is not there, or marking where it cannot be written, does not throw.
    expect(() => off.clear()).not.toThrow();
    const blocked = path.join(tempDir(), 'file');
    fs.writeFileSync(blocked, '');
    await expect(brokerOffEffects(() => path.join(blocked, 'mcp-broker-off'), async () => false).tripped()).resolves.toBeUndefined();
    // A probe that throws is not a reason to mark.
    await brokerOffEffects(() => marker, async () => { throw new Error('probe'); }).tripped();
    expect(fs.existsSync(marker)).toBe(false);
  });
});
