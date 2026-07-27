import { describe, it, expect, vi, beforeEach } from 'vitest';

// A macOS GUI launch inherits only launchd's minimal PATH and can't find Homebrew
// git — execFile('git', …) seeing only this PATH failed quietly, which was the cause
// of the branch-sync badge not appearing in the workspace sidebar on macOS
// (owner-reported 2026-07-19). This locks that getExecEnv() augments PATH with the
// Homebrew/system paths on mac only.

vi.mock('../platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform')>();
  return { ...actual, isMac: true };
});

describe('getExecEnv', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('macOS: augments PATH with the Homebrew/system paths', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/usr/bin:/bin';
    try {
      const { getExecEnv } = await import('../execEnv');
      const env = getExecEnv();
      expect(env.PATH).toContain('/opt/homebrew/bin');
      expect(env.PATH).toContain('/usr/local/bin');
      expect(env.PATH).toContain('/usr/bin'); // preserves the existing PATH
      // ~/.local/bin: per-user CLI installs (the tailscale shim case, 2026-07-27).
      // Substring match, not split(':') — on a Windows CI runner (isMac mocked
      // true) path.join yields C:\Users\..., whose drive colon breaks the split.
      const { default: os } = await import('node:os');
      const { default: path } = await import('node:path');
      expect(env.PATH).toContain(path.join(os.homedir(), '.local', 'bin'));
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('macOS: does not add a path that is already in PATH', async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const { getExecEnv } = await import('../execEnv');
      const env = getExecEnv();
      const occurrences = (env.PATH ?? '').split(':').filter((p) => p === '/opt/homebrew/bin').length;
      expect(occurrences).toBe(1);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

describe('getExecEnv on non-mac', () => {
  it('returns process.env as-is (no recompute)', async () => {
    vi.doMock('../platform', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../platform')>();
      return { ...actual, isMac: false };
    });
    vi.resetModules();
    const { getExecEnv } = await import('../execEnv');
    expect(getExecEnv()).toBe(process.env);
  });
});
