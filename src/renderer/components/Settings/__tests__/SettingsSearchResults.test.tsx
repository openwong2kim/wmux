// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_CATALOG } from '../../../settings/catalog';
import { matchSettings } from '../../../settings/searchSettings';
import { SettingsSearchResults } from '../SettingsSearchResults';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const LABELS: Record<string, string> = {
  'settings.cursorShape': 'Cursor shape',
  'settings.cursorShapeDesc': 'Block, underline, or bar. Block is the default.',
  'settings.searchNoMatches': 'No settings match “{query}”.',
};

function t(key: string, vars?: Record<string, string | number>): string {
  let out = LABELS[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) out = out.replace(`{${k}}`, String(v));
  }
  return out;
}

function render(query: string, onJump = vi.fn()) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const hits = matchSettings(query, t, SETTINGS_CATALOG);
  act(() => root.render(
    <SettingsSearchResults
      query={query}
      hits={hits}
      tabLabel={(tab) => tab}
      t={t}
      onJump={onJump}
    />,
  ));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return { container, onJump };
}

describe('SettingsSearchResults', () => {
  it('shows an empty state when nothing matches', () => {
    const { container } = render('zzzz-no-such-setting');
    expect(container.querySelector('[data-testid="settings-search-empty"]')?.textContent)
      .toContain('zzzz-no-such-setting');
  });

  it('jumps to the catalog id when a hit is clicked', () => {
    const { container, onJump } = render('cursor');
    act(() => container.querySelector<HTMLButtonElement>('[data-jump="cursorshape"]')?.click());
    expect(onJump).toHaveBeenCalledWith('cursorshape');
  });
});
