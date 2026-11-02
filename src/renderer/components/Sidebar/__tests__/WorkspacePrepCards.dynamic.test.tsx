// @vitest-environment jsdom
//
// The sidebar's "Preparing" cards: progress with elapsed time against the
// limit, a failure with its last lines and Retry / Start anyway (only where an
// agent starts), and a skip or a gap that stays until dismissed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspacePrepCard } from '../../../../shared/workspacePrepCard';
import WorkspacePrepCards, { applyPrepCardEvent, clock, lingers } from '../WorkspacePrepCards';
import { prepCardToast } from '../../../../shared/workspacePrepCard';
import { useStore } from '../../../stores';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let emit: (card: WorkspacePrepCard) => void = () => undefined;
const decide = vi.fn(async () => ({ ok: true }));

const card = (over: Partial<WorkspacePrepCard> = {}): WorkspacePrepCard => ({
  id: 'c1', title: 'issue-12', startsAgent: true, status: 'running', phase: 'copying', copied: 0, missing: 0, refused: 0, updatedAt: 1, ...over,
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  decide.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    workspacePrep: {
      onCard: (cb: (c: WorkspacePrepCard) => void) => { emit = cb; return () => undefined; },
      list: async () => [],
      decide,
    },
  };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('card list rules', () => {
  it('keeps a skip, a gap or a suggestion after main closes it, drops a clean one', () => {
    expect(lingers(card({ status: 'skipped', reason: 'stale' }))).toBe(true);
    expect(lingers(card({ status: 'ready', missing: 1 }))).toBe(true);
    expect(lingers(card({ status: 'ready', suggestCopy: { cwd: '/repo', count: 1, root: '/repo' } }))).toBe(true);
    expect(lingers(card({ status: 'ready' }))).toBe(false);
    const open = applyPrepCardEvent([], card({ status: 'ready' }));
    expect(applyPrepCardEvent(open, card({ status: 'closed' }))).toEqual([]);
    const gap = applyPrepCardEvent([], card({ status: 'ready', missing: 1 }));
    expect(applyPrepCardEvent(gap, card({ status: 'closed' }))).toHaveLength(1);
    expect(applyPrepCardEvent(gap, card({ status: 'closed', gone: true }))).toEqual([]);
    // A failed card is never kept: its buttons answer a wait that is over.
    expect(lingers(card({ status: 'failed', suggestCopy: { cwd: '/repo', count: 1, root: '/repo' } }))).toBe(false);
    expect(clock(83_000)).toBe('1:23');
  });

  it('toasts a failure, a skip or a gap once, as it happens', () => {
    expect(prepCardToast('running', card({ status: 'failed' }))?.key).toBe('prepCard.toastFailed');
    expect(prepCardToast('failed', card({ status: 'failed', expired: true }))).toBeNull();
    expect(prepCardToast(undefined, card({ status: 'skipped', reason: 'stale' }))?.key).toBe('prepCard.toastSkipped');
    expect(prepCardToast('running', card({ status: 'ready', missing: 1 }))?.key).toBe('prepCard.toastGaps');
    expect(prepCardToast('running', card({ status: 'ready' }))).toBeNull();
  });
});

describe('WorkspacePrepCards', () => {
  it('shows elapsed time against the limit while the setup runs', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ phase: 'setup', copied: 2, setupStartedAt: Date.now() - 80_000, setupTimeoutMs: 300_000 })));
    const el = container.querySelector('[data-testid="workspace-prep-card"]') as HTMLElement;
    expect(el.textContent).toContain('2 files copied');
    expect(el.textContent).toMatch(/running setup… 1:2\d of 5:00/);
  });

  it('a failure shows its last lines and answers with Retry or Start anyway', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ status: 'failed', error: 'exited with code 1', outputTail: ['npm ERR! missing'] })));
    expect(container.querySelector('[data-testid="workspace-prep-tail"]')?.textContent).toBe('npm ERR! missing');
    const buttons = [...container.querySelectorAll('button')];
    act(() => buttons.find((b) => b.textContent === 'Start anyway')!.click());
    expect(decide).toHaveBeenCalledWith('c1', 'start');
    act(() => buttons.find((b) => b.textContent === 'Retry')!.click());
    expect(decide).toHaveBeenCalledWith('c1', 'retry');
  });

  it('a skip waiting for the one re-approval says so', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ status: 'skipped', reason: 'needs-review' })));
    expect(container.querySelector('[data-testid="workspace-prep-card"]')?.textContent).toContain('need one review');
  });

  it('a start that made the worktree offers Discard; once it stopped waiting, Discard or Keep', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ status: 'failed', canDiscard: true, error: 'x' })));
    const names = () => [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(names()).toEqual(['Retry', 'Start anyway', 'Discard']);
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Discard')!.click());
    expect(decide).toHaveBeenCalledWith('c1', 'discard');
    act(() => emit(card({ status: 'failed', canDiscard: true, expired: true, error: 'x' })));
    expect(names()).toEqual(['Discard', 'Keep']);
    expect(container.querySelector('[data-testid="workspace-prep-expired"]')).not.toBeNull();
  });

  it('a refused Discard names the folder and points to the task cleanup list', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ status: 'failed', canDiscard: true, discardRefused: '/wt/issue-12', error: 'x' })));
    expect(container.querySelector('[data-testid="workspace-prep-refused"]')?.textContent).toContain('/wt/issue-12');
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Retry', 'Start anyway', 'Open task cleanup list', 'Keep']);
    act(() => buttons.find((b) => b.textContent === 'Open task cleanup list')!.click());
    expect(useStore.getState().worktaskCleanupVisible).toBe(true);
  });

  it('dismissing a card kept for reading tells main to forget it', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ status: 'skipped', reason: 'stale' })));
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')!.click());
    expect(decide).toHaveBeenCalledWith('c1', 'dismiss');
    expect(container.querySelector('[data-testid="workspace-prep-card"]')).toBeNull();
  });

  it('offers no Start anyway where no agent starts', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ startsAgent: false, status: 'failed', error: 'x' })));
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Retry', 'Dismiss']);
  });

  it('the one-time suggestion opens New workspace setup for that folder', async () => {
    await act(async () => root.render(createElement(WorkspacePrepCards)));
    act(() => emit(card({ status: 'ready', suggestCopy: { cwd: '/repo', count: 1, root: '/repo' } })));
    act(() => emit(card({ status: 'closed', suggestCopy: { cwd: '/repo', count: 1, root: '/repo' } })));
    expect(container.querySelector('[data-testid="workspace-prep-suggest"]')).not.toBeNull();
    act(() => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Choose files…')!.click());
    expect(useStore.getState().prepDialogCwd).toBe('/repo');
    expect(container.querySelector('[data-testid="workspace-prep-card"]')).toBeNull();
  });
});
