// Pure-logic coverage for the #863 shortcut-hygiene pass: the PS-literal
// safety guard, script construction (what gets embedded and what refuses to
// build), and output parsing. The effectful end-to-end run against real .lnk
// files lives in shortcutHygiene.runtime.test.ts.
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  isSafePsPathLiteral,
  buildRepairScript,
  parseRepairOutput,
  defaultRepairLocations,
  runShortcutRepairPass,
  buildToastEntryRemovalScript,
  defaultToastEntryLocations,
  TOAST_ACTIVATOR_CLSID_KEY,
  type ToastEntryLocations,
} from '../shortcutHygiene';

const LOC = {
  topLevelLnks: ['C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\wmux.lnk'],
  pinDirs: ['C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'],
  publisherLnk: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\*\\wmux.lnk',
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
  it('embeds root, the top-level link, pin dirs, and the publisher wildcard', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC);
    expect(s).not.toBeNull();
    expect(s).toContain("'C:\\Users\\u\\AppData\\Local\\wmux'");
    expect(s).toContain(LOC.topLevelLnks[0]);
    expect(s).toContain(LOC.pinDirs[0]);
    expect(s).toContain(LOC.publisherLnk);
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
    expect(
      buildRepairScript('C:\\wmux', { ...LOC, topLevelLnks: ['C:\\a\rb\\wmux.lnk'] }),
    ).toBeNull();
    expect(buildRepairScript('C:\\wmux', { ...LOC, pinDirs: ['C:\\p$in'] })).not.toBeNull();
  });

  it('only ever repairs toward the root stub and app.ico', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC) ?? '';
    expect(s).toContain("Join-Path $root 'wmux.exe'");
    expect(s).toContain("Join-Path $root 'app.ico'");
    // #2971: deletion is reserved for the publisher-folder links; the
    // top-level entry and pins are never removed.
    expect(s).toContain('if ($pubs -icontains $p) {');
    expect(s).not.toMatch(/\$legacy|\$pubExists/);
  });
});

describe('buildToastEntryRemovalScript', () => {
  const TOAST: ToastEntryLocations = {
    topLevelLnks: [LOC.topLevelLnks[0]],
    clsidKey: 'HKCU:\\Software\\Classes\\CLSID',
  };

  it('removes only the top-level link and activator classes that point under the root', () => {
    const s = buildToastEntryRemovalScript('C:\\Users\\u\\AppData\\Local\\wmux', TOAST) ?? '';
    expect(s).toContain("$root = 'C:\\Users\\u\\AppData\\Local\\wmux'");
    expect(s).toContain(TOAST.topLevelLnks[0]);
    expect(s).toContain("Get-ChildItem -LiteralPath 'HKCU:\\Software\\Classes\\CLSID'");
    // Electron's name for the class, and the LocalServer32 check under the root.
    expect(s).toContain("$k.GetValue('') -ne 'Electron Notification Activator'");
    expect(s).toContain("$k.OpenSubKey('LocalServer32')");
    expect(s).toContain("StartsWith($root + '\\', [System.StringComparison]::OrdinalIgnoreCase)");
  });

  it('refuses to build when a path carries a line terminator', () => {
    expect(buildToastEntryRemovalScript('C:\\wmux\r', TOAST)).toBeNull();
    expect(buildToastEntryRemovalScript('C:\\wmux', { ...TOAST, clsidKey: 'HKCU:\\x\ny' })).toBeNull();
  });

  it('defaults to the top-level entry and the HKCU class key', () => {
    const appData = path.join('C:\\Users', 'u', 'AppData', 'Roaming');
    const loc = defaultToastEntryLocations(appData);
    expect(loc.topLevelLnks).toEqual(defaultRepairLocations(appData).topLevelLnks);
    expect(loc.clsidKey).toBe(TOAST_ACTIVATOR_CLSID_KEY);
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

describe('defaultRepairLocations', () => {
  // Expectations are composed with path.join, not literal backslashes: the
  // helper joins with the HOST separator, so hardcoding '\' fails the
  // cross-platform CI leg even though the code is Windows-only at runtime.
  it('derives every location from %APPDATA%', () => {
    const appData = path.join('C:\\Users', 'u', 'AppData', 'Roaming');
    const programs = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    const pinned = path.join(appData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned');
    const loc = defaultRepairLocations(appData);

    expect(loc.topLevelLnks).toEqual([path.join(programs, 'wmux.lnk')]);
    expect(loc.pinDirs).toEqual([
      path.join(pinned, 'TaskBar'),
      path.join(pinned, 'StartMenu'),
    ]);
    expect(loc.publisherLnk).toBe(path.join(programs, '*', 'wmux.lnk'));
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
