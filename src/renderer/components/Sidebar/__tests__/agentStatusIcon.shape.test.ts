// Red is spent on two different statuses — "needs you" and "error" — so the
// hue cannot distinguish them. `shape` is the channel that does, and it is a
// contract the sidebar row and MiniSidebar both read.

import { describe, it, expect } from 'vitest';
import { AGENT_STATUS_ICON } from '../agentStatusIcon';
import { rowStatusMark } from '../AgentMarks';
import type { AgentStatus } from '../../../../shared/types';

const STATUSES = Object.keys(AGENT_STATUS_ICON) as AgentStatus[];

describe('AGENT_STATUS_ICON shape', () => {
  it('marks error as a cross', () => {
    expect(AGENT_STATUS_ICON.error.shape).toBe('cross');
  });

  it('leaves every other status a dot', () => {
    for (const status of STATUSES) {
      if (status === 'error') continue;
      expect(AGENT_STATUS_ICON[status].shape).toBe('dot');
    }
  });

  // The cross paints itself from `dotVar` too, so no status may lose it.
  it('keeps a dotVar on every status', () => {
    expect(STATUSES.length).toBeGreaterThan(0);
    for (const status of STATUSES) {
      expect(AGENT_STATUS_ICON[status].dotVar).toBeTruthy();
    }
  });
});

// #1481 — the sidebar row's mark tells status by shape.
describe('sidebar status mark mapping', () => {
  it('maps each status to its shape', () => {
    expect(rowStatusMark('running', false)).toBe('dot');
    expect(rowStatusMark('awaiting_input', false)).toBe('ring');
    expect(rowStatusMark('waiting', false)).toBe('ring');
    expect(rowStatusMark('error', false)).toBe('cross');
    expect(rowStatusMark('complete', false)).toBe('check');
    expect(rowStatusMark('idle', false)).toBe('none');
  });

  it('draws the unconfirmed ring whenever the running claim is unverifiable', () => {
    expect(rowStatusMark('running', true)).toBe('unconfirmed');
  });
});
