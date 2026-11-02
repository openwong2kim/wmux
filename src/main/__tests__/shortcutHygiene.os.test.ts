// Pure-logic coverage for the #863 shortcut-hygiene pass and the #2971 Start
// Menu passes: the PS-literal safety guard, script construction (what gets
// embedded and what refuses to build), and output parsing. The effectful
// end-to-end runs against real .lnk files live in
// shortcutHygiene.runtime.test.ts.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  isSafePsPathLiteral,
  buildRepairScript,
  parseRepairOutput,
  defaultRepairLocations,
  runShortcutRepairPass,
  buildToastEntryRemovalScript,
  buildSecondEntryRemovalScript,
  defaultSecondEntryLocations,
  defaultToastEntryLocations,
  topLevelStartMenuLnk,
  TOAST_ACTIVATOR_CLSID_KEY,
  type ToastEntryLocations,
} from '../shortcutHygiene';

const PROGRAMS = 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs';
const TOP = `${PROGRAMS}\\wmux.lnk`;
const LOC = {
  pinDirs: ['C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'],
};

describe('isSafePsPathLiteral', () => {
  it('accepts ordinary Windows paths, including spaces', () => {
    expect(isSafePsPathLiteral('C:\\Users\\a b\\AppData\\Local\\wmux')).toBe(true);
  });

  // These are legal Windows path characters. Rejecting them would silently
  // disable the repair for real profiles (O'Connor) and folders named $app —
  // the single-quoted PS literal handles all of them.
  it.each(["'", '"', '$', '`'])('accepts the legal path character %j', (ch) => {
    expect(isSafePsPathLiteral(`C:\\Users\\O${ch}Connor\\wmux`)).toBe(true);
  });

  it.each(['\n', '\r'])('refuses the line terminator %j', (ch) => {
    expect(isSafePsPathLiteral(`C:\\wmux${ch}x`)).toBe(false);
  });

  it('refuses the empty string', () => {
    expect(isSafePsPathLiteral('')).toBe(false);
  });
});

describe('buildRepairScript', () => {
  it('embeds root and pin dirs, and never the Start Menu (Electron owns its entry, #2971)', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC);
    expect(s).not.toBeNull();
    expect(s).toContain("'C:\\Users\\u\\AppData\\Local\\wmux'");
    expect(s).toContain(LOC.pinDirs[0]);
    expect(s).not.toContain('Start Menu');
    // The no-stub bail-out must precede any mutation.
    expect(s).toContain("if (-not (Test-Path $stub)) { Write-Output '[]'; exit 0 }");
  });

  it('doubles an embedded apostrophe rather than refusing the path', () => {
    const s = buildRepairScript("C:\\Users\\O'Connor\\wmux", LOC);
    expect(s).not.toBeNull();
    expect(s).toContain("$root = 'C:\\Users\\O''Connor\\wmux'");
    // A doubled apostrophe must never leave an odd number of quotes behind.
    const quotes = (s ?? '').split("$root = ")[1].split('\n')[0];
    expect((quotes.match(/'/g) ?? []).length % 2).toBe(0);
  });

  it('refuses to build only when a path carries a line terminator', () => {
    expect(buildRepairScript('C:\\wmux\nx', LOC)).toBeNull();
    expect(buildRepairScript('C:\\wmux', { pinDirs: ['C:\\a\rb'] })).toBeNull();
    expect(buildRepairScript('C:\\wmux', { pinDirs: ['C:\\p$in'] })).not.toBeNull();
  });

  it('only ever repairs toward the root stub and app.ico, and never removes a pin', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC) ?? '';
    expect(s).toContain("Join-Path $root 'wmux.exe'");
    expect(s).toContain("Join-Path $root 'app.ico'");
    expect(s).not.toContain('Remove-Item');
  });
});

describe('buildToastEntryRemovalScript (#2971)', () => {
  const TOAST: ToastEntryLocations = { topLevelLnk: TOP, clsidKey: 'HKCU:\\Software\\Classes\\CLSID' };

  it('removes only the top-level link and activator classes that point under the root', () => {
    const s = buildToastEntryRemovalScript('C:\\Users\\u\\AppData\\Local\\wmux', TOAST) ?? '';
    expect(s).toContain("$root = 'C:\\Users\\u\\AppData\\Local\\wmux'");
    expect(s).toContain(TOAST.topLevelLnk);
    expect(s).toContain("Get-ChildItem -LiteralPath 'HKCU:\\Software\\Classes\\CLSID'");
    // Electron's name for the class, and the LocalServer32 check under the root.
    expect(s).toContain("$k.GetValue('') -ne 'Electron Notification Activator'");
    expect(s).toContain("$k.OpenSubKey('LocalServer32')");
    expect(s).toContain("StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)");
  });

  it('still cleans the registry when WScript.Shell is refused (that part needs no COM)', () => {
    const s = buildToastEntryRemovalScript('C:\\wmux', TOAST) ?? '';
    expect(s).not.toContain('exit 3');
    expect(s).toContain('$l = if ($sh) { $sh.CreateShortcut($top) } else { $null }');
  });

  it('refuses to build when a path carries a line terminator', () => {
    expect(buildToastEntryRemovalScript('C:\\wmux\r', TOAST)).toBeNull();
    expect(buildToastEntryRemovalScript('C:\\wmux', { ...TOAST, clsidKey: 'HKCU:\\x\ny' })).toBeNull();
  });

  it('defaults to the top-level entry and the HKCU class key', () => {
    const appData = path.join('C:\\Users', 'u', 'AppData', 'Roaming');
    const loc = defaultToastEntryLocations(appData);
    expect(loc.topLevelLnk).toBe(topLevelStartMenuLnk(appData));
    expect(loc.clsidKey).toBe(TOAST_ACTIVATOR_CLSID_KEY);
  });
});

describe('second Start Menu entry (#2971)', () => {
  it("names only Squirrel's own publisher folder, from the author name", () => {
    const appData = path.join('C:\\Users', 'u', 'AppData', 'Roaming');
    const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    expect(defaultSecondEntryLocations(appData, 'openwong2kim')).toEqual({
      topLevelLnk: path.join(programs, 'wmux.lnk'),
      publisherLnk: path.join(programs, 'openwong2kim', 'wmux.lnk'),
    });
  });

  // The user's own folders must never be touched: the Startup folder (wmux at
  // logon) and anything a path character could reach.
  it.each(['', '  ', '.', '..', 'Startup', 'STARTUP', 'a\\b', 'a/b', 'C:', '*', 'a?b'])(
    'refuses the publisher name %j',
    (name) => {
      expect(defaultSecondEntryLocations('C:\\AppData', name)).toBeNull();
    },
  );

  it('removes the publisher link only once the top-level entry exists and both point under the root', () => {
    const s = buildSecondEntryRemovalScript('C:\\Users\\u\\AppData\\Local\\wmux', {
      topLevelLnk: TOP,
      publisherLnk: `${PROGRAMS}\\openwong2kim\\wmux.lnk`,
    }) ?? '';
    expect(s).toContain(
      "if (-not (Test-Path -LiteralPath $top) -or -not (Test-Path -LiteralPath $pub)) { Write-Output '[]'; exit 0 }",
    );
    // The top-level entry must point at a file that exists: a link left by a
    // removed app-X.Y.Z\ is not a replacement.
    expect(s).toContain(
      '$keep = -not $t -or -not (& $under $t.TargetPath) -or -not (Test-Path -LiteralPath $t.TargetPath) -or -not $p -or -not (& $under $p.TargetPath)',
    );
    // The removal comes after the keep check, never before it.
    expect(s.indexOf('Remove-Item -LiteralPath $pub')).toBeGreaterThan(s.indexOf("if ($keep) { Write-Output '[]'; exit 0 }"));
  });

  it('refuses to build when a path carries a line terminator', () => {
    expect(buildSecondEntryRemovalScript('C:\\wmux', { topLevelLnk: TOP, publisherLnk: 'C:\\x\nwmux.lnk' })).toBeNull();
  });
});

describe('parseRepairOutput', () => {
  it('parses an array of actions', () => {
    expect(
      parseRepairOutput('[{"path":"C:\\\\a.lnk","action":"retargeted"},{"path":"C:\\\\b.lnk","action":"removed"}]'),
    ).toEqual([
      { path: 'C:\\a.lnk', action: 'retargeted' },
      { path: 'C:\\b.lnk', action: 'removed' },
    ]);
  });

  it('accepts the bare-object form ConvertTo-Json emits for one item', () => {
    expect(parseRepairOutput('{"path":"C:\\\\a.lnk","action":"retargeted"}')).toEqual([
      { path: 'C:\\a.lnk', action: 'retargeted' },
    ]);
  });

  it('returns [] on empty, non-JSON, or malformed rows', () => {
    expect(parseRepairOutput('')).toEqual([]);
    expect(parseRepairOutput('not json')).toEqual([]);
    expect(parseRepairOutput('[{"path":1,"action":"retargeted"},{"action":"removed"},{"path":"x","action":"exploded"}]')).toEqual([]);
  });
});

describe('default locations', () => {
  // Expectations are composed with path.join, not literal backslashes: the
  // helper joins with the HOST separator, so hardcoding '\' fails the
  // cross-platform CI leg even though the code is Windows-only at runtime.
  it('derives every location from %APPDATA%', () => {
    const appData = path.join('C:\\Users', 'u', 'AppData', 'Roaming');
    const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
    expect(defaultRepairLocations(appData).pinDirs).toEqual([
      path.join(pinned, 'TaskBar'),
      path.join(pinned, 'StartMenu'),
    ]);
    expect(topLevelStartMenuLnk(appData)).toBe(path.join(programs, 'wmux.lnk'));
  });
});

// #962 — an empty action list used to mean two different things: nothing
// needed repair, and the pass never ran. A CI flake landed on the second and
// left `expected [] to deeply equal [...]` as the entire evidence.
describe('repair pass diagnostics', () => {
  it('makes the script exit non-zero, with a marker, when the COM object is refused', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC) ?? '';
    // Without this the SilentlyContinue preference turns every read through a
    // null $sh into a skipped candidate, and the script prints a clean `[]`.
    expect(s).toContain('if (-not $sh)');
    expect(s).toContain('exit 3');
    // The marker, not the exit code, is what the retry is allowed to key on —
    // a runtime abort also exits 3. It goes to stdout via Write-Output because
    // ConstrainedLanguage (a likely reason COM was refused in the first place)
    // blocks [Console]::Error.WriteLine.
    expect(s).toContain("Write-Output 'WMUX_COM_UNAVAILABLE'");
    expect(s).not.toContain('[Console]::Error');
  });

  it('fails the pass when candidate links existed and none could be opened', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC) ?? '';
    // The COM guard only covers CreateShortcut being unavailable at all. A
    // per-link failure (locked/corrupt .lnk, WSH policy, a COM server that
    // died mid-loop) leaves $l null, and skipping every candidate would emit
    // the same misleading `[]`.
    expect(s).toContain('if (-not $l) { $unopened++; continue }');
    expect(s).toContain("if ($opened -eq 0 -and $unopened -gt 0) { Write-Output 'WMUX_NO_LINKS_READABLE'; exit 4 }");
  });

  it('reports no failure off win32 — there is nothing to repair, not a broken pass', () => {
    if (process.platform === 'win32') return;
    expect(runShortcutRepairPass('/tmp/app-1.0.0/wmux')).toEqual({ actions: [], failure: null });
  });
});
