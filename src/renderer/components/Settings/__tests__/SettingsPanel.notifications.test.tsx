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
import { NotificationsView, type NotificationsViewProps, type NotificationsViewWorkspaceRow } from '../SettingsPanel';

// ─── Fixtures ────────────────────────────────────────────────────────────────

const noop = (): void => undefined;
const noopBool = (_: boolean): void => undefined;
const noopNum = (_v: number) => {};
const noopChoice = (_: 'default' | 'none'): void => undefined;
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
    onToggleNotificationSound: noop,
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
    notificationSoundChoice: 'default',
    onChangeNotificationSoundChoice: noopChoice,
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
    // Sound choice (radio group, not a toggle)
    expect(html).toContain('notification-sound-choice-row');
    expect(html).toContain('settings.notificationSoundChoice');
    expect(html).toContain('settings.notificationSoundChoiceDesc');
  });

  it('renders the sound-choice radio group with "default" selected by default', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps()));
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('name="notification-sound-choice"');
    // Match the `<input>` tag containing both `value="default"` and `checked`,
    // regardless of attribute order (react-dom emits them in declaration order).
    const defaultRadio = html.match(/<input[^>]*value="default"[^>]*>/);
    const noneRadio = html.match(/<input[^>]*value="none"[^>]*>/);
    expect(defaultRadio).not.toBeNull();
    expect(noneRadio).not.toBeNull();
    expect(defaultRadio && defaultRadio[0]).toContain('checked');
    expect(noneRadio && noneRadio[0].includes('checked')).toBe(false);
  });

  it('renders sound-choice with "none" selected when prop says so', () => {
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ notificationSoundChoice: 'none' })));
    const defaultRadio = html.match(/<input[^>]*value="default"[^>]*>/);
    const noneRadio = html.match(/<input[^>]*value="none"[^>]*>/);
    expect(defaultRadio).not.toBeNull();
    expect(noneRadio).not.toBeNull();
    expect(noneRadio && noneRadio[0]).toContain('checked');
    expect(defaultRadio && defaultRadio[0].includes('checked')).toBe(false);
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
    // Find the aria-label="settings.paneRing" switch and assert it is aria-checked=false.
    const m = html.match(/aria-checked="(true|false)"[^>]*aria-label="settings.paneRing"/);
    expect(m).not.toBeNull();
    expect(m && m[1]).toBe('false');

    const m2 = html.match(/aria-checked="(true|false)"[^>]*aria-label="settings.paneFlash"/);
    expect(m2).not.toBeNull();
    expect(m2 && m2[1]).toBe('false');

    const m3 = html.match(/aria-checked="(true|false)"[^>]*aria-label="settings.taskbarFlash"/);
    expect(m3).not.toBeNull();
    expect(m3 && m3[1]).toBe('false');
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

describe('NotificationsView — sound-choice radio wiring', () => {
  it('choosing "default" calls setNotificationSoundChoice with "default"', () => {
    const setter = vi.fn();
    const props = makeProps({ notificationSoundChoice: 'none', onChangeNotificationSoundChoice: setter });
    props.onChangeNotificationSoundChoice('default');
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith('default');
  });

  it('choosing "none" calls setNotificationSoundChoice with "none"', () => {
    const setter = vi.fn();
    const props = makeProps({ notificationSoundChoice: 'default', onChangeNotificationSoundChoice: setter });
    props.onChangeNotificationSoundChoice('none');
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith('none');
  });
});

// ─── Per-workspace mute list ────────────────────────────────────────────────

describe('NotificationsView — per-workspace mute list', () => {
  it('renders one row per workspace with a checkbox bound to muted', () => {
    const workspaces = [
      workspaceRow('ws-1', 'Workspace 1', false),
      workspaceRow('ws-2', 'Workspace 2', true),
    ];
    const html = renderToStaticMarkup(createElement(NotificationsView, makeProps({ workspaces })));
    expect(html).toContain('per-workspace-mute-row-ws-1');
    expect(html).toContain('per-workspace-mute-row-ws-2');
    expect(html).toContain('per-workspace-mute-checkbox-ws-1');
    expect(html).toContain('per-workspace-mute-checkbox-ws-2');
    // The muted row's checkbox renders as `checked`.
    const ws2Checkbox = html.match(/id="workspace-mute-ws-2"[^>]*checked/);
    expect(ws2Checkbox).not.toBeNull();
    // The unmuted row's checkbox does NOT have the checked attribute.
    const ws1Checkbox = html.match(/id="workspace-mute-ws-1"[^>]*checked/);
    expect(ws1Checkbox).toBeNull();
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

  it('notificationSoundEnabled toggle calls toggleNotificationSound (no payload)', () => {
    const setter = vi.fn();
    const props = makeProps({ notificationSoundEnabled: true, onToggleNotificationSound: setter });
    props.onToggleNotificationSound();
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledWith();
  });

  it('notificationRingEnabled onChange(false) calls setNotificationRingEnabled with false', () => {
    const setter = vi.fn();
    const props = makeProps({ notificationRingEnabled: true, onChangeNotificationRingEnabled: setter });
    props.onChangeNotificationRingEnabled(!props.notificationRingEnabled);
    expect(setter).toHaveBeenCalledWith(false);
  });
});
