import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ----- fs mock -----------------------------------------------------------
//
// We intercept fs.existsSync and fs.statSync so each test can declare which
// Caskroom path "exists" and what its stat looks like. The vi.hoisted block
// keeps the mock factory and the tests pointing at the same vi.fn() handles
// despite vi.mock() being hoisted above all imports.
const fsMocks = vi.hoisted(() => {
  return {
    existsSync: vi.fn(),
    statSync: vi.fn(),
  };
});

vi.mock('fs', () => ({
  existsSync: fsMocks.existsSync,
  statSync: fsMocks.statSync,
}));

// ----- platform mock -----------------------------------------------------
//
// Default state is mac. Per-OS suites below call vi.resetModules() and
// vi.doMock to flip isMac to false (linux/win) before re-importing the SUT.
vi.mock('../../../shared/platform', () => ({
  isMac: true,
}));

const APPLE_SILICON = '/opt/homebrew/Caskroom/wmux';
const INTEL_MAC = '/usr/local/Caskroom/wmux';

function makeStat(isDir: boolean) {
  return { isDirectory: () => isDir };
}

describe('BrewDetector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fsMocks.existsSync.mockReturnValue(false);
    fsMocks.statSync.mockReturnValue(makeStat(false));
  });

  afterEach(() => {
    vi.resetModules();
  });

  describe('on macOS', () => {
    // Top-level vi.mock already sets isMac: true. No re-mock needed.

    it('returns true and the Apple Silicon path when /opt/homebrew/Caskroom/wmux exists', async () => {
      fsMocks.existsSync.mockImplementation((p: string) => p === APPLE_SILICON);
      fsMocks.statSync.mockImplementation((p: string) => makeStat(p === APPLE_SILICON));

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(true);
      expect(getBrewCaskroomPath()).toBe(APPLE_SILICON);
    });

    it('returns true and the Intel path when /usr/local/Caskroom/wmux exists', async () => {
      fsMocks.existsSync.mockImplementation((p: string) => p === INTEL_MAC);
      fsMocks.statSync.mockImplementation((p: string) => makeStat(p === INTEL_MAC));

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(true);
      expect(getBrewCaskroomPath()).toBe(INTEL_MAC);
    });

    it('returns false and null when neither Caskroom path exists', async () => {
      fsMocks.existsSync.mockReturnValue(false);

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(false);
      expect(getBrewCaskroomPath()).toBeNull();
    });

    it('returns false when the path exists but is not a directory (cask installs always make dirs)', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.statSync.mockReturnValue(makeStat(false));

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(false);
      expect(getBrewCaskroomPath()).toBeNull();
    });

    it('treats existsSync exceptions as non-existence (catch/skip semantics)', async () => {
      fsMocks.existsSync.mockImplementation(() => {
        throw new Error('EACCES: permission denied');
      });

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      // Must not throw — both queries should return the negative case.
      expect(() => isBrewInstalled()).not.toThrow();
      expect(isBrewInstalled()).toBe(false);
      expect(getBrewCaskroomPath()).toBeNull();
    });

    it('treats statSync exceptions as non-existence (catch/skip semantics)', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.statSync.mockImplementation(() => {
        throw new Error('ENOENT: race — gone after existsSync');
      });

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(false);
      expect(getBrewCaskroomPath()).toBeNull();
    });

    it('prefers Apple Silicon path over Intel when both exist (probe order)', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.statSync.mockReturnValue(makeStat(true));

      const { getBrewCaskroomPath } = await import('../BrewDetector');
      expect(getBrewCaskroomPath()).toBe(APPLE_SILICON);
    });
  });

  describe('on Linux', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock('../../../shared/platform', () => ({ isMac: false }));
    });

    it('returns false / null without touching the filesystem', async () => {
      // Prime fs to "exist" so we'd get a false positive if isMac guard were missing.
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.statSync.mockReturnValue(makeStat(true));

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(false);
      expect(getBrewCaskroomPath()).toBeNull();
      // Hard guarantee: the isMac short-circuit must skip the loop entirely.
      expect(fsMocks.existsSync).not.toHaveBeenCalled();
      expect(fsMocks.statSync).not.toHaveBeenCalled();
    });
  });

  describe('on Windows', () => {
    beforeEach(() => {
      vi.resetModules();
      vi.doMock('../../../shared/platform', () => ({ isMac: false }));
    });

    it('returns false / null without touching the filesystem', async () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.statSync.mockReturnValue(makeStat(true));

      const { isBrewInstalled, getBrewCaskroomPath } = await import('../BrewDetector');
      expect(isBrewInstalled()).toBe(false);
      expect(getBrewCaskroomPath()).toBeNull();
      expect(fsMocks.existsSync).not.toHaveBeenCalled();
      expect(fsMocks.statSync).not.toHaveBeenCalled();
    });
  });
});
