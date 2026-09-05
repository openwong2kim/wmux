// Every chrome button must announce itself.
//
// The audit's finding: a CDP sweep of the packaged window for /settings/i over
// aria-label matched nothing at all — the titlebar's settings gear was an
// unnamed button, because `title` is not an accessible name when the only child
// is an inline <svg> with no <title> element. The pane tab's close glyph, the
// company panel's `+` and `✕`, and the mini sidebar's bare unread count were in
// the same state: a tooltip a mouse can find and a screen reader cannot.
//
// Source scan rather than a render, for the same reason the hit-area contract
// is one: the chrome files reach into the store, the Electron preload and
// xterm, and half of what this has to cover (company mode, the profile modal,
// the remote attach sheet) is behind a flag or a click that a mount would never
// take. The scan sees every branch.
//
// The contract it enforces: a <button> in these files carries `aria-label` /
// `aria-labelledby`, or renders translated text of its own (a `t(` call in its
// body). Buttons whose visible label comes from data rather than the
// translation table are listed explicitly below with what names them.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPONENTS = join(__dirname, '..');

/** The chrome this lane owns: titlebar, sidebar, pane tab strip, deck header. */
const CHROME_FILES = [
  'Titlebar/Titlebar.tsx',
  'StatusBar/StatusBar.tsx',
  'Sidebar/Sidebar.tsx',
  'Sidebar/WorkspaceItem.tsx',
  'Sidebar/WorkspaceAgentRoster.tsx',
  'Sidebar/MissionsSection.tsx',
  'Sidebar/MiniSidebar.tsx',
  'Sidebar/CompanyPanel.tsx',
  'Sidebar/PresetPicker.tsx',
  'Sidebar/WorkspaceProfileModal.tsx',
  'Sidebar/WorkspaceAccountMenu.tsx',
  'Sidebar/WorkspaceChromeProfileMenu.tsx',
  'Sidebar/RemoteWorkspaceItem.tsx',
  'Sidebar/AttachRemoteModal.tsx',
  'Pane/SurfaceTabs.tsx',
  'Deck/DeckTabs.tsx',
  'Deck/DeckToggle.tsx',
];

/**
 * Buttons whose visible text is data, not a translation key, so the `t(` rule
 * cannot see it. Each one really does render a readable label:
 *   - the "open with" rows render `folderAppLabel(t, app)` — an app name;
 *   - the remote host rows render `host.label` — the host's own name.
 */
const NAMED_BY_DATA = [/folderAppLabel\(/, /\{host\.label\}/];

interface ButtonSite {
  line: number;
  open: string;
  body: string;
}

/** Split a file into its `<button>` sites: the opening tag and the children. */
function buttonSites(source: string): ButtonSite[] {
  const out: ButtonSite[] = [];
  for (const m of source.matchAll(/<button\b/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let end = start;
    let selfClosing = false;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) {
        selfClosing = source[i - 1] === '/';
        end = i;
        break;
      }
    }
    let body = '';
    if (!selfClosing) {
      const close = source.indexOf('</button>', end);
      body = close === -1 ? '' : source.slice(end + 1, close);
    }
    out.push({
      line: source.slice(0, start).split('\n').length,
      open: source.slice(start, end + 1),
      body,
    });
  }
  return out;
}

describe('chrome accessible names', () => {
  it('leaves no button in the titlebar, sidebar, tab strip or deck header unnamed', () => {
    const unnamed: string[] = [];
    for (const file of CHROME_FILES) {
      const source = readFileSync(join(COMPONENTS, file), 'utf8');
      for (const site of buttonSites(source)) {
        if (/aria-label(ledby)?\s*=/.test(site.open)) continue;
        if (/\bt\(/.test(site.body)) continue;
        if (NAMED_BY_DATA.some((re) => re.test(site.body))) continue;
        unnamed.push(`${file}:${site.line} ${site.body.replace(/\s+/g, ' ').trim().slice(0, 60)}`);
      }
    }
    expect(unnamed).toEqual([]);
  });

  it('names the four controls the audit caught, from the existing table', () => {
    const expected: [string, RegExp][] = [
      ['StatusBar/StatusBar.tsx', /aria-label=\{t\('statusBar\.settingsTooltip'\)\}/],
      ['Sidebar/Sidebar.tsx', /aria-label=\{t\('sidebar\.hideTooltip'\)\}/],
      ['Pane/SurfaceTabs.tsx', /aria-label=\{t\('surface\.closeTabNamed'/],
      ['Sidebar/CompanyPanel.tsx', /aria-label=\{t\('company\.destroyTitle'\)\}/],
    ];
    for (const [file, re] of expected) {
      expect(readFileSync(join(COMPONENTS, file), 'utf8'), file).toMatch(re);
    }
  });

  it('never names a control with a glyph a screen reader would read aloud', () => {
    // `aria-label="✕"` / `"→"` is worse than no label: it is announced.
    const glyphNames: string[] = [];
    for (const file of CHROME_FILES) {
      const source = readFileSync(join(COMPONENTS, file), 'utf8');
      for (const m of source.matchAll(/aria-label=(?:"([^"]*)"|\{'([^']*)'\})/g)) {
        const value = m[1] ?? m[2] ?? '';
        if (value && !/[\p{L}\p{N}]/u.test(value)) glyphNames.push(`${file}: ${value}`);
      }
    }
    expect(glyphNames).toEqual([]);
  });
});
