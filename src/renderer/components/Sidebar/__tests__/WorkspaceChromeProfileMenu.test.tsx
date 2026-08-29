// @vitest-environment jsdom
//
// "New profile…" used to call window.prompt, which Electron's renderer does not
// implement — the call itself throws, so the row was dead on arrival. These
// tests pin the inline form that replaced it: the create→bind flow, the failure
// path (main rejects bad names, the reserved 'live', and the 20-profile cap, so
// errors are the common case and must not close the form), Escape, and the fact
// that no prompt/alert is reached at all.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import WorkspaceChromeProfileMenu from '../WorkspaceChromeProfileMenu';
import { useStore } from '../../../stores';

const list = vi.fn(async () => ({ profiles: ['default'], bindings: {} as Record<string, string> }));
type CreateResult = { ok: boolean; error?: string };
const create = vi.fn<(name: string) => Promise<CreateResult>>(async () => ({ ok: true }));
const bind = vi.fn<(workspaceId: string, profileName: string | null) => Promise<CreateResult>>(
  async () => ({ ok: true }),
);

function installApi(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    browser: { chromeProfiles: { list, create, bind } },
  };
}

const mounted: Array<() => void> = [];

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function flush(ticks = 8) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  });
}

function q<T extends Element>(container: Element, testId: string): T | null {
  return container.querySelector<T>(`[data-testid="${testId}"]`);
}

/** Simulates typing into a controlled <input> through React's onChange path
 *  (a native `.value =` assignment bypasses React's tracked value). */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

/** Hovering the root row is what opens the submenu holding the form.
 *  (React synthesizes onMouseEnter/onMouseLeave from mouseover/mouseout.) */
function openSubmenu(container: Element) {
  act(() => {
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

function leaveSubmenu(container: Element) {
  act(() => {
    container.firstElementChild!.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
  });
}

let promptSpy: ReturnType<typeof vi.spyOn>;
let alertSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  list.mockClear();
  create.mockClear();
  create.mockImplementation(async () => ({ ok: true }));
  bind.mockClear();
  installApi();
  act(() => { useStore.getState().setBrowserBackend('chrome'); });
  // Match Electron: reaching for either of these is itself the bug.
  promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => {
    throw new Error('prompt() is not available in the Electron renderer');
  });
  alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {
    throw new Error('alert() is not available in the Electron renderer');
  });
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  promptSpy.mockRestore();
  alertSpy.mockRestore();
});

describe('WorkspaceChromeProfileMenu — inline new-profile form', () => {
  it('opens an inline form instead of calling window.prompt', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);

    click(q(container, 'chrome-profile-new-open')!);

    expect(q(container, 'chrome-profile-new-form')).not.toBeNull();
    expect(q<HTMLInputElement>(container, 'chrome-profile-new-input')).not.toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('creates the profile and binds it on submit', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);

    setInputValue(q<HTMLInputElement>(container, 'chrome-profile-new-input')!, 'work-account');
    click(q(container, 'chrome-profile-new-submit')!);
    await flush();

    expect(create).toHaveBeenCalledWith('work-account');
    expect(bind).toHaveBeenCalledWith('ws-1', 'work-account');
    // Success closes the form again.
    expect(q(container, 'chrome-profile-new-form')).toBeNull();
  });

  it('keeps the form and the typed name, and shows the error, when create fails', async () => {
    create.mockImplementation(async () => ({ ok: false, error: 'Profile "live" is reserved' }));
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);

    setInputValue(q<HTMLInputElement>(container, 'chrome-profile-new-input')!, 'live');
    click(q(container, 'chrome-profile-new-submit')!);
    await flush();

    expect(q(container, 'chrome-profile-new-error')?.textContent).toBe('Profile "live" is reserved');
    expect(q(container, 'chrome-profile-new-form')).not.toBeNull();
    expect(q<HTMLInputElement>(container, 'chrome-profile-new-input')!.value).toBe('live');
    expect(bind).not.toHaveBeenCalled();
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('submits on Enter but not while an IME composition is closing', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);
    const input = q<HTMLInputElement>(container, 'chrome-profile-new-input')!;
    setInputValue(input, 'account-b');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
    });
    await flush();
    expect(create).not.toHaveBeenCalled();

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(create).toHaveBeenCalledWith('account-b');
  });

  it('closes the form and clears the input on Escape', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);
    setInputValue(q<HTMLInputElement>(container, 'chrome-profile-new-input')!, 'half-typed');

    act(() => {
      q(container, 'chrome-profile-new-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(q(container, 'chrome-profile-new-form')).toBeNull();
    click(q(container, 'chrome-profile-new-open')!);
    expect(q<HTMLInputElement>(container, 'chrome-profile-new-input')!.value).toBe('');
  });

  it('keeps the submenu open when the pointer leaves while the form is up', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);

    leaveSubmenu(container);

    // Hover-close would otherwise unmount the form mid-typing.
    expect(q(container, 'chrome-profile-new-form')).not.toBeNull();
  });

  it('closes the submenu too when the form closes with the pointer already outside', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);

    leaveSubmenu(container);
    // The guard swallowed that mouseleave, so the submenu is still up…
    expect(q(container, 'chrome-profile-new-form')).not.toBeNull();

    act(() => {
      q(container, 'chrome-profile-new-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // …and mouseleave never fires a second time, so closing the form has to
    // take the submenu with it — otherwise it hangs open until the user
    // hovers the row again just to leave it.
    expect(q(container, 'chrome-profile-new-open')).toBeNull();
  });

  it('leaves the submenu open when the form closes with the pointer still inside', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);

    act(() => {
      q(container, 'chrome-profile-new-input')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    // The pointer never left — the row the user is hovering must stay put.
    expect(q(container, 'chrome-profile-new-open')).not.toBeNull();
  });

  it('closes the submenu after a successful create when the pointer has left', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-new-open')!);
    setInputValue(q<HTMLInputElement>(container, 'chrome-profile-new-input')!, 'work-account');

    leaveSubmenu(container);
    click(q(container, 'chrome-profile-new-submit')!);
    await flush();

    expect(bind).toHaveBeenCalledWith('ws-1', 'work-account');
    expect(q(container, 'chrome-profile-new-open')).toBeNull();
  });
});
