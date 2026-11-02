// @wmux-lane unit — 'win32' here is the platform the reporter is told it runs on; the window and the daemon client are stubs.
import { describe, expect, it, vi } from 'vitest';
import { clearHostWindow, hostWindowHandle, reportHostWindow } from '../conptyHostWindow';
import { HOST_WINDOW_RPC } from '../../../shared/conptyParentWindow';

const hwnd = Buffer.from([0x2a, 0x10, 0, 0, 0, 0, 0, 0]);
const win = (destroyed = false) => ({ isDestroyed: () => destroyed, getNativeWindowHandle: () => hwnd });
const client = (isConnected = true) => ({ isConnected, rpc: vi.fn(() => Promise.resolve({ ok: true })) });

describe('reportHostWindow', () => {
  it('sends the desk window handle to the daemon as base64 (Windows)', () => {
    const c = client();
    reportHostWindow(() => c, win(), 'win32');
    expect(c.rpc).toHaveBeenCalledWith(HOST_WINDOW_RPC, { handle: hwnd.toString('base64') });
  });

  it('sends nothing off Windows, for a destroyed window, or without a connected daemon', () => {
    const c = client();
    reportHostWindow(() => c, win(), 'darwin');
    reportHostWindow(() => c, win(true), 'win32');
    reportHostWindow(() => c, null, 'win32');
    const down = client(false);
    reportHostWindow(() => down, win(), 'win32');
    reportHostWindow(() => null, win(), 'win32');
    expect(c.rpc).not.toHaveBeenCalled();
    expect(down.rpc).not.toHaveBeenCalled();
  });

  it('swallows a daemon that does not know the method', async () => {
    const old = { isConnected: true, rpc: vi.fn(() => Promise.reject(new Error('Unknown method: daemon.setHostWindow'))) };
    expect(() => reportHostWindow(() => old, win(), 'win32')).not.toThrow();
    await Promise.resolve();
  });
});

describe('clearHostWindow', () => {
  it('sends an all-zero handle, which the daemon reads as no window (Windows only)', () => {
    const c = client();
    clearHostWindow(() => c, 'win32');
    expect(c.rpc).toHaveBeenCalledWith(HOST_WINDOW_RPC, { handle: Buffer.alloc(8).toString('base64') });
    const other = client();
    clearHostWindow(() => other, 'darwin');
    clearHostWindow(() => null, 'win32');
    expect(other.rpc).not.toHaveBeenCalled();
  });
});

describe('hostWindowHandle', () => {
  it('is the window HWND on Windows and null otherwise', () => {
    expect(hostWindowHandle(win(), 'win32')?.equals(hwnd)).toBe(true);
    expect(hostWindowHandle(win(), 'linux')).toBeNull();
    expect(hostWindowHandle(win(true), 'win32')).toBeNull();
  });
});
