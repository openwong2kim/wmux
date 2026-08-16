// Every searchable setting must have somewhere to jump to.
//
// `jumpTo` does `document.querySelector('[data-setting-id=…]')?.scrollIntoView()`.
// The optional chain means a catalog entry with no matching anchor fails
// SILENTLY: the tab switches, nothing scrolls, nothing flashes, and the user
// concludes the search is broken. 24 of the 45 entries were in that state.
//
// This is a source-level contract on purpose. Rendering every tab would need
// the whole settings tree mocked, and the property being checked really is
// textual — the anchor is an attribute in the JSX. The same drift already bit
// this file once: the shortcuts list was "a hand-copied subset that had
// drifted" until #818 derived it from WMUX_KEYMAP.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTINGS_CATALOG } from '../catalog';

const SETTINGS_DIR = join(__dirname, '..', '..', 'components', 'Settings');
const SOURCES = [
  'SettingsPanel.tsx',
  'AccountsSection.tsx',
  'ClaudeIntegrationSection.tsx',
  'IntegrationSetupSection.tsx',
];

function anchoredIds(): Set<string> {
  const found = new Set<string>();
  for (const name of SOURCES) {
    let src: string;
    try {
      src = readFileSync(join(SETTINGS_DIR, name), 'utf8');
    } catch {
      continue; // a section file that moved is caught by the assertion below
    }
    // Direct attribute, and the two components that forward `id` to it.
    for (const m of src.matchAll(/data-setting-id="([^"]+)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/<(?:SettingRow|SectionLabel)[^>]*\bid="([^"]+)"/g)) found.add(m[1]);
  }
  return found;
}

describe('settings catalog anchors', () => {
  it('gives every catalog entry a jump target', () => {
    const anchors = anchoredIds();
    const missing = SETTINGS_CATALOG.filter((e) => !anchors.has(e.id)).map((e) => e.id);
    expect(
      missing,
      'catalog entries with no [data-setting-id] anchor — searching for these '
      + 'switches tabs and then does nothing. Add id="<catalog id>" to the '
      + 'SettingRow / SectionLabel that renders the setting.',
    ).toEqual([]);
  });

  it('reads the sources it claims to read', () => {
    // A typo'd path would make the check above vacuously pass.
    expect(anchoredIds().size).toBeGreaterThan(SETTINGS_CATALOG.length / 2);
  });

  it('has no duplicate catalog ids', () => {
    // Two entries sharing an id would make one of them jump to the other's row.
    const ids = SETTINGS_CATALOG.map((e) => e.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
