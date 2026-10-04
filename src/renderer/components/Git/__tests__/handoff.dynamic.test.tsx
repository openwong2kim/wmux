// @vitest-environment jsdom
//
// Handing an issue or PR to an agent from the renderer: what a drop target
// accepts (only a drag that began on a Git page row of the same repo), the
// confirm popover (send with a note, cancel, Esc, the already-in-progress
// state, Start in a new worktree, a modal layer that gives focus back), the
// row drag payloads, and the rail's spring-loaded Workspaces button.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import HandoffPopover from '../HandoffPopover';
import { PrSection } from '../PrSection';
import SidebarNavigation, { SPRING_LOAD_MS } from '../../Sidebar/SidebarNavigation';
import WorkspaceItem from '../../Sidebar/WorkspaceItem';
import { allHandoffTargets, beginHandoffDrag, handoffTargetForPty, isHandoffDrag, isOurHandoffDrag, readHandoffDrop, takeHandoffDrop } from '../handoffDrag';
import { repoOwnerWorkspace } from '../repoGroups';
import { ISSUE_DRAG_TYPE, serializeIssueRef } from '../../../../shared/issueRef';
import { PR_DRAG_TYPE, parsePrDragRef, serializePrDragRef } from '../../../../shared/prDragRef';
import type { HandoffTarget } from '../../../../shared/gitHandoff';
import type { Workspace } from '../../../../shared/types';

const issue = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 12, title: 'Crash on\nlaunch', url: 'https://github.com/Acme/Widgets/issues/12' };
const pr = { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 7, title: 'feat: x', url: 'https://github.com/Acme/Widgets/pull/7' };
const target: HandoffTarget = { workspaceId: 'ws-a', paneId: 'p-a', surfaceId: 's-a', ptyId: 'pty-a', agentName: 'Claude Code', agentSlug: 'claude' };
const fromRow = { repoPath: '/r', workspaceId: 'ws-a', owner: 'Acme', repo: 'Widgets' };

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
    gitHandoff: null, gitDragContext: null, toasts: [], appRoute: 'git',
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
  it('reads an issue or PR ref that matches its URL, on github.com only', () => {
    expect(isHandoffDrag({ types: [ISSUE_DRAG_TYPE] } as never)).toBe(true);
    expect(isHandoffDrag({ types: [PR_DRAG_TYPE] } as never)).toBe(true);
    expect(isHandoffDrag({ types: ['text/plain', 'Files'] } as never)).toBe(false);
    expect(readHandoffDrop(dt({ [ISSUE_DRAG_TYPE]: serializeIssueRef(issue) }))).toMatchObject({ kind: 'issue', ref: { number: 12 } });
    expect(readHandoffDrop(dt({ [PR_DRAG_TYPE]: serializePrDragRef(pr) }))).toMatchObject({ kind: 'pr', ref: { number: 7 } });
    expect(readHandoffDrop(dt({ [PR_DRAG_TYPE]: JSON.stringify({ ...pr, number: 8 }) }))).toBeNull();
    expect(readHandoffDrop(dt({ [PR_DRAG_TYPE]: JSON.stringify({ ...pr, url: 'javascript:alert(1)' }) }))).toBeNull();
    expect(readHandoffDrop(dt({ [ISSUE_DRAG_TYPE]: '{not json' }))).toBeNull();
    expect(readHandoffDrop(dt({ 'text/plain': 'https://github.com/Acme/Widgets/issues/12' }))).toBeNull();
    const elsewhere = { ...issue, host: 'git.example.com', url: 'https://git.example.com/Acme/Widgets/issues/12' };
    expect(readHandoffDrop(dt({ [ISSUE_DRAG_TYPE]: serializeIssueRef(elsewhere) }))).toBeNull();
  });

  it('a drop is taken only when its drag began on a Git page row of the same repo, and only once', () => {
    const data = dt({ [ISSUE_DRAG_TYPE]: serializeIssueRef(issue) });
    // A drag from anywhere else (a forged payload): no context, nothing taken.
    expect(isOurHandoffDrag(data)).toBe(false);
    expect(takeHandoffDrop(data)).toBeNull();
    // From a row of another repo: refused, and the context is used up.
    act(() => beginHandoffDrag({ ...fromRow, repo: 'Other' }));
    expect(isOurHandoffDrag(data)).toBe(true);
    expect(takeHandoffDrop(data)).toBeNull();
    expect(useStore.getState().gitDragContext).toBeNull();
    // From this repo's row (case aside): taken once.
    act(() => beginHandoffDrag({ ...fromRow, owner: 'acme' }));
    expect(takeHandoffDrop(data)).toMatchObject({ item: { kind: 'issue' }, repo: { repoPath: '/r', workspaceId: 'ws-a' } });
    expect(takeHandoffDrop(data)).toBeNull();
  });

  it('the drag context is forgotten when the drag ends anywhere, even with its row gone', async () => {
    vi.useFakeTimers();
    act(() => beginHandoffDrag(fromRow));
    act(() => { window.dispatchEvent(new Event('dragend')); });
    expect(useStore.getState().gitDragContext).toBeNull();
    // On a drop the target reads it first; it is cleared a tick later.
    act(() => beginHandoffDrag(fromRow));
    act(() => { window.dispatchEvent(new Event('drop')); });
    expect(useStore.getState().gitDragContext).not.toBeNull();
    act(() => { vi.advanceTimersByTime(1); });
    expect(useStore.getState().gitDragContext).toBeNull();
    // A cancelled drag whose row unmounted: the next press clears it.
    act(() => beginHandoffDrag(fromRow));
    act(() => { window.dispatchEvent(new Event('pointerdown')); });
    expect(useStore.getState().gitDragContext).toBeNull();
  });

  it('a dropped-on terminal becomes a target with its pane and agent', () => {
    const st = { ...useStore.getState(), surfaceAgent: { 'pty-a': { name: 'Claude Code', slug: 'claude' } } } as never;
    expect(handoffTargetForPty(st, 'pty-a')).toEqual(target);
    expect(handoffTargetForPty(st, 'pty-gone')).toBeNull();
  });

  it('an agent idle at its first prompt is a target; a pane whose agent is known gone is a plain terminal', () => {
    const base = useStore.getState();
    const idle = { ...base, surfaceAgent: { 'pty-a': { name: 'Claude Code', status: 'idle', slug: 'claude' } } } as never;
    expect(handoffTargetForPty(idle, 'pty-a')).toEqual(target);
    expect(allHandoffTargets(idle)).toEqual([target]);
    const gone = { ...base, surfaceAgent: { 'pty-a': { name: 'Claude Code', status: 'idle', slug: 'claude' } }, agentAliveByPtyId: { 'pty-a': false } } as never;
    expect(handoffTargetForPty(gone, 'pty-a')).toEqual({ ...target, agentName: '', agentSlug: undefined });
    expect(allHandoffTargets(gone)).toEqual([]);
  });

  it('All repos: a group\'s hand-offs belong to its own workspace, the active one only when it is in that repo', () => {
    const group = { checkouts: [{ mainPath: '/b', label: 'b', workspaces: [{ workspaceId: 'ws-b1', name: 'b1', pr: null, repoPath: '/b' }, { workspaceId: 'ws-b2', name: 'b2', pr: null, repoPath: '/b' }] }] };
    expect(repoOwnerWorkspace(group, 'ws-a')).toBe('ws-b1');
    expect(repoOwnerWorkspace(group, 'ws-b2')).toBe('ws-b2');
    expect(repoOwnerWorkspace({ checkouts: [] }, 'ws-a')).toBeUndefined();
  });
});

describe('confirm popover', () => {
  const open = (extra: Record<string, unknown> = {}) => {
    act(() => root.render(createElement(HandoffPopover)));
    act(() => useStore.getState().setGitHandoff({ item: { kind: 'issue', ref: issue }, target, ...extra } as never));
  };

  it('asks where it goes, naming the repo, then sends with the note and closes', async () => {
    open();
    expect(q('[data-handoff-question]')?.textContent).toBe('Send issue Acme/Widgets#12 to Claude Code in alpha?');
    expect(q('[data-testid="git-handoff"]')?.getAttribute('aria-modal')).toBe('true');
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
    expect(useStore.getState().toasts.at(-1)?.message).toBe('Sent issue Acme/Widgets#12 to Claude Code in alpha.');
  });

  it('Cancel and Esc close without sending, and focus goes back where it was', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    open();
    expect(document.activeElement).toBe(q('[data-handoff-note]'));
    act(() => q<HTMLButtonElement>('[data-handoff-cancel]')!.click());
    expect(useStore.getState().gitHandoff).toBeNull();
    expect(document.activeElement).toBe(opener);
    open();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(useStore.getState().gitHandoff).toBeNull();
    expect(handoffSend).not.toHaveBeenCalled();
    opener.remove();
  });

  it('already in progress: says where, Send anyway is held while busy, then sends with force', async () => {
    handoffSend.mockResolvedValueOnce({ ok: false, code: 'in-progress', inProgress: { linkId: 'l0', workspaceId: 'ws-a', state: 'running' } });
    open();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    await flush();
    expect(q('[data-handoff-in-progress]')?.textContent).toContain('Already in progress in alpha.');
    let release!: (v: unknown) => void;
    handoffSend.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await act(async () => { q<HTMLButtonElement>('[data-handoff-anyway]')!.click(); });
    expect(q<HTMLButtonElement>('[data-handoff-anyway]')!.disabled).toBe(true);
    expect(handoffSend.mock.calls[1][0]).toMatchObject({ force: true });
    await act(async () => { release({ ok: true, linkId: 'l1', delivered: true }); });
    await flush();
    expect(useStore.getState().gitHandoff).toBeNull();
  });

  it('an answer for a hand-off that was replaced meanwhile closes nothing', async () => {
    let release!: (v: unknown) => void;
    handoffSend.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    open();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    const newer = { item: { kind: 'pr', ref: pr }, target };
    act(() => useStore.getState().setGitHandoff(newer as never));
    await act(async () => { release({ ok: true, linkId: 'l1', delivered: true }); });
    await flush();
    expect(useStore.getState().gitHandoff).toBe(newer);
    expect(useStore.getState().toasts).toEqual([]);
  });

  it('not delivered: says it did not send, and why in a word of its own (else the delivery\'s hint)', async () => {
    handoffSend.mockResolvedValueOnce({ ok: true, linkId: 'l1', delivered: false, note: 'a long generic hint', reason: 'agent_changed' });
    open();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    await flush();
    expect(useStore.getState().toasts.at(-1)).toMatchObject({
      level: 'warn', message: 'Did not send issue Acme/Widgets#12 to Claude Code in alpha. The agent left that pane or was replaced.',
    });
    handoffSend.mockResolvedValueOnce({ ok: true, linkId: 'l1', delivered: false, note: 'Someone was typing.', reason: 'something_new' });
    open();
    await act(async () => { q<HTMLButtonElement>('[data-handoff-send]')!.click(); });
    await flush();
    expect(useStore.getState().toasts.at(-1)?.message).toContain('Someone was typing.');
  });

  it('Start in a new worktree runs from the repo\'s owning workspace; without one, or for a PR, there is no such button', async () => {
    open({ repo: { repoPath: '/r', workspaceId: 'ws-a' } });
    await act(async () => { q<HTMLButtonElement>('[data-handoff-start]')!.click(); });
    await flush();
    expect(handoffStartWorktree).toHaveBeenCalledWith(expect.objectContaining({ item: { kind: 'issue', ref: issue }, repoPath: '/r', workspaceId: 'ws-a' }));
    expect(useStore.getState().toasts.at(-1)?.message).toContain('issue-12-crash-on-launch');
    act(() => useStore.getState().setGitHandoff({ item: { kind: 'issue', ref: issue }, target, repo: { repoPath: '/r' } } as never));
    expect(q('[data-handoff-start]')).toBeNull();
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
  it('a PR row drags as an application/x-wmux-pr ref and registers where it came from', async () => {
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
    expect(useStore.getState().gitDragContext).toEqual({ repoPath: '/r', workspaceId: 'ws-a', owner: 'Acme', repo: 'Widgets' });
    act(() => { window.dispatchEvent(new Event('dragend')); });
    expect(useStore.getState().gitDragContext).toBeNull();
  });

  it('holding a Git page drag over Workspaces opens it; leaving early, or a foreign drag, does not', () => {
    vi.useFakeTimers();
    act(() => root.render(createElement(SidebarNavigation, { home: true })));
    const home = container.querySelector('[data-sidebar-nav="home"]') as HTMLButtonElement;
    const over = (types: string[]) => {
      const ev = new Event('dragover', { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      ev.dataTransfer = { types, dropEffect: 'move' };
      act(() => { home.dispatchEvent(ev); });
    };
    // Our type, but not started on a Git page row.
    over([ISSUE_DRAG_TYPE]);
    act(() => { vi.advanceTimersByTime(SPRING_LOAD_MS + 50); });
    expect(useStore.getState().appRoute).toBe('git');
    act(() => useStore.getState().setGitDragContext(fromRow));
    over([ISSUE_DRAG_TYPE]);
    act(() => { home.dispatchEvent(new Event('dragleave', { bubbles: true })); });
    act(() => { vi.advanceTimersByTime(SPRING_LOAD_MS + 50); });
    expect(useStore.getState().appRoute).toBe('git');
    over([ISSUE_DRAG_TYPE]);
    act(() => { vi.advanceTimersByTime(SPRING_LOAD_MS + 50); });
    expect(useStore.getState().appRoute).toBe('workspaces');
  });

  it('a workspace row takes a Git page drop: highlighted while held, then the popover for that workspace; a forged drop opens nothing', async () => {
    const noop = () => undefined;
    await act(async () => {
      root.render(createElement(WorkspaceItem, {
        workspaceId: 'ws-a', isActive: false, isMultiview: false, index: 0,
        onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop, onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
      }));
    });
    const row = container.querySelector('.sidebar-row') as HTMLElement;
    const data = { [ISSUE_DRAG_TYPE]: serializeIssueRef(issue) };
    const fire = (type: string) => {
      const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
      ev.dataTransfer = { ...dt(data), dropEffect: 'none' };
      act(() => { row.dispatchEvent(ev); });
      return ev;
    };
    // Forged: our type, no drag from a Git page row.
    expect(fire('dragover').defaultPrevented).toBe(false);
    fire('drop');
    expect(useStore.getState().gitHandoff).toBeNull();
    act(() => beginHandoffDrag(fromRow));
    expect(fire('dragover').defaultPrevented).toBe(true);
    expect(row.getAttribute('data-handoff-over')).toBe('true');
    fire('drop');
    expect(row.getAttribute('data-handoff-over')).toBeNull();
    expect(useStore.getState().gitHandoff).toMatchObject({ item: { kind: 'issue', ref: { number: 12 } }, workspaceId: 'ws-a', repo: { repoPath: '/r', workspaceId: 'ws-a' } });
    expect(useStore.getState().gitDragContext).toBeNull();
  });
});
