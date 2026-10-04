// @vitest-environment jsdom
//
// "Who acts next" in the PR detail header: from the PR's most recently updated
// active work link; nothing when no work is linked. Re-read on a change.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { GitDetail } from '../GitDetail';
import { useStore } from '../../../stores';
import type { PrSummary } from '../../../../shared/prSurface';
import type { WorkLink } from '../../../../shared/workLink';

const pr: PrSummary = {
  number: 9, title: 'Fix', state: 'open', author: 'a', headRefName: 'fix', updatedAt: 'u',
  url: 'https://github.com/Acme/Widgets/pull/9', reviewDecision: '', checks: null, mergeable: '',
};
const link = (over: Partial<WorkLink>): WorkLink => ({
  id: 'l1', origin: 'pr', owner: { workspaceId: 'ws-1' }, state: 'running', decisionIds: [], createdAt: 1, updatedAt: 1,
  pr: { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 9 }, ...over,
});

let container: HTMLDivElement;
let root: Root;
let list: ReturnType<typeof vi.fn>;
let changed: (ids: string[]) => void;

beforeEach(() => {
  list = vi.fn(async () => [] as WorkLink[]);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    github: { prList: vi.fn(), prDetail: vi.fn(async () => ({ ok: true, detail: { number: 9, comments: [] } })) },
    workLinks: { list, get: vi.fn(), onChanged: vi.fn((cb: (ids: string[]) => void) => { changed = cb; return () => undefined; }) },
  };
  act(() => useStore.setState({ workspaces: [{ id: 'ws-1', name: 'Widgets WS' }] as never }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };
const render = () => act(() => root.render(createElement(GitDetail, { kind: 'pr', repoPath: '/r', repoLabel: 'r', pr })));
const slot = () => container.querySelector('[data-git-detail-slot]')!;

describe('who acts next', () => {
  it('reads the PR\'s active links and says you act next, and why', async () => {
    list.mockResolvedValue([link({ state: 'needs-you', reason: 'decision' })]);
    render();
    await flush();
    expect(list).toHaveBeenCalledWith({
      pr: { host: 'github.com', owner: 'Acme', repo: 'Widgets', number: 9 },
      states: ['queued', 'running', 'needs-you', 'blocked', 'review'],
    });
    expect(slot().textContent).toBe('Next: you · a decision');
  });

  it('names the agent (or workspace) doing the work, newest link first', async () => {
    list.mockResolvedValue([
      link({ id: 'old', state: 'needs-you', reason: 'decision', updatedAt: 1 }),
      link({ id: 'new', state: 'running', agent: 'codex', updatedAt: 5 }),
    ]);
    render();
    await flush();
    expect(slot().textContent).toBe('Next: Codex CLI · working');
    list.mockResolvedValue([link({ state: 'blocked', reason: 'ci-failing' })]);
    await act(async () => { changed(['l1']); });
    await flush();
    expect(slot().textContent).toBe('Next: Widgets WS · CI failing');
  });

  it('says nothing when no work is linked', async () => {
    render();
    await flush();
    expect(list).toHaveBeenCalled();
    expect(slot().textContent).toBe('');
    expect(slot().childElementCount).toBe(0);
  });
});
