// #1046 — the boot-time half of the half-completed-install detection: an
// installation that RUNS but never got Update.exe written can never update
// or uninstall, and before this check nothing ever said so. Pure functions
// only — the dialog wiring is a thin best-effort shell over these.
import { describe, it, expect } from 'vitest';
import { squirrelInstallRootFor, findInstallIntegrityGap } from '../installIntegrity';

const SQUIRREL_EXE = 'C:\\Users\\u\\AppData\\Local\\wmux\\app-3.47.1\\wmux.exe';

describe('squirrelInstallRootFor', () => {
  it('extracts the root from the app-<version> layout', () => {
    expect(squirrelInstallRootFor(SQUIRREL_EXE)).toBe('C:\\Users\\u\\AppData\\Local\\wmux');
  });

  it('rejects every non-Squirrel layout', () => {
    // Dev run: electron.exe out of node_modules.
    expect(squirrelInstallRootFor('D:\\wmux\\node_modules\\electron\\dist\\electron.exe')).toBeNull();
    // Portable copy in an arbitrary folder.
    expect(squirrelInstallRootFor('C:\\tools\\wmux\\wmux.exe')).toBeNull();
    // Not an exe at all.
    expect(squirrelInstallRootFor('C:\\x\\app-1.2.3\\wmux.dll')).toBeNull();
    // Non-Windows layout strings never match the app-*/exe shape.
    expect(squirrelInstallRootFor('/usr/lib/wmux/wmux')).toBeNull();
  });

  it('is case-insensitive the way NTFS is', () => {
    expect(squirrelInstallRootFor('C:\\U\\APP-3.47.1\\WMUX.EXE')).toBe('C:\\U');
  });
});

describe('findInstallIntegrityGap', () => {
  it('reports Update.exe missing for a half-completed install', () => {
    const gap = findInstallIntegrityGap(SQUIRREL_EXE, () => false);
    expect(gap).toEqual({
      root: 'C:\\Users\\u\\AppData\\Local\\wmux',
      missing: ['Update.exe'],
    });
  });

  it('checks exactly <root>\\Update.exe, nothing deeper', () => {
    const probed: string[] = [];
    findInstallIntegrityGap(SQUIRREL_EXE, (p) => { probed.push(p); return false; });
    expect(probed).toEqual(['C:\\Users\\u\\AppData\\Local\\wmux\\Update.exe']);
  });

  it('is null for a complete install', () => {
    expect(findInstallIntegrityGap(SQUIRREL_EXE, () => true)).toBeNull();
  });

  it('is null — never a probe — outside the Squirrel layout', () => {
    const probed: string[] = [];
    const gap = findInstallIntegrityGap('D:\\wmux\\node_modules\\electron\\dist\\electron.exe', (p) => {
      probed.push(p);
      return false;
    });
    expect(gap).toBeNull();
    expect(probed).toEqual([]);
  });

  it('treats a throwing probe as missing-info, not as missing-file (default probe swallows)', () => {
    // The default exists() wraps fs.existsSync in try/catch; the injected
    // seam here documents the contract: a probe that returns false is the
    // only way to report a gap, so an exotic fs error can at worst produce
    // the warning, never a crash.
    const gap = findInstallIntegrityGap(SQUIRREL_EXE, () => { throw new Error('EIO'); });
    expect(gap).toBeNull();
  });
});
