// @vitest-environment jsdom
//
// Handing an issue or PR to an agent from the renderer: what a drop target
// accepts, the confirm popover (send with a note, cancel, Esc, the
// already-in-progress state, Start in a new worktree), the PR row's drag
// payload, and the rail's spring-loaded Workspaces button.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import HandoffPopover from '../HandoffPopover';
import { PrSection } from '../PrSection';
import SidebarNavigation, { SPRING_LOAD_MS } from '../../Sidebar/SidebarNavigation';
import WorkspaceItem from '../../Sidebar/WorkspaceItem';
import { handoffTargetForPty, isHandoffDrag, readHandoffDrop } from '../handoffDrag';
import { ISSUE_DRAG_TYPE, serializeIssueRef } from '../../../../shared/issueRef';
import { PR_DRAG_TYPE, parsePrDragRef, serializePrDragRef } from '../../../../shared/prDragRef';
import type { HandoffTarget } from '../../../../shared/gitHandoff';
import type { Workspace } from '../../../../shared/types';

const issue = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12, title: 'Crash on\nlaunch', url: 'https://github.com/Acme/Widgets/issues/12' };
const pr = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 7, title: 'feat: x', url: 'https://github.com/Acme/Widgets/pull/7' };
const target: HandoffTarget = { workspaceId: 'ws-a', paneId: 'p-a', surfaceId: 's-a', ptyId: 'pty-a', agentName: 'Claude Code', agentSlug: 'claude' };

const dt = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (k: string) => data[k] ?? '' });

let container: HTMLDivElement;
let root: Root;
let handoffSend: ReturnType<typeof vi.fn>;
let handoffStartWorktree: ReturnType<typeof vi.fn>;

beforeEach(() => {
  handoffSend = vi.fn(async () => ({ ok: true, linkId: 'l1', taskId: 't1', delivered: true }));
  handoffStartWorktree = vi.fn(async () => ({ ok: true, linkId: 'l2', workspaceId: 'ws-new', branch: 'issue-12-crash-on-launch' }));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    github: { handoffSend, handoffStartWorktree, prList: vi.fn(async () => ({ ok: true, prs: [] })), prDetail: vi.fn() },
    web: { status: vi.fn(async () => ({ running: false })) },
  };
  act(() => useStore.setState({
    workspaces: [{ id: 'ws-a', name: 'alpha', rootPane: { id: 'p-a', type: 'leaf', activeSurfaceId: 's-a', surfaces: [{ id: 's-a', ptyId: 'pty-a', title: 'a', shell: 'zsh', cwd: '/r', surfaceType: 'terminal' }] }, activePaneId: 'p-a' } as Workspace],
    gitHandoff: null, toasts: [], appRoute: 'git',
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector(sel) as T | null;
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('drop payload', () => {
  it('accepts an issue or a PR ref that matches its URL, nothing else', () => {
    expect(isHandoffDrag({ types: [ISSUE_DRAG_TYPE] } as never)).toBe(true);
    expect(isHandoffDrag({ types: [PR_DRAG_TYPE] } as never)).toBe(true);
    expect(isHandoffDrag({ types: ['text/plain', 'Files'] } as never)).toBe(false);
    expect(readHandoffDrop(dt({ [ISSUE_DRAG_TYPE]: serializeIssueRef(issue) }))).toMatchObject({ kind: 'issue', ref: { number: 12 } });
    expect(readHandoffDrop(dt({ [PR_DRAG_TYPE]: serializePrDragRef(pr) }))).toMatchObject({ kind: 'pr', ref: { number: 7 } });
    // A number that disagrees with the URL, a foreign host shape, or junk: refused.
    expect(readHandoffDrop(dt({ [PR_DRAG_TYPE]: JSON.stringify({ ...pr, number: 8 }) }))).toBeNull();
    expect(readHandoffDrop(dt({ [PR_DRAG_TYPE]: JSON.stringify({ ...pr, url: 'javascript:alert(1)' }) }))).toBeNull();
    expect(readHandoffDrop(dt({ [ISSUE_DRAG_TYPE]: '{not json' }))).toBeNull();
    expect(readHandoffDrop(dt({ 'text/plain': 'https://github.com/Acme/Widgets/issues/12' }))).toBeNull();
  });

  it('a dropped-on terminal becomes a target with its pane and agent', () => {
    const st = { ...useStore.getState(), surfaceAgent: { 'pty-a': { name: 'Claude Code', slug: 'claude' } } } as never;
    expect(handoffTargetForPty(st, 'pty-a')).toEqual(target);
    expect(handoffTargetForPty(st, 'pty-gone')).toBeNull();
  });
});

describe('confirm popover', () => {
  const open = (extra: Record<string, unknown> = {}) => {
    act(() => root.render(createElement(HandoffPopover)));
    act(() => useStore.getState().setGitHandoff({ item: { kind: 'issue', ref: issue }, target, ...extra } as never));
  };

  it('asks where it goes, then sends with the note and closes', async () => {
    open();
    expect(q('[data-handoff-question]')?.textContent).toBe('Send issue #12 to Claude Code in alpha?');
    // The title shows as one sanitized line.
    expect(q('.wmux-handoff-item')?.textContent).toBe('“Crash on launch”');
    const note = q<HTMLTextAreaElement>('[data-handoff-note]')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(note, 'look at the logs');
      note.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    await flush();
    expect(handoffSend).toHaveBeenCalledWith({ item: { kind: 'issue', ref: issue }, target, note: 'look at the logs', force: false });
    expect(useStore.getState().gitHandoff).toBeNull();
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Sent issue #12 to Claude Code in alpha.');
  });

  it('Cancel and Esc close without sending', () => {
    open();
    act(() => q<HTMLButtonElement>('[data-handoff-cancel]')!.click());
    expect(useStore.getState().gitHandoff).toBeNull();
    open();
    expect(q('[data-testid="git-handoff"]')).not.toBeNull();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(useStore.getState().gitHandoff).toBeNull();
    expect(handoffSend).not.toHaveBeenCalled();
  });

  it('already in progress: says where, and Send anyway sends with force', async () => {
    handoffSend.mockResolvedValueOnce({ ok: false, code: 'in-progress', inProgress: { linkId: 'l0', workspaceId: 'ws-a', state: 'running' } });
    open();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    await flush();
    expect(q('[data-handoff-in-progress]')?.textContent).toContain('Already in progress in alpha.');
    expect(useStore.getState().gitHandoff).not.toBeNull();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-anyway]')!.click(); });
    await flush();
    expect(handoffSend.mock.calls[1][0]).toMatchObject({ force: true });
    expect(useStore.getState().gitHandoff).toBeNull();
  });

  it('stored but not delivered warns with the reason', async () => {
    handoffSend.mockResolvedValueOnce({ ok: true, linkId: 'l1', delivered: false, note: 'Someone was typing.' });
    open();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    await flush();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({ level: 'warn' });
    expect(useStore.getState().toasts.at(-1)?.message).toContain('Someone was typing.');
  });

  it('Start in a new worktree runs from the repo\'s workspace; a PR has no such button', async () => {
    open({ repo: { repoPath: '/r', workspaceId: 'ws-a' } });
    await act(async () => { q<HTMLButtonElement>('[data-handoff-start]')!.click(); });
    await flush();
    expect(handoffStartWorktree).toHaveBeenCalledWith(expect.objectContaining({ item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws-a', agentCmd: expect.any(String) }));
    expect(useStore.getState().toasts.at(-1)?.message).toContain('issue-12-crash-on-launch');
    act(() => useStore.getState().setGitHandoff({ item: { kind: 'pr', ref: pr }, target, repo: { repoPath: '/r', workspaceId: 'ws-a' } } as never));
    expect(q('[data-handoff-start]')).toBeNull();
  });

  it('with no target it lists the agents to pick from, or says there are none', () => {
    act(() => root.render(createElement(HandoffPopover)));
    act(() => useStore.getState().setGitHandoff({ item: { kind: 'issue', ref: issue } } as never));
    expect(q('[data-handoff-none]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-handoff-send]')!.disabled).toBe(true);
  });
});

describe('drag sources and the rail', () => {
  it('a PR row drags as an application/x-wmux-pr ref', async () => {
    (window as unknown as { electronAPI: { github: { prList: unknown } } }).electronAPI.github.prList = vi.fn(async () => ({
      ok: true, prs: [{ number: 7, title: 'feat: x', state: 'open', author: 'a', headRefName: 'h', updatedAt: '2026-10-01T00:00:00Z', url: pr.url, reviewDecision: '', checks: null, mergeable: '' }],
    }));
    act(() => root.render(createElement(PrSection, { repoPath: '/r', shown: false, dragContext: { repoPath: '/r', workspaceId: 'ws-a' } })));
    await flush();
    const row = container.querySelector('[data-pr-row="7"] button') as HTMLButtonElement;
    expect(row.getAttribute('draggable')).toBe('true');
    const data = new Map<string, string>();
    const ev = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown };
    ev.dataTransfer = { setData: (k: string, v: string) => data.set(k, v), effectAllowed: 'all' };
    act(() => { row.dispatchEvent(ev); });
    expect([...data.keys()]).toEqual([PR_DRAG_TYPE]);
    expect(parsePrDragRef(data.get(PR_DRAG_TYPE)!)).toEqual(pr);
    expect(useStore.getState().gitDragContext).toEqual({ repoPath: '/r', workspaceId: 'ws-a' });
    act(() => { row.dispatchEvent(new Event('dragend', { bubbles: true })); });
    expect(useStore.getState().gitDragContext).toBeNull();
  });

  it('holding a hand-off drag over Workspaces opens it; leaving early does not', () => {
    vi.useFakeTimers();
    act(() => root.render(createElement(SidebarNavigation, { home: true })));
    const home = container.querySelector('[data-sidebar-nav="home"]') as HTMLButtonElement;
    const over = (types: string[]) => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      ev.dataTransfer = { types, dropEffect: 'move' };
      act(() => { home.dispatchEvent(ev); });
    };
    over(['Files']);
    act(() => { vi.advanceTimersByTime(SPRING_LOAD_MS + 50); });
    expect(useStore.getState().appRoute).toBe('git');
    over([ISSUE_DRAG_TYPE]);
    act(() => { home.dispatchEvent(new Event('dragleave', { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(SPRING_LOAD_MS + 50); });
    expect(useStore.getState().appRoute).toBe('git');
    over([ISSUE_DRAG_TYPE]);
    act(() => { vi.advanceTimersByTime(SPRING_LOAD_MS + 50); });
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('a workspace row takes a hand-off drop: highlighted while held, then the popover for that workspace', async () => {
    const noop = () => undefined;
    act(() => useStore.getState().setGitDragContext({ repoPath: '/r', workspaceId: 'ws-a' }));
    await act(async () => {
      root.render(createElement(WorkspaceItem, {
        workspaceId: 'ws-a', isActive: false, isMultiview: false, index: 0,
        onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop, onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
      }));
    });
    const row = container.querySelector('.sidebar-row') as HTMLElement;
    const data = { [ISSUE_DRAG_TYPE]: serializeIssueRef(issue) };
    const fire = (type: string) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown; clientX: number; clientY: number };
      ev.dataTransfer = { ...dt(data), dropEffect: 'none' };
      act(() => { row.dispatchEvent(ev); });
      return ev;
    };
    expect(fire('dragover').defaultPrevented).toBe(true);
    expect(row.getAttribute('data-handoff-over')).toBe('true');
    fire('drop');
    expect(row.getAttribute('data-handoff-over')).toBeNull();
    expect(useStore.getState().gitHandoff).toMatchObject({ item: { kind: 'issue', ref: { number: 12 } }, workspaceId: 'ws-a', repo: { repoPath: '/r', workspaceId: 'ws-a' } });
  });
});
