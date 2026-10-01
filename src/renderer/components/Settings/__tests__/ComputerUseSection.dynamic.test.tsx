// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComputerUseSettingsPayload } from '../../../../shared/computer/config';
import { TabComputerUse, formatStopKey } from '../ComputerUseSection';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const base: ComputerUseSettingsPayload = { enabled: false, helper: 'missing', stopKey: 'CommandOrControl+Alt+Shift+Escape' };

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function render(api: { get: () => Promise<ComputerUseSettingsPayload>; set: (v: boolean) => Promise<ComputerUseSettingsPayload> }) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { computerUse: api };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(TabComputerUse));
  });
  return container;
}

describe('formatStopKey', () => {
  it('names the keys a person presses on each OS', () => {
    expect(formatStopKey('CommandOrControl+Alt+Shift+Escape', false)).toBe('Ctrl+Alt+Shift+Esc');
    expect(formatStopKey('CommandOrControl+Alt+Shift+Escape', true)).toBe('Cmd+Option+Shift+Esc');
  });
});

describe('Settings › Computer use', () => {
  it('shows the stored state, the helper status and the stop key', async () => {
    const el = await render({ get: async () => base, set: async () => base });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(el.textContent).toContain('Not in this build yet');
    expect(el.textContent).toMatch(/(Ctrl|Cmd)\+(Alt|Option)\+Shift\+Esc/);
    for (const id of ['computeruse', 'computerusehelper', 'computerusestop']) {
      expect(el.querySelector(`[data-setting-id="${id}"]`), id).not.toBeNull();
    }
  });

  it('turns it on through main and shows what main saved', async () => {
    const set = vi.fn(async (enabled: boolean) => ({ ...base, enabled }));
    const el = await render({ get: async () => base, set });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { sw.click(); });
    expect(set).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('falls back to the state on disk and explains a failed save', async () => {
    const el = await render({
      get: async () => base,
      set: async () => ({ ...base, enabled: false, error: 'config.json is missing' }),
    });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { sw.click(); });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(el.textContent).toContain('config.json is missing');
  });
});
