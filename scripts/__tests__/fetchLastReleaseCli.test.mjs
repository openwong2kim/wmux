// The downgrade test's release: the newest stable `vX.Y.Z` tag, picked at run
// time so it follows every release without a step of its own.
import { describe, expect, it } from 'vitest';
import { latestRelease } from '../lib/last-release.mjs';

describe('latestRelease', () => {
  it('is the newest vX.Y.Z by number, prereleases and other tags left out', () => {
    expect(latestRelease(['v4.9.0', 'v4.14.0', 'v4.10.2', 'v4.15.0-beta.1', 'v4.14.0-rc.1', 'release-5', 'v5', ''])).toBe('4.14.0');
    expect(latestRelease(['v4.14.0\n', 'v10.0.0'])).toBe('10.0.0');
  });

  it('is null when there is no release tag', () => {
    expect(latestRelease([])).toBeNull();
    expect(latestRelease(['v4.15.0-beta.1', 'nightly'])).toBeNull();
  });
});
