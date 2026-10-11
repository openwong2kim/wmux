// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SecretHookSetting } from '../SecretHookSetting';
import { useStore } from '../../../stores';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => { act(() => root?.unmount()); root = null; host?.remove(); });

async function mount(get: { autoInstall: boolean }, set = vi.fn(async (on: boolean) => ({ autoInstall: on, failed: [] as string[] }))) {
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: { secretHookGet: vi.fn(async () => get), secretHookSet: set } };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<SecretHookSetting />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return set;
}
const sw = () => host.querySelector('[data-testid="secret-hook-switch"]') as HTMLElement;
const click = async () => { await act(async () => { sw().click(); await new Promise((r) => setTimeout(r, 0)); }); };

describe('SecretHookSetting', () => {
  it('shows the saved state with a plain description; turning it off asks main to uninstall', async () => {
    useStore.setState({ locale: 'en' } as never);
    const set = await mount({ autoInstall: true });
    expect(sw().getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('a commit from any terminal or tool');
    await click();
    expect(set).toHaveBeenCalledWith(false);
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('shows a saved off state', async () => {
    await mount({ autoInstall: false });
    expect(sw().getAttribute('aria-checked')).toBe('false');
  });

  it('says so when the check could not be removed everywhere', async () => {
    await mount({ autoInstall: true }, vi.fn(async () => ({ autoInstall: false, failed: ['/r'] })));
    await click();
    expect(host.querySelector('[data-testid="secret-hook-error"]')).not.toBeNull();
  });
});
