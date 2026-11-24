// @vitest-environment jsdom
// @wmux-lane unit
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TerminalCoreSettings } from '../../../../shared/terminalCoreSettings';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: string) => key }));
import { TerminalEngineSetting } from '../TerminalEngineSetting';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rust: TerminalCoreSettings = {
  runtime: { requested: 'rust', effective: 'rust', rustAvailable: true, environmentOverride: false, available: true },
  host: 'daemon',
};
let root: Root;
let container: HTMLDivElement;
const get = vi.fn(); const off = vi.fn();
let connected: () => void;
beforeEach(() => {
  vi.resetAllMocks();
  get.mockResolvedValue(rust);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    settings: { getTerminalCore: get },
    daemon: { onConnected: (cb: () => void) => { connected = cb; return off; } },
  } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render() { await act(async () => root.render(<TerminalEngineSetting />)); }

describe('terminal engine status', () => {
  it('shows the running engine read-only, with no picker', async () => {
    await render();
    expect(container.querySelector('select')).toBeNull();
    expect(container.textContent).toContain('settings.terminalEngine');
    expect(container.textContent).toContain('Rust');
    expect(container.textContent).not.toContain('settings.terminalEngineMissing');
  });
  it('says the module is missing, with the reason', async () => {
    get.mockResolvedValue({ ...rust, runtime: { ...rust.runtime!, rustAvailable: false, available: false, reason: 'Native terminal core lacks pty-v1' } });
    await render();
    expect(container.textContent).toContain('settings.terminalEngineMissing');
    expect(container.textContent).toContain('Native terminal core lacks pty-v1');
  });
  it('shows what an older daemon reports, and Unknown when it reports nothing', async () => {
    get.mockResolvedValue({ host: 'daemon', runtime: { requested: 'node', effective: 'node', rustAvailable: true, environmentOverride: false } });
    await render();
    expect(container.textContent).toContain('Node');
    expect(container.textContent).not.toContain('settings.terminalEngineMissing');
    get.mockResolvedValue({ host: 'daemon', runtime: null });
    await act(async () => connected());
    expect(container.textContent).toContain('settings.terminalEngineUnknown');
  });
  it('offers a refresh when the status read fails', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    await render();
    expect(container.textContent).toContain('settings.terminalEngineError');
    const button = container.querySelector('button');
    if (!button) throw new Error('Missing refresh button');
    await act(async () => button.click());
    expect(container.textContent).not.toContain('settings.terminalEngineError');
  });
});
