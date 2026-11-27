// ─── T1 — fan-out invite memberId=workspaceId 규약 (J1 §2 ⑤) ──────────
//
// FanOutService ⑤는 태스크 워크스페이스를 미션 채널에 invite할 때
// invitedMember = { workspaceId, memberId: workspaceId }로 넣는다(FanOutService
// spawnOne ⑤ 참조). 이 규약 하에서 해당 workspaceId 멤버의 채널 발신(post)이
// 멤버 게이트를 통과하는지를 고정한다 — invite→post 왕복이 깨지면 태스크 에이전트가
// 미션 채널에 말을 못 하므로 J1의 핵심 계약이 무너진다.
//
// fake 구조는 ChannelService.rosterIdentity.test.ts를 재사용한다.

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
    loadWithStatus() { return { status: 'loaded' as const, state: this.load() }; },
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

describe('T1 — invite memberId=workspaceId 후 그 멤버의 post가 게이트를 통과한다', () => {
  it('CEO가 미션 채널을 만들고 태스크 워크스페이스를 invite하면 태스크 워크스페이스가 발신 가능', async () => {
    const { svc } = makeService();
    // 미션 채널은 생성자(owner) 워크스페이스가 만든다.
    const created = await svc.create({
      name: 'mission',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-owner', memberId: 'ws-owner' },
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const channelId = created.channel.id;

    // FanOutService ⑤와 동일한 wire shape: workspaceId == memberId.
    const TASK_WS = 'ws-task-1';
    const invited = await svc.invite({
      channelId,
      invitedMember: { workspaceId: TASK_WS, memberId: TASK_WS },
      verifiedWorkspaceId: 'ws-owner',
    });
    expect(invited.ok).toBe(true);

    // 태스크 워크스페이스(에이전트 페인)가 verifiedWorkspaceId=TASK_WS로 발신.
    const posted = await svc.post({
      channelId,
      sender: { workspaceId: TASK_WS, memberId: TASK_WS },
      text: '태스크 진행 상황 보고',
      verifiedWorkspaceId: TASK_WS,
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) {
      // 멤버 게이트 통과 + 로스터 행 신원으로 렌더.
      expect(posted.message.memberId).toBe(TASK_WS);
    }
  });

  it('invite 안 된 워크스페이스라도 단일 로스터 매핑으로 발신은 되지만, invite된 워크스페이스는 자기 행으로 귀속된다', async () => {
    // 회귀 방어: invite된 TASK_WS의 발신이 owner 행이 아니라 TASK_WS 행으로 귀속돼야
    // N개 태스크 신원이 뭉개지지 않는다(§1 신원 축 분리).
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
