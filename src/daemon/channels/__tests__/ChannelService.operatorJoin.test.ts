// ─── operator-join tests (설계 §2.1/§2.2) ─────────────────────────────────────
// 오퍼레이터(사람)가 에이전트들이 만든 비공개 채널에 스스로 들어가는 신뢰 경로와
// 그 발견 목록에 대한 단위 테스트. 보안 스펙의 핵심(파라미터 주입 무시 / 서버-발행
// 시스템 메시지 원자 append / 좌석 shape 정합)을 고정한다.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit } from '../ChannelService';
import { applyChannelEvent } from '../channelEvents';
import type { ChannelEventPayload } from '../channelEvents';
import {
  HUMAN_WORKSPACE_ID,
  HUMAN_MEMBER_ID,
  type ChannelMessage,
  type ChannelState,
} from '../../../shared/channels';
import { HUMAN_SELF_PRINCIPAL_ID } from '../../../shared/principals';

// 인메모리 fake writer(ChannelService.test.ts와 동일 계약) — legacy 모드 구동.
function makeFakeWriter(opts: { failNext?: boolean } = {}) {
  let failNext = opts.failNext ?? false;
  let lastSaved: ChannelState | null = null;
  const freshState = (): ChannelState => ({
    version: 1,
    channels: [],
    members: {},
    messages: {},
    idempotency: {},
  });
  const clone = (state: ChannelState): ChannelState => ({
    version: state.version,
    channels: state.channels.map((c) => ({ ...c })),
    members: Object.fromEntries(
      Object.entries(state.members).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    messages: Object.fromEntries(
      Object.entries(state.messages).map(([k, v]) => [k, v.map((m) => ({ ...m }))]),
    ),
    idempotency: Object.fromEntries(
      Object.entries(state.idempotency).map(([k, v]) => [k, { ...v }]),
    ),
  });
  return {
    saveImmediate: vi.fn((state: ChannelState): boolean => {
      if (failNext) {
        failNext = false;
        return false;
      }
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
    setFailNext() {
      failNext = true;
    },
  };
}

function makeService() {
  const writer = makeFakeWriter();
  const emit = vi.fn<ChannelServiceEmit>();
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: 'co-test',
    emit,
    now: () => 1_700_000_000_000,
  });
  return { svc, writer, emit };
}

/** 에이전트가 만든 비공개 채널(사람은 비멤버) — operatorJoin의 표준 대상. */
async function makePrivateAgentChannel(svc: ChannelService): Promise<string> {
  const created = await svc.create({
    name: 'secret-room',
    visibility: 'private',
    createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
    verifiedWorkspaceId: 'ws-agent',
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  return created.channel.id;
}

describe('ChannelService.operatorJoin', () => {
  it('joins a PRIVATE channel the human OBSERVES but is not a member of (adds a roster seat)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // W1: 사전조건 — 사람은 이 비공개 채널을 read-only로 관전한다(get 가시). 하지만
    // 아직 멤버는 아니다(roster에 ws-human 없음). operatorJoin이 좌석을 심는다.
    expect(svc.get(channelId, HUMAN_WORKSPACE_ID)).not.toBeNull();
    expect(
      svc.getMembers(channelId, HUMAN_WORKSPACE_ID).some((m) => m.workspaceId === HUMAN_WORKSPACE_ID),
    ).toBe(false);

    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.memberId).toBe(HUMAN_MEMBER_ID);
    // 사후조건: 이제 사람이 멤버다(관전 → 참여).
    expect(svc.get(channelId, HUMAN_WORKSPACE_ID)).not.toBeNull();
    expect(
      svc.getMembers(channelId, HUMAN_WORKSPACE_ID).some((m) => m.workspaceId === HUMAN_WORKSPACE_ID),
    ).toBe(true);
  });

  it('rejects an archived channel with CHANNEL_ARCHIVED', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await svc.archive({ channelId, archivedBy: 'ws-agent', verifiedWorkspaceId: 'ws-agent' });
    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res).toMatchObject({ ok: false, error: { code: 'CHANNEL_ARCHIVED' } });
  });

  it('rejects a second operatorJoin with DUPLICATE_MEMBER (no silent success)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res).toMatchObject({ ok: false, error: { code: 'DUPLICATE_MEMBER' } });
  });

  it('rejects an unknown channel with CHANNEL_NOT_FOUND', async () => {
    const { svc } = makeService();
    const res = await svc.operatorJoin({ channelId: 'ch-missing', verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res).toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_FOUND' } });
  });

  it('rejects a missing verifiedWorkspaceId with NOT_AUTHORIZED (no anonymous mutation)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: '' });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_AUTHORIZED' } });
  });

  it('seat row shape matches the P5-merged human row EXACTLY (no memberName, hardcoded principal)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    const rows = svc.getMembers(channelId, HUMAN_WORKSPACE_ID);
    const human = rows.find((m) => m.memberId === HUMAN_MEMBER_ID);
    // 정확 키 집합 — memberName 없음(렌더러가 localized "Me"로 대체), principal 하드코딩.
    expect(human).toEqual({
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      joinedAt: 1_700_000_000_000,
      historyFromSeq: 0,
      lastReadSeq: 0, // create 직후 nextSeq=1 → nextSeq-1
      principalId: HUMAN_SELF_PRINCIPAL_ID,
    });
    expect(human).not.toHaveProperty('memberName');
  });

  it('IGNORES injected garbage params (member / includeHistory / workspaceId) — constant seat only', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // 원시 params에 P5류 주입을 시도한다(타입 표면엔 없으므로 any 캐스트로 강제 주입).
    await svc.operatorJoin({
      channelId,
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
      member: { workspaceId: 'ws-evil', memberId: 'evil-seat', principalId: 'evil-principal' },
      includeHistory: false,
      workspaceId: 'ws-evil',
      historyFromSeq: 999,
      lastReadSeq: 999,
    } as unknown as Parameters<ChannelService['operatorJoin']>[0]);
    const rows = svc.getMembers(channelId, HUMAN_WORKSPACE_ID);
    // 주입된 ws-evil/evil-seat 좌석은 존재하지 않는다.
    expect(rows.some((m) => m.workspaceId === 'ws-evil' || m.memberId === 'evil-seat')).toBe(false);
    const human = rows.find((m) => m.memberId === HUMAN_MEMBER_ID);
    // 좌석은 상수: principal은 HUMAN_SELF, historyFromSeq는 0(주입된 999 아님).
    expect(human?.principalId).toBe(HUMAN_SELF_PRINCIPAL_ID);
    expect(human?.historyFromSeq).toBe(0);
  });

  it('appends a server-published system message that consumes a seq (durable audit)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const before = svc.get(channelId, 'ws-agent');
    expect(before?.nextSeq).toBe(1);

    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    // seq 소비: nextSeq가 1 전진.
    const after = svc.get(channelId, 'ws-agent');
    expect(after?.nextSeq).toBe(2);
    // 히스토리에 systemKind 마커 1건.
    const msgs = svc.getMessages(channelId, undefined, HUMAN_WORKSPACE_ID);
    const sys = msgs.filter((m) => m.systemKind === 'operator-join');
    expect(sys).toHaveLength(1);
    expect(sys[0].seq).toBe(1);
    expect(sys[0].workspaceId).toBe(HUMAN_WORKSPACE_ID);
    expect(sys[0].memberId).toBe(HUMAN_MEMBER_ID);
  });

  it('system message owes NO unread to agent members (audit marker, not deliverable work)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);

    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    // 채널 생성자(에이전트)의 unread — unreadFor()의 systemKind 면제가 wake
    // worker의 plain-unread nudge를 막는 실제 장치다(3모델 리뷰 합의). 마커가
    // seq는 소비하되(headSeq 전진) 누구의 unread도 만들지 않아야 한다.
    const rows = svc.unreadFor('ws-agent', 'agent-1');
    const row = rows.find((r) => r.channelId === channelId);
    expect(row).toBeDefined();
    expect(row?.headSeq).toBe(1);
    expect(row?.unread).toBe(0);
    expect(row?.mentionUnread).toBe(0);
  });

  it('atomically ROLLS BACK seat AND system message when persist fails', async () => {
    const { svc, writer } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    writer.setFailNext(); // 다음 saveImmediate(=operatorJoin의 저장)가 실패한다.

    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res).toMatchObject({ ok: false, error: { code: 'PERSIST_FAILED' } });

    // 좌석 미추가.
    const rows = svc.getMembers(channelId, 'ws-agent');
    expect(rows.some((m) => m.memberId === HUMAN_MEMBER_ID)).toBe(false);
    // 메시지 미append.
    expect(svc.getMessages(channelId, undefined, 'ws-agent')).toHaveLength(0);
    // nextSeq 원복(1).
    expect(svc.get(channelId, 'ws-agent')?.nextSeq).toBe(1);
  });

  it('emits a membership catalog fan-out INCLUDING the agent members + the human', async () => {
    const { svc, emit } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    emit.mockClear();
    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    const catalog = emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === 'channel.catalog');
    expect(catalog?.type).toBe('channel.catalog');
    if (catalog?.type === 'channel.catalog') {
      expect(catalog.reason).toBe('membership');
      expect(catalog.recipientWorkspaceIds).toContain(HUMAN_WORKSPACE_ID);
      expect(catalog.recipientWorkspaceIds).toContain('ws-agent');
    }
    // 시스템 메시지 라이브 팬아웃도 발생(systemKind 포함).
    const message = emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === 'channel.message');
    expect(message?.type).toBe('channel.message');
    if (message?.type === 'channel.message') {
      expect(message.message.systemKind).toBe('operator-join');
    }
  });

  it('re-operatorJoin after leave gets a FRESH seat (unread reset, no state carry)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    // 사람이 leave.
    await svc.leave({
      channelId,
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    expect(svc.getMembers(channelId, 'ws-agent').some((m) => m.memberId === HUMAN_MEMBER_ID)).toBe(false);
    // 재진입 — 새 좌석 lastReadSeq = 재진입 시점 nextSeq-1(상태 이월 없음).
    const before = svc.get(channelId, 'ws-agent')?.nextSeq ?? 0;
    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);
    const human = svc.getMembers(channelId, HUMAN_WORKSPACE_ID).find((m) => m.memberId === HUMAN_MEMBER_ID);
    expect(human?.lastReadSeq).toBe(before - 1);
    expect(human?.historyFromSeq).toBe(0);
  });
});

describe('ChannelService.operatorList', () => {
  it('returns metadata-only projection (no messages, no member detail)', async () => {
    const { svc } = makeService();
    await makePrivateAgentChannel(svc);
    const list = svc.operatorList({ verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(list).toHaveLength(1);
    // 정확 키 집합 — 프로젝션 필드만.
    expect(Object.keys(list[0]).sort()).toEqual(
      ['createdAt', 'id', 'memberCount', 'name', 'status', 'visibility'].sort(),
    );
    expect(list[0]).not.toHaveProperty('messages');
    expect(list[0]).not.toHaveProperty('members');
  });

  it('includes private channels the caller is NOT a member of', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // 사람은 비멤버지만 operatorList엔 보인다(발견 어포던스).
    const list = svc.operatorList({ verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(list.map((c) => c.id)).toContain(channelId);
    expect(list[0].visibility).toBe('private');
    expect(list[0].memberCount).toBe(1); // agent creator only
  });

  it('includes ARCHIVED channels (audit visibility)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await svc.archive({ channelId, archivedBy: 'ws-agent', verifiedWorkspaceId: 'ws-agent' });
    const list = svc.operatorList({ verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(list.find((c) => c.id === channelId)?.status).toBe('archived');
  });

  it('is deterministically ordered (createdAt asc, id tiebreak)', async () => {
    const writer = makeFakeWriter();
    const emit = vi.fn<ChannelServiceEmit>();
    // 같은 now()로 두 채널을 만들어 createdAt 동률을 강제 → id tiebreak 검증.
    const svc = new ChannelService({
      writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
      companyId: 'co-test',
      emit,
      now: () => 1_700_000_000_000,
    });
    const a = await svc.create({
      name: 'aaa',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm', memberName: 'M' },
      verifiedWorkspaceId: 'ws-1',
    });
    const b = await svc.create({
      name: 'bbb',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-1', memberId: 'm', memberName: 'M' },
      verifiedWorkspaceId: 'ws-1',
    });
    if (!a.ok || !b.ok) throw new Error('create failed');
    const list = svc.operatorList({ verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    const ids = list.map((c) => c.id);
    // createdAt 동률이므로 id 사전순으로 결정론적.
    const expected = [a.channel.id, b.channel.id].sort((x, y) => x.localeCompare(y));
    expect(ids).toEqual(expected);
  });

  it('rejects (empty list) a missing verifiedWorkspaceId', async () => {
    const { svc } = makeService();
    await makePrivateAgentChannel(svc);
    expect(svc.operatorList({ verifiedWorkspaceId: '' })).toEqual([]);
  });
});

// ─── replay 적용기: operator-join 이벤트의 원자성 + 멱등성 ─────────────────────
describe('applyChannelEvent — operator-join (compound event replay)', () => {
  function seedState(): ChannelState {
    return {
      version: 1,
      channels: [
        {
          id: 'ch-1',
          companyId: 'co',
          name: 'secret',
          visibility: 'private',
          status: 'active',
          createdAt: 1,
          createdBy: 'ws-agent',
          nextSeq: 1,
        },
      ],
      members: { 'ch-1': [{ workspaceId: 'ws-agent', memberId: 'agent-1', joinedAt: 1, historyFromSeq: 0, lastReadSeq: 0 }] },
      messages: { 'ch-1': [] },
      idempotency: {},
    };
  }
  const sysMsg: ChannelMessage = {
    channelId: 'ch-1',
    seq: 1,
    workspaceId: HUMAN_WORKSPACE_ID,
    memberId: HUMAN_MEMBER_ID,
    memberName: HUMAN_MEMBER_ID,
    text: 'Operator joined the channel.',
    postedAt: 2,
    deliveryStatus: 'delivered',
    systemKind: 'operator-join',
  };
  const event: ChannelEventPayload = {
    kind: 'operator-join',
    channelId: 'ch-1',
    member: {
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      joinedAt: 2,
      historyFromSeq: 0,
      lastReadSeq: 0,
      principalId: HUMAN_SELF_PRINCIPAL_ID,
    },
    message: sysMsg,
  };

  it('applies BOTH effects (seat push + message append + nextSeq advance)', () => {
    const state = seedState();
    applyChannelEvent(state, event);
    expect(state.members['ch-1'].some((m) => m.memberId === HUMAN_MEMBER_ID)).toBe(true);
    expect(state.messages['ch-1']).toHaveLength(1);
    expect(state.messages['ch-1'][0].systemKind).toBe('operator-join');
    expect(state.channels[0].nextSeq).toBe(2);
  });

  it('is idempotent — re-applying the same event is a no-op (no dup seat, no dup message)', () => {
    const state = seedState();
    applyChannelEvent(state, event);
    applyChannelEvent(state, event);
    expect(state.members['ch-1'].filter((m) => m.memberId === HUMAN_MEMBER_ID)).toHaveLength(1);
    expect(state.messages['ch-1']).toHaveLength(1);
    expect(state.channels[0].nextSeq).toBe(2);
  });
});

// ─── 경계 고정: MCP 도구 표면에 operator 메서드 부재 ──────────────────────────
describe('operator methods are absent from the bundled MCP tool surface', () => {
  it('src/mcp/channels.ts never references operatorJoin / operatorList', () => {
    // vitest는 리포 루트(worktree)에서 실행된다 — cwd 기준 상대 경로로 소스를 읽는다.
    const channelsTool = readFileSync(resolve(process.cwd(), 'src/mcp/channels.ts'), 'utf8');
    expect(channelsTool).not.toContain('operatorJoin');
    expect(channelsTool).not.toContain('operatorList');
  });
});
