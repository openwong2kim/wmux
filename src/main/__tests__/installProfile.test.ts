import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROFILE_MARKER_FILE,
  hookUserDataDir,
  isExistingProfile,
  markProfileActive,
  markProfileUninstalled,
  planInstallHook,
} from '../installProfile';

describe('planInstallHook', () => {
  // #2971: Update.exe never writes a Start Menu link; Electron's toast setup
  // owns the one entry, at the top level of Programs.
  it('a first install turns autostart on and creates only the Desktop shortcut', () => {
    expect(planInstallHook(false)).toEqual({ autostart: 'enable', shortcutLocations: 'Desktop' });
  });

  it('an update keeps autostart as the user left it and runs no --createShortcut', () => {
    expect(planInstallHook(true)).toEqual({ autostart: 'refresh', shortcutLocations: null });
  });
});

describe('isExistingProfile', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-install-profile-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('an empty userData is a first install', () => {
    expect(isExistingProfile(dir)).toBe(false);
    expect(isExistingProfile(path.join(dir, 'missing'))).toBe(false);
  });

  it('a normal startup marks the profile, and the hook then reads an update', () => {
    markProfileActive(dir);
    expect(fs.readFileSync(path.join(dir, PROFILE_MARKER_FILE), 'utf-8')).toBe('active');
    expect(isExistingProfile(dir)).toBe(true);
  });

  it('from a version that never wrote the marker, session.json decides', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), '{}');
    expect(isExistingProfile(dir)).toBe(true);
  });

  it('after an uninstall the next install is a first install again, whatever userData holds', () => {
    fs.writeFileSync(path.join(dir, 'session.json'), '{}');
    markProfileActive(dir);
    markProfileUninstalled(dir);
    expect(isExistingProfile(dir)).toBe(false);

    // ...until wmux starts normally once more.
    markProfileActive(dir);
    expect(isExistingProfile(dir)).toBe(true);
  });

  it('an unrecognized marker falls back to session.json', () => {
    fs.writeFileSync(path.join(dir, PROFILE_MARKER_FILE), 'garbage');
    expect(isExistingProfile(dir)).toBe(false);
    fs.writeFileSync(path.join(dir, 'session.json'), '{}');
    expect(isExistingProfile(dir)).toBe(true);
  });

  it('creates userData when it does not exist yet', () => {
    const nested = path.join(dir, 'Roaming', 'wmux');
    markProfileActive(nested);
    expect(isExistingProfile(nested)).toBe(true);
  });
});

describe('hookUserDataDir', () => {
  it('adds WMUX_DATA_SUFFIX the way appInit does, and nothing without one', () => {
    expect(hookUserDataDir('C:\\Users\\u\\AppData\\Roaming\\wmux', {})).toBe('C:\\Users\\u\\AppData\\Roaming\\wmux');
    expect(hookUserDataDir('C:\\Users\\u\\AppData\\Roaming\\wmux', { WMUX_DATA_SUFFIX: '-dev' }))
      .toBe('C:\\Users\\u\\AppData\\Roaming\\wmux-dev');
  });
});
