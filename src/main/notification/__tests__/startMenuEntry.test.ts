// @wmux-lane unit
// The platform is a field of the probe here ("win32" is data), never process.platform.
import { describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ isSupported: vi.fn(() => true) }));
vi.mock('electron', () => ({ Notification: { isSupported: electron.isSupported } }));

import { shouldWriteStartMenuEntry, writeStartMenuEntry, type StartMenuEntryProbe } from '../startMenuEntry';

const installed: StartMenuEntryProbe = {
  platform: 'win32',
  isPackaged: true,
  dataSuffix: '',
  squirrelRoot: 'C:\\Users\\u\\AppData\\Local\\wmux',
};

describe('shouldWriteStartMenuEntry (#2971)', () => {
  it('writes the entry for the installed app on Windows', () => {
    expect(shouldWriteStartMenuEntry(installed)).toBe(true);
  });

  // Any of these would point the installed app's entry at a copy (#2964).
  it.each([
    ['an isolated copy (data suffix)', { dataSuffix: '-portable' }],
    ['a verification copy', { dataSuffix: '-verify-a1' }],
    ['a copy outside a Squirrel install', { squirrelRoot: null }],
    ['a dev build', { isPackaged: false }],
    ['macOS', { platform: 'darwin' as const }],
    ['Linux', { platform: 'linux' as const }],
  ])('never for %s', (_label, over) => {
    expect(shouldWriteStartMenuEntry({ ...installed, ...over })).toBe(false);
  });
});

describe('writeStartMenuEntry', () => {
  it("asks for Electron's notification support, which runs its toast setup", () => {
    electron.isSupported.mockClear();
    writeStartMenuEntry();
    expect(electron.isSupported).toHaveBeenCalledTimes(1);
  });

  it('never throws', () => {
    electron.isSupported.mockImplementationOnce(() => { throw new Error('no presenter'); });
    expect(() => writeStartMenuEntry()).not.toThrow();
  });
});
