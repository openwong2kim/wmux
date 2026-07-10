import { describe, it, expect } from 'vitest';
import type { Channel, ChannelMention, ChannelMessage } from '../../../../shared/channels';
import { HUMAN_WORKSPACE_ID } from '../../../../shared/channels';
import { panePrincipalId } from '../../../../shared/principals';
import {
  COMMANDER_CHANNEL_NAME,
  findCommanderChannel,
  fanoutInviteMembers,
  groupCommanderThreads,
} from '../commanderThread';

// ─── fixtures ────────────────────────────────────────────────────────────────

function msg(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-cmd',
    seq: 1,
    workspaceId: HUMAN_WORKSPACE_ID,
    memberId: 'local-ui',
    memberName: 'local-ui',
    text: 'hi',
    postedAt: 1_700_000_000_000,
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-cmd',
    companyId: 'co-default',
    name: COMMANDER_CHANNEL_NAME,
    visibility: 'private',
    status: 'active',
    createdAt: 1,
    createdBy: 'local-ui',
    nextSeq: 1,
    ...overrides,
  };
}

// ─── findCommanderChannel ─────────────────────────────────────────────────────

describe('findCommanderChannel', () => {
  it('returns the active #commander channel', () => {
    const c = channel({ id: 'ch-1' });
    const other = channel({ id: 'ch-2', name: 'general' });
    expect(findCommanderChannel({ 'ch-1': c, 'ch-2': other })?.id).toBe('ch-1');
  });

  it('returns null when no commander channel exists', () => {
    expect(findCommanderChannel({ 'ch-2': channel({ id: 'ch-2', name: 'general' }) })).toBeNull();
  });

  it('prefers an active commander channel over an archived one', () => {
    const archived = channel({ id: 'ch-old', status: 'archived' });
    const active = channel({ id: 'ch-new', status: 'active' });
    expect(findCommanderChannel({ 'ch-old': archived, 'ch-new': active })?.id).toBe('ch-new');
  });

  it('falls back to an archived commander channel when no active one exists', () => {
    const archived = channel({ id: 'ch-old', status: 'archived' });
    expect(findCommanderChannel({ 'ch-old': archived })?.id).toBe('ch-old');
  });
});

// ─── groupCommanderThreads ────────────────────────────────────────────────────

describe('groupCommanderThreads', () => {
  it('groups each human dispatch with the replies that follow it', () => {
    const messages: ChannelMessage[] = [
      msg({ seq: 1, workspaceId: HUMAN_WORKSPACE_ID, text: 'do X' }),
      msg({ seq: 2, workspaceId: 'ws-a', memberId: 'w1-1(claude)', text: 'X done' }),
      msg({ seq: 3, workspaceId: 'ws-b', memberId: 'w2-1(codex)', text: 'X here too' }),
      msg({ seq: 4, workspaceId: HUMAN_WORKSPACE_ID, text: 'now Y' }),
      msg({ seq: 5, workspaceId: 'ws-a', memberId: 'w1-1(claude)', text: 'Y done' }),
    ];
    const threads = groupCommanderThreads(messages, HUMAN_WORKSPACE_ID);
    expect(threads).toHaveLength(2);
    expect(threads[0].dispatch?.seq).toBe(1);
    expect(threads[0].replies.map((r) => r.seq)).toEqual([2, 3]);
    expect(threads[1].dispatch?.seq).toBe(4);
    expect(threads[1].replies.map((r) => r.seq)).toEqual([5]);
  });

  it('sorts by seq before grouping (store order is not trusted)', () => {
    const messages: ChannelMessage[] = [
      msg({ seq: 3, workspaceId: 'ws-a', text: 'reply' }),
      msg({ seq: 1, workspaceId: HUMAN_WORKSPACE_ID, text: 'dispatch' }),
      msg({ seq: 2, workspaceId: 'ws-b', text: 'reply2' }),
    ];
    const threads = groupCommanderThreads(messages, HUMAN_WORKSPACE_ID);
    expect(threads).toHaveLength(1);
    expect(threads[0].dispatch?.seq).toBe(1);
    expect(threads[0].replies.map((r) => r.seq)).toEqual([2, 3]);
  });

  it('opens a dispatch-less group for replies that precede the first dispatch', () => {
    const messages: ChannelMessage[] = [
      msg({ seq: 1, workspaceId: 'ws-a', text: 'orphan reply' }),
      msg({ seq: 2, workspaceId: HUMAN_WORKSPACE_ID, text: 'dispatch' }),
    ];
    const threads = groupCommanderThreads(messages, HUMAN_WORKSPACE_ID);
    expect(threads).toHaveLength(2);
    expect(threads[0].dispatch).toBeNull();
    expect(threads[0].replies.map((r) => r.seq)).toEqual([1]);
    expect(threads[1].dispatch?.seq).toBe(2);
  });

  it('returns an empty array for no messages', () => {
    expect(groupCommanderThreads([], HUMAN_WORKSPACE_ID)).toEqual([]);
  });
});

// ─── fanoutInviteMembers ──────────────────────────────────────────────────────

describe('fanoutInviteMembers', () => {
  it('produces one member per unique non-human workspace with a pane-pinned coordinate', () => {
    const mentions: ChannelMention[] = [
      { workspaceId: 'ws-a', paneId: 'pane-1', ptyId: 'pty-1', name: 'w1-1(claude)' },
      { workspaceId: 'ws-b', paneId: 'pane-2', ptyId: 'pty-2', name: 'w2-1(codex)' },
    ];
    const members = fanoutInviteMembers(mentions, HUMAN_WORKSPACE_ID);
    expect(members).toEqual([
      {
        workspaceId: 'ws-a',
        memberId: 'w1-1(claude)',
        memberName: 'w1-1(claude)',
        principalId: panePrincipalId('ws-a', 'pane-1'),
      },
      {
        workspaceId: 'ws-b',
        memberId: 'w2-1(codex)',
        memberName: 'w2-1(codex)',
        principalId: panePrincipalId('ws-b', 'pane-2'),
      },
    ]);
  });

  it('dedups multiple panes in the same workspace to one invite (validation is per-workspace)', () => {
    const mentions: ChannelMention[] = [
      { workspaceId: 'ws-a', paneId: 'pane-1', ptyId: 'pty-1', name: 'w1-1(claude)' },
      { workspaceId: 'ws-a', paneId: 'pane-2', ptyId: 'pty-2', name: 'w1-2(claude)' },
    ];
    const members = fanoutInviteMembers(mentions, HUMAN_WORKSPACE_ID);
    expect(members).toHaveLength(1);
    expect(members[0].workspaceId).toBe('ws-a');
  });

  it('never invites the human seat', () => {
    const mentions: ChannelMention[] = [
      { workspaceId: HUMAN_WORKSPACE_ID, name: 'me' },
      { workspaceId: 'ws-a', paneId: 'pane-1', ptyId: 'pty-1', name: 'w1-1(claude)' },
    ];
    const members = fanoutInviteMembers(mentions, HUMAN_WORKSPACE_ID);
    expect(members).toHaveLength(1);
    expect(members[0].workspaceId).toBe('ws-a');
  });

  it('omits principalId for a bare (paneless) workspace mention', () => {
    const members = fanoutInviteMembers([{ workspaceId: 'ws-a', name: 'w1' }], HUMAN_WORKSPACE_ID);
    expect(members[0].principalId).toBeUndefined();
  });
});
