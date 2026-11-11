// @wmux-lane unit — every native path helper is a mock; nothing is loaded.
import { describe, it, expect, vi } from 'vitest';

// Loading this module must not load koffi. Every process that loads main
// imports it, the Squirrel installer hooks included, and a hook process that
// has loaded koffi hangs on exit: koffi's DLL detach calls FlushFileBuffers on
// stdout, and Squirrel reads that pipe only after the hook exits (#3017).
const paths = vi.hoisted(() => ({
  canonicalExePath: vi.fn((p: string) => p),
  onLocalFixedDrive: vi.fn(() => true),
  systemDirectory: vi.fn(() => 'C:\\Windows\\System32'),
}));
vi.mock('../../../../shared/netWinPaths', () => paths);
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), removeHandler: vi.fn() }, shell: { openExternal: vi.fn() } }));
vi.mock('../../../net/elevate', () => ({ shellExecuteAndWait: vi.fn(), tokenElevationType: vi.fn(() => null) }));
vi.mock('../../../computer/selfElevation', () => ({ isSelfElevated: vi.fn(() => null) }));

describe('netFirewall handler module load', () => {
  it('reads no native path facts when it loads', async () => {
    await import('../netFirewall.handler');
    expect(paths.canonicalExePath).not.toHaveBeenCalled();
    expect(paths.onLocalFixedDrive).not.toHaveBeenCalled();
    expect(paths.systemDirectory).not.toHaveBeenCalled();
  });
});
