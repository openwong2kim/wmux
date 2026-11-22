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
  saved: { ringCompression: true }, running: { ringCompression: true },
  ringCompressionInConfig: null, restartRequired: false,
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
  const checked = () => ringToggle().getAttribute('aria-checked') ?? String((ringToggle() as HTMLInputElement).checked);
  it('is on and enabled by default, with no note', async () => {
    await render(base);
    expect(ringToggle().disabled).toBe(false);
    expect(checked()).toBe('true');
    expect(container.textContent).not.toContain('settings.labsRingCompressionInConfig');
    expect(container.textContent).not.toContain('settings.labsRingCompressionOffInConfig');
    expect(container.textContent).not.toContain('settings.labsRestartDaemon');
  });
  it('reads off and disabled, with the reason, when config.json turns compression off', async () => {
    await render({ ...base, running: { ringCompression: false }, ringCompressionInConfig: false });
    expect(ringToggle().disabled).toBe(true);
    expect(checked()).toBe('false');
    expect(container.textContent).toContain('settings.labsRingCompressionOffInConfig');
    expect(container.textContent).not.toContain('settings.labsRestartDaemon');
  });
  it('shows the restart notice when config.json turned compression on after the daemon started', async () => {
    await render({ ...base, ringCompressionInConfig: true, restartRequired: true });
    expect(container.textContent).toContain('settings.labsRingCompressionInConfig');
    expect(container.textContent).toContain('settings.labsRestartDaemon');
    expect(container.textContent).toContain(base.stopCommand);
  });
});
