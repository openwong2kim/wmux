// @vitest-environment jsdom
//
// The all-empty launch confirm, and the role select's width floor.
//
// Launching N tasks with no prompt at all is legitimate ("open me N worktrees
// and I'll type into them"), so it is confirmed rather than refused — but it is
// almost never what someone means once they have filled in titles and roles.
// What is pinned here is that the FIRST press asks and launches nothing, the
// second press launches, and typing a prompt withdraws the question.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import FanOutDialog from '../FanOutDialog';
import { useStore } from '../../../stores';

let container: HTMLDivElement;
let root: Root;
let start: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ toasts: [] });
  start = vi.fn(async () => ({ ok: true, tasks: [] }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { fanout: { start } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(createElement(FanOutDialog, { onClose: vi.fn(), workspaceId: 'ws-1' })));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const q = <T extends HTMLElement>(id: string): T | null => container.querySelector(`[data-testid="${id}"]`);

function click(id: string): void {
  act(() => {
    q<HTMLElement>(id)?.click();
  });
}

function typeInto(id: string, value: string): void {
  const el = q<HTMLTextAreaElement>(id) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function fillRepo(): void {
  const el = q<HTMLInputElement>('fanout-repo') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, '/repo');
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('FanOutDialog — launching with no prompt at all', () => {
  it('asks once, launches nothing, then launches on the second press', () => {
    fillRepo();
    expect(q('fanout-confirm-empty')).toBeNull();

    click('fanout-submit');
    expect(q('fanout-confirm-empty')).not.toBeNull();
    expect(start).not.toHaveBeenCalled();

    click('fanout-submit');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('withdraws the question as soon as a prompt exists', () => {
    fillRepo();
    click('fanout-submit');
    expect(q('fanout-confirm-empty')).not.toBeNull();

    typeInto('fanout-prompt', 'do the thing');
    expect(q('fanout-confirm-empty')).toBeNull();

    // …and with a prompt the first press launches, no confirm at all.
    click('fanout-submit');
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('never asks when a prompt was there from the start', () => {
    fillRepo();
    typeInto('fanout-prompt', 'do the thing');
    click('fanout-submit');
    expect(q('fanout-confirm-empty')).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('FanOutDialog — role select width', () => {
  it('gives the role select room for a bound label instead of truncating it', () => {
    const select = q<HTMLSelectElement>('fanout-role-0') as HTMLSelectElement;
    expect(select).not.toBeNull();
    // "Reviewer — claude" does not fit in the old 92px floor.
    expect(parseInt(select.style.minWidth, 10)).toBeGreaterThanOrEqual(132);
    // …and it is still capped, so it cannot squeeze the title field beside it.
    expect(parseInt(select.style.maxWidth, 10)).toBeLessThanOrEqual(180);
  });
});


// ── One toast per fan-out, not one per task ────────────────────────────────
// Eight tasks used to push eight near-identical "Task \"…\" ready" cards on top
// of the summary that had just been posted: the summary scrolled away before it
// could be read, and "open diff" became a race to click the right card.
describe('FanOutDialog — the launch report', () => {
  const readyTasks = (count: number) =>
    Array.from({ length: count }, (_, k) => ({
      ok: true,
      title: `task #${k + 1}`,
      taskId: `wtask-${k}`,
      workspaceId: `ws-child-${k}`,
    }));

  async function launchWith(tasks: unknown[]): Promise<void> {
    start.mockResolvedValue({ ok: true, tasks });
    fillRepo();
    typeInto('fanout-prompt', 'do the thing');
    await act(async () => {
      q<HTMLElement>('fanout-submit')?.click();
      await Promise.resolve();
    });
  }

  it('reports four ready tasks with one toast, not four', async () => {
    await launchWith(readyTasks(4));
    const toasts = useStore.getState().toasts;
    // One summary toast + one readiness toast. The count is the assertion: the
    // old code posted 1 + N.
    expect(toasts).toHaveLength(2);
    const ready = toasts[1];
    expect(ready?.message).toContain('4');
    expect(ready?.action).toBeDefined();
  });

  it('still names the single task when only one is ready', async () => {
    await launchWith(readyTasks(1));
    const toasts = useStore.getState().toasts;
    expect(toasts).toHaveLength(2);
    expect(toasts[1]?.message).toContain('task #1');
  });

  it('posts no readiness toast when nothing materialized', async () => {
    await launchWith([{ ok: true, title: 'unmaterialized', unmaterialized: true }]);
    // Just the summary — there is no diff to open.
    expect(useStore.getState().toasts).toHaveLength(1);
  });
});
