// @vitest-environment jsdom
// The titlebar's search & command pill: the palette's entry now that the rail
// carries pages only. It opens the existing palette, names its shortcut per
// platform, and opts out of window dragging on its own.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStore } from '../../../stores';
import CommandPill, { paletteShortcutLabel } from '../CommandPill';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('electronAPI', { platform: 'darwin' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ commandPaletteVisible: false, appRoute: 'fleet', fleetViewVisible: true, shortcutOverrides: {} });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe('titlebar command pill', () => {
  it('opens the palette over the current page and shows the shortcut', () => {
    act(() => root.render(<CommandPill />));
    const pill = container.querySelector<HTMLButtonElement>('[data-command-pill]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('Search & commands');
    expect(pill?.textContent).toContain('⌘K');
    expect(pill?.getAttribute('aria-label')).toBe('Search & commands (⌘K)');
    // Only the pill is no-drag; its lane stays part of the drag region.
    expect(pill?.style.getPropertyValue('-webkit-app-region') || (pill?.style as unknown as Record<string, string>).WebkitAppRegion).toBe('no-drag');
    act(() => pill?.click());
    expect(useStore.getState().commandPaletteVisible).toBe(true);
    expect(useStore.getState().appRoute).toBe('fleet');
  });

  it('labels the shortcut the way each keyboard reads it', () => {
    expect(paletteShortcutLabel('darwin', 'Meta+K')).toBe('⌘K');
    expect(paletteShortcutLabel('win32', 'Ctrl+K')).toBe('Ctrl+K');
    expect(paletteShortcutLabel('linux', undefined)).toBe('');
  });
});
