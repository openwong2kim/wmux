import { describe, it, expect } from 'vitest';
import type { InboxItem } from '../../../stores/selectors/approvalInbox';
import {
  AUTO_REJECT_LOG_CAP,
  deadlineForItem,
  inboxItemLabel,
  reduceAutoRejected,
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

describe('reduceAutoRejected', () => {
  const tracked = [{ key: 'a2a:ap-1', label: 'task-1', deadlineAt: T0 }];

  it('logs a row that vanished after its deadline passed', () => {
    const out = reduceAutoRejected({
      previous: [],
      tracked,
      presentKeys: new Set<string>(),
      now: T0 + 1,
    });
    expect(out).toEqual([{ key: 'a2a:ap-1', label: 'task-1', at: T0 }]);
  });

  it('does NOT log a row a human answered before the deadline', () => {
    expect(
      reduceAutoRejected({ previous: [], tracked, presentKeys: new Set<string>(), now: T0 - 1_000 }),
    ).toEqual([]);
  });

  it('keeps a still-present row out of the log and is idempotent on key', () => {
    expect(
      reduceAutoRejected({ previous: [], tracked, presentKeys: new Set(['a2a:ap-1']), now: T0 + 1 }),
    ).toEqual([]);
    const once = reduceAutoRejected({ previous: [], tracked, presentKeys: new Set<string>(), now: T0 + 1 });
    const twice = reduceAutoRejected({ previous: once, tracked, presentKeys: new Set<string>(), now: T0 + 1 });
    expect(twice).toBe(once);
  });

  it('keeps the newest entries and caps the log', () => {
    const many = Array.from({ length: AUTO_REJECT_LOG_CAP + 3 }, (_, i) => ({
      key: `mcp:p-${i}`,
      label: `plugin-${i}`,
      deadlineAt: T0 + i,
    }));
    const previous: AutoRejectedEntry[] = [];
    const out = reduceAutoRejected({
      previous,
      tracked: many,
      presentKeys: new Set<string>(),
      now: T0 + 1_000,
    });
    expect(out).toHaveLength(AUTO_REJECT_LOG_CAP);
    expect(out[0].key).toBe(`mcp:p-${many.length - 1}`);
  });
});

describe('inboxItemLabel', () => {
  it('names the task for A2A and the plugin for MCP', () => {
    expect(inboxItemLabel(a2a)).toBe('task-1');
    expect(inboxItemLabel(mcp)).toBe('some-plugin');
  });
});
