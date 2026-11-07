import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, autoUpdater: {}, ipcMain: {}, net: {}, shell: {} }));

import { edgeArgs, isEdgeBinary, mergeDisableFeatures } from '../ChromeLauncher';
import { protectedChromeArgs } from '../ProtectedProxy';

describe('isEdgeBinary', () => {
  it('knows Edge by its binary name on each OS', () => {
    for (const p of [
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\MSEDGE.EXE',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/opt/microsoft/msedge/msedge',
    ]) expect(isEdgeBinary(p), p).toBe(true);
  });

  it('leaves Chrome and Chromium alone', () => {
    for (const p of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome-stable',
      '/opt/edge-tools/chrome',
    ]) expect(isEdgeBinary(p), p).toBe(false);
  });
});

describe('edgeArgs', () => {
  it('turns off implicit sign-in and sync for Edge only', () => {
    expect(edgeArgs('/usr/bin/microsoft-edge')).toEqual(['--disable-features=msImplicitSignin', '--disable-sync']);
    expect(edgeArgs('/usr/bin/google-chrome')).toEqual([]);
  });
});

describe('mergeDisableFeatures', () => {
  it('folds every --disable-features into one switch at the first one, without repeats', () => {
    expect(mergeDisableFeatures(['--a', '--disable-features=X,Y', '--b', '--disable-features=Y,Z', '--c'])).toEqual([
      '--a', '--disable-features=X,Y,Z', '--b', '--c',
    ]);
  });

  it('leaves a list without the switch as it is', () => {
    expect(mergeDisableFeatures(['--a', '--enable-features=Q'])).toEqual(['--a', '--enable-features=Q']);
  });

  it('a protected Edge gets one switch with DnsOverHttps and msImplicitSignin', () => {
    const edge = '/usr/bin/microsoft-edge';
    const args = mergeDisableFeatures(['--user-data-dir=/p', ...protectedChromeArgs(1234), ...edgeArgs(edge)]);
    expect(args.filter((a) => a.startsWith('--disable-features='))).toEqual(['--disable-features=DnsOverHttps,msImplicitSignin']);
    expect(args).toContain('--disable-sync');
  });
});
