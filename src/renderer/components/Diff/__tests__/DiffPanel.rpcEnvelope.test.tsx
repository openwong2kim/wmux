// @vitest-environment jsdom
//
// `electronAPI.rpc.invoke` resolves with the RPC protocol envelope
// `{ id, ok, result }` (the pipe RpcRouter's response), not the daemon reply
// itself. DiffPanel used to read `res.tasks` / `res.channel` / `res.messages` /
// `res.members` straight off that envelope, so a task-mode panel opened from
// the fan-out toast always showed "Task not found" and hunk adoption was
// unreachable. These tests mock `rpc.invoke` with the real envelope shape.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import DiffPanel from '../DiffPanel';
import type { DiffReadResult } from '../../../../shared/diffParse';

const TASK_ID = 'wtask-1';
const CHANNEL_ID = 'chan-1';
const WS = 'ws-owner';

function readResult(): DiffReadResult {
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
            bodyLines: [' ctx', '+added'],
          },
        ],
      },
    ],
    numstat: [{ path: 'a.txt', additions: 1, deletions: 0 }],
    snapshot: { targetRepoPath: '/wt', targetBranch: 'main', targetHeadOid: 'oid', targetDirtyFiles: [] },
    truncated: [],
    unsupported: [],
  };
}

/** What RpcRouter.dispatch actually returns to the renderer bridge. */
function envelope(result: Record<string, unknown>) {
  return { id: 'renderer-1', ok: true, result };
}

let channelStatus = 'active';
let members: Array<Record<string, string>> = [];

const invoke = vi.fn(async (method: string) => {
  switch (method) {
    case 'task.mission.list':
      return envelope({
        ok: true,
        verifiedWorkspaceId: WS,
        tasks: [{ id: TASK_ID, status: 'open', worktreePath: '/wt', branch: 'b', missionChannelId: CHANNEL_ID }],
      });
    case 'a2a.channel.get':
      return envelope({ ok: true, channel: { status: channelStatus } });
    case 'a2a.channel.getMessages':
      return envelope({
        ok: true,
        messages: [
          {
            text: '[diff: a.txt] looks good',
            memberName: 'alice',
            postedAt: 1000,
            data: { kind: 'diff-comment', taskId: TASK_ID, file: 'a.txt', hunkHeader: '@@ -1,2 +1,3 @@' },
          },
        ],
      });
    case 'a2a.channel.getMembers':
      return envelope({ ok: true, members });
    default:
      return envelope({ ok: true });
  }
});
const read = vi.fn(async () => readResult());
const mutateChannelLocal = vi.fn(async () => ({ ok: true }));

const mounted: Array<() => void> = [];

function render() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(
      <DiffPanel source={{ kind: 'task', taskId: TASK_ID }} isActive surfaceId="s1" verifiedWorkspaceId={WS} />,
    ),
  );
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

function q<T extends Element>(c: Element, id: string): T | null {
  return c.querySelector<T>(`[data-testid="${id}"]`);
}

function click(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** Type into a controlled input through React's onChange path. */
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  channelStatus = 'active';
  members = [];
  invoke.mockClear();
  read.mockClear();
  mutateChannelLocal.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { read, applyHunks: vi.fn() },
    rpc: { invoke, mutateChannelLocal },
  };
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('DiffPanel — unwraps the rpc.invoke envelope', () => {
  it('resolves the task from an enveloped task.mission.list and loads its diff', async () => {
    const c = render();
    await flush();

    expect(invoke).toHaveBeenCalledWith('task.mission.list', { verifiedWorkspaceId: WS });
    // The worktree path came out of `result.tasks` — resolveTaskMeta succeeded.
    expect(read).toHaveBeenCalledWith('/wt', undefined, 'task');
    expect(c.textContent).not.toContain('Task not found');
    // Enveloped getMessages feeds the inline comment list.
    expect(c.textContent).toContain('alice');
    // Enveloped a2a.channel.get with an active channel enables commenting.
    expect(q(c, 'diff-comment-open')).not.toBeNull();
  });

  it('honours an archived mission channel read from an enveloped a2a.channel.get', async () => {
    channelStatus = 'archived';
    const c = render();
    await flush();

    expect(read).toHaveBeenCalledWith('/wt', undefined, 'task');
    expect(q(c, 'diff-comment-open')).toBeNull();
  });

  it('mentions the mission agents read from an enveloped a2a.channel.getMembers', async () => {
    // Without the unwrap the roster comes back empty, the post carries no
    // mentions, and the task's agent is never woken for the comment.
    members = [
      { workspaceId: WS, memberId: 'owner', memberName: 'owner' },
      { workspaceId: 'ws-agent', memberId: 'claude', memberName: 'claude' },
    ];
    const c = render();
    await flush();
    click(q(c, 'diff-comment-open')!);
    setInputValue(q<HTMLInputElement>(c, 'diff-comment-input')!, 'please rework this');
    click(q(c, 'diff-comment-submit')!);
    await flush();

    expect(mutateChannelLocal).toHaveBeenCalledWith(
      'a2a.channel.post',
      expect.objectContaining({
        channelId: CHANNEL_ID,
        mentions: [expect.objectContaining({ workspaceId: 'ws-agent' })],
      }),
    );
  });
});
