import { describe, expect, it } from 'vitest';
import os from 'node:os';
import {
  currentPlatform,
  isLinux,
  isMac,
  isUnix,
  isWindows,
  parseWindowsBuildNumber,
  platformChoice,
} from '../platform';
import {
  isConptyDllLoadError,
  shouldUseBundledConpty,
  xtermWindowsBuildNumber,
} from '../conptyWindows';

describe('platform constants', () => {
  it('exactly one of isWindows / isMac / isLinux is true on supported OS', () => {
    if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
      const trueCount = [isWindows, isMac, isLinux].filter(Boolean).length;
      expect(trueCount).toBe(1);
    }
  });

  it('isUnix is the negation of isWindows', () => {
    expect(isUnix).toBe(!isWindows);
  });

  it('currentPlatform matches process.platform when supported', () => {
    if (process.platform === 'win32') expect(currentPlatform).toBe('win32');
    else if (process.platform === 'darwin') expect(currentPlatform).toBe('darwin');
    else if (process.platform === 'linux') expect(currentPlatform).toBe('linux');
    else expect(currentPlatform).toBe('other');
  });
});

describe('platformChoice', () => {
  it('returns the OS-specific value when present', () => {
    const result = platformChoice<string>({
      win: 'win-value',
      mac: 'mac-value',
      linux: 'linux-value',
      default: 'default-value',
    });
    if (process.platform === 'win32') expect(result).toBe('win-value');
    else if (process.platform === 'darwin') expect(result).toBe('mac-value');
    else if (process.platform === 'linux') expect(result).toBe('linux-value');
    else expect(result).toBe('default-value');
  });

  it('falls back to default when the OS-specific value is omitted', () => {
    const result = platformChoice<number>({
      // intentionally only set the OS we are NOT on so the default is returned.
      win: process.platform === 'win32' ? undefined : 1,
      mac: process.platform === 'darwin' ? undefined : 2,
      linux: process.platform === 'linux' ? undefined : 3,
      default: 99,
    });
    expect(result).toBe(99);
  });

  it('preserves complex value types (array, object)', () => {
    const arr = platformChoice<string[]>({ win: ['a'], mac: ['b'], linux: ['c'], default: [] });
    expect(Array.isArray(arr)).toBe(true);

    const obj = platformChoice<{ key: string }>({
      win: { key: 'w' },
      mac: { key: 'm' },
      linux: { key: 'l' },
      default: { key: 'd' },
    });
    expect(typeof obj.key).toBe('string');
  });
});

/**
 * xterm switches on build 21376 in two opposite directions — reflow is on only
 * at `>= 21376`, the legacy ConPTY wrapping heuristics only at `< 21376` — so
 * the boundary is asserted from both sides here. The terminal used to hardcode
 * 21376, which declared every Windows install modern.
 */
describe('parseWindowsBuildNumber', () => {
  it('takes the build out of the third field, not the frozen 10.0 prefix', () => {
    // Windows 11 still reports major.minor 10.0, so only the third field
    // separates it from Windows 10.
    expect(parseWindowsBuildNumber('10.0.19045')).toBe(19045);
    expect(parseWindowsBuildNumber('10.0.26200')).toBe(26200);
  });

  it('lands each side of xterm\'s 21376 boundary', () => {
    // Windows 10 stays on the legacy side; Windows 11 and the build that
    // introduced the modern behaviour stay on the reflow side.
    expect(parseWindowsBuildNumber('10.0.19045')).toBeLessThan(21376);
    expect(parseWindowsBuildNumber('10.0.22000')).toBeGreaterThanOrEqual(21376);
    expect(parseWindowsBuildNumber('10.0.21376')).toBeGreaterThanOrEqual(21376);
  });

  it('agrees with what this machine actually reports', () => {
    // The parser is only useful if it handles the real string. os.release() and
    // Electron's process.getSystemVersion() were measured to return the same
    // value on Windows.
    if (process.platform !== 'win32') return;
    const release = os.release();
    const parsed = parseWindowsBuildNumber(release);
    expect(parsed).not.toBeNull();
    expect(String(parsed)).toBe(release.split('.')[2]);
  });

  it('returns null rather than guessing when there is no readable build', () => {
    // The caller keeps its no-information default on null. A wrong number would
    // silently flip every install to the opposite ConPTY branch.
    for (const bad of [null, undefined, '', '10.0', '10', 'unknown', '10.0.x', '10.0.-1', 'a.b.c']) {
      expect(parseWindowsBuildNumber(bad)).toBeNull();
    }
  });

  it('tolerates the trailing forms a version string can arrive in', () => {
    expect(parseWindowsBuildNumber(' 10.0.19045 ')).toBe(19045);
    expect(parseWindowsBuildNumber('10.0.19045.3803')).toBe(19045);
  });
});

describe('shouldUseBundledConpty', () => {
  it('bundles below Windows 11, in-box at Windows 11 and above', () => {
    // #910: Win10's in-box ConPTY drops mouse DECSETs; the bundled OpenConsole
    // has the fix. 22000 is a product cut — Server 2022 (20348) bundles too,
    // early Win11 22000 does not (its in-box already relays mouse).
    expect(shouldUseBundledConpty('win32', 19045)).toBe(true);
    expect(shouldUseBundledConpty('win32', 20348)).toBe(true);
    expect(shouldUseBundledConpty('win32', 21999)).toBe(true);
    expect(shouldUseBundledConpty('win32', 22000)).toBe(false);
    expect(shouldUseBundledConpty('win32', 26200)).toBe(false);
  });

  it('never bundles off Windows or without a readable build', () => {
    // null build = "could not read it" — keep the in-box default rather than
    // act on a number that was never read.
    expect(shouldUseBundledConpty('darwin', 19045)).toBe(false);
    expect(shouldUseBundledConpty('linux', 19045)).toBe(false);
    expect(shouldUseBundledConpty('win32', null)).toBe(false);
  });
});

describe('xtermWindowsBuildNumber', () => {
  it('reports a modern build when the bundled DLL drives the PTY', () => {
    // The bundled OpenConsole, not the kernel, decides reflow behaviour, so
    // 22621 is a capability token — NOT a claim about the user's OS. It keeps
    // xterm on the >= 21376 reflow side while the OS is 19045.
    expect(xtermWindowsBuildNumber('win32', 19045)).toBe(22621);
    expect(xtermWindowsBuildNumber('win32', 20348)).toBe(22621);
  });

  it('passes the real build through when in-box ConPTY drives the PTY', () => {
    expect(xtermWindowsBuildNumber('win32', 22000)).toBe(22000);
    expect(xtermWindowsBuildNumber('win32', 26200)).toBe(26200);
  });

  it('returns null off Windows or unreadable, so the caller omits the field', () => {
    // Omitting buildNumber keeps xterm's default (reflow enabled) — the
    // pre-#900 behaviour, unchanged.
    expect(xtermWindowsBuildNumber('darwin', 19045)).toBeNull();
    expect(xtermWindowsBuildNumber('win32', null)).toBeNull();
  });
});

describe('isConptyDllLoadError', () => {
  it('matches every error LoadConptyDll throws for a missing/corrupt DLL', () => {
    // Strings from node-pty src/win/conpty.cc — re-check on node-pty upgrades.
    expect(isConptyDllLoadError('Failed to get conpty.node module handle')).toBe(true);
    expect(isConptyDllLoadError('Failed to get conpty.node module file name')).toBe(true);
    expect(isConptyDllLoadError('Cannot find conpty.dll at C:\\app\\conpty\\conpty.dll')).toBe(true);
    expect(isConptyDllLoadError('Failed to load conpty.dll')).toBe(true);
    // conpty.cc:307 — DLL loaded but pseudoconsole creation failed (e.g. the
    // bundled OpenConsole.exe blocked by antivirus). Without this match a
    // damaged install would hard-fail the shell instead of falling back.
    expect(isConptyDllLoadError('Cannot launch conpty')).toBe(true);
  });

  it('does not match transient spawn failures like ConPTY error 87', () => {
    // A broad match would let one transient 87 silently demote the pane to
    // mouse-less in-box ConPTY forever — PaneSupervisor exists to absorb those.
    expect(isConptyDllLoadError('Failed to start shell: The parameter is incorrect (87)')).toBe(false);
    expect(isConptyDllLoadError('Cannot find module')).toBe(false);
    expect(isConptyDllLoadError('')).toBe(false);
  });
});
