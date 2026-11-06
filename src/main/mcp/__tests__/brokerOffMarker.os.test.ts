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
  it('writes the marker, creating its directory, and clears it', () => {
    const marker = path.join(tempDir(), '.wmux-x', 'mcp-broker-off');
    const off = brokerOffEffects(() => marker);
    off.mark();
    expect(fs.existsSync(marker)).toBe(true);
    off.clear();
    expect(fs.existsSync(marker)).toBe(false);
    // Clearing what is not there, or marking where it cannot be written, does not throw.
    expect(() => off.clear()).not.toThrow();
    const blocked = path.join(tempDir(), 'file');
    fs.writeFileSync(blocked, '');
    expect(() => brokerOffEffects(() => path.join(blocked, 'mcp-broker-off')).mark()).not.toThrow();
  });

  it.skipIf(process.platform === 'win32')('removes the socket file only when nothing answers on it', async () => {
    const sock = path.join(tempDir(), 'b.sock');
    fs.writeFileSync(sock, '');
    await brokerOffEffects(undefined, () => sock, async () => true).unlinkStaleSocket();
    expect(fs.existsSync(sock)).toBe(true);
    await brokerOffEffects(undefined, () => sock, async () => false).unlinkStaleSocket();
    expect(fs.existsSync(sock)).toBe(false);
    // Already gone: still no throw.
    await expect(brokerOffEffects(undefined, () => sock, async () => false).unlinkStaleSocket()).resolves.toBeUndefined();
  });
});
