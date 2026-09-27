// 2026-09-27 — task-group fold keys per requesting pane: prune and migrate.
import { describe, expect, it } from 'vitest';
import { ORPHAN_GROUP_KEY, pruneTaskGroupExpanded } from '../sidebarLayout';

describe('pruneTaskGroupExpanded', () => {
  const live = new Set(['w1', 'w2']);
  const panesOf = (id: string) => (id === 'w1' ? ['p1', 'p2'] : id === 'w2' ? ['q1'] : []);

  it('keeps live pane, closed-pane and orphan keys; drops dead owners, dead panes and bad values', () => {
    expect(pruneTaskGroupExpanded({
      [ORPHAN_GROUP_KEY]: true,
      'pane:w1:p1': false,
      'pane:w1:gone': true,
      'pane:dead:p1': true,
      'closedPane:w2': true,
      'closedPane:dead': false,
      'pane:w2:q1': 'yes',
      dead: true,
    }, live, panesOf)).toEqual({ [ORPHAN_GROUP_KEY]: true, 'pane:w1:p1': false, 'closedPane:w2': true });
  });

  it('migrates a pre-2026-09-27 owner key once onto its panes and closed-pane group, never over a set key', () => {
    const out = pruneTaskGroupExpanded({ w1: false, 'pane:w1:p2': true }, live, panesOf);
    expect(out).toEqual({ 'closedPane:w1': false, 'pane:w1:p1': false, 'pane:w1:p2': true });
    // Idempotent: a second load changes nothing.
    expect(pruneTaskGroupExpanded(out, live, panesOf)).toEqual(out);
  });
});
