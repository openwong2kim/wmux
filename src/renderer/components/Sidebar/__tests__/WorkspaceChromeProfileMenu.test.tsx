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
let confirmSpy: ReturnType<typeof vi.spyOn>;

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
  // The live-bind confirm must be inline too — reaching for the native dialog
  // is the bug the owner flagged ("doesn't match our tone").
  confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => {
    throw new Error('confirm() is not available in the Electron renderer');
  });
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  promptSpy.mockRestore();
  alertSpy.mockRestore();
  confirmSpy.mockRestore();
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

// Binding the reserved 'live' profile hands the workspace's agent the user's
// whole live browser, so it takes a confirm. That confirm used to be
// window.confirm — a native OS dialog the owner flagged as off-tone. These pin
// the inline replacement: it opens instead of the native dialog, binds only on
// an explicit yes, and survives a pointer-leave the same way the form does.
describe('WorkspaceChromeProfileMenu — inline live-bind confirm', () => {
  it('opens an inline confirm instead of calling window.confirm, and does not bind yet', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);

    click(q(container, 'chrome-profile-live')!);

    expect(q(container, 'chrome-profile-live-confirm')).not.toBeNull();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it('binds live only after the user confirms', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-live')!);

    click(q(container, 'chrome-profile-live-confirm-yes')!);
    await flush();

    expect(bind).toHaveBeenCalledWith('ws-1', 'live');
    expect(q(container, 'chrome-profile-live-confirm')).toBeNull();
  });

  it('cancel dismisses the confirm without binding', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-live')!);

    click(q(container, 'chrome-profile-live-confirm-cancel')!);
    await flush();

    expect(bind).not.toHaveBeenCalled();
    expect(q(container, 'chrome-profile-live-confirm')).toBeNull();
  });

  it('Escape dismisses the confirm without binding', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-live')!);

    act(() => {
      q(container, 'chrome-profile-live-confirm')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(q(container, 'chrome-profile-live-confirm')).toBeNull();
    expect(bind).not.toHaveBeenCalled();
  });

  it('keeps the submenu open when the pointer leaves while the confirm is up', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    click(q(container, 'chrome-profile-live')!);

    leaveSubmenu(container);

    // A danger confirm that vanished the instant the pointer drifted off would
    // be trivially defeated — the guard must hold it open like the form.
    expect(q(container, 'chrome-profile-live-confirm')).not.toBeNull();
  });

  it('opening the live confirm dismisses an open new-profile form (one at a time)', async () => {
    const container = render(<WorkspaceChromeProfileMenu workspaceId="ws-1" flipLeft={false} />);
    await flush();
    openSubmenu(container);
    // The new-profile form and the confirm share one bottom slot; the Live row
    // stays visible above it, so a click there while the form is up must swap
    // the slot to the confirm rather than stack the two.
    click(q(container, 'chrome-profile-new-open')!);
    setInputValue(q<HTMLInputElement>(container, 'chrome-profile-new-input')!, 'half-typed');
    expect(q(container, 'chrome-profile-new-form')).not.toBeNull();

    click(q(container, 'chrome-profile-live')!);

    expect(q(container, 'chrome-profile-new-form')).toBeNull();
    expect(q(container, 'chrome-profile-live-confirm')).not.toBeNull();
    // And the dropped form must not resurrect its half-typed name later.
    click(q(container, 'chrome-profile-live-confirm-cancel')!);
    click(q(container, 'chrome-profile-new-open')!);
    expect(q<HTMLInputElement>(container, 'chrome-profile-new-input')!.value).toBe('');
  });
});
