import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedChromeProfileLabel } from '../ChromeLauncher';

// Profile display-name seeding (window chip "wmux · <profile>"). Real tmpdir —
// the main ChromeLauncher suite mocks node:fs, so this lives separately.

describe('seedChromeProfileLabel', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-chrome-label-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const readState = () =>
    JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')) as {
      profile: { info_cache: { Default: { name: string; is_using_default_name: boolean } } };
    };

  it('creates Local State with the label on a fresh profile dir', () => {
    seedChromeProfileLabel(dir, 'wmux · youtube-a');
    const def = readState().profile.info_cache.Default;
    expect(def.name).toBe('wmux · youtube-a');
    expect(def.is_using_default_name).toBe(false);
  });

  it('updates a wmux-authored label but never clobbers a user-chosen name', () => {
    seedChromeProfileLabel(dir, 'wmux · old');
    seedChromeProfileLabel(dir, 'wmux · new');
    expect(readState().profile.info_cache.Default.name).toBe('wmux · new');

    // Simulate the user renaming the profile inside Chrome.
    mkdirSync(dir, { recursive: true });
    const state = readState();
    state.profile.info_cache.Default.name = 'My Custom Name';
    writeFileSync(join(dir, 'Local State'), JSON.stringify(state));

    seedChromeProfileLabel(dir, 'wmux · newer');
    expect(readState().profile.info_cache.Default.name).toBe('My Custom Name');
  });
});
