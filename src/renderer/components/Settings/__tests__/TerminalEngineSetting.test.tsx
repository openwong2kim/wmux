// @vitest-environment jsdom
// @wmux-lane unit
// 'win32' and 'darwin' here are only platform values given to the mocked electronAPI; nothing reaches the OS.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCoreSettings } from '../../../../shared/terminalCoreSettings';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: string) => key }));
import { TerminalEngineSetting } from '../TerminalEngineSetting';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initial: TerminalCoreSettings = {
  selected: 'node', runtime: { requested: 'node', effective: 'node', rustAvailable: true, environmentOverride: false },
  rustAvailable: true, environmentOverride: false, restartRequired: false, host: 'daemon', stopCommand: "WMUX_DATA_SUFFIX='-test' wmux daemon stop",
};
let root: Root;
let container: HTMLDivElement;
const get = vi.fn(); const set = vi.fn(); const off = vi.fn();
let connected: () => void;
beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue(initial);
  vi.stubGlobal('electronAPI', undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    settings: { getTerminalCore: get, setTerminalCore: set },
    daemon: { onConnected: (cb: () => void) => { connected = cb; return off; } },
  } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function select() {
  const control = container.querySelector('select');
  if (!control) throw new Error('Missing engine picker');
  return control;
}
function refreshButton() {
  const button = container.querySelector('button');
  if (!button) throw new Error('Missing refresh button');
  return button;
}
async function render() { await act(async () => root.render(<TerminalEngineSetting />)); }
async function choose(value: string) {
  await act(async () => {
    const control = select();
    control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('terminal engine setting', () => {
  it('saves Rust, shows Node as still running, and can revert without a restart', async () => {
    await render();
    const control = select();
    expect(control.labels?.[0]?.textContent).toContain('settings.terminalEngine');
    set.mockResolvedValue({ ...initial, selected: 'rust', restartRequired: true });
    await choose('rust');
    expect(set).toHaveBeenCalledWith('rust');
    expect(control.value).toBe('rust');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Node');
    expect(container.textContent).toContain('settings.terminalEngineRestartDaemon');
    set.mockResolvedValue(initial); await choose('node');
    expect(container.textContent).not.toContain('settings.terminalEngineRestartDaemon');
  });
  it('names Rust as the default on Windows and macOS and as experimental elsewhere', async () => {
    await render();
    const rust = () => select().querySelector('option[value="rust"]')?.textContent;
    expect(rust()).toBe('settings.terminalEngineRust');
    for (const platform of ['win32', 'darwin']) {
      act(() => root.unmount());
      root = createRoot(container);
      (window.electronAPI as unknown as { platform: string }).platform = platform;
      await render();
      expect(rust()).toBe('settings.terminalEngineRustDefault');
    }
  });
  it('disables unavailable Rust, while keeping Node selectable', async () => {
    get.mockResolvedValue({ ...initial, selected: 'rust', rustAvailable: false });
    await render();
    expect(container.querySelector('option[value="rust"]')?.hasAttribute('disabled')).toBe(true);
    expect(container.querySelector('select')?.disabled).toBe(false);
    expect(container.textContent).toContain('settings.terminalEngineUnavailable');
  });
  it('locks environment overrides and refreshes actual runtime on reconnect', async () => {
    get.mockResolvedValue({ ...initial, environmentOverride: true }); await render();
    expect(container.querySelector('select')?.disabled).toBe(true);
    expect(container.textContent).toContain('settings.terminalEngineOverride');
    get.mockResolvedValue({ ...initial, selected: 'rust', runtime: { ...initial.runtime, requested: 'rust', effective: 'rust' } });
    await act(async () => connected());
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Rust');
  });
  it('waits for an in-flight save before refreshing after daemon reconnect', async () => {
    await render();
    let resolveSave: (value: TerminalCoreSettings) => void = () => { throw new Error('Save not started'); };
    set.mockImplementation(() => new Promise<TerminalCoreSettings>((resolve) => { resolveSave = resolve; }));
    await choose('rust');
    await act(async () => connected());
    expect(get).toHaveBeenCalledTimes(1);
    const pending = { ...initial, selected: 'rust' as const, restartRequired: true };
    get.mockResolvedValue(pending);
    await act(async () => resolveSave(pending));
    expect(get).toHaveBeenCalledTimes(2);
    expect(select().value).toBe('rust');
  });
  it('keeps the saved choice on a failed write and offers a refresh after read failure', async () => {
    await render(); set.mockRejectedValue(new Error('disk full')); await choose('rust');
    expect(container.querySelector('select')?.value).toBe('node');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    get.mockRejectedValue(new Error('disconnected'));
    await act(async () => refreshButton().click());
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    get.mockResolvedValue(initial);
    await act(async () => refreshButton().click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
