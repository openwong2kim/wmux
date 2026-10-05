// @vitest-environment jsdom
//
// Moa's header ⋯ menu: every control that used to sit in a row under the
// header (or above the composer) is reachable here with the same presence
// rules, disabled states and confirmations; focus returns to ⋯.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoaHeaderMenu, type MoaHeaderMenuProps } from '../MoaHeaderMenu';
import { setDeckHeaderSlot } from '../deckHeaderSlot';
import { useStore } from '../../../stores';

let host: HTMLDivElement;
let slot: HTMLDivElement;
let root: Root;

const t = (k: string) => k;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function apis() {
  // Main stores the mode: a read after a set returns what was set.
  let stored: 'off' | 'assist' | 'danger' = 'assist';
  return {
    modeApi: {
      get: vi.fn(async () => ({ mode: stored })),
      set: vi.fn(async (_ws: string, mode: 'off' | 'assist' | 'danger') => { stored = mode; return { ok: true, mode }; }),
    },
    sessionApi: { clear: vi.fn(async () => ({ ok: true })), wake: vi.fn(async () => ({ ok: true })) },
    wake: vi.fn(async () => ({ ok: true })),
  };
}

async function mount(over: Partial<MoaHeaderMenuProps> = {}) {
  const props: MoaHeaderMenuProps = {
    t,
    workspaceId: 'ws-hq',
    brainBusy: false,
    brainPtyId: 'pty-hq',
    chatAvailable: true,
    view: 'chat',
    onViewChange: vi.fn(),
    onOpenLoop: vi.fn(),
    onOpenSchedules: vi.fn(),
    hasLoop: true,
    hasSchedules: true,
    ...apis(),
    ...over,
  };
  await act(async () => root.render(createElement(MoaHeaderMenu, props)));
  await flush();
  return props;
}

const more = () => slot.querySelector('[data-moa-header-more]') as HTMLButtonElement;
const item = (key: string) => document.querySelector(`[data-pane-menu-action="${key}"]`) as HTMLButtonElement | null;
const openMenu = () => act(() => more().click());

beforeEach(() => {
  host = document.createElement('div');
  slot = document.createElement('div');
  document.body.append(host, slot);
  act(() => setDeckHeaderSlot(slot));
  root = createRoot(host);
  useStore.setState({ deckBrainModel: '' });
});
afterEach(() => {
  act(() => root.unmount());
  act(() => setDeckHeaderSlot(null));
  host.remove();
  slot.remove();
});

describe('MoaHeaderMenu', () => {
  it('renders into the header slot: a quiet mode label and a labelled ⋯ menu button', async () => {
    await mount();
    expect(slot.querySelector('[data-moa-mode-chip="assist"]')?.textContent).toBe('deck.mode.assist');
    expect(more().getAttribute('aria-label')).toBe('moa.panel.options');
    expect(more().getAttribute('aria-haspopup')).toBe('menu');
    await openMenu();
    expect(document.querySelector('[data-pane-actions-menu]')?.getAttribute('role')).toBe('menu');
    expect([...document.querySelectorAll('[data-pane-menu-action]')].map((el) => el.getAttribute('data-pane-menu-action')))
      .toEqual(['model', 'mode', 'new-session', 'wake', 'view', 'loop', 'schedules', 'settings']);
  });

  it('renders nothing without a header slot', async () => {
    act(() => setDeckHeaderSlot(null));
    await mount();
    expect(document.querySelector('[data-moa-header-more]')).toBeNull();
  });

  it('Escape closes the menu and hands focus back to ⋯', async () => {
    await mount();
    await openMenu();
    expect(document.activeElement?.getAttribute('data-pane-menu-action')).toBe('model');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('Mode opens a submenu; picking a mode applies it like the old chip', async () => {
    const props = await mount();
    await openMenu();
    act(() => item('mode')!.click());
    expect(item('mode:assist')?.getAttribute('aria-checked')).toBe('true');
    await act(async () => item('mode:off')!.click());
    expect(props.modeApi!.set).toHaveBeenCalledWith('ws-hq', 'off');
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();
    expect(slot.querySelector('[data-moa-mode-chip]')?.getAttribute('data-moa-mode-chip')).toBe('off');
  });

  it('Model and Mode announce their submenus; Escape in one steps back to the main menu on its opener', async () => {
    await mount();
    await openMenu();
    expect(item('model')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(item('mode')?.getAttribute('aria-haspopup')).toBe('menu');
    expect(item('wake')?.getAttribute('aria-haspopup')).toBeNull();
    act(() => item('mode')!.click());
    expect(item('mode:off')).not.toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    // Back in the main menu, not closed, focus on Mode.
    expect(item('mode:off')).toBeNull();
    expect(item('settings')).not.toBeNull();
    expect(document.activeElement).toBe(item('mode'));
    // A second Escape closes everything and lands on ⋯.
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('picking from a submenu closes the menu and lands on ⋯', async () => {
    await mount();
    await openMenu();
    act(() => item('model')!.click());
    act(() => item('model:default')!.click());
    expect(document.querySelector('[data-pane-actions-menu]')).toBeNull();
    expect(document.activeElement).toBe(more());
  });

  it('Model opens a submenu with the main bot model options', async () => {
    await mount();
    await openMenu();
    act(() => item('model')!.click());
    expect(item('model:default')?.getAttribute('aria-checked')).toBe('true');
    const other = [...document.querySelectorAll('[data-pane-menu-action^="model:"]')].find((el) => el.getAttribute('data-pane-menu-action') !== 'model:default') as HTMLButtonElement;
    const value = other.getAttribute('data-pane-menu-action')!.slice('model:'.length);
    act(() => other.click());
    expect(useStore.getState().deckBrainModel).toBe(value);
  });

  it('New session asks first; Cancel leaves the brain alone, confirm clears then wakes', async () => {
    const props = await mount();
    await openMenu();
    act(() => item('new-session')!.click());
    expect(props.sessionApi!.clear).not.toHaveBeenCalled();
    const dialog = document.querySelector('[data-testid="moa-new-session-confirm"]')!;
    expect(dialog.textContent).toContain('deck.newSessionConfirm');
    act(() => (dialog.querySelector('[data-moa-new-session-cancel]') as HTMLButtonElement).click());
    expect(props.sessionApi!.clear).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(more());

    await openMenu();
    act(() => item('new-session')!.click());
    await act(async () => (document.querySelector('[data-moa-new-session-confirm]') as HTMLButtonElement).click());
    await flush();
    expect(props.sessionApi!.clear).toHaveBeenCalledWith('ws-hq');
    expect(props.sessionApi!.wake).toHaveBeenCalledWith('ws-hq');
  });

  it('mid-turn: Wake is disabled with the reason; New session stays live with the interrupt wording', async () => {
    const props = await mount({ brainBusy: true });
    await openMenu();
    expect(item('wake')?.getAttribute('aria-disabled')).toBe('true');
    expect(item('wake')?.getAttribute('title')).toBe('moa.panel.busy');
    act(() => item('wake')!.click());
    expect(props.wake).not.toHaveBeenCalled();
    expect(item('new-session')?.getAttribute('aria-disabled')).toBeNull();
    act(() => item('new-session')!.click());
    expect(document.querySelector('[data-testid="moa-new-session-confirm"]')?.textContent).toContain('deck.newSessionConfirmBusy');
  });

  it('Wake, the view switch, Loop, Schedules and Settings do what their buttons did', async () => {
    const props = await mount({ view: 'terminal' });
    await openMenu();
    act(() => item('wake')!.click());
    expect(props.wake).toHaveBeenCalledWith('ws-hq');
    await openMenu();
    expect(item('view')?.textContent).toBe('moa.panel.viewAsChat');
    act(() => item('view')!.click());
    expect(props.onViewChange).toHaveBeenCalledWith('chat');
    await openMenu();
    act(() => item('loop')!.click());
    expect(props.onOpenLoop).toHaveBeenCalledTimes(1);
    await openMenu();
    act(() => item('schedules')!.click());
    expect(props.onOpenSchedules).toHaveBeenCalledTimes(1);
    const openSettingsTab = vi.fn();
    useStore.setState({ openSettingsTab });
    await openMenu();
    act(() => item('settings')!.click());
    expect(openSettingsTab).toHaveBeenCalledWith('moa');
  });

  it('keeps the old presence rules: no Wake or view switch before the brain is up', async () => {
    await mount({ brainPtyId: null, chatAvailable: false, hasLoop: false, hasSchedules: false });
    await openMenu();
    expect(item('wake')).toBeNull();
    expect(item('view')).toBeNull();
    expect(item('loop')).toBeNull();
    expect(item('schedules')).toBeNull();
    expect(item('new-session')).not.toBeNull();
  });
});
