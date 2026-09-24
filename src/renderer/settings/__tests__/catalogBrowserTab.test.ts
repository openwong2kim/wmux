// The browser rows moved out of the Terminal tab into their own Browser tab.
// Search jumps by `entry.tab`, so the catalog is what decides where a hit lands.
import { describe, it, expect } from 'vitest';
import { SETTINGS_CATALOG, SETTINGS_NAV_GROUPS } from '../catalog';

const BROWSER_IDS = ['browserbackend', 'browserlight', 'sitememory', 'siteguides'];

describe('settings catalog — Browser tab', () => {
  it('maps the four browser settings to the browser tab', () => {
    for (const id of BROWSER_IDS) {
      expect(SETTINGS_CATALOG.find((e) => e.id === id)?.tab, id).toBe('browser');
    }
  });

  it('puts nothing else on the browser tab', () => {
    const onBrowser = SETTINGS_CATALOG.filter((e) => e.tab === 'browser').map((e) => e.id);
    expect(onBrowser.sort()).toEqual([...BROWSER_IDS].sort());
  });

  it('leaves the rest of the Terminal tab where it was', () => {
    const onTerminal = SETTINGS_CATALOG.filter((e) => e.tab === 'terminal').map((e) => e.id);
    expect(onTerminal).toEqual([
      'shell', 'startdir', 'splitcwd', 'ime', 'retention', 'coldpark', 'scrollback', 'restore', 'imagepaste',
    ]);
  });

  it('lists browser last in the Agents nav group', () => {
    const agents = SETTINGS_NAV_GROUPS.find((g) => g.id === 'agents');
    expect(agents?.tabs).toEqual(['claude-integration', 'accounts', 'orchestrator', 'roles', 'browser']);
    const elsewhere = SETTINGS_NAV_GROUPS.filter((g) => g.id !== 'agents').flatMap((g) => g.tabs);
    expect(elsewhere).not.toContain('browser');
  });
});
