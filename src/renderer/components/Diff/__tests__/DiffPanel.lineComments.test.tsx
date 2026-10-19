// @vitest-environment jsdom
//
// Line comments from the diff gutter: a task diff posts the line in its anchor;
// a workspace diff (no mission channel) collects comments into a review draft
// that is copied, or typed into the agent's input, as one note.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import DiffPanel, { type DiffPanelSource } from '../DiffPanel';
import { useStore } from '../../../stores';
import type { DiffReadResult } from '../../../../shared/diffParse';

const TASK_ID = 'wtask-1';
const CHANNEL_ID = 'chan-1';
const WS = 'ws-owner';

function readResult(body: string[] = [' ctx', '+added', '+more']): DiffReadResult {
  return {
    ok: true,
    files: [
      {
        path: 'a.txt',
        oldPath: 'a.txt',
        newPath: 'a.txt',
        kind: 'modify',
        hunkSelectable: true,
        headerBlock: 'diff --git a/a.txt b/a.txt\n',
        digest: 'd1',
        hunks: [
          {
            header: '@@ -1,2 +1,3 @@',
            oldStart: 1,
            oldLines: 2,
            newStart: 1,
            newLines: 3,
            section: '',
            bodyLines: body,
          },
        ],
      },
    ],
    numstat: [{ path: 'a.txt', additions: 2, deletions: 0 }],
    snapshot: { targetRepoPath: '/repo', targetBranch: 'main', targetHeadOid: 'oid', targetDirtyFiles: [] },
    truncated: [],
    unsupported: [],
  };
}

const invoke = vi.fn(async (method: string) => {
  switch (method) {
    case 'task.mission.list':
      return {
        ok: true,
        tasks: [{ id: TASK_ID, status: 'open', worktreePath: '/wt', branch: 'b', missionChannelId: CHANNEL_ID }],
      };
    case 'a2a.channel.get':
      return { ok: true, channel: { status: 'active' } };
    case 'a2a.channel.getMessages':
      return { ok: true, messages: [] };
    case 'a2a.channel.getMembers':
      return { ok: true, members: [{ workspaceId: 'ws-claude', memberId: 'claude', memberName: 'claude' }] };
    default:
      return { ok: true };
  }
});
const mutateChannelLocal = vi.fn(async () => ({ ok: true }));
const writeLaunch = vi.fn(async (): Promise<void> => undefined);
const read = vi.fn(async () => readResult());
const writeText = vi.fn(async () => undefined);

const mounted: Array<() => void> = [];

function render(source: DiffPanelSource) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<DiffPanel source={source} isActive surfaceId="s1" verifiedWorkspaceId={WS} />));
  mounted.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  return container;
}

async function flush(ticks = 14) {
  await act(async () => {
    for (let i = 0; i < ticks; i++) await Promise.resolve();
  });
}

function click(el: Element, init: MouseEventInit = {}) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }));
  });
}

function type(c: Element, value: string) {
  const input = c.querySelector<HTMLInputElement>('[data-testid="diff-comment-input"]')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const gutter = (c: Element, key: string) => c.querySelector(`[data-line-comment="${key}"]`)!;
const submit = (c: Element) => click(c.querySelector('[data-testid="diff-comment-submit"]')!);

beforeEach(() => {
  invoke.mockClear();
  mutateChannelLocal.mockClear();
  writeText.mockClear();
  writeLaunch.mockReset();
  writeLaunch.mockResolvedValue(undefined);
  read.mockReset();
  read.mockResolvedValue(readResult());
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { read, applyHunks: vi.fn() },
    rpc: { invoke, mutateChannelLocal },
    pty: { writeLaunch },
  };
  (window as unknown as { clipboardAPI: unknown }).clipboardAPI = { writeText };
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { clipboardAPI?: unknown }).clipboardAPI;
});

describe('DiffPanel — line comments', () => {
  it('a task diff posts the line range in the anchor (shift-click extends it)', async () => {
    const c = render({ kind: 'task', taskId: TASK_ID });
    await flush();
    click(gutter(c, 'new:2'));
    click(gutter(c, 'new:3'), { shiftKey: true });
    type(c, 'split this');
    submit(c);
    await flush();

    expect(mutateChannelLocal).toHaveBeenCalledWith(
      'a2a.channel.post',
      expect.objectContaining({
        text: '[diff: a.txt:2-3 @ @@ -1,2 +1,3 @@] split this',
        data: { kind: 'diff-comment', taskId: TASK_ID, file: 'a.txt', hunkHeader: '@@ -1,2 +1,3 @@', side: 'new', line: 2, endLine: 3 },
      }),
    );
  });

  it('a workspace diff collects comments into one review note, copied when no agent pane is found', async () => {
    const c = render({ kind: 'workspace', repoPath: '/repo' });
    await flush();
    click(gutter(c, 'new:2'));
    type(c, 'rename');
    submit(c);
    click(gutter(c, 'new:1'));
    type(c, 'keep');
    submit(c);

    // Drafts render under their lines; nothing is posted anywhere.
    expect(c.querySelectorAll('[data-diff-comment]')).toHaveLength(2);
    expect(mutateChannelLocal).not.toHaveBeenCalled();
    // No agent terminal beside this diff: Copy is the action, Send is not offered.
    expect(c.querySelector('[data-testid="diff-review-send"]')).toBeNull();
    click(c.querySelector('[data-testid="diff-review-copy"]')!);
    await flush();
    expect(writeText).toHaveBeenCalledWith(
      'Review comments on the uncommitted changes in /repo:\n\n1. a.txt:2 at "added"\n   rename\n2. a.txt:1 at "ctx"\n   keep\n',
    );
  });
});

describe('DiffPanel — workspace review delivery', () => {
  const seedAgentPane = () =>
    act(() =>
      useStore.setState({
        workspaces: [{
          id: 'ws-1',
          name: 'w',
          rootPane: {
            id: 'pane-1',
            type: 'leaf',
            activeSurfaceId: 's1',
            surfaces: [
              { id: 'term-1', ptyId: 'pty-1', title: 'claude', shell: '', cwd: '' },
              { id: 's1', ptyId: '', title: 'Diff', shell: '', cwd: '', surfaceType: 'diff', diffRepoPath: '/repo' },
            ],
          },
        }],
        surfaceAgent: { 'pty-1': { name: 'Claude Code', status: 'idle' } },
        agentAliveByPtyId: {},
        commandRunningByPtyId: {},
      } as never),
    );

  async function draftOne(c: Element) {
    click(gutter(c, 'new:2'));
    type(c, 'rename');
    submit(c);
    await flush();
  }

  it('keeps the draft when main refuses the write, and clears it once the line is typed', async () => {
    seedAgentPane();
    const c = render({ kind: 'workspace', repoPath: '/repo' });
    await flush();
    await draftOne(c);

    writeLaunch.mockRejectedValueOnce(new Error('PTY_WRITE_LAUNCH: the session is not live'));
    click(c.querySelector('[data-testid="diff-review-send"]')!);
    await flush();
    expect(writeLaunch).toHaveBeenCalledWith('pty-1', expect.stringContaining('a.txt:2 at "added": rename'), false);
    expect(c.querySelectorAll('[data-diff-comment]')).toHaveLength(1);

    click(c.querySelector('[data-testid="diff-review-send"]')!);
    await flush();
    expect(writeLaunch).toHaveBeenCalledTimes(2);
    expect(c.querySelectorAll('[data-diff-comment]')).toHaveLength(0);
  });

  it('closes an open composer when a reload changed the hunk body under the same header', async () => {
    const c = render({ kind: 'workspace', repoPath: '/repo' });
    await flush();
    click(gutter(c, 'new:2'));
    expect(c.querySelector('[data-testid="diff-comment-input"]')).not.toBeNull();

    read.mockResolvedValue(readResult([' ctx', '+other', '+more']));
    click([...c.querySelectorAll('button')].find((b) => b.textContent === 'Reload')!);
    await flush();
    expect(c.querySelector('[data-testid="diff-comment-input"]')).toBeNull();
  });
});
