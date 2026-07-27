import { describe, it, expect } from 'vitest';
import { t } from '../../../i18n';
import {
  foldToolRuns,
  formatToolRunLabel,
  toolCallState,
  MAX_LABEL_NAMES,
  type ToolRunRow,
} from '../foldToolRuns';
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';

let seq = 0;
function use(name: string, id = `use-${++seq}`): TurnEvent {
  return { id, kind: 'tool_use', toolUseId: id, name, argSummary: `${name} arg` };
}
function result(forId: string, ok = true, extra?: { diffLike?: boolean; bytes?: number }): TurnEvent {
  return {
    id: `res-${forId}`,
    kind: 'tool_result',
    toolUseId: forId,
    ok,
    bytes: extra?.bytes ?? 10,
    diffLike: extra?.diffLike,
  };
}
function prose(id: string): TurnEvent {
  return { id, kind: 'assistant_text', text: 'done' };
}

function pair(name: string, n: number): TurnEvent[] {
  const out: TurnEvent[] = [];
  for (let i = 0; i < n; i++) {
    const u = use(name);
    out.push(u, result(u.id));
  }
  return out;
}

describe('foldToolRuns', () => {
  it('returns one row per prose event when there are no tool calls', () => {
    const rows = foldToolRuns([prose('a'), prose('b')]);
    expect(rows.map((r) => r.kind)).toEqual(['event', 'event']);
  });

  it('folds a consecutive run into one row', () => {
    const rows = foldToolRuns([prose('a'), ...pair('Read', 3), prose('b')]);
    expect(rows.map((r) => r.kind)).toEqual(['event', 'tool_run', 'event']);
    const run = rows[1] as ToolRunRow;
    expect(run.callCount).toBe(3);
    expect(run.events).toHaveLength(6);
  });

  it('breaks the run on an interleaved prose event', () => {
    const rows = foldToolRuns([...pair('Read', 1), prose('mid'), ...pair('Edit', 1)]);
    expect(rows.map((r) => r.kind)).toEqual(['tool_run', 'event', 'tool_run']);
  });

  it('lifts a diff-shaped result out of the fold as its own chip row', () => {
    const u = use('Bash');
    const rows = foldToolRuns([u, result(u.id, true, { diffLike: true })]);
    expect(rows.map((r) => r.kind)).toEqual(['tool_run', 'diff']);
    // …and the diff row never becomes prose (no inline rendering path).
    expect(rows[1].kind === 'diff' && rows[1].event.diffLike).toBe(true);
  });

  it('reports the run as running until every call has a result', () => {
    const u1 = use('Read');
    const u2 = use('Read');
    const rows = foldToolRuns([u1, result(u1.id), u2]);
    const run = rows[0] as ToolRunRow;
    expect(run.running).toBe(true);
    expect(run.failed).toBe(false);
    expect(toolCallState(run, u1 as never)).toBe('ok');
    expect(toolCallState(run, u2 as never)).toBe('running');
  });

  it('reports failure when any folded result carries an error', () => {
    const u1 = use('Bash');
    const u2 = use('Read');
    const run = foldToolRuns([u1, result(u1.id, false), u2, result(u2.id)])[0] as ToolRunRow;
    expect(run.failed).toBe(true);
    expect(run.running).toBe(false);
    expect(toolCallState(run, u1 as never)).toBe('error');
  });
});

describe('formatToolRunLabel', () => {
  it('produces the plan label for 12 calls across three tools', () => {
    const run = foldToolRuns([
      ...pair('Read', 5),
      ...pair('Edit', 4),
      ...pair('Bash', 3),
    ])[0] as ToolRunRow;
    expect(run.callCount).toBe(12);
    expect(formatToolRunLabel(run, t)).toBe('12 tool calls (Read ×5 · Edit ×4 · Bash ×3)');
  });

  it('orders names most-used first regardless of first-seen order', () => {
    const run = foldToolRuns([...pair('Bash', 1), ...pair('Read', 4)])[0] as ToolRunRow;
    expect(formatToolRunLabel(run, t)).toBe('5 tool calls (Read ×4 · Bash)');
  });

  it('keeps first-seen order for equal counts (stable label across re-reads)', () => {
    const run = foldToolRuns([...pair('Edit', 2), ...pair('Read', 2)])[0] as ToolRunRow;
    expect(formatToolRunLabel(run, t)).toBe('4 tool calls (Edit ×2 · Read ×2)');
  });

  it('singularizes one call and omits a ×1 multiplier', () => {
    const run = foldToolRuns(pair('Read', 1))[0] as ToolRunRow;
    expect(formatToolRunLabel(run, t)).toBe('1 tool call (Read)');
  });

  it(`spells out at most ${MAX_LABEL_NAMES} names and summarizes the rest`, () => {
    const run = foldToolRuns([
      ...pair('Read', 4),
      ...pair('Edit', 3),
      ...pair('Bash', 2),
      ...pair('Grep', 1),
      ...pair('Glob', 1),
    ])[0] as ToolRunRow;
    expect(formatToolRunLabel(run, t)).toBe('11 tool calls (Read ×4 · Edit ×3 · Bash ×2 · +2 more)');
  });

  it('falls back to the count alone when the run has no tool_use events', () => {
    const run = foldToolRuns([result('orphan')])[0] as ToolRunRow;
    expect(run.callCount).toBe(0);
    expect(formatToolRunLabel(run, t)).toBe('0 tool calls');
  });
});
