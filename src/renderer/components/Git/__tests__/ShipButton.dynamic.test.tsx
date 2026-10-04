// @vitest-environment jsdom
//
// The ship button follows the branch: Commit (a message box), Push, Create PR
// (an editable title), Open PR; the menu holds the other valid steps; a
// blocked step is disabled with its reason.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ShipButton } from '../ShipButton';

type Status = {
  branch: string | null; detached: boolean; upstream: string | null; ahead: number; behind: number; dirty: number;
  defaultBranch: string | null; headSubject: string; pr: { state: 'open' | 'draft' | 'merged' | 'closed'; url: string } | null;
};
const base: Status = {
  branch: 'feat/x', detached: false, upstream: 'origin/feat/x', ahead: 0, behind: 0, dirty: 0,
  defaultBranch: 'main', headSubject: 'feat: add x', pr: null,
};

let container: HTMLDivElement;
let root: Root;
let status: Status;
const bridge = {
  shipStatus: vi.fn(async () => ({ ok: true, status })),
  shipCommit: vi.fn(async () => ({ ok: true })),
  shipPush: vi.fn(async () => ({ ok: true })),
  shipCreatePr: vi.fn(async () => ({ ok: true, url: 'https://github.com/o/r/pull/9' })),
};

beforeEach(() => {
  status = { ...base };
  for (const f of Object.values(bridge)) f.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = { github: bridge };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); }); };
const mount = async (over: Partial<Status> = {}, mergeActive = false) => {
  status = { ...base, ...over };
  act(() => root.render(createElement(ShipButton, { repoPath: '/r', mergeActive })));
  await flush();
};
const primary = () => container.querySelector('[data-git-ship-primary]') as HTMLButtonElement;

describe('ShipButton', () => {
  it('uncommitted changes → Commit, which asks for a message and commits it', async () => {
    await mount({ dirty: 2 });
    expect(primary().textContent).toBe('Commit');
    act(() => primary().click());
    const box = document.querySelector('[data-git-ship-text]') as HTMLTextAreaElement;
    expect(document.querySelector('[data-testid="git-ship-commit"]')?.textContent).toContain('2 changed file');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(box, 'fix: thing');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { (document.querySelector('[data-git-ship-submit]') as HTMLButtonElement).click(); });
    await flush();
    expect(bridge.shipCommit).toHaveBeenCalledWith('/r', 'fix: thing');
    expect(document.querySelector('[data-testid="git-ship-commit"]')).toBeNull();
    // The step is read again after it lands.
    expect(bridge.shipStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('committed, not pushed → Push', async () => {
    await mount({ ahead: 1 });
    expect(primary().textContent).toBe('Push');
    await act(async () => { primary().click(); });
    await flush();
    expect(bridge.shipPush).toHaveBeenCalledWith('/r');
  });

  it('pushed, no PR → Create PR with the last commit subject as an editable title, then opens it', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await mount();
      expect(primary().textContent).toBe('Create PR');
      act(() => primary().click());
      const input = document.querySelector('[data-git-ship-text]') as HTMLInputElement;
      expect(input.value).toBe('feat: add x');
      await act(async () => { (document.querySelector('[data-git-ship-submit]') as HTMLButtonElement).click(); });
      await flush();
      expect(bridge.shipCreatePr).toHaveBeenCalledWith('/r', 'feat: add x');
      expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/9', '_blank');
    } finally {
      open.mockRestore();
    }
  });

  it('a PR open → Open PR', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      await mount({ pr: { state: 'open', url: 'https://github.com/o/r/pull/3' } });
      expect(primary().textContent).toBe('Open PR');
      act(() => primary().click());
      expect(open).toHaveBeenCalledWith('https://github.com/o/r/pull/3', '_blank');
    } finally {
      open.mockRestore();
    }
  });

  it('the menu offers the other steps that can run, and Open PR stays beside the button', async () => {
    await mount({ dirty: 1, ahead: 1, pr: { state: 'open', url: 'https://github.com/o/r/pull/3' } });
    expect(primary().textContent).toBe('Commit');
    expect(container.querySelector('[data-git-open-pr]')).not.toBeNull();
    act(() => (container.querySelector('[data-git-ship-more]') as HTMLButtonElement).click());
    const items = [...container.querySelectorAll('[data-git-ship-item]')].map((b) => b.getAttribute('data-git-ship-item'));
    expect(items).toEqual(['push', 'openPr']);
  });

  it('a merge session or no upstream disables the step and says why', async () => {
    await mount({ dirty: 1 }, true);
    expect(primary().disabled).toBe(true);
    expect(container.querySelector('[data-git-ship-reason]')?.textContent).toBe('A merge session is running');
    act(() => root.unmount());
    root = createRoot(container);
    await mount({ ahead: 1, upstream: null });
    expect(primary().textContent).toBe('Push');
    expect(primary().disabled).toBe(true);
    expect(container.querySelector('[data-git-ship-reason]')?.textContent).toBe('No upstream branch to push to');
  });

  it('a failed push says so and keeps the step', async () => {
    bridge.shipPush.mockResolvedValueOnce({ ok: false, error: 'rejected' } as never);
    await mount({ ahead: 1 });
    await act(async () => { primary().click(); });
    await flush();
    expect(primary().textContent).toBe('Push');
  });
});
