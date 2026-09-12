import { describe, it, expect, beforeEach, vi } from 'vitest';

// #1103 — a distro chosen once and uninstalled later must fall back to the
// system default rather than inject `-d <gone>` into every new pane.

type Mod = typeof import('../defaultWslDistro');

describe('defaultWslDistro', () => {
  let mod: Mod;

  beforeEach(async () => {
    vi.resetModules();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mod = await import('../defaultWslDistro');
  });

  it('returns the choice while no enumeration has succeeded yet', () => {
    mod.setDefaultWslDistro('Ubuntu');
    expect(mod.getDefaultWslDistro()).toBe('Ubuntu');
  });

  it('falls back to the system default when the chosen distro is no longer installed', () => {
    mod.setDefaultWslDistro('Ubuntu');
    mod.noteKnownWslDistros(['Debian', 'docker-desktop']);
    expect(mod.getDefaultWslDistro()).toBeNull();
    mod.noteKnownWslDistros(['Debian', 'Ubuntu']);
    expect(mod.getDefaultWslDistro()).toBe('Ubuntu');
  });

  it('an empty (failed) enumeration never erases the known list', () => {
    mod.setDefaultWslDistro('Ubuntu');
    mod.noteKnownWslDistros(['Debian']);
    mod.noteKnownWslDistros([]);
    expect(mod.getDefaultWslDistro()).toBeNull();
  });

  it('null / empty choice is the system default', () => {
    mod.setDefaultWslDistro(null);
    expect(mod.getDefaultWslDistro()).toBeNull();
    mod.setDefaultWslDistro('');
    expect(mod.getDefaultWslDistro()).toBeNull();
  });
});
