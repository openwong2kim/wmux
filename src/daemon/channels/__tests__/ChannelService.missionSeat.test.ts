// ─── #1920 — a fan-out worker can join its own private mission channel ──────
//
// The fan-out owner invites the task workspace right after materialization.
// When that invite was lost, the worker got NOT_A_MEMBER on post and
// CHANNEL_NOT_FOUND on join (private channels hide themselves from
// non-members), and a human had to add it. The join gate now also admits the
// workspace the daemon's WorkTask projection names as that mission's task
// workspace — a server-side fact, never a caller claim.

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import type { ChannelState } from '../../../shared/channels';

function makeService(isMissionTaskSeat?: (channelId: string, workspaceId: string) => boolean) {
  let saved: ChannelState = { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
  const writer = {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      saved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => JSON.parse(JSON.stringify(saved))),
  };
  return new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: 'co-test',
    emit: vi.fn<ChannelServiceEmit>(),
    now: () => 1_700_000_000_000,
    ...(isMissionTaskSeat ? { isMissionTaskSeat } : {}),
  });
}

async function privateMission(svc: ChannelService): Promise<string> {
  const created = await svc.create({
    name: 'mission-task-a',
    visibility: 'private',
    createdBy: { workspaceId: 'ws-owner', memberId: 'ws-owner' },
    verifiedWorkspaceId: 'ws-owner',
  });
  if (!created.ok) throw new Error('create failed');
  return created.channel.id;
}

const join = (svc: ChannelService, channelId: string, ws: string) =>
  svc.join({ channelId, member: { workspaceId: ws, memberId: ws }, verifiedWorkspaceId: ws });

describe('#1920 — mission task seat on join', () => {
  it('lets the mission task workspace join its private channel, then post', async () => {
    let channelId = '';
    const svc = makeService((ch, ws) => ch === channelId && ws === 'ws-task-1');
    channelId = await privateMission(svc);

    // The state the issue reports: not a member, so the post is refused.
    const before = await svc.post({
      channelId,
      sender: { workspaceId: 'ws-task-1', memberId: 'ws-task-1' },
      text: 'report',
      verifiedWorkspaceId: 'ws-task-1',
    });
    expect(before.ok).toBe(false);
    if (!before.ok) expect(before.error.code).toBe('NOT_A_MEMBER');

    const joined = await join(svc, channelId, 'ws-task-1');
    expect(joined.ok).toBe(true);

    const after = await svc.post({
      channelId,
      sender: { workspaceId: 'ws-task-1', memberId: 'ws-task-1' },
      text: 'report',
      verifiedWorkspaceId: 'ws-task-1',
    });
    expect(after.ok).toBe(true);
  });

  it('still hides the private channel from any other non-member', async () => {
    let channelId = '';
    const svc = makeService((ch, ws) => ch === channelId && ws === 'ws-task-1');
    channelId = await privateMission(svc);

    const stranger = await join(svc, channelId, 'ws-other');
    expect(stranger.ok).toBe(false);
    if (!stranger.ok) expect(stranger.error.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('without the seat source (legacy construction) the gate is unchanged', async () => {
    const svc = makeService();
    const channelId = await privateMission(svc);

    const res = await join(svc, channelId, 'ws-task-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('does not reopen an archived mission channel to the task workspace', async () => {
    let channelId = '';
    const svc = makeService((ch, ws) => ch === channelId && ws === 'ws-task-1');
    channelId = await privateMission(svc);
    const archived = await svc.archive({ channelId, archivedBy: 'ws-owner', verifiedWorkspaceId: 'ws-owner' });
    expect(archived.ok).toBe(true);

    const res = await join(svc, channelId, 'ws-task-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CHANNEL_ARCHIVED');
  });
});
