// @vitest-environment jsdom
// @wmux-lane unit
// process.platform is stubbed in-test; the result is host-independent.
//
// "Browse WSL folder…" in the + menu: win32 only, and only with at least one
// WSL distro. It opens the native folder dialog on the distro's share and makes
// a workspace whose startupCwd is the picked share path (main turns that into
// a WSL shell in that distro). With several distros a short list comes first.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act, createElement } from 'react';
import PresetPicker from '../PresetPicker';
import { useStore } from '../../../stores';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let pickFolder: ReturnType<typeof vi.fn>;
let addWorkspace: ReturnType<typeof vi.fn>;
let saved: ReturnType<typeof useStore.getState>['addWorkspace'];

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
}

function install(platform: string, distros: string[]): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform,
    dialog: { pickFolder },
    shell: { wslDistros: vi.fn(async () => distros) },
    remote: { hostsList: vi.fn(async () => []) },
  };
}

async function mount(onClose = vi.fn()): Promise<ReturnType<typeof vi.fn>> {
  act(() => root.render(createElement(PresetPicker, { onClose })));
  await flush();
  return onClose;
}

const row = (): HTMLButtonElement | null => container.querySelector('[data-browse-wsl]');
const distroRow = (name: string): HTMLButtonElement => {
  const el = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-wsl-distro]'))
    .find((b) => b.textContent === name);
  if (!el) throw new Error(`no distro row ${name}`);
  return el;
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  pickFolder = vi.fn();
  addWorkspace = vi.fn();
  saved = useStore.getState().addWorkspace;
  useStore.setState({ addWorkspace: addWorkspace as never });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useStore.setState({ addWorkspace: saved });
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('Browse WSL folder row', () => {
  it('is hidden when there is no distro', async () => {
    install('win32', []);
    await mount();
    expect(row()).toBeNull();
  });

  it('is hidden off Windows even with distros', async () => {
    install('linux', ['Ubuntu']);
    await mount();
    expect(row()).toBeNull();
  });

  it('with one distro opens the dialog on its home share and adds the workspace', async () => {
    install('win32', ['Ubuntu']);
    pickFolder.mockResolvedValue(['\\\\wsl.localhost\\Ubuntu\\home\\me\\proj']);
    const onClose = await mount();
    await act(async () => row()!.click());
    await flush();
    expect(pickFolder).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\home');
    expect(addWorkspace).toHaveBeenCalledWith('proj', { startupCwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\proj' });
    expect(onClose).toHaveBeenCalled();
  });

  it('names a workspace after the distro when its root is picked', async () => {
    install('win32', ['Ubuntu']);
    pickFolder.mockResolvedValue(['\\\\wsl.localhost\\Ubuntu\\']);
    await mount();
    await act(async () => row()!.click());
    await flush();
    expect(addWorkspace).toHaveBeenCalledWith('Ubuntu', { startupCwd: '\\\\wsl.localhost\\Ubuntu\\' });
  });

  it('with several distros lists them first, then opens the dialog on the chosen one', async () => {
    install('win32', ['Ubuntu', 'Debian']);
    pickFolder.mockResolvedValue(['\\\\wsl.localhost\\Debian\\srv\\app']);
    await mount();
    await act(async () => row()!.click());
    await flush();
    expect(pickFolder).not.toHaveBeenCalled();
    await act(async () => distroRow('Debian').click());
    await flush();
    expect(pickFolder).toHaveBeenCalledWith('\\\\wsl.localhost\\Debian\\home');
    expect(addWorkspace).toHaveBeenCalledWith('app', { startupCwd: '\\\\wsl.localhost\\Debian\\srv\\app' });
  });

  it('adds nothing when the dialog is cancelled', async () => {
    install('win32', ['Ubuntu']);
    pickFolder.mockResolvedValue([]);
    const onClose = await mount();
    await act(async () => row()!.click());
    await flush();
    expect(addWorkspace).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('ignores a distro name that is not a valid distro name', async () => {
    install('win32', ['bad\\name', '-x']);
    await mount();
    expect(row()).toBeNull();
  });
});
