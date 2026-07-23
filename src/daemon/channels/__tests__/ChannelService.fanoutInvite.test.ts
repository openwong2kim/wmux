// ─── T1 — fan-out invite memberId=workspaceId convention (J1 §2 ⑤) ──────────
//
// FanOutService ⑤ invites a task workspace to a mission channel with
// invitedMember = { workspaceId, memberId: workspaceId } (see FanOutService
// spawnOne ⑤). This test locks down that a channel post from that workspaceId
// member passes the member gate — if invite→post breaks, task agents cannot
// speak in the mission channel and J1's core contract collapses.
//
// Reuses the fake structure from ChannelService.rosterIdentity.test.ts.

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import type { ChannelState } from '../../../shared/channels';

const COMPANY = 'co-test';

function freshState(): ChannelState {
  return { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
}

function makeFakeWriter(initial?: ChannelState) {
  let lastSaved: ChannelState | null = initial ?? null;
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? JSON.parse(JSON.stringify(lastSaved)) : freshState())),
  };
}

function makeService() {
  const writer = makeFakeWriter();
  const emit = vi.fn<ChannelServiceEmit>();
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: COMPANY,
    emit,
    now: () => 1_700_000_000_000,
  });
  return { svc, writer, emit };
}

describe('T1 — an invited memberId=workspaceId can post through the gate', () => {
  it('CEOIf you create a mission channel and invite a task workspace, the task workspace can send.', async () => {
    const { svc } = makeService();
    // Mission channel is created by the owner workspace.
    const created = await svc.create({
      name: 'mission',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-owner', memberId: 'ws-owner' },
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const channelId = created.channel.id;

    // Same wire shape as FanOutService ⑤: workspaceId == memberId.
    const TASK_WS = 'ws-task-1';
    const invited = await svc.invite({
      channelId,
      invitedMember: { workspaceId: TASK_WS, memberId: TASK_WS },
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(invited.ok).toBe(true);

    // Task workspace (agent pane) posts with verifiedWorkspaceId=TASK_WS.
    const posted = await svc.post({
      channelId,
      sender: { workspaceId: TASK_WS, memberId: TASK_WS },
      text: 'Task progress report',
      verifiedWorkspaceId: TASK_WS,
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) {
      // Member gate passed + render under roster row identity.
      expect(posted.message.memberId).toBe(TASK_WS);
    }
  });

  it('invite Even if it is not a workspace, you can send with a single roster mapping., inviteThe created workspace belongs to its own row.', async () => {
    // Regression guard: invited TASK_WS posts must attribute to TASK_WS row, not owner row,
    // so N task identities do not collapse (§1 identity-axis separation).
    const { svc } = makeService();
    const created = await svc.create({
      name: 'mission',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-owner', memberId: 'ws-owner' },
      verifiedWorkspaceId: 'ws-owner',
    });
    if (!created.ok) throw new Error('create failed');
    const channelId = created.channel.id;

    const TASK_A = 'ws-task-a';
    const TASK_B = 'ws-task-b';
    await svc.invite({ channelId, invitedMember: { workspaceId: TASK_A, memberId: TASK_A }, verifiedWorkspaceId: 'ws-owner' });
    await svc.invite({ channelId, invitedMember: { workspaceId: TASK_B, memberId: TASK_B }, verifiedWorkspaceId: 'ws-owner' });

    const a = await svc.post({ channelId, sender: { workspaceId: TASK_A, memberId: TASK_A }, text: 'A', verifiedWorkspaceId: TASK_A });
    const b = await svc.post({ channelId, sender: { workspaceId: TASK_B, memberId: TASK_B }, text: 'B', verifiedWorkspaceId: TASK_B });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok) expect(a.message.memberId).toBe(TASK_A);
    if (b.ok) expect(b.message.memberId).toBe(TASK_B);
  });
});
