// @vitest-environment jsdom
// @wmux-lane unit
// 'win32' here is only a platform value passed to pure helpers; nothing reaches the OS.
//
// The window glass row: on a Windows build without the acrylic material it
// reads Off, every level is disabled and the reason is shown, whatever level
// the store holds; on a supported build the saved level is selected and
// picking another reaches the store. When the theme keeps the window opaque
// on Windows, the saved level stays selected and changeable and the row says
// why.

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WindowGlassSetting } from '../SettingsPanel';
import { themeBlocksWindowGlass, type WindowGlassLevel } from '../../../utils/windowGlass';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function render(supported: boolean, value: WindowGlassLevel, onChange = vi.fn(), themeBlocked = false): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<WindowGlassSetting supported={supported} themeBlocked={themeBlocked} value={value} onChange={onChange} />));
  cleanups.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

function option(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('button, [role="radio"]')]
    .find((el) => el.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label} option`);
  return found;
}

const isDisabled = (el: HTMLElement) =>
  el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled');
const isSelected = (el: HTMLElement) =>
  el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'on' || el.getAttribute('data-state') === 'checked';

describe('WindowGlassSetting', () => {
  it('reads Off, disables every level and says why without the material', () => {
    const onChange = vi.fn();
    const container = render(false, 'soft', onChange);
    for (const label of ['Off', 'Soft', 'Clear']) expect(isDisabled(option(container, label)), label).toBe(true);
    expect(isSelected(option(container, 'Off'))).toBe(true);
    expect(isSelected(option(container, 'Soft'))).toBe(false);
    expect(container.textContent).toContain('Needs Windows 11 version 22H2 or later. This Windows keeps a solid window.');
    act(() => option(container, 'Clear').click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects the saved level and changes it where the material exists', () => {
    const onChange = vi.fn();
    const container = render(true, 'soft', onChange);
    for (const label of ['Off', 'Soft', 'Clear']) expect(isDisabled(option(container, label)), label).toBe(false);
    expect(isSelected(option(container, 'Soft'))).toBe(true);
    expect(container.textContent).not.toContain('Needs Windows 11');
    act(() => option(container, 'Clear').click());
    expect(onChange).toHaveBeenCalledWith('clear');
  });

  it('says the theme keeps the window opaque, with the saved level selected and changeable', () => {
    const onChange = vi.fn();
    const container = render(true, 'soft', onChange, true);
    for (const label of ['Off', 'Soft', 'Clear']) expect(isDisabled(option(container, label)), label).toBe(false);
    expect(isSelected(option(container, 'Soft'))).toBe(true);
    expect(isSelected(option(container, 'Off'))).toBe(false);
    expect(container.textContent).toContain('This theme stays opaque so its text stays readable over the desktop.');
    expect(container.textContent).not.toContain('How much of the desktop shows through');
    act(() => option(container, 'Clear').click());
    expect(onChange).toHaveBeenCalledWith('clear');
  });

  it('shows no theme reason while glass applies', () => {
    const container = render(true, 'soft');
    expect(container.textContent).not.toContain('This theme stays opaque');
    expect(container.textContent).toContain('How much of the desktop shows through');
  });
});

describe('themeBlocksWindowGlass', () => {
  it.each([
    ['win32', 'soft', 'off', true],
    ['win32', 'clear', 'off', true],
    ['win32', 'soft', 'soft', false],
    // The user's own Off is not the theme's doing.
    ['win32', 'off', 'off', false],
    // Nothing applied yet, or no glass sync at all.
    ['win32', 'soft', null, false],
    // macOS derives its coverage too (#3283).
    ['darwin', 'soft', 'off', true],
    ['darwin', 'soft', 'soft', false],
    ['linux', 'soft', 'off', false],
    [undefined, 'soft', 'off', false],
  ] as const)('%s, saved %s, applied %s → %s', (platform, chosen, effective, expected) => {
    expect(themeBlocksWindowGlass(platform, chosen, effective)).toBe(expected);
  });
});
