import { describe, it, expect, afterEach } from 'vitest';
import { isPlausibleCwd } from '../cwdShape';

type BridgeHost = { electronAPI?: { platform?: string } };

/** Stand in for the preload bridge — the renderer's only host-platform source. */
function setBridgedPlatform(platform: string | undefined): void {
  const host = globalThis as BridgeHost;
  if (platform === undefined) delete host.electronAPI;
  else host.electronAPI = { platform };
}

// Regression (2026-07-21): a pane's cwd was stored as the literal string "path"
// — a prompt-scrape false positive that the old win32 rule ("any non-empty
// string passes") let through, breaking the Git tab's repo resolution. A real
// cwd is always absolute (or ~-anchored); relative tokens are rejected on every
// platform.
describe('isPlausibleCwd — absolute-shape guard', () => {
  it('rejects a bare relative token on every platform (the "path" incident)', () => {
    for (const plat of ['win32', 'darwin', 'linux']) {
      expect(isPlausibleCwd('path', plat)).toBe(false);
      expect(isPlausibleCwd('some words', plat)).toBe(false);
      expect(isPlausibleCwd('rel/child', plat)).toBe(false);
    }
  });

  it('rejects the empty string', () => {
    expect(isPlausibleCwd('', 'win32')).toBe(false);
  });

  it('accepts Windows drive and UNC shapes on win32', () => {
    expect(isPlausibleCwd('C:\\Users\\me', 'win32')).toBe(true);
    expect(isPlausibleCwd('D:/wmux', 'win32')).toBe(true);
    expect(isPlausibleCwd('\\\\server\\share', 'win32')).toBe(true);
  });

  it('accepts POSIX-absolute paths on win32 (WSL panes)', () => {
    expect(isPlausibleCwd('/home/me/project', 'win32')).toBe(true);
  });

  it('accepts ~-anchored paths (bash \\w renders $HOME as ~)', () => {
    expect(isPlausibleCwd('~', 'linux')).toBe(true);
    expect(isPlausibleCwd('~/work', 'darwin')).toBe(true);
    expect(isPlausibleCwd('~/work', 'win32')).toBe(true);
  });

  it('still rejects Windows shapes on POSIX platforms (2026-07-20 incident)', () => {
    expect(isPlausibleCwd('C:\\Users\\me', 'darwin')).toBe(false);
    expect(isPlausibleCwd('\\\\server\\share', 'linux')).toBe(false);
  });

  it('accepts POSIX-absolute paths on POSIX platforms', () => {
    expect(isPlausibleCwd('/home/me', 'linux')).toBe(true);
    expect(isPlausibleCwd('/Users/me', 'darwin')).toBe(true);
  });

  it('rejects a ~-prefixed non-anchor token (e.g. "~foo" is a username ref, not a cwd we track)', () => {
    expect(isPlausibleCwd('~foo/bar', 'linux')).toBe(false);
  });
});

// Issue #833: the renderer has no `process` (contextIsolation), so the omitted-
// platform default resolved to 'linux' there and rejected every Windows path.
// That is the write path for the per-surface cwd, so on a Windows host the cwd
// froze at the spawn directory. These lock the default's resolution order —
// they are the tests that would have caught it, since every existing case above
// passes the platform explicitly and so never exercises the default at all.
describe('isPlausibleCwd — default platform resolution', () => {
  afterEach(() => setBridgedPlatform(undefined));

  it('uses the preload bridge platform when there is no process (renderer)', () => {
    setBridgedPlatform('win32');
    // No explicit platform — exactly how surfaceSlice.updateSurfaceCwd calls it.
    expect(isPlausibleCwd('C:\\Users\\me\\repo')).toBe(true);
    expect(isPlausibleCwd('D:\\')).toBe(true);
    expect(isPlausibleCwd('\\\\server\\share')).toBe(true);
  });

  it('still rejects an impossible shape when the bridge reports a POSIX host', () => {
    setBridgedPlatform('darwin');
    expect(isPlausibleCwd('C:\\Users\\me')).toBe(false);
    expect(isPlausibleCwd('/Users/me')).toBe(true);
  });

  it('prefers the bridge over process.platform when both exist', () => {
    setBridgedPlatform('win32');
    // The suite runs on POSIX in CI, where process.platform would reject this.
    expect(isPlausibleCwd('C:\\Users\\me')).toBe(true);
  });

  it('falls back to process.platform when no bridge is present (main/daemon)', () => {
    setBridgedPlatform(undefined);
    // POSIX-absolute passes on every platform, so this holds on any runner.
    expect(isPlausibleCwd('/home/me')).toBe(true);
    // A Windows shape tracks the real host: accepted on win32, rejected on POSIX.
    expect(isPlausibleCwd('C:\\Users\\me')).toBe(process.platform === 'win32');
    // A relative token is rejected regardless of which source answered.
    expect(isPlausibleCwd('path')).toBe(false);
  });
});
