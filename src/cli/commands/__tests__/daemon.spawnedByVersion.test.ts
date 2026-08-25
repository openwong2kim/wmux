import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #1019 maintainer review, blocker 1: in the installed layout the CLI bundle
 * lives at `<resources>/cli-bundle`, where `__dirname/../../package.json`
 * does not exist — `resolveSpawnedByVersion()` must fall back to the
 * `'unknown'` sentinel the B′ staleness gate special-cases, NOT `'0.0.0'`,
 * which the gate parses as a real, positively-older version and uses to
 * justify killing the daemon the CLI just started (PTYs included).
 *
 * Exercised two ways: the unit itself (mocked fs), and the actual gate
 * (`isDaemonOlder`, unmocked, real production code) fed the unit's output —
 * so this proves the fix by execution, not just by reading the diff.
 */

const readFileSyncMock = vi.fn();

vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => readFileSyncMock(...args),
}));

import { resolveSpawnedByVersion } from '../daemon';
import { isDaemonOlder } from '../../../main/daemon/daemonReplacement';

describe('resolveSpawnedByVersion — installed-layout regression (#1019 review)', () => {
  beforeEach(() => {
    readFileSyncMock.mockReset();
  });

  it('returns the real version when package.json resolves (dev checkout)', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ version: '3.46.0' }));
    expect(resolveSpawnedByVersion()).toBe('3.46.0');
  });

  it('falls back to "unknown", NOT "0.0.0", when package.json is unreachable (installed cli-bundle layout)', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    });
    expect(resolveSpawnedByVersion()).toBe('unknown');
  });

  it('falls back to "unknown" when package.json parses but has no usable version field', () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ name: 'wmux' }));
    expect(resolveSpawnedByVersion()).toBe('unknown');
  });

  it('end-to-end: the "unknown" fallback survives the real staleness gate — the daemon is kept, not killed', () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const spawnedByVersion = resolveSpawnedByVersion();

    const verdict = isDaemonOlder({ spawnedByVersion }, '3.46.0', 1);

    expect(verdict.older).toBe(false);
    expect(verdict.reason).toContain('unknown');
  });

  it('end-to-end regression: "0.0.0" (the old fallback) WOULD have been read as positively older', () => {
    // Documents exactly what the bug looked like from the gate's side, so a
    // future revert of the fallback value is caught here even if nobody
    // reads this file's prose.
    const verdict = isDaemonOlder({ spawnedByVersion: '0.0.0' }, '3.46.0', 1);
    expect(verdict.older).toBe(true);
  });
});
