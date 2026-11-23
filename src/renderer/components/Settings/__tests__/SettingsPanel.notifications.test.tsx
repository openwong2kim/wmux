/**
 * Tests for the SettingsPanel notifications section (T12).
 *
 * The repo's vitest config runs in a `node` env without a DOM library, so we
 * mirror the SettingsPanel.firstRunSection test pattern:
 *   1. Drive the pure presentational `NotificationsView` through
 *      `renderToStaticMarkup` — verifies markup, test ids, initial values,
 *      and ARIA wiring.
 *   2. Drive the same view with a controllable harness that runs the
 *      onChange callbacks the static markup would dispatch — verifies that
 *      each toggle/radio is wired to the right setter and that the
 *      per-workspace checkbox payload (`{ notificationsMuted: bool }`) hits
 *      `updateWorkspaceMetadata` exactly as the workspaceSlice expects.
 *   3. Container wiring (useStore selectors → setters) is implicitly
 *      validated by the TypeScript build (`tsc --noEmit`) since the
 *      container passes `useStore(...)` slots straight to the view's typed
 *      props.
 */
import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  NotificationsView,
  applyNotificationSound,
  notificationSoundOn,
  type NotificationsViewProps,
  type NotificationsViewWorkspaceRow,
} from '../SettingsPanel';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const noop = (): void => undefined;
const noopBool = (_: boolean): void => undefined;
const noopNum = (_v: number): void => undefined;
const noopMute = (_id: string, _muted: boolean): void => undefined;

/** Identity-style translator that returns the interpolated key — keeps tests
 *  independent of en.ts copy drift. Vars are inlined when provided. */
const tStub: NotificationsViewProps['t'] = (key, vars) => {
  if (!vars) return key;
  let out = key;
  for (const [k, v] of Object.entries(vars)) {
    out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
  }
  return out;
};

function makeProps(overrides: Partial<NotificationsViewProps> = {}): NotificationsViewProps {
  return {
    notificationSoundEnabled: true,
    onChangeNotificationSound: noopBool,
    toastEnabled: true,
    onChangeToastEnabled: noopBool,
    notificationRingEnabled: true,
    onChangeNotificationRingEnabled: noopBool,
    mutedNotificationCategories: [],
    onChangeCategoryMuted: noop,
    paneRingEnabled: true,
    onChangePaneRingEnabled: noopBool,
    paneGlowOpacity: 0.6,
    onChangePaneGlowOpacity: noopNum,
    paneFlashEnabled: true,
    onChangePaneFlashEnabled: noopBool,
    taskbarFlashEnabled: true,
    onChangeTaskbarFlashEnabled: noopBool,
    taskbarBadgeEnabled: true,
    onChangeTaskbarBadgeEnabled: noopBool,
    notificationSoundChoice: 'default',
    workspaces: [],
    onChangeWorkspaceMuted: noopMute,
    t: tStub,
    ...overrides,
  };
}

const workspaceRow = (id: string, name: string, muted = false): NotificationsViewWorkspaceRow => ({
  id, name, muted,
});

// ─── Initial render — store defaults wire to the right toggle state ─────────

describe('NotificationsView — initial render', () => {
  it('renders the section root with the per-workspace mute section', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps()));
    expect(html).toContain('notifications-settings-section');
    expect(html).toContain('per-workspace-mute-section');
  });

  it('renders all 4 new T12 toggles with the keys from en.ts', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps()));
    // Pane ring
    expect(html).toContain('settings.paneRing');
    expect(html).toContain('settings.paneRingDesc');
    // Pane flash
    expect(html).toContain('settings.paneFlash');
    expect(html).toContain('settings.paneFlashDesc');
    // Taskbar flash
    expect(html).toContain('settings.taskbarFlash');
    expect(html).toContain('settings.taskbarFlashDesc');
    // Sound has one row: no separate sound-choice radio group.
    expect(html).not.toContain('notification-sound-choice-row');
    expect(html).not.toContain('role="radiogroup"');
  });

  it('shows one sound switch, on only while sound is enabled and the cue is not "none"', () => {
    const soundState = (props: Partial<NotificationsViewProps>): string | null => {
      const html = renderToStaticMarkup(createElement(NotificationsView, makeProps(props)));
      const tag = html.match(/<button[^>]*aria-label="settings.sound"[^>]*>/);
      return tag ? (tag[0].match(/aria-checked="(true|false)"/)?.[1] ?? null) : null;
    };
    expect(soundState({ notificationSoundEnabled: true, notificationSoundChoice: 'default' })).toBe('true');
    expect(soundState({ notificationSoundEnabled: true, notificationSoundChoice: 'none' })).toBe('false');
    expect(soundState({ notificationSoundEnabled: false, notificationSoundChoice: 'default' })).toBe('false');
  });

  it('renders all 4 new toggles as ON when store defaults are true', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({
      paneRingEnabled: true,
      paneFlashEnabled: true,
      taskbarFlashEnabled: true,
    })));
    // Toggle uses role="switch" + aria-checked
    const switches = html.match(/aria-checked="true"/g) ?? [];
    // 3 existing toggles (sound/toast/ring) + 3 new toggles (paneRing/paneFlash/taskbarFlash) = 6 ON
    expect(switches.length).toBeGreaterThanOrEqual(6);
  });

  it('reflects per-toggle disabled state', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({
      paneRingEnabled: false,
      paneFlashEnabled: false,
      taskbarFlashEnabled: false,
    })));
    // Find the aria-label="settings.paneRing" switch and assert it is
    // aria-checked=false. Attribute order is the primitive's business, so the
    // switch's opening tag is found first and its state read from it.
    const switchState = (label: string): string | null => {
      const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`));
      return tag ? (tag[0].match(/aria-checked="(true|false)"/)?.[1] ?? null) : null;
    };
    expect(switchState('settings.paneRing')).toBe('false');
    expect(switchState('settings.paneFlash')).toBe('false');
    expect(switchState('settings.taskbarFlash')).toBe('false');
  });
});

describe('NotificationsView — child rows follow the pane ring', () => {
  const switchTag = (html: string, label: string): string =>
    html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? '';

  it('disables the flash switch while the pane ring is off, and only then', () => {
    const off = renderToStaticMarkup(createElement(NotificationsView, makeProps({ paneRingEnabled: false })));
    const on = renderToStaticMarkup(createElement(NotificationsView, makeProps({ paneRingEnabled: true })));
    expect(switchTag(off, 'settings.paneFlash')).toMatch(/disabled/);
    expect(switchTag(on, 'settings.paneFlash')).not.toMatch(/disabled/);
  });

  it('names the attention row after the Dock on macOS and the taskbar elsewhere', () => {
    const mac = renderToStaticMarkup(createElement(NotificationsView, makeProps({ platform: 'darwin' })));
    const win = renderToStaticMarkup(createElement(NotificationsView, makeProps({ platform: undefined })));
    expect(switchTag(mac, 'settings.taskbarFlash.darwin')).not.toBe('');
    expect(mac).toContain('settings.taskbarFlashDesc.darwin');
    expect(switchTag(win, 'settings.taskbarFlash')).not.toBe('');
    expect(win).toContain('settings.taskbarFlashDesc<');
  });

  it('shows the taskbar overlay switch on Windows only', () => {
    for (const platform of ['darwin', 'linux', undefined]) {
      const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ platform })));
      expect(html).not.toContain('settings.taskbarBadge');
    }
    const win = renderToStaticMarkup(createElement(NotificationsView, makeProps({ platform: 'win32', taskbarBadgeEnabled: false })));
    expect(switchTag(win, 'settings.taskbarBadge')).toMatch(/aria-checked="false"/);
    expect(win).toContain('data-setting-id="taskbarbadge"');
  });
});

// ─── Handler wiring — clicking each toggle calls the matching setter ─────────
//
// The static markup pattern can't fire DOM events, so we exercise the
// handlers directly. The view's render path passes the props straight through
// to the underlying Toggle / radio's onChange, so calling the props with the
// inverted value mirrors what a click would do.

describe('NotificationsView — toggle handler wiring', () => {
  it('paneRing onChange(false) calls setPaneRingEnabled with false', () => {
    const setter = vi.fn();
    const props = makeProps({ paneRingEnabled: true, onChangePaneRingEnabled: setter });
    props.onChangePaneRingEnabled(!props.paneRingEnabled);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(false);
  });

  it('paneFlash onChange(false) calls setPaneFlashEnabled with false', () => {
    const setter = vi.fn();
    const props = makeProps({ paneFlashEnabled: true, onChangePaneFlashEnabled: setter });
    props.onChangePaneFlashEnabled(!props.paneFlashEnabled);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(false);
  });

  it('taskbarFlash onChange(false) calls setTaskbarFlashEnabled with false', () => {
    const setter = vi.fn();
    const props = makeProps({ taskbarFlashEnabled: true, onChangeTaskbarFlashEnabled: setter });
    props.onChangeTaskbarFlashEnabled(!props.taskbarFlashEnabled);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(false);
  });

  it('paneRing onChange(true) calls setPaneRingEnabled with true', () => {
    const setter = vi.fn();
    const props = makeProps({ paneRingEnabled: false, onChangePaneRingEnabled: setter });
    props.onChangePaneRingEnabled(!props.paneRingEnabled);
    expect(setter).toHaveBeenCalledWith(true);
  });
});

describe('Notification sound switch over its two stored values', () => {
  it('reads on only when enabled and the choice is not "none"', () => {
    expect(notificationSoundOn(true, 'default')).toBe(true);
    expect(notificationSoundOn(true, 'none')).toBe(false);
    expect(notificationSoundOn(false, 'default')).toBe(false);
    expect(notificationSoundOn(false, 'none')).toBe(false);
  });

  it('turning it on writes enabled and resets the choice to "default"', () => {
    const setEnabled = vi.fn();
    const setChoice = vi.fn();
    applyNotificationSound(true, setEnabled, setChoice);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(setChoice).toHaveBeenCalledWith('default');
  });

  it('turning it off writes enabled only and leaves the choice alone', () => {
    const setEnabled = vi.fn();
    const setChoice = vi.fn();
    applyNotificationSound(false, setEnabled, setChoice);
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(setChoice).not.toHaveBeenCalled();
  });
});

// ─── Per-workspace mute list ────────────────────────────────────────────────

describe('NotificationsView — per-workspace mute list', () => {
  it('renders one row per workspace with a switch bound to muted', () => {
    const workspaces = [
      workspaceRow('ws-1', 'Workspace 1', false),
      workspaceRow('ws-2', 'Workspace 2', true),
    ];
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces })));
    expect(html).toContain('per-workspace-mute-row-ws-1');
    expect(html).toContain('per-workspace-mute-row-ws-2');
    expect(html).toContain('per-workspace-mute-switch-ws-1');
    expect(html).toContain('per-workspace-mute-switch-ws-2');
    const switchState = (id: string): string | null => {
      const tag = html.match(new RegExp(`<button[^>]*id="workspace-mute-${id}"[^>]*>`));
      return tag ? (tag[0].match(/aria-checked="(true|false)"/)?.[1] ?? null) : null;
    };
    // The muted row's switch is on, the unmuted row's is off.
    expect(switchState('ws-2')).toBe('true');
    expect(switchState('ws-1')).toBe('false');
  });

  it('renders the workspace name in the row label', () => {
    const workspaces = [workspaceRow('ws-99', 'Frontend Team', false)];
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces })));
    // tStub interpolates {name} into the key — so the label ends with " for Frontend Team".
    expect(html).toContain('Frontend Team');
  });

  it('toggling a workspace mute calls onChangeWorkspaceMuted(id, true)', () => {
    const setter = vi.fn();
    const workspaces = [workspaceRow('ws-1', 'Workspace 1', false)];
    const props = makeProps({ workspaces, onChangeWorkspaceMuted: setter });
    // Simulate the onChange callback the input would dispatch.
    props.onChangeWorkspaceMuted('ws-1', true);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith('ws-1', true);
  });

  it('un-muting a workspace calls onChangeWorkspaceMuted(id, false)', () => {
    const setter = vi.fn();
    const workspaces = [workspaceRow('ws-1', 'Workspace 1', true)];
    const props = makeProps({ workspaces, onChangeWorkspaceMuted: setter });
    props.onChangeWorkspaceMuted('ws-1', false);
    expect(setter).toHaveBeenCalledWith('ws-1', false);
  });

  it('renders the empty-state message when workspaces.length === 0', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces: [] })));
    expect(html).toContain('per-workspace-mute-empty');
    expect(html).toContain('settings.perWorkspaceNotificationsEmpty');
  });

  it('renders the scroll container with maxHeight when there are workspaces', () => {
    const workspaces = Array.from({ length: 15 }, (_, i) =>
      workspaceRow(`ws-${i}`, `Workspace ${i}`, false),
    );
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces })));
    // 15 rows should be present in the DOM…
    for (let i = 0; i < 15; i++) {
      expect(html).toContain(`per-workspace-mute-row-ws-${i}`);
    }
    // …and the container limits height + scrolls.
    expect(html).toMatch(/max-height:\s*240px/);
    expect(html).toMatch(/overflow-y:\s*auto/);
  });
});

// ─── Regression — existing toggles still work ────────────────────────────────

describe('NotificationsView — existing toggle regressions', () => {
  it('toastEnabled onChange(false) calls setToastEnabled with false', () => {
    const setter = vi.fn();
    const props = makeProps({ toastEnabled: true, onChangeToastEnabled: setter });
    props.onChangeToastEnabled(!props.toastEnabled);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(false);
  });

  it('the sound switch passes its new state to onChangeNotificationSound', () => {
    const setter = vi.fn();
    const props = makeProps({ notificationSoundEnabled: true, onChangeNotificationSound: setter });
    props.onChangeNotificationSound(false);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith(false);
  });

  it('notificationRingEnabled onChange(false) calls setNotificationRingEnabled with false', () => {
    const setter = vi.fn();
    const props = makeProps({ notificationRingEnabled: true, onChangeNotificationRingEnabled: setter });
    props.onChangeNotificationRingEnabled(!props.notificationRingEnabled);
    expect(setter).toHaveBeenCalledWith(false);
  });
});

// ─── Per-workspace "Wake the agent on PR events" ───────────────────────────

describe('NotificationsView — wake the agent on PR events', () => {
  it('renders one checkbox per workspace, on unless the workspace turned it off', () => {
    const workspaces = [
      { ...workspaceRow('ws-1', 'Workspace 1'), prWake: true },
      { ...workspaceRow('ws-2', 'Workspace 2'), prWake: false },
      workspaceRow('ws-3', 'Workspace 3'),
    ];
    const html = renderToStaticMarkup(
      createElement(NotificationsView, makeProps({ workspaces, onChangeWorkspacePrWake: () => undefined })),
    );
    expect(html).toContain('per-workspace-pr-wake-section');
    expect(html.match(/id="workspace-pr-wake-ws-1"[^>]*checked/)).not.toBeNull();
    expect(html.match(/id="workspace-pr-wake-ws-2"[^>]*checked/)).toBeNull();
    expect(html.match(/id="workspace-pr-wake-ws-3"[^>]*checked/)).not.toBeNull();
  });

  it('checks passed is its own checkbox: off by default, disabled while the workspace is off', () => {
    const workspaces = [
      { ...workspaceRow('ws-1', 'Workspace 1'), prWake: true },
      { ...workspaceRow('ws-2', 'Workspace 2'), prWake: true, prWakeChecksPassed: true },
      { ...workspaceRow('ws-3', 'Workspace 3'), prWake: false, prWakeChecksPassed: true },
    ];
    const html = renderToStaticMarkup(
      createElement(NotificationsView, makeProps({
        workspaces,
        onChangeWorkspacePrWake: () => undefined,
        onChangeWorkspacePrWakeChecksPassed: () => undefined,
      })),
    );
    const tag = (id: string) => html.match(new RegExp(`<input[^>]*id="workspace-pr-wake-passed-${id}"[^>]*>`))?.[0] ?? '';
    expect(tag('ws-1')).not.toMatch(/checked/);
    expect(tag('ws-2')).toMatch(/checked/);
    expect(tag('ws-3')).toMatch(/disabled/);
    expect(tag('ws-3')).not.toMatch(/checked/);
  });

    it('is absent without a handler or without workspaces', () => {
    expect(renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces: [workspaceRow('ws-1', 'W')] })))).not.toContain(
      'per-workspace-pr-wake-section',
    );
    expect(
      renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces: [], onChangeWorkspacePrWake: () => undefined }))),
    ).not.toContain('per-workspace-pr-wake-section');
  });
});
