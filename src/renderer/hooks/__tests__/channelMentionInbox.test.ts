// ─── Tests for channel mention → a2a inbox routing (#7) ──────────────────
//
// Pure-function tests: routeChannelMentionToInbox takes injected deps, so we
// drive it with spies and assert the task shape + pointer emit + idempotency
// without a store or EventBus.

import { describe, it, expect } from 'vitest';
import {
  routeChannelMentionToInbox,
  channelMentionTaskId,
  type MentionInboxDeps,
} from '../channelMentionInbox';
import type { ChannelMessage } from '../../../shared/channels';
import type { Task } from '../../../shared/types';

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-1',
    seq: 5,
    workspaceId: 'ws-sender',
    memberId: 'm-1',
    memberName: 'Alice',
    text: 'hey @me check this',
    postedAt: 1_700_000_000_000,
    deliveryStatus: 'pending',
    mentions: [{ workspaceId: 'ws-me', name: 'me' }],
    ...overrides,
  };
}

type CreatedTask = Parameters<MentionInboxDeps['createA2aTask']>[0];
interface Published {
  from: string;
  to: string;
  taskId: string;
  state: string;
  kind: string;
}

function makeDeps(overrides: Partial<MentionInboxDeps> = {}): {
  deps: MentionInboxDeps;
  created: CreatedTask[];
  published: Published[];
} {
  const created: CreatedTask[] = [];
  const published: Published[] = [];
  const deps: MentionInboxDeps = {
    getTask: () => undefined,
    createA2aTask: (t) => {
      created.push(t);
      return t.id ?? 'task-x';
    },
    channelName: (id) => (id === 'ch-1' ? 'general' : id),
    workspaceName: (id) => (id === 'ws-me' ? 'My WS' : id),
    publish: (from, to, taskId, state, kind) => {
      published.push({ from, to, taskId, state, kind });
    },
    ...overrides,
  };
  return { deps, created, published };
}

describe('channelMentionTaskId', () => {
  it('is deterministic', () => {
    expect(channelMentionTaskId('ch-9', 42)).toBe('chmention-ch-9-42');
  });
});

describe('routeChannelMentionToInbox', () => {
  it('creates nothing when the message does not mention self', () => {
    const { deps, created, published } = makeDeps();
    const out = routeChannelMentionToInbox(
      makeMessage({ mentions: [{ workspaceId: 'ws-other', name: 'other' }] }),
      'ws-me',
      deps,
    );
    expect(out).toBeNull();
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('creates nothing when the message carries no mentions at all', () => {
    const { deps, created } = makeDeps();
    const out = routeChannelMentionToInbox(makeMessage({ mentions: undefined }), 'ws-me', deps);
    expect(out).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('mints an a2a task + emits the pointer on a self-mention', () => {
    const { deps, created, published } = makeDeps();
    const out = routeChannelMentionToInbox(makeMessage(), 'ws-me', deps);

    expect(out).toBe(channelMentionTaskId('ch-1', 5));
    expect(created).toHaveLength(1);
    const t = created[0];
    expect(t.id).toBe('chmention-ch-1-5');
    expect(t.from).toEqual({ workspaceId: 'ws-sender', name: 'Alice' });
    expect(t.to).toEqual({ workspaceId: 'ws-me', name: 'My WS' });
    expect(t.title).toContain('general');
    expect(t.history).toHaveLength(1);
    expect(t.history[0].role).toBe('user');
    expect(t.history[0].parts[0]).toEqual({ kind: 'text', text: 'hey @me check this' });

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      from: 'ws-sender',
      to: 'ws-me',
      taskId: 'chmention-ch-1-5',
      state: 'submitted',
      kind: 'created',
    });
  });

  it('does not ping yourself when you authored the post', () => {
    const { deps, created, published } = makeDeps();
    const out = routeChannelMentionToInbox(
      makeMessage({ workspaceId: 'ws-me', mentions: [{ workspaceId: 'ws-me', name: 'me' }] }),
      'ws-me',
      deps,
    );
    expect(out).toBeNull();
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('is idempotent — a re-delivered event does not double-create', () => {
    const existing = { kind: 'task', id: 'chmention-ch-1-5' } as Task;
    const { deps, created, published } = makeDeps({
      getTask: (id) => (id === 'chmention-ch-1-5' ? existing : undefined),
    });
    const out = routeChannelMentionToInbox(makeMessage(), 'ws-me', deps);
    expect(out).toBeNull();
    expect(created).toHaveLength(0);
    expect(published).toHaveLength(0);
  });

  it('returns null (no throw) when createA2aTask fails — never breaks dispatch', () => {
    const { deps, published } = makeDeps({
      createA2aTask: () => {
        throw new Error('boom');
      },
    });
    const out = routeChannelMentionToInbox(makeMessage(), 'ws-me', deps);
    expect(out).toBeNull();
    expect(published).toHaveLength(0);
  });
});
