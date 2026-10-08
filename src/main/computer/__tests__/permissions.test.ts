import { describe, expect, it, vi } from 'vitest';
import { TCCUTIL_PATH, isPermissionOp, requestHelperPermissions, resetHelperPermissions, revealHelper } from '../permissions';

const BINARY = '/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app/Contents/MacOS/wmux-computer-use';
const APP = '/Applications/wmux.app/Contents/Resources/computer-use-macos/wmux Computer Use.app';

function deps() {
  const order: string[] = [];
  const child = { unref: vi.fn(), on: vi.fn() };
  return {
    order,
    child,
    helperPath: BINARY,
    verify: vi.fn(async (command: string) => { order.push(`verify ${command}`); }),
    spawn: vi.fn((command: string, args: readonly string[]) => { order.push(`spawn ${command} ${args.join(' ')}`); return child; }),
    execFile: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(),
  };
}

describe('permission buttons', () => {
  it('Request access spawns the helper with --request-permissions only after it passed verification', async () => {
    const d = deps();
    await requestHelperPermissions(d);
    expect(d.order).toEqual([`verify ${BINARY}`, `spawn ${BINARY} --request-permissions`]);
    expect(d.child.unref).toHaveBeenCalled();
  });

  it('Request access spawns nothing when verification fails', async () => {
    const d = deps();
    d.verify.mockRejectedValueOnce(new Error('signature does not match'));
    await expect(requestHelperPermissions(d)).rejects.toThrow('signature does not match');
    expect(d.spawn).not.toHaveBeenCalled();
  });

  it('Reset access runs tccutil by absolute path for exactly the helper\'s two services', async () => {
    const d = deps();
    await resetHelperPermissions(d);
    expect(TCCUTIL_PATH).toBe('/usr/bin/tccutil');
    expect(d.execFile.mock.calls).toEqual([
      ['/usr/bin/tccutil', ['reset', 'Accessibility', 'com.electron.wmux.computer-use']],
      ['/usr/bin/tccutil', ['reset', 'ScreenCapture', 'com.electron.wmux.computer-use']],
    ]);
  });

  it('Show helper in Finder selects the .app, not the binary inside it', () => {
    const d = deps();
    revealHelper(d);
    expect(d.showItemInFolder).toHaveBeenCalledWith(APP);
  });

  it('refuses without a helper and accepts only the three ops', async () => {
    await expect(requestHelperPermissions({ ...deps(), helperPath: null })).rejects.toThrow(/no computer-use helper/);
    expect(['request', 'reset', 'reveal'].every(isPermissionOp)).toBe(true);
    expect(isPermissionOp('rm')).toBe(false);
  });
});
