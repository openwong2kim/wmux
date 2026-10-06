// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComputerUseSettingsPayload } from '../../../../shared/computer/config';
import { TabComputerUse, formatStopKey } from '../ComputerUseSection';

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

const base: ComputerUseSettingsPayload = {
  enabled: false,
  helper: 'missing',
  stopKey: 'CommandOrControl+Alt+Shift+Escape',
  stopKeyStatus: 'off',
};

const ready: ComputerUseSettingsPayload = { ...base, helper: 'ready' };

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
    // The macOS chord (Cmd would force-quit the front app).
    expect(formatStopKey('Control+Alt+Shift+Escape', true)).toBe('Control+Option+Shift+Esc');
  });
});

describe('Settings › Computer use', () => {
  it('lets an unsigned Windows helper turn on, with one note about Defender or SmartScreen', async () => {
    const unsigned: ComputerUseSettingsPayload = { ...ready, helperUnsigned: true };
    const el = await render({ get: async () => unsigned, set: async () => ({ ...unsigned, enabled: true }) });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled || sw.getAttribute('aria-disabled') === 'true').toBe(false);
    expect(el.textContent).toContain('Windows Defender or SmartScreen may warn');
    expect(el.textContent).not.toContain('Not in this build yet');
    await act(async () => { sw.click(); });
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('shows no unsigned note for a signed or non-Windows helper', async () => {
    const el = await render({ get: async () => ready, set: async () => ready });
    expect(el.textContent).not.toContain('code-signed');
  });

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

  it('does not advertise a stop key it could not take, and says why input is refused', async () => {
    const unavailable: ComputerUseSettingsPayload = { ...base, enabled: true, stopKeyStatus: 'unavailable' };
    const el = await render({ get: async () => unavailable, set: async () => unavailable });
    expect(el.textContent).toContain('Unavailable');
    expect(el.textContent).toContain('Another app is using this shortcut');
    expect(el.textContent).toContain('Agents cannot control apps while the stop key is unavailable');
    expect(el.textContent).not.toContain('Press it anywhere to stop all agents');
  });

  it('advertises the stop key while it is held', async () => {
    const held: ComputerUseSettingsPayload = { ...ready, enabled: true, stopKeyStatus: 'held' };
    const el = await render({ get: async () => held, set: async () => held });
    expect(el.textContent).toContain('Press it anywhere to stop all agents');
    expect(el.textContent).not.toContain('Unavailable');
  });

  it('cannot be turned on without a helper, and says why', async () => {
    const set = vi.fn(async (enabled: boolean) => ({ ...base, enabled }));
    const el = await render({ get: async () => base, set });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    await act(async () => { sw.click(); });
    expect(set).not.toHaveBeenCalled();
    expect(el.textContent).toContain('does not include the helper for this OS yet');
  });

  it('does not advertise a stop key that is not held', async () => {
    const el = await render({ get: async () => base, set: async () => base });
    expect(el.textContent).toContain('Not held: this build has no helper');
    expect(el.textContent).not.toContain('Press it anywhere');
    const off = await render({ get: async () => ready, set: async () => ready });
    expect(off.textContent).toContain('Held only while computer use is on');
  });

  it('tells people who turned it on without a helper to turn it off', async () => {
    const el = await render({ get: async () => ({ ...base, enabled: true }), set: async () => base });
    expect(el.textContent).toContain('Turn it off for now');
    expect(el.textContent).not.toContain('does not include the helper for this OS yet');
  });

  it('can still be turned off when it was on without a helper', async () => {
    const set = vi.fn(async (enabled: boolean) => ({ ...base, enabled }));
    const el = await render({ get: async () => ({ ...base, enabled: true }), set });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    expect(sw.disabled).toBe(false);
    await act(async () => { sw.click(); });
    expect(set).toHaveBeenCalledWith(false);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.disabled).toBe(true);
  });

  it('turns it on through main and shows what main saved', async () => {
    const set = vi.fn(async (enabled: boolean) => ({ ...ready, enabled }));
    const el = await render({ get: async () => ready, set });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { sw.click(); });
    expect(set).toHaveBeenCalledWith(true);
    expect(sw.getAttribute('aria-checked')).toBe('true');
  });

  it('falls back to the state on disk and explains a failed save', async () => {
    const el = await render({
      get: async () => ready,
      set: async () => ({ ...ready, enabled: false, error: 'config.json is missing' }),
    });
    const sw = el.querySelector('[role="switch"]') as HTMLButtonElement;
    await act(async () => { sw.click(); });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(el.textContent).toContain('config.json is missing');
  });
});
