// Chat View row model (plan PR-7) — pure, no React, no i18n side effects.
//
// A supervision lens must answer "what did this agent SAY", so machine
// evidence collapses: a run of consecutive tool_use / tool_result events folds
// into ONE line ("12 tool calls (Read ×5 · Edit ×4 · Bash ×3)") that expands on
// click. Two events break a run:
//
//   • any prose / meta event — the run belongs to the turn it sits in;
//   • a diff-shaped tool_result — a diff is the evidence an operator most
//     wants one click from (DESIGN.md "every claim is one click from its
//     evidence"), so it is lifted out of the fold as its own chip row and
//     never rendered inline.

import type {
  ToolResultEvent,
  ToolUseEvent,
  TurnEvent,
} from '../../../shared/transcript/turnEvents';

/** How many distinct tool names the folded label spells out before "+N more". */
export const MAX_LABEL_NAMES = 3;

export interface ToolRunRow {
  kind: 'tool_run';
  /** Stable key: the first event's id. */
  id: string;
  /** Every folded event, in transcript order. */
  events: (ToolUseEvent | ToolResultEvent)[];
  /** Number of tool_use events — what "N tool calls" counts. */
  callCount: number;
  /** [toolName, occurrences], most-used first, first-seen breaking ties. */
  counts: [string, number][];
  /** Any folded tool_result carried is_error → the line takes the error glyph. */
  failed: boolean;
  /** At least one tool_use has no matching tool_result yet → still running. */
  running: boolean;
}

export interface EventRow {
  kind: 'event';
  id: string;
  event: TurnEvent;
}

export interface DiffRow {
  kind: 'diff';
  id: string;
  event: ToolResultEvent;
}

export type ChatRowModel = EventRow | ToolRunRow | DiffRow;

function isToolEvent(ev: TurnEvent): ev is ToolUseEvent | ToolResultEvent {
  return ev.kind === 'tool_use' || ev.kind === 'tool_result';
}

function isDiffResult(ev: TurnEvent): ev is ToolResultEvent {
  return ev.kind === 'tool_result' && ev.diffLike === true;
}

function buildRun(events: (ToolUseEvent | ToolResultEvent)[]): ToolRunRow {
  const order: string[] = [];
  const tally = new Map<string, number>();
  const usedIds = new Set<string>();
  const resolvedIds = new Set<string>();
  let failed = false;

  for (const ev of events) {
    if (ev.kind === 'tool_use') {
      usedIds.add(ev.toolUseId);
      const prev = tally.get(ev.name);
      if (prev === undefined) order.push(ev.name);
      tally.set(ev.name, (prev ?? 0) + 1);
    } else {
      resolvedIds.add(ev.toolUseId);
      if (!ev.ok) failed = true;
    }
  }

  const counts: [string, number][] = order
    .map((name, i) => ({ name, n: tally.get(name) ?? 0, i }))
    // Most-used first; first-seen order breaks ties so the label is stable
    // across re-reads of the same transcript span.
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map(({ name, n }) => [name, n]);

  let running = false;
  for (const id of usedIds) {
    if (!resolvedIds.has(id)) {
      running = true;
      break;
    }
  }

  return {
    kind: 'tool_run',
    id: events[0].id,
    events,
    callCount: [...tally.values()].reduce((a, b) => a + b, 0),
    counts,
    failed,
    running,
  };
}

/** Group a transcript window into renderable rows. Pure; input untouched. */
export function foldToolRuns(events: readonly TurnEvent[]): ChatRowModel[] {
  const rows: ChatRowModel[] = [];
  let run: (ToolUseEvent | ToolResultEvent)[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    rows.push(buildRun(run));
    run = [];
  };

  for (const ev of events) {
    if (isDiffResult(ev)) {
      flush();
      rows.push({ kind: 'diff', id: ev.id, event: ev });
      continue;
    }
    if (isToolEvent(ev)) {
      run.push(ev);
      continue;
    }
    flush();
    rows.push({ kind: 'event', id: ev.id, event: ev });
  }
  flush();
  return rows;
}

/**
 * "12 tool calls (Read ×5 · Edit ×4 · Bash ×3)". The disclosure glyph is
 * chrome and belongs to ToolRunLine, not to this string.
 *
 * `t` is the app translator; every fragment is a locale key (en.ts only —
 * other locales are Partial<> with an `en` fallback).
 */
export function formatToolRunLabel(
  run: ToolRunRow,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const head = run.callCount === 1
    ? t('chat.toolRun')
    : t('chat.toolRuns', { count: run.callCount });
  if (run.counts.length === 0) return head;

  const shown = run.counts.slice(0, MAX_LABEL_NAMES);
  const parts = shown.map(([name, n]) => (n === 1 ? name : `${name} ×${n}`));
  const hidden = run.counts.length - shown.length;
  if (hidden > 0) parts.push(t('chat.toolRunMore', { count: hidden }));
  return `${head} (${parts.join(' · ')})`;
}

/** Per-call status glyph for the expanded run: ● running · ✓ ok · ✕ error. */
export function toolCallState(
  run: ToolRunRow,
  call: ToolUseEvent,
): 'running' | 'ok' | 'error' {
  const result = run.events.find(
    (e): e is ToolResultEvent => e.kind === 'tool_result' && e.toolUseId === call.toolUseId,
  );
  if (!result) return 'running';
  return result.ok ? 'ok' : 'error';
}
