// Pure-logic coverage for the #863 shortcut-hygiene pass: the PS-literal
// safety guard, script construction (what gets embedded and what refuses to
// build), and output parsing. The effectful end-to-end run against real .lnk
// files lives in shortcutHygiene.runtime.test.ts.
import { describe, it, expect } from 'vitest';
import {
  isSafePsPathLiteral,
  buildRepairScript,
  parseRepairOutput,
  defaultRepairLocations,
} from '../shortcutHygiene';

const LOC = {
  legacyLnks: ['C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\wmux.lnk'],
  pinDirs: ['C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar'],
  publisherLnk: 'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\*\\wmux.lnk',
};

describe('isSafePsPathLiteral', () => {
  it('accepts ordinary Windows paths, including spaces', () => {
    expect(isSafePsPathLiteral('C:\\Users\\a b\\AppData\\Local\\wmux')).toBe(true);
  });

  it.each(["'", '"', '$', '`', '\n', '\r'])('refuses %j', (ch) => {
    expect(isSafePsPathLiteral(`C:\\wmux${ch}x`)).toBe(false);
  });

  it('refuses the empty string', () => {
    expect(isSafePsPathLiteral('')).toBe(false);
  });
});

describe('buildRepairScript', () => {
  it('embeds root, legacy links, pin dirs, and the publisher wildcard', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC);
    expect(s).not.toBeNull();
    expect(s).toContain("'C:\\Users\\u\\AppData\\Local\\wmux'");
    expect(s).toContain(LOC.legacyLnks[0]);
    expect(s).toContain(LOC.pinDirs[0]);
    expect(s).toContain(LOC.publisherLnk);
    // The no-stub bail-out must precede any mutation.
    expect(s).toContain("if (-not (Test-Path $stub)) { Write-Output '[]'; exit 0 }");
  });

  it('refuses to build when any embedded path could escape its quoting', () => {
    expect(buildRepairScript("C:\\wmux'x", LOC)).toBeNull();
    expect(
      buildRepairScript('C:\\wmux', { ...LOC, legacyLnks: ["C:\\a'b\\wmux.lnk"] }),
    ).toBeNull();
    expect(
      buildRepairScript('C:\\wmux', { ...LOC, pinDirs: ['C:\\p$in'] }),
    ).toBeNull();
  });

  it('only ever repairs toward the root stub and app.ico', () => {
    const s = buildRepairScript('C:\\Users\\u\\AppData\\Local\\wmux', LOC)!;
    expect(s).toContain("Join-Path $root 'wmux.exe'");
    expect(s).toContain("Join-Path $root 'app.ico'");
    // Deletion is reserved for the legacy list; pins are never removed.
    expect(s).toContain('$legacy -icontains $p');
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
  it('derives every location from %APPDATA%', () => {
    const loc = defaultRepairLocations('C:\\Users\\u\\AppData\\Roaming');
    expect(loc.legacyLnks).toEqual([
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\wmux.lnk',
    ]);
    expect(loc.pinDirs).toEqual([
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar',
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\StartMenu',
    ]);
    expect(loc.publisherLnk).toBe(
      'C:\\Users\\u\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\*\\wmux.lnk',
    );
  });
});
