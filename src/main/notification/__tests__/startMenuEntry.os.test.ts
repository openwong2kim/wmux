import { describe, expect, it, vi } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const electron = vi.hoisted(() => ({ isSupported: vi.fn(() => true) }));
vi.mock('electron', () => ({ Notification: { isSupported: electron.isSupported } }));
const hygiene = vi.hoisted(() => ({
  removeSecondStartMenuEntry: vi.fn(async () => ({ actions: [], failure: null })),
}));
vi.mock('../../shortcutHygiene', () => hygiene);

import {
  keepOneStartMenuEntry,
  publisherFromPackageJson,
  shouldWriteStartMenuEntry,
  writeStartMenuEntry,
  type StartMenuEntryProbe,
} from '../startMenuEntry';

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

describe('publisherFromPackageJson', () => {
  const withPkg = (pkg: unknown, fn: (dir: string) => void) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pkg-'));
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it("reads the author's name, as an object or the string form", () => {
    withPkg({ author: { name: 'openwong2kim', email: 'x@example.com' } }, (d) => expect(publisherFromPackageJson(d)).toBe('openwong2kim'));
    withPkg({ author: 'Some One <some@example.com> (https://example.com)' }, (d) => expect(publisherFromPackageJson(d)).toBe('Some One'));
  });

  it('is empty when there is no author or no package.json', () => {
    withPkg({ name: 'wmux' }, (d) => expect(publisherFromPackageJson(d)).toBe(''));
    expect(publisherFromPackageJson(path.join(os.tmpdir(), 'wmux-no-such-dir-2971'))).toBe('');
  });
});

describe('keepOneStartMenuEntry', () => {
  it('writes the entry now and looks for the second one later, once', async () => {
    vi.useFakeTimers();
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-pkg-'));
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ author: { name: 'openwong2kim' } }));
      electron.isSupported.mockClear();
      hygiene.removeSecondStartMenuEntry.mockClear();
      keepOneStartMenuEntry('C:\\wmux\\app-1.0.0\\wmux.exe', dir);
      fs.rmSync(dir, { recursive: true, force: true });
      expect(electron.isSupported).toHaveBeenCalledTimes(1);
      expect(hygiene.removeSecondStartMenuEntry).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(hygiene.removeSecondStartMenuEntry).toHaveBeenCalledTimes(1);
      expect(hygiene.removeSecondStartMenuEntry).toHaveBeenCalledWith('C:\\wmux\\app-1.0.0\\wmux.exe', 'openwong2kim');
    } finally {
      vi.useRealTimers();
    }
  });
});
