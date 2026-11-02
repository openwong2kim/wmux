// @vitest-environment jsdom
// @wmux-lane unit
// Settings › Labs: the ring-compression row against the status main reports.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabsStatus } from '../../../../shared/labsSettings';
vi.mock('../../../hooks/useT', () => ({ useT: () => (key: string) => key }));
import { TabLabs } from '../SettingsPanel';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const base: LabsStatus = {
  saved: { ringCompression: false }, running: { ringCompression: false },
  ringCompressionInConfig: false, ringCompressionApplies: true, restartRequired: false,
  stopCommand: "WMUX_DATA_SUFFIX='-test' wmux daemon stop",
};
let root: Root;
let container: HTMLDivElement;
const getLabs = vi.fn();
beforeEach(() => {
  getLabs.mockReset();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { settings: { getLabs, setLabs: vi.fn() } } });
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
async function render(status: LabsStatus) {
  getLabs.mockResolvedValue(status);
  await act(async () => root.render(<TabLabs />));
}
function ringToggle(): HTMLButtonElement | HTMLInputElement {
  const toggle = container.querySelector<HTMLButtonElement | HTMLInputElement>(
    '[data-setting-id="labs-ring-compression"] button, [data-setting-id="labs-ring-compression"] input',
  );
  if (!toggle) throw new Error('Missing ring compression toggle');
  return toggle;
}

describe('Settings › Labs ring compression', () => {
  it('is enabled without a note while the daemon runs the Node engine', async () => {
    await render(base);
    expect(ringToggle().disabled).toBe(false);
    expect(container.textContent).not.toContain('settings.labsRingCompressionNodeOnly');
  });
  it('is disabled with the Node-only note while the daemon runs Rust', async () => {
    await render({ ...base, saved: { ringCompression: true }, ringCompressionApplies: false });
    expect(ringToggle().disabled).toBe(true);
    expect(container.textContent).toContain('settings.labsRingCompressionNodeOnly');
    expect(container.textContent).not.toContain('settings.labsRestartDaemon');
  });
  it('shows the restart notice when config.json turned compression on after the daemon started', async () => {
    await render({ ...base, ringCompressionInConfig: true, restartRequired: true });
    expect(container.textContent).toContain('settings.labsRingCompressionInConfig');
    expect(container.textContent).toContain('settings.labsRestartDaemon');
    expect(container.textContent).toContain(base.stopCommand);
  });
});
