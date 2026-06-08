import { describe, it, expect } from 'vitest';
import { isSquirrelInstallerEvent, SQUIRREL_INSTALLER_EVENTS } from '../squirrel';

// Pure classifier (no electron, no app bootstrap), exercised directly.
//
// Regression context: a prior `startsWith('--squirrel-')` guard in index.ts
// treated '--squirrel-firstrun' as an installer event, set isSquirrelEvent,
// matched no handler, never quit, and skipped appInit() — leaving an invisible
// main process that lazily spawned its own gpu/network subprocesses (duplicate
// GPU process → UI stutter). firstrun MUST classify as "not an installer event"
// so it falls through to the normal single-instance-locked app init path.

describe('isSquirrelInstallerEvent', () => {
  it('returns true for each of the four installer lifecycle events', () => {
    for (const ev of SQUIRREL_INSTALLER_EVENTS) {
      expect(isSquirrelInstallerEvent(ev)).toBe(true);
    }
  });

  it('exposes exactly the four installer events (no firstrun in the list)', () => {
    expect([...SQUIRREL_INSTALLER_EVENTS]).toEqual([
      '--squirrel-install',
      '--squirrel-updated',
      '--squirrel-uninstall',
      '--squirrel-obsolete',
    ]);
    expect([...SQUIRREL_INSTALLER_EVENTS]).not.toContain('--squirrel-firstrun');
  });

  it('returns false for --squirrel-firstrun (the regression guard)', () => {
    // firstrun is a normal launch, not an installer hook — must run the app.
    expect(isSquirrelInstallerEvent('--squirrel-firstrun')).toBe(false);
  });

  it('returns false for an unknown --squirrel-* arg', () => {
    // Defensive: any future/unknown squirrel arg runs normally rather than
    // becoming a never-quit zombie.
    expect(isSquirrelInstallerEvent('--squirrel-frobnicate')).toBe(false);
  });

  it('returns false for a normal launch with no flag (argv[1] undefined)', () => {
    expect(isSquirrelInstallerEvent(undefined)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isSquirrelInstallerEvent('')).toBe(false);
  });

  it('returns false for a real exe/script path (dev `electron .`)', () => {
    expect(isSquirrelInstallerEvent('C:\\Users\\me\\wmux\\app.exe')).toBe(false);
    expect(isSquirrelInstallerEvent('.')).toBe(false);
  });

  it('does not partial-match a prefix or substring', () => {
    expect(isSquirrelInstallerEvent('--squirrel-')).toBe(false);
    expect(isSquirrelInstallerEvent('--squirrel-install-extra')).toBe(false);
    expect(isSquirrelInstallerEvent('squirrel-install')).toBe(false);
  });
});
