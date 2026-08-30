// @vitest-environment jsdom
//
// The per-hunk "comment" button called window.prompt, which Electron's renderer
// does not implement — the call throws, so this feature was dead in production
// (the same window.prompt bug #1073 fixed for "New profile…" and the ask flow,
// and which a comment at DiffPanel.tsx already documented while line 534 still
// reached for it). These pin the inline composer that replaced it: it opens
// instead of the native prompt, posts the typed comment to the mission channel,
// and cancels on Escape, with the IME-safe Enter guard.

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

// resolveTaskMeta / loadDiffComments / loadMissionRoster all go through rpc.invoke;
// the comment post goes through rpc.mutateChannelLocal. Mock exactly those.
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
const read = vi.fn(async () => readResult());

function installApi(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    diff: { read, applyHunks: vi.fn() },
    rpc: { invoke, mutateChannelLocal },
  };
}

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

let promptSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  invoke.mockClear();
  mutateChannelLocal.mockClear();
  read.mockClear();
  installApi();
  // Reaching for the native dialog is the bug — make it loud.
  promptSpy = vi.spyOn(window, 'prompt').mockImplementation(() => {
    throw new Error('prompt() is not available in the Electron renderer');
  });
});

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  promptSpy.mockRestore();
});

describe('DiffPanel — inline comment composer (replaces dead window.prompt)', () => {
  it('opens an inline input instead of calling window.prompt', async () => {
    const c = render();
    await flush();

    const openBtn = q(c, 'diff-comment-open');
    expect(openBtn).not.toBeNull();
    click(openBtn!);

    expect(q(c, 'diff-comment-input')).not.toBeNull();
    expect(promptSpy).not.toHaveBeenCalled();
  });

  it('posts the typed comment to the mission channel on submit, never via prompt', async () => {
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
        text: expect.stringContaining('please rework this'),
      }),
    );
    expect(promptSpy).not.toHaveBeenCalled();
    // The composer closes after a submit.
    expect(q(c, 'diff-comment-input')).toBeNull();
  });

  it('does not submit on Enter while an IME composition is closing', async () => {
    const c = render();
    await flush();
    click(q(c, 'diff-comment-open')!);
    const input = q<HTMLInputElement>(c, 'diff-comment-input')!;
    setInputValue(input, 'draft');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }));
    });
    await flush();
    expect(mutateChannelLocal).not.toHaveBeenCalled();

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(mutateChannelLocal).toHaveBeenCalled();
  });

  it('cancels the composer on Escape without posting', async () => {
    const c = render();
    await flush();
    click(q(c, 'diff-comment-open')!);
    const input = q<HTMLInputElement>(c, 'diff-comment-input')!;
    setInputValue(input, 'draft');

    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(q(c, 'diff-comment-input')).toBeNull();
    expect(mutateChannelLocal).not.toHaveBeenCalled();
  });
});
