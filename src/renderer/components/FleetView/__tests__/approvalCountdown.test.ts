import { describe, it, expect } from 'vitest';
import type { InboxItem } from '../../../stores/selectors/approvalInbox';
import {
  AUTO_REJECT_GRACE_MS,
  AUTO_REJECT_LOG_CAP,
  appendAutoRejected,
  deadlineForItem,
  inboxItemLabel,
  isAutoRejection,
  remainingSeconds,
  type AutoRejectedEntry,
} from '../approvalCountdown';

const T0 = 1_700_000_000_000;

const a2a: InboxItem = {
  source: 'a2a',
  key: 'a2a:ap-1',
  approvalId: 'ap-1',
  taskId: 'task-1',
  messagePreview: 'run it',
  expiresAt: T0 + 30_000,
  senderWorkspaceId: 'ws-1',
  receiverWorkspaceId: 'ws-2',
  cwd: null,
};

const mcp: InboxItem = {
  source: 'mcp',
  key: 'mcp:p-1',
  promptId: 'p-1',
  clientName: 'some-plugin',
  declaredCapabilities: [],
  isCritical: false,
};

describe('deadlineForItem (C-3)', () => {
  it('uses the A2A row\'s own expiry', () => {
    expect(deadlineForItem(a2a)).toBe(T0 + 30_000);
  });

  it('renders no deadline for an MCP prompt until the record carries one', () => {
    expect(deadlineForItem(mcp)).toBeUndefined();
    expect(deadlineForItem(mcp, () => undefined)).toBeUndefined();
    expect(deadlineForItem(mcp, () => Number.NaN)).toBeUndefined();
    expect(deadlineForItem(mcp, () => T0 + 45_000)).toBe(T0 + 45_000);
  });
});

describe('remainingSeconds', () => {
  it('counts down and floors at zero', () => {
    expect(remainingSeconds(T0 + 30_000, T0)).toBe(30);
    expect(remainingSeconds(T0 + 1, T0)).toBe(1);
    expect(remainingSeconds(T0 - 5_000, T0)).toBe(0);
  });
});

// Review fix: "gone and past its deadline" alone mislabelled a row a human
// answered after a throttled timer or a machine sleep.
describe('isAutoRejection', () => {
  it('logs a row removed at, or just after, its deadline', () => {
    expect(isAutoRejection({ deadlineAt: T0, removedAt: T0 })).toBe(true);
    expect(isAutoRejection({ deadlineAt: T0, removedAt: T0 + AUTO_REJECT_GRACE_MS })).toBe(true);
  });

  it('does NOT log a row a human answered before the deadline', () => {
    expect(isAutoRejection({ deadlineAt: T0, removedAt: T0 - 1 })).toBe(false);
  });

  it('does NOT log a row removed long after the deadline — a throttled timer, not an expiry', () => {
    expect(isAutoRejection({ deadlineAt: T0, removedAt: T0 + AUTO_REJECT_GRACE_MS + 1 })).toBe(false);
    expect(isAutoRejection({ deadlineAt: T0, removedAt: T0 + 600_000 })).toBe(false);
  });

  it('says nothing about a row that never had a deadline', () => {
    expect(isAutoRejection({ removedAt: T0 })).toBe(false);
    expect(isAutoRejection({ deadlineAt: Number.NaN, removedAt: T0 })).toBe(false);
  });
});

describe('appendAutoRejected', () => {
  const entry: AutoRejectedEntry = { key: 'a2a:ap-1', label: 'task-1', at: T0 };

  it('prepends newest-first and is idempotent on key', () => {
    const once = appendAutoRejected([], entry);
    expect(once).toEqual([entry]);
    expect(appendAutoRejected(once, entry)).toBe(once);
    const second: AutoRejectedEntry = { key: 'mcp:p-1', label: 'plugin', at: T0 + 1 };
    expect(appendAutoRejected(once, second)[0]).toEqual(second);
  });

  it('caps the log', () => {
    let log: AutoRejectedEntry[] = [];
    for (let i = 0; i < AUTO_REJECT_LOG_CAP + 3; i++) {
      log = appendAutoRejected(log, { key: `mcp:p-${i}`, label: `plugin-${i}`, at: T0 + i });
    }
    expect(log).toHaveLength(AUTO_REJECT_LOG_CAP);
    expect(log[0].key).toBe(`mcp:p-${AUTO_REJECT_LOG_CAP + 2}`);
  });
});

describe('inboxItemLabel', () => {
  it('names the task for A2A and the plugin for MCP', () => {
    expect(inboxItemLabel(a2a)).toBe('task-1');
    expect(inboxItemLabel(mcp)).toBe('some-plugin');
  });
});
