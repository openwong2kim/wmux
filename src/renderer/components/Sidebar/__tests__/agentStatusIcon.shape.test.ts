// Red is spent on two different statuses — "needs you" and "error" — so the
// hue cannot distinguish them. `shape` is the channel that does, and it is a
// contract the sidebar row and MiniSidebar both read.

import { describe, it, expect } from 'vitest';
import { AGENT_STATUS_ICON } from '../agentStatusIcon';
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
