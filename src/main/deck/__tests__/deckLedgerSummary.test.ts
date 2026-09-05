import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildDeckLedgerSummary,
  createLedgerPushCoalescer,
  freshSnapshotPanes,
  pickWorkerStatus,
  sanitizeLedgerLine,
  sanitizeLedgerTitle,
  EMPTY_LEDGER_SUMMARY,
  UNAVAILABLE_LEDGER_SUMMARY,
  LEDGER_PUSH_DEBOUNCE_MS,
  LEDGER_ROW_LINE_MAX,
  LEDGER_ROW_TITLE_MAX,
  LEDGER_SUMMARY_ROW_CAP,
} from '../deckLedgerSummary';
import { LEDGER_SCHEMA_VERSION, type LedgerEntry, type LedgerStatus } from '../../../shared/ledger';
import type { FleetSnapshot } from '../../../shared/workspaceMirror';

function entry(over: Partial<LedgerEntry> & { id: string }): LedgerEntry {
  return {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    taskWorkspaceId: `ws-${over.id}`,
    ownerWorkspaceId: 'owner-1',
    title: `task ${over.id}`,
    status: 'working' as LedgerStatus,
    rev: 1,
    updatedAt: 1_000,
    updatedBy: { kind: 'worker', workspaceId: `ws-${over.id}` },
    ...over,
  };
}

function snapshot(over: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    workspaceId: 'ws-a',
    ts: 10_000,
    panes: [{ ptyId: 'p1', agentName: null, agentStatus: 'running', isActivePane: true }],
    ...over,
  };
}

describe('sanitizeLedgerLine', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(sanitizeLedgerLine('gate\u0000 ran\n\n  green\t')).toBe('gate ran green');
  });

  it('returns null for absent or whitespace-only summaries', () => {
    expect(sanitizeLedgerLine(undefined)).toBeNull();
    expect(sanitizeLedgerLine('   \n ')).toBeNull();
  });

  it('truncates to the row cap with an ellipsis', () => {
    const line = sanitizeLedgerLine('x'.repeat(LEDGER_ROW_LINE_MAX + 50));
    expect(line).toHaveLength(LEDGER_ROW_LINE_MAX);
    expect(line?.endsWith('…')).toBe(true);
  });

  // A bidi override is a printable code point, so the C0 scrub misses it — and
  // in the DOM it reverses everything after it, letting a worker's own line
  // impersonate another task's row.
  it('strips bidi overrides and zero-width characters', () => {
    expect(sanitizeLedgerLine(`ok\u202E dessap\u200B`)).toBe('ok dessap');
  });

  // Slicing UTF-16 units splits a surrogate pair and leaves a lone half, which
  // renders as U+FFFD — a mangled glyph where the cap should have been clean.
  it('truncates by code point, never mid-surrogate', () => {
    const astral = String.fromCodePoint(0x1f600);
    const line = sanitizeLedgerLine(astral.repeat(LEDGER_ROW_LINE_MAX + 10));
    expect(line).not.toBeNull();
    expect(Array.from(line as string)).toHaveLength(LEDGER_ROW_LINE_MAX);
    expect(line).not.toContain('\uFFFD');
    expect(line?.endsWith('…')).toBe(true);
  });
});

describe('sanitizeLedgerTitle', () => {
  it('applies the same scrub as the line, at the title cap', () => {
    expect(sanitizeLedgerTitle(`ship\u202E\tit`)).toBe('ship it');
    const long = sanitizeLedgerTitle('t'.repeat(LEDGER_ROW_TITLE_MAX + 40));
    expect(long).toHaveLength(LEDGER_ROW_TITLE_MAX);
  });
});

describe('pickWorkerStatus', () => {
  it('is null when the mirror knows no pane', () => {
    expect(pickWorkerStatus([])).toBeNull();
  });

  it('prefers the pane that needs a human over a running one', () => {
    expect(
      pickWorkerStatus([{ agentStatus: 'running' }, { agentStatus: 'awaiting_input' }]),
    ).toBe('awaiting_input');
  });

  it('falls back to running when nothing is blocked', () => {
    expect(pickWorkerStatus([{ agentStatus: 'idle' }, { agentStatus: 'running' }])).toBe('running');
  });

  // 'waiting' means "turn ended, ready for the next instruction" — one finished
  // pane of a fan-out workspace must not hide the panes still doing the work.
  it('reports live work over a pane that already finished its turn', () => {
    expect(pickWorkerStatus([{ agentStatus: 'waiting' }, { agentStatus: 'running' }])).toBe(
      'running',
    );
    expect(pickWorkerStatus([{ agentStatus: 'waiting' }, { agentStatus: 'complete' }])).toBe(
      'waiting',
    );
    expect(pickWorkerStatus([{ agentStatus: 'error' }, { agentStatus: 'running' }])).toBe('error');
  });
});

describe('freshSnapshotPanes', () => {
  it('serves the panes of a snapshot inside the freshness window', () => {
    expect(freshSnapshotPanes(snapshot({ ts: 10_000 }), 12_000, 30_000)).toHaveLength(1);
  });

  // A closed or detached task workspace stops pushing: its last snapshot would
  // otherwise report a dead worker as `running` for the rest of the session.
  it('is null for a stale snapshot and for no snapshot at all', () => {
    expect(freshSnapshotPanes(snapshot({ ts: 10_000 }), 50_000, 30_000)).toBeNull();
    expect(freshSnapshotPanes(null, 1_000, 30_000)).toBeNull();
    expect(freshSnapshotPanes(undefined, 1_000, 30_000)).toBeNull();
  });
});

describe('buildDeckLedgerSummary', () => {
  it('projects rows newest-transition-first with worker status and age', () => {
    const summary = buildDeckLedgerSummary({
      entries: [
        entry({ id: 'a', updatedAt: 1_000, summary: 'first' }),
        entry({ id: 'b', updatedAt: 5_000, status: 'review_requested', summary: 'ready  for review' }),
      ],
      panesFor: (ws) => (ws === 'ws-b' ? [{ agentStatus: 'awaiting_input' }] : []),
      now: () => 6_000,
    });
    expect(summary.openCount).toBe(2);
    expect(summary.rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(summary.rows[0]).toMatchObject({
      status: 'review_requested',
      workerStatus: 'awaiting_input',
      lastLine: 'ready for review',
      ageMs: 1_000,
    });
    expect(summary.rows[1].workerStatus).toBeNull();
  });

  // The title is written by whoever created the task, so it is exactly as
  // untrusted as the summary line — it was reaching the DOM raw.
  it('sanitizes and caps the title, falling back to the id when nothing survives', () => {
    const summary = buildDeckLedgerSummary({
      entries: [
        entry({ id: 'a', title: `land\u202E\tthe PR` }),
        entry({ id: 'b', title: 'T'.repeat(LEDGER_ROW_TITLE_MAX + 30) }),
        entry({ id: 'c', title: `\u200B  ` }),
      ],
      panesFor: () => null,
      now: () => 2_000,
    });
    const byId = Object.fromEntries(summary.rows.map((r) => [r.id, r.title]));
    expect(byId.a).toBe('land the PR');
    expect(byId.b).toHaveLength(LEDGER_ROW_TITLE_MAX);
    expect(byId.c).toBe('c');
  });

  it('caps rendered rows but keeps the open count honest', () => {
    const entries = Array.from({ length: LEDGER_SUMMARY_ROW_CAP + 5 }, (_, i) =>
      entry({ id: `t${i}`, updatedAt: 1_000 + i }),
    );
    const summary = buildDeckLedgerSummary({ entries, panesFor: () => null, now: () => 2_000 });
    expect(summary.openCount).toBe(LEDGER_SUMMARY_ROW_CAP + 5);
    expect(summary.rows).toHaveLength(LEDGER_SUMMARY_ROW_CAP);
  });

  it('never reports a negative age when a writer clock ran ahead', () => {
    const summary = buildDeckLedgerSummary({
      entries: [entry({ id: 'a', updatedAt: 9_000 })],
      panesFor: () => null,
      now: () => 1_000,
    });
    expect(summary.rows[0].ageMs).toBe(0);
  });
});

// "Nothing is delegated" and "I cannot read the ledger" are opposite facts and
// must not share a shape: the panel renders one as nothing and the other as a
// stated failure.
describe('the unavailable summary', () => {
  it('is distinguishable from the empty one', () => {
    expect(EMPTY_LEDGER_SUMMARY.error).toBeUndefined();
    expect(UNAVAILABLE_LEDGER_SUMMARY.error).toBe(true);
    expect(UNAVAILABLE_LEDGER_SUMMARY.rows).toEqual([]);
    expect(UNAVAILABLE_LEDGER_SUMMARY.openCount).toBe(0);
  });
});

describe('createLedgerPushCoalescer', () => {
  afterEach(() => vi.useRealTimers());

  it('collapses a burst per owner and still fires once per owner', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const c = createLedgerPushCoalescer((ws) => seen.push(ws));
    c.notify('owner-a');
    c.notify('owner-a');
    c.notify('owner-b');
    c.notify('owner-a');
    vi.advanceTimersByTime(LEDGER_PUSH_DEBOUNCE_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen.sort()).toEqual(['owner-a', 'owner-b']);
  });

  it('fires again for a transition after the window closed', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const c = createLedgerPushCoalescer((ws) => seen.push(ws));
    c.notify('owner-a');
    vi.advanceTimersByTime(LEDGER_PUSH_DEBOUNCE_MS);
    c.notify('owner-a');
    vi.advanceTimersByTime(LEDGER_PUSH_DEBOUNCE_MS);
    expect(seen).toEqual(['owner-a', 'owner-a']);
  });

  it('drops pending pushes on dispose', () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const c = createLedgerPushCoalescer((ws) => seen.push(ws));
    c.notify('owner-a');
    c.dispose();
    vi.advanceTimersByTime(LEDGER_PUSH_DEBOUNCE_MS * 4);
    expect(seen).toEqual([]);
  });
});

// Closing a task used to take its mission channel out of reach: the sidebar's
// finished-tasks disclosure was the way back, and it went away with the
// sidebar rows. The panel's own disclosure reads this half of the summary.
describe('buildDeckLedgerSummary — the finished half', () => {
  it('splits terminal entries out of the open rows and counts each honestly', () => {
    const summary = buildDeckLedgerSummary({
      entries: [
        entry({ id: 'open-1', updatedAt: 1_000 }),
        entry({ id: 'done', updatedAt: 5_000, status: 'completed' }),
        entry({ id: 'failed', updatedAt: 4_000, status: 'failed' }),
        entry({ id: 'cancelled', updatedAt: 3_000, status: 'cancelled' }),
        entry({ id: 'review', updatedAt: 2_000, status: 'review_requested' }),
      ],
      panesFor: () => null,
      now: () => 6_000,
    });
    // review_requested is OPEN work — a worker handed it back, nobody closed it.
    expect(summary.openCount).toBe(2);
    expect(summary.rows.map((r) => r.id)).toEqual(['review', 'open-1']);
    expect(summary.finishedCount).toBe(3);
    expect(summary.finishedRows?.map((r) => r.id)).toEqual(['done', 'failed', 'cancelled']);
  });

  it('leaves both fields absent when the caller asked for open entries only', () => {
    const summary = buildDeckLedgerSummary({
      entries: [entry({ id: 'a', updatedAt: 1_000 })],
      panesFor: () => null,
      now: () => 2_000,
    });
    // Absent, not zero: "I did not ask" is not "nothing has finished".
    expect(summary.finishedRows).toBeUndefined();
    expect(summary.finishedCount).toBeUndefined();
  });

  it('caps the finished rows but keeps the finished count honest', () => {
    const entries = Array.from({ length: LEDGER_SUMMARY_ROW_CAP + 4 }, (_, i) =>
      entry({ id: `f${i}`, updatedAt: 1_000 + i, status: 'completed' }),
    );
    const summary = buildDeckLedgerSummary({ entries, panesFor: () => null, now: () => 9_000 });
    expect(summary.openCount).toBe(0);
    expect(summary.rows).toHaveLength(0);
    expect(summary.finishedCount).toBe(LEDGER_SUMMARY_ROW_CAP + 4);
    expect(summary.finishedRows).toHaveLength(LEDGER_SUMMARY_ROW_CAP);
  });
});
