// @vitest-environment jsdom
// The renderer half of app.action: targets are resolved in the live store,
// held to the caller's workspace, and acted on without reading the workspace
// the human is looking at.
import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../../stores';
import type { Notification, PaneBranch, PaneLeaf, Workspace } from '../../../shared/types';
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../hooks/useKeyboard';
import { runAppAction } from '../runAppAction';

function leaf(id: string, surfaceId: string, ptyId: string, ordinal: number, userName?: string): PaneLeaf {
  return {
    id,
    type: 'leaf',
    ordinal,
    activeSurfaceId: surfaceId,
    surfaces: [{ id: surfaceId, ptyId, title: 'zsh', shell: '', cwd: '', ...(userName ? { userName } : {}) }],
  };
}

function workspace(id: string, name: string, wsOrdinal: number, rootPane: PaneLeaf | PaneBranch): Workspace {
  const first = rootPane.type === 'leaf' ? rootPane.id : (rootPane.children[0] as PaneLeaf).id;
  return { id, name, wsOrdinal, rootPane, activePaneId: first, nextPaneOrdinal: 9 };
}

function note(id: string, workspaceId: string, surfaceId: string, read = false): Notification {
  return { id, workspaceId, surfaceId, title: 't', body: 'b', type: 'info', read, timestamp: 1 } as Notification;
}

/** wsA: the caller's, two panes side by side, not focused. wsB: someone else's, focused. */
function seed(): void {
  const wsA = workspace('ws-a', 'alpha', 1, {
    id: 'branch-a',
    type: 'branch',
    direction: 'horizontal',
    sizes: [80, 20],
    children: [leaf('pane-a1', 'surf-a1', 'pty-a1', 1), leaf('pane-a2', 'surf-a2', 'pty-a2', 2)],
  });
  const wsB = workspace('ws-b', 'beta', 2, leaf('pane-b1', 'surf-b1', 'pty-b1', 1, 'builder'));
  useStore.setState({
    paneGate: 'ready',
    workspaces: [wsA, wsB],
    activeWorkspaceId: 'ws-b',
    parkedWorkspaceIds: {},
    remoteWorkspaces: [],
    paneLabel: {},
    toasts: [],
    notifications: [note('n1', 'ws-a', 'surf-a1'), note('n2', 'ws-a', 'surf-a2'), note('n3', 'ws-b', 'surf-b1')],
    unreadBySurfaceId: { 'surf-a1': 1, 'surf-a2': 1, 'surf-b1': 1 },
    theme: 'tint',
    terminalFontSize: 14,
    terminalFontFamily: 'Cascadia Code',
  });
}

const ws = (id: string) => useStore.getState().workspaces.find((w) => w.id === id)!;
const act = (id: string, extra: Record<string, unknown> = {}) =>
  runAppAction({ id, args: {}, callerWorkspaceId: 'ws-a', callerPtyId: 'pty-a1', ...extra });

beforeEach(seed);

describe('ownership', () => {
  it('a target in another workspace is not_owned, by id, pane, tab or #tag', () => {
    for (const target of ['ws-b', 'pane-b1', 'surf-b1', '#w2-1', '#builder']) {
      expect(act('layout.balance', { target }), target).toMatchObject({ ok: false, code: 'not_owned' });
    }
    expect(ws('ws-b').name).toBe('beta');
  });

  it('an unknown target is not_found', () => {
    expect(act('layout.balance', { target: 'ws-nope' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(act('layout.balance', { target: '#nope' })).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('another computer\'s workspace is not_owned, as a target or as the caller', () => {
    useStore.setState({
      remoteWorkspaces: [{ key: 'host-1:ws-r', hostId: 'host-1', hostLabel: 'pc', workspaceId: 'ws-r', name: 'r', panes: [] }] as never,
    });
    expect(act('layout.balance', { target: 'ws-r' })).toMatchObject({ code: 'not_owned' });
    expect(act('layout.balance', { callerWorkspaceId: 'ws-r' })).toMatchObject({ code: 'not_owned' });
  });

  it('a caller with no workspace is no_identity; a gone one not_found', () => {
    expect(act('layout.balance', { callerWorkspaceId: '' })).toMatchObject({ code: 'no_identity' });
    expect(act('layout.balance', { callerWorkspaceId: 'ws-gone' })).toMatchObject({ code: 'not_found' });
  });

  it('a cold-parked workspace still takes actions (parking only hides its view)', () => {
    useStore.setState({ parkedWorkspaceIds: { 'ws-a': true } });
    expect(act('workspace.rename', { args: { name: 'parked-ok' } })).toMatchObject({ ok: true });
  });
});

describe('workspace.rename', () => {
  it('renames the caller\'s workspace while another one is focused, and is idempotent', () => {
    expect(act('workspace.rename', { args: { name: 'api' } })).toMatchObject({ ok: true, changed: true });
    expect(ws('ws-a').name).toBe('api');
    expect(useStore.getState().activeWorkspaceId).toBe('ws-b');
    expect(act('workspace.rename', { args: { name: 'api' } })).toMatchObject({ ok: true, changed: false });
  });

  it('refuses a clashing or pane-tag-shaped name', () => {
    for (const name of ['beta', 'BETA ', 'w1-2', 'w​3-1 x']) {
      expect(act('workspace.rename', { args: { name } }), name).toMatchObject({ ok: false, code: 'invalid_args' });
    }
    expect(ws('ws-a').name).toBe('alpha');
  });

  it('the store refuses the same names for the UI, with a toast', () => {
    expect(useStore.getState().renameWorkspace('ws-a', 'beta')).toBe(false);
    expect(useStore.getState().renameWorkspace('ws-a', 'w4-1')).toBe(false);
    expect(useStore.getState().renameWorkspace('ws-a', 'x'.repeat(65))).toBe(false);
    expect(ws('ws-a').name).toBe('alpha');
    expect(useStore.getState().toasts).toHaveLength(3);
    expect(useStore.getState().renameWorkspace('ws-a', 'gamma')).toBe(true);
    expect(ws('ws-a').name).toBe('gamma');
  });
});

describe('tab.rename', () => {
  it('defaults to the caller\'s own tab', () => {
    expect(act('tab.rename', { args: { name: 'reviewer' } })).toMatchObject({ ok: true, surfaceId: 'surf-a1' });
    const s = (ws('ws-a').rootPane as PaneBranch).children[0] as PaneLeaf;
    expect(s.surfaces[0].userName).toBe('reviewer');
    expect(act('tab.rename', { args: { name: 'reviewer' } })).toMatchObject({ ok: true, changed: false });
  });

  it('refuses a name another tab or pane label has anywhere, or a pane-tag shape', () => {
    expect(act('tab.rename', { args: { name: 'Builder' } })).toMatchObject({ code: 'invalid_args' });
    useStore.setState({ paneLabel: { 'pane-a2': 'docs' } });
    expect(act('tab.rename', { args: { name: 'docs' } })).toMatchObject({ code: 'invalid_args' });
    expect(act('tab.rename', { args: { name: 'w1-1' } })).toMatchObject({ code: 'invalid_args' });
  });

  it('names another tab of the caller\'s workspace by #tag', () => {
    expect(act('tab.rename', { target: '#w1-2', args: { name: 'tests' } })).toMatchObject({ ok: true, surfaceId: 'surf-a2' });
  });

  it('without a pty of its own and no target, asks for one', () => {
    expect(act('tab.rename', { callerPtyId: undefined, args: { name: 'x' } })).toMatchObject({ code: 'invalid_args' });
  });
});

describe('layout', () => {
  it('layout.balance balances the caller\'s workspace, not the focused one', () => {
    expect(act('layout.balance')).toMatchObject({ ok: true, workspaceId: 'ws-a' });
    expect((ws('ws-a').rootPane as PaneBranch).sizes).toEqual([50, 50]);
  });

  it('pane.move sets the final position, and a second run changes nothing', () => {
    expect(act('pane.move', { args: { beside: '#w1-2', edge: 'right' } })).toMatchObject({ ok: true, changed: true });
    const root = ws('ws-a').rootPane as PaneBranch;
    expect(root.children.map((c) => c.id)).toEqual(['pane-a2', 'pane-a1']);
    expect(act('pane.move', { args: { beside: '#w1-2', edge: 'right' } })).toMatchObject({ ok: true, changed: false });
  });

  it('pane.move refuses a pane in another workspace or itself', () => {
    expect(act('pane.move', { args: { beside: 'pane-b1', edge: 'left' } })).toMatchObject({ code: 'not_owned' });
    expect(act('pane.move', { args: { beside: 'pane-a1', edge: 'left' } })).toMatchObject({ code: 'invalid_args' });
  });
});

describe('settings', () => {
  it('reads every setting, or one', () => {
    expect(act('settings.get')).toMatchObject({
      ok: true,
      settings: { theme: 'tint', 'terminal.fontSize': 14, 'terminal.fontFamily': 'Cascadia Code' },
    });
    expect(act('settings.get', { args: { key: 'theme' } })).toEqual({ ok: true, settings: { theme: 'tint' } });
  });

  it('sets a known theme, shows a toast, and is idempotent', () => {
    expect(act('settings.set', { args: { key: 'theme', value: 'zinc' } })).toMatchObject({ ok: true, changed: true });
    expect(useStore.getState().theme).toBe('zinc');
    expect(document.documentElement.getAttribute('data-theme')).toBe('zinc');
    expect(useStore.getState().toasts).toHaveLength(1);
    expect(act('settings.set', { args: { key: 'theme', value: 'zinc' } })).toMatchObject({ ok: true, changed: false });
    expect(useStore.getState().toasts).toHaveLength(1);
  });

  it('refuses an unknown theme and custom', () => {
    for (const value of ['custom', 'neon', '"><script>']) {
      expect(act('settings.set', { args: { key: 'theme', value } }), value).toMatchObject({ code: 'invalid_args' });
    }
    expect(useStore.getState().theme).toBe('tint');
    expect(useStore.getState().toasts).toHaveLength(0);
  });

  it('font size: inside the keyboard zoom range only', () => {
    expect(act('settings.set', { args: { key: 'terminal.fontSize', value: String(FONT_SIZE_MAX) } })).toMatchObject({ ok: true });
    expect(useStore.getState().terminalFontSize).toBe(FONT_SIZE_MAX);
    for (const value of [FONT_SIZE_MIN - 1, FONT_SIZE_MAX + 1, '13.5', 'big']) {
      expect(act('settings.set', { args: { key: 'terminal.fontSize', value } }), String(value)).toMatchObject({ code: 'invalid_args' });
    }
    expect(useStore.getState().terminalFontSize).toBe(FONT_SIZE_MAX);
  });

  it('font family goes through the sanitizer; locale must be supported', () => {
    expect(act('settings.set', { args: { key: 'terminal.fontFamily', value: 'JetBrains Mono;}' } })).toMatchObject({ ok: true });
    expect(useStore.getState().terminalFontFamily).toBe('JetBrains Mono');
    expect(act('settings.set', { args: { key: 'terminal.fontFamily', value: ';{}' } })).toMatchObject({ code: 'invalid_args' });
    expect(act('settings.set', { args: { key: 'locale', value: 'xx' } })).toMatchObject({ code: 'invalid_args' });
  });

  it('takes no target', () => {
    expect(act('settings.get', { target: 'ws-a' })).toMatchObject({ code: 'invalid_args' });
  });
});

describe('notifications', () => {
  it('marks read and clears the caller\'s workspace only', () => {
    expect(act('notifications.markRead')).toMatchObject({ ok: true, marked: 2 });
    const byId = () => Object.fromEntries(useStore.getState().notifications.map((n) => [n.id, n.read]));
    expect(byId()).toEqual({ n1: true, n2: true, n3: false });
    expect(useStore.getState().unreadBySurfaceId).toEqual({ 'surf-b1': 1 });
    expect(act('notifications.clear')).toMatchObject({ ok: true, cleared: 2 });
    expect(useStore.getState().notifications.map((n) => n.id)).toEqual(['n3']);
  });

  it('clearing unread notifications keeps the unread index in step', () => {
    expect(act('notifications.clear')).toMatchObject({ ok: true, cleared: 2 });
    expect(useStore.getState().unreadBySurfaceId).toEqual({ 'surf-b1': 1 });
  });
});

describe('refusals before the target', () => {
  it('an unknown action, or args that break the schema', () => {
    expect(act('workspace.delete')).toMatchObject({ code: 'unknown_action' });
    expect(act('workspace.rename', { args: { name: 'x', extra: 1 } })).toMatchObject({ code: 'invalid_args' });
  });
});
