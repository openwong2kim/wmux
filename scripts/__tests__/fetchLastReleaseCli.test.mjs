// The downgrade test's release: the newest stable `vX.Y.Z` tag, picked at run
// time so it follows every release without a step of its own.
import { describe, expect, it } from 'vitest';
import { AssetNotFound, fetchNewestPublished, stableReleases } from '../lib/last-release.mjs';

describe('stableReleases', () => {
  it('lists vX.Y.Z newest first by number, prereleases and other tags left out', () => {
    expect(stableReleases(['v4.9.0', 'v4.14.0', 'v4.10.2', 'v4.15.0-beta.1', 'v4.14.0-rc.1', 'release-5', 'v5', ''])).toEqual(['4.14.0', '4.10.2', '4.9.0']);
    expect(stableReleases(['v4.14.0\n', 'v10.0.0', 'v4.14.0'])).toEqual(['10.0.0', '4.14.0']);
  });

  it('is empty when there is no release tag', () => {
    expect(stableReleases([])).toEqual([]);
    expect(stableReleases(['v4.15.0-beta.1', 'nightly'])).toEqual([]);
  });
});

describe('fetchNewestPublished', () => {
  const logs = [];
  const log = (line) => logs.push(line);

  it('fetches the newest release', async () => {
    const tried = [];
    expect(await fetchNewestPublished(['4.15.0', '4.14.0'], async (r) => (tried.push(r), `cli ${r}`), log)).toBe('cli 4.15.0');
    expect(tried).toEqual(['4.15.0']);
  });

  it('falls back once, to the release before, only when the newest has no assets yet', async () => {
    logs.length = 0;
    const tried = [];
    const fetchRelease = async (r) => {
      tried.push(r);
      if (r !== '4.13.0') throw new AssetNotFound('HTTP 404');
      return `cli ${r}`;
    };
    await expect(fetchNewestPublished(['4.15.0', '4.14.0', '4.13.0'], fetchRelease, log)).rejects.toThrow('HTTP 404');
    expect(tried).toEqual(['4.15.0', '4.14.0']);
    expect(logs).toEqual(['last release: v4.15.0 has no assets yet (HTTP 404), using v4.14.0']);
    tried.length = 0;
    expect(await fetchNewestPublished(['4.14.0', '4.13.0'], fetchRelease, log)).toBe('cli 4.13.0');
    expect(tried).toEqual(['4.14.0', '4.13.0']);
  });

  it('does not fall back on any other error, or with no release before', async () => {
    const tried = [];
    const broken = async (r) => {
      tried.push(r);
      throw new Error('SHA-256 mismatch');
    };
    await expect(fetchNewestPublished(['4.15.0', '4.14.0'], broken, log)).rejects.toThrow('SHA-256 mismatch');
    expect(tried).toEqual(['4.15.0']);
    await expect(fetchNewestPublished(['4.15.0'], async () => { throw new AssetNotFound('HTTP 404'); }, log)).rejects.toThrow('HTTP 404');
  });
});
