// @vitest-environment jsdom
//
// Render tests for the pinned task-ledger panel — fake api injected, no store
// and no IPC. Covers the B-1 contract: rows come from the ledger summary, a
// zero-task deck renders nothing, and main's transition ping re-reads only for
// the workspace this deck is bound to.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DeckLedgerPanel, formatAge, type DeckLedgerApi } from '../DeckLedgerPanel';
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

const summary = (rows: DeckLedgerRow[]): DeckLedgerSummary => ({
  openCount: rows.length,
  rows,
  ts: 1,
});

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
