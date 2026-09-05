// The one status vocabulary — every ledger status, and the worker states that
// modulate `working`. The point of the helper is that two surfaces cannot
// disagree, so the table below is the contract both of them are held to.

import { describe, expect, it } from 'vitest';
import {
  TASK_DOT_COLOR,
  missionLedgerStatus,
  taskStatusDot,
} from '../taskStatusDot';
import { LEDGER_STATUSES, type LedgerStatus } from '../../../../shared/ledger';
import type { AgentStatus } from '../../../../shared/types';

describe('taskStatusDot', () => {
  it('paints a running worker amber and an idle one gray — the same open task', () => {
    expect(taskStatusDot('working', 'running').tone).toBe('running');
    expect(taskStatusDot('working', 'idle').tone).toBe('idle');
    // The bug this replaces: the sidebar painted BOTH of these green because
    // the task was open.
    expect(taskStatusDot('working', 'running').color).not.toBe(TASK_DOT_COLOR.ok);
    expect(taskStatusDot('working', 'idle').color).not.toBe(TASK_DOT_COLOR.ok);
  });

  it('turns red when the worker needs somebody', () => {
    for (const s of ['awaiting_input', 'waiting', 'error'] as AgentStatus[]) {
      expect(taskStatusDot('working', s).tone).toBe('attention');
    }
  });

  it('is gray when nothing is known about the worker', () => {
    expect(taskStatusDot('working').tone).toBe('idle');
    expect(taskStatusDot('working', null).tone).toBe('idle');
  });

  it('reads input_required as red whatever the worker is doing', () => {
    expect(taskStatusDot('input_required', 'running').tone).toBe('attention');
    expect(taskStatusDot('input_required', null).tone).toBe('attention');
  });

  it('reads review_requested as amber — it needs the brain, it is not done', () => {
    const dot = taskStatusDot('review_requested', 'idle');
    expect(dot.tone).toBe('running');
    expect(dot.labelKey).toBe('taskStatus.review');
  });

  it('lets a terminal ledger status win over a leftover pane', () => {
    expect(taskStatusDot('completed', 'running').tone).toBe('ok');
    expect(taskStatusDot('failed', 'running').tone).toBe('idle');
    expect(taskStatusDot('cancelled', 'awaiting_input').tone).toBe('idle');
  });

  it('gives failed and cancelled their own labels on the shared muted tone', () => {
    expect(taskStatusDot('failed').labelKey).toBe('taskStatus.failed');
    expect(taskStatusDot('cancelled').labelKey).toBe('taskStatus.cancelled');
  });

  it('answers for every ledger status with one of the four DESIGN.md colours', () => {
    const allowed = new Set(Object.values(TASK_DOT_COLOR));
    expect(allowed.size).toBe(4);
    for (const status of LEDGER_STATUSES as readonly LedgerStatus[]) {
      const dot = taskStatusDot(status);
      expect(allowed.has(dot.color)).toBe(true);
      expect(dot.color).toBe(TASK_DOT_COLOR[dot.tone]);
      expect(dot.labelKey.startsWith('taskStatus.')).toBe(true);
    }
  });
});

describe('missionLedgerStatus', () => {
  it('maps the sidebar WorkTask lifecycle onto the ledger vocabulary', () => {
    expect(missionLedgerStatus('open')).toBe('working');
    expect(missionLedgerStatus('closed')).toBe('completed');
  });

  it('makes an open mission with an idle worker gray, not green', () => {
    expect(taskStatusDot(missionLedgerStatus('open'), 'idle').tone).toBe('idle');
    expect(taskStatusDot(missionLedgerStatus('closed')).tone).toBe('ok');
  });
});
