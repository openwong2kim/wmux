// @vitest-environment jsdom
//
// Render tests for the pinned task-ledger panel — fake api injected, no store
// and no IPC. Covers the B-1 contract: rows come from the ledger summary, a
// zero-task deck renders nothing, and main's transition ping re-reads only for
// the workspace this deck is bound to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DeckLedgerPanel,
  LEDGER_PANEL_EXPANDED_KEY,
  LEDGER_PANEL_VISIBLE_ROWS,
  formatAge,
  readLedgerPanelExpanded,
  type DeckLedgerApi,
} from '../DeckLedgerPanel';
import type { DeckLedgerRow, DeckLedgerSummary } from '../../../../main/deck/deckLedgerSummary';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const row = (over: Partial<DeckLedgerRow> & { id: string }): DeckLedgerRow => ({
  title: `task ${over.id}`,
  status: 'working',
  taskWorkspaceId: `ws-${over.id}`,
  workerStatus: 'running',
  lastLine: null,
  updatedAt: 0,
  ageMs: 5_000,
  ...over,
});

const summary = (
  rows: DeckLedgerRow[],
  extra: Partial<DeckLedgerSummary> = {},
): DeckLedgerSummary => ({
  openCount: rows.length,
  rows,
  ts: 1,
  ...extra,
});

/** A promise plus the handle to settle it later — for the ordering tests. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

async function mount(api: DeckLedgerApi, props: Record<string, unknown> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(DeckLedgerPanel, { api, workspaceId: 'ws-owner', ...props }));
  });
}

describe('formatAge', () => {
  it('steps from seconds to minutes to hours', () => {
    expect(formatAge(5_000)).toBe('5s');
    expect(formatAge(90_000)).toBe('1m');
    expect(formatAge(3 * 60 * 60_000)).toBe('3h');
  });
});

describe('DeckLedgerPanel', () => {
  it('renders one row per open task with status, worker status, line and age', async () => {
    await mount({
      summary: async () =>
        summary([
          row({
            id: 'a',
            title: 'write DOGFOOD.md',
            status: 'review_requested',
            workerStatus: 'awaiting_input',
            lastLine: 'gate passed',
            ageMs: 65_000,
          }),
        ]),
    });
    const rows = container.querySelectorAll('[data-deck-ledger-row]');
    expect(rows).toHaveLength(1);
    expect(container.querySelector('[data-deck-ledger-count]')?.textContent).toContain('1');
    expect(rows[0].querySelector('[data-deck-ledger-title]')?.textContent).toBe('write DOGFOOD.md');
    expect(rows[0].querySelector('[data-deck-ledger-status]')?.textContent).toBe(
      'review_requested · awaiting_input',
    );
    expect(rows[0].querySelector('[data-deck-ledger-line]')?.textContent).toBe('gate passed');
    expect(rows[0].querySelector('[data-deck-ledger-age]')?.textContent).toBe('1m');
  });

  it('renders nothing when no task is open', async () => {
    await mount({ summary: async () => summary([]) });
    expect(container.querySelector('[data-deck-ledger-panel]')).toBeNull();
  });

  it('reports the open count so the deck can open its report rail', async () => {
    const seen: number[] = [];
    await mount({ summary: async () => summary([row({ id: 'a' })]) }, {
      onOpenCountChange: (n: number) => seen.push(n),
    });
    expect(seen).toEqual([1]);
  });

  // "Nothing is delegated" and "I cannot read the ledger" are opposite facts.
  // Collapsing the second into the first calls the deck idle at the exact
  // moment the Stop gate may be holding its turn on a ledger it cannot read.
  it('states that the ledger is unavailable instead of collapsing', async () => {
    await mount({ summary: async () => ({ openCount: 0, rows: [], ts: 1, error: true as const }) });
    expect(container.querySelector('[data-deck-ledger-panel]')).not.toBeNull();
    expect(container.querySelector('[data-deck-ledger-unavailable]')).not.toBeNull();
    expect(container.querySelector('[data-deck-ledger-count]')).toBeNull();
    expect(container.querySelectorAll('[data-deck-ledger-row]')).toHaveLength(0);
  });

  // Four things fire this read (mount, the fallback timer, main's ping, a
  // workspace change) and IPC replies are not ordered. Without a sequence
  // guard a slow reply for the workspace just left renders another deck's
  // tasks into this one.
  it('ignores a reply that a newer request has already superseded', async () => {
    const first = deferred<DeckLedgerSummary>();
    const second = deferred<DeckLedgerSummary>();
    const calls: string[] = [];
    const api: DeckLedgerApi = {
      summary: async (ws: string) => {
        calls.push(ws);
        return calls.length === 1 ? first.promise : second.promise;
      },
    };
    await mount(api, { workspaceId: 'ws-old' });
    // Switch decks: the effect cleanup invalidates the read still in flight.
    await act(async () => {
      root.render(createElement(DeckLedgerPanel, { api, workspaceId: 'ws-new' }));
    });
    expect(calls).toEqual(['ws-old', 'ws-new']);
    // The OLD workspace's reply lands last, and must write nothing.
    await act(async () => {
      second.resolve(summary([row({ id: 'new', title: 'new deck task' })]));
      first.resolve(summary([row({ id: 'old', title: 'old deck task' })]));
    });
    const titles = Array.from(
      container.querySelectorAll('[data-deck-ledger-title]'),
      (el) => el.textContent,
    );
    expect(titles).toEqual(['new deck task']);
  });

  it("re-reads on main's ping for this workspace and ignores another's", async () => {
    let notify: ((e: { workspaceId: string }) => void) | null = null;
    const summaryFn = vi.fn(async () => summary([row({ id: 'a' })]));
    await mount({
      summary: summaryFn,
      onChanged: (cb) => {
        notify = cb;
        return () => { notify = null; };
      },
    });
    expect(summaryFn).toHaveBeenCalledTimes(1);
    await act(async () => { notify?.({ workspaceId: 'ws-other' }); });
    expect(summaryFn).toHaveBeenCalledTimes(1);
    await act(async () => { notify?.({ workspaceId: 'ws-owner' }); });
    expect(summaryFn).toHaveBeenCalledTimes(2);
  });
});

// ─── The dot vocabulary, shared with every other task surface ───────────────
describe('DeckLedgerPanel status dots', () => {
  it('paints each row from the shared helper, not from the ledger status alone', async () => {
    await mount({
      summary: async () =>
        summary([
          row({ id: 'a', status: 'working', workerStatus: 'running' }),
          row({ id: 'b', status: 'working', workerStatus: 'idle' }),
          row({ id: 'c', status: 'input_required', workerStatus: 'running' }),
          row({ id: 'd', status: 'completed', workerStatus: 'idle' }),
        ]),
    });
    const tones = Array.from(
      container.querySelectorAll('[data-deck-ledger-dot]'),
      (el) => el.getAttribute('data-tone'),
    );
    expect(tones).toEqual(['running', 'idle', 'attention', 'ok']);
  });
});

// ─── The `#` jump the deleted sidebar rows carried ──────────────────────────
describe('DeckLedgerPanel channel jump', () => {
  it('opens the task channel from the row', async () => {
    const opened: string[] = [];
    await mount({ summary: async () => summary([row({ id: 'a' })]) }, {
      channelByTaskId: { a: 'chan-a' },
      onOpenChannel: (id: string) => opened.push(id),
    });
    const link = container.querySelector('[data-deck-ledger-channel]') as HTMLButtonElement;
    expect(link.getAttribute('data-channel-id')).toBe('chan-a');
    await act(async () => { link.click(); });
    expect(opened).toEqual(['chan-a']);
  });

  it('draws no link for a task with no known channel', async () => {
    await mount({ summary: async () => summary([row({ id: 'a' }), row({ id: 'b' })]) }, {
      channelByTaskId: { a: 'chan-a' },
      onOpenChannel: vi.fn(),
    });
    const links = container.querySelectorAll('[data-deck-ledger-channel]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('data-channel-id')).toBe('chan-a');
  });

  it('draws no link at all when the caller cannot open a channel', async () => {
    await mount({ summary: async () => summary([row({ id: 'a' })]) }, {
      channelByTaskId: { a: 'chan-a' },
    });
    expect(container.querySelector('[data-deck-ledger-channel]')).toBeNull();
  });
});

// ─── The panel must not push the conversation off the deck ──────────────────
describe('DeckLedgerPanel row cap', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ id: `t${i}`, title: `task ${i}` }));

  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* storage blocked */ }
  });

  it('shows at most five rows and offers the rest behind a toggle', async () => {
    await mount({ summary: async () => summary(many(8)) });
    expect(container.querySelectorAll('[data-deck-ledger-row]')).toHaveLength(
      LEDGER_PANEL_VISIBLE_ROWS,
    );
    const more = container.querySelector('[data-deck-ledger-more]') as HTMLButtonElement;
    expect(more.textContent).toContain('3');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    // The header count stays honest about the whole ledger.
    expect(container.querySelector('[data-deck-ledger-count]')?.textContent).toContain('8');
  });

  it('offers no toggle when everything already fits', async () => {
    await mount({ summary: async () => summary(many(LEDGER_PANEL_VISIBLE_ROWS)) });
    expect(container.querySelectorAll('[data-deck-ledger-row]')).toHaveLength(
      LEDGER_PANEL_VISIBLE_ROWS,
    );
    expect(container.querySelector('[data-deck-ledger-more]')).toBeNull();
  });

  it('expands to every row and remembers the choice', async () => {
    await mount({ summary: async () => summary(many(8)) });
    const more = container.querySelector('[data-deck-ledger-more]') as HTMLButtonElement;
    await act(async () => { more.click(); });
    expect(container.querySelectorAll('[data-deck-ledger-row]')).toHaveLength(8);
    expect(
      container.querySelector('[data-deck-ledger-more]')?.getAttribute('aria-expanded'),
    ).toBe('true');
    expect(window.localStorage.getItem(LEDGER_PANEL_EXPANDED_KEY)).toBe('1');
  });

  it('mounts expanded when that is how it was left', async () => {
    window.localStorage.setItem(LEDGER_PANEL_EXPANDED_KEY, '1');
    await mount({ summary: async () => summary(many(8)) });
    expect(container.querySelectorAll('[data-deck-ledger-row]')).toHaveLength(8);
  });

  it('mounts collapsed with nothing stored', async () => {
    expect(readLedgerPanelExpanded()).toBe(false);
    await mount({ summary: async () => summary(many(8)) });
    expect(container.querySelectorAll('[data-deck-ledger-row]')).toHaveLength(
      LEDGER_PANEL_VISIBLE_ROWS,
    );
  });
});

// ─── Every claim is one click from its evidence (DESIGN.md) ─────────────────
describe('DeckLedgerPanel row affordances', () => {
  it('jumps to the task workspace from the row title', async () => {
    const jumped: string[] = [];
    await mount({ summary: async () => summary([row({ id: 'a' })]) }, {
      onJumpToTaskWorkspace: (id: string) => jumped.push(id),
    });
    const title = container.querySelector('[data-deck-ledger-title]') as HTMLButtonElement;
    expect(title.tagName).toBe('BUTTON');
    expect(title.getAttribute('data-jump-workspace-id')).toBe('ws-a');
    await act(async () => { title.click(); });
    expect(jumped).toEqual(['ws-a']);
  });

  it('leaves the title as plain text when the caller cannot navigate', async () => {
    await mount({ summary: async () => summary([row({ id: 'a' })]) });
    expect(container.querySelector('[data-deck-ledger-title]')?.tagName).toBe('SPAN');
  });

  // The dot's colour was the only carrier of the status for a screen reader —
  // its title sat on an aria-hidden node, which reaches nobody.
  it('renders the dot meaning as text, not only as colour', async () => {
    await mount({ summary: async () => summary([row({ id: 'a', status: 'input_required' })]) }, {
      t: (key: string) => key,
    });
    const label = container.querySelector('[data-deck-ledger-dot-label]');
    expect(label?.textContent).toBe('taskStatus.needsYou');
    expect(label?.className).toContain('sr-only');
  });
});

// ─── The toggle must not imply a completeness the read does not have ────────
describe('DeckLedgerPanel row cap honesty', () => {
  const many = (n: number) =>
    Array.from({ length: n }, (_, i) => row({ id: `t${i}`, title: `task ${i}` }));

  beforeEach(() => {
    try { window.localStorage.clear(); } catch { /* storage blocked */ }
  });

  it('says what is on screen when the ledger read itself was capped', async () => {
    // 20 rows delivered (LEDGER_SUMMARY_ROW_CAP) out of 34 open tasks.
    await mount({ summary: async () => summary(many(20), { openCount: 34 }) });
    const more = container.querySelector('[data-deck-ledger-more]') as HTMLButtonElement;
    await act(async () => { more.click(); });
    const expandedToggle = container.querySelector('[data-deck-ledger-more]');
    expect(expandedToggle?.getAttribute('data-capped')).toBe('true');
    expect(expandedToggle?.textContent).toContain('20');
    expect(expandedToggle?.textContent).toContain('34');
    expect(expandedToggle?.textContent).not.toMatch(/Show less/i);
  });

  it('still says "Show less" when the list really is complete', async () => {
    await mount({ summary: async () => summary(many(8)) });
    const more = container.querySelector('[data-deck-ledger-more]') as HTMLButtonElement;
    await act(async () => { more.click(); });
    const expandedToggle = container.querySelector('[data-deck-ledger-more]');
    expect(expandedToggle?.getAttribute('data-capped')).toBeNull();
    expect(expandedToggle?.textContent).toMatch(/Show less/i);
  });
});

// ─── Finished tasks keep their channel entry point ──────────────────────────
//
// Closing a task used to take its mission channel out of reach the moment the
// sidebar's finished-tasks disclosure went away with the sidebar rows.
describe('DeckLedgerPanel finished disclosure', () => {
  const finished = summary([], {
    openCount: 0,
    finishedRows: [row({ id: 'f1', title: 'shipped', status: 'completed', workerStatus: null })],
    finishedCount: 1,
  });

  it('keeps the panel alive for a ledger with only finished tasks', async () => {
    await mount({ summary: async () => finished });
    expect(container.querySelector('[data-deck-ledger-panel]')).not.toBeNull();
    expect(container.querySelector('[data-deck-ledger-finished-toggle]')?.textContent).toContain('1');
    // Collapsed by default: it is history, not work.
    expect(container.querySelector('[data-deck-ledger-finished-rows]')).toBeNull();
  });

  it('lists the finished rows with their channel jump when opened', async () => {
    const opened: string[] = [];
    await mount({ summary: async () => finished }, {
      finishedExpanded: true,
      channelByTaskId: { f1: 'chan-f1' },
      onOpenChannel: (id: string) => opened.push(id),
    });
    const rows = container.querySelectorAll('[data-deck-ledger-finished-rows] [data-deck-ledger-row]');
    expect(rows).toHaveLength(1);
    // Green is reachable again — a completed task is the only row that has it.
    expect(rows[0].querySelector('[data-deck-ledger-dot]')?.getAttribute('data-tone')).toBe('ok');
    const link = rows[0].querySelector('[data-deck-ledger-channel]') as HTMLButtonElement;
    await act(async () => { link.click(); });
    expect(opened).toEqual(['chan-f1']);
  });

  it('reports the disclosure toggle to the caller', async () => {
    const seen: boolean[] = [];
    await mount({ summary: async () => finished }, {
      onToggleFinished: (v: boolean) => seen.push(v),
    });
    const toggle = container.querySelector('[data-deck-ledger-finished-toggle]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    expect(seen).toEqual([true]);
  });

  it('draws no disclosure when the ledger reported no finished half', async () => {
    await mount({ summary: async () => summary([row({ id: 'a' })]) });
    expect(container.querySelector('[data-deck-ledger-finished]')).toBeNull();
  });
});

// ─── The channel map is re-pulled on main's push, not 15 s later ────────────
describe('DeckLedgerPanel push callback', () => {
  it('tells the caller to re-pull only for this workspace', async () => {
    let notify: ((e: { workspaceId: string }) => void) | null = null;
    const pushes: number[] = [];
    await mount(
      {
        summary: async () => summary([row({ id: 'a' })]),
        onChanged: (cb) => { notify = cb; return () => { notify = null; }; },
      },
      { onLedgerPush: () => pushes.push(1) },
    );
    expect(pushes).toHaveLength(0);
    await act(async () => { notify?.({ workspaceId: 'ws-other' }); });
    expect(pushes).toHaveLength(0);
    await act(async () => { notify?.({ workspaceId: 'ws-owner' }); });
    expect(pushes).toHaveLength(1);
  });
});
