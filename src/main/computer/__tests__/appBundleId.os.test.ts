import { describe, expect, it, vi } from 'vitest';
import { PLUTIL_PATH, appBundleSelector, readAppBundleId, type ExecFileText } from '../appBundleId';

describe('readAppBundleId', () => {
  it('runs plutil by absolute path, without a shell, on the bundle\'s Info.plist', async () => {
    const execFile = vi.fn<ExecFileText>((_file, _args, cb) => cb(null, 'com.apple.TextEdit\n'));
    expect(await readAppBundleId('/Applications/My Notes.app', execFile, 'darwin')).toBe('com.apple.TextEdit');
    expect(PLUTIL_PATH).toBe('/usr/bin/plutil');
    expect(execFile.mock.calls[0].slice(0, 2)).toEqual([
      '/usr/bin/plutil',
      ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/Applications/My Notes.app/Contents/Info.plist'],
    ]);
  });

  it('answers null when the bundle id cannot be read', async () => {
    expect(await readAppBundleId('/x.app', (_f, _a, cb) => cb(new Error('No value at that key path'), ''), 'darwin')).toBeNull();
    expect(await readAppBundleId('/x.app', (_f, _a, cb) => cb(null, '  \n'), 'darwin')).toBeNull();
    expect(await readAppBundleId('/x.app', () => { throw new Error('spawn failed'); }, 'darwin')).toBeNull();
  });

  it('never runs plutil off macOS (on Windows the path is drive-relative)', async () => {
    for (const platform of ['win32', 'linux']) {
      const execFile = vi.fn<ExecFileText>((_file, _args, cb) => cb(null, 'com.example.Planted\n'));
      expect(await readAppBundleId('/Users/me/Notes.app', execFile, platform)).toBeNull();
      expect(execFile).not.toHaveBeenCalled();
    }
  });

  it('treats only an absolute .app path as a bundle selector', () => {
    expect(appBundleSelector('/Applications/Safari.app/')).toBe('/Applications/Safari.app');
    expect(appBundleSelector('Safari.app')).toBeNull();
    expect(appBundleSelector('Safari')).toBeNull();
    expect(appBundleSelector('com.apple.Safari')).toBeNull();
  });
});
