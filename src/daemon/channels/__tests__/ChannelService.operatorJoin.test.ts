// ─── operator-join tests (design §2.1/§2.2) ─────────────────────────────────────
// Unit tests for the trusted path where an operator (human) joins a private channel
// created by agents, and its discovery list. Locks down security spec essentials
// (ignore injected params / server-published system message atomic append / seat shape).

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

// In-memory fake writer (same contract as ChannelService.test.ts) — runs legacy mode.
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

/** Private channel created by an agent (human is non-member) — standard operatorJoin target. */
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
    // W1: precondition — human observes this private channel read-only (get visible). But
    // not yet a member (no ws-human in roster). operatorJoin plants the seat.
    expect(svc.get(channelId, HUMAN_WORKSPACE_ID)).not.toBeNull();
    expect(
      svc.getMembers(channelId, HUMAN_WORKSPACE_ID).some((m) => m.workspaceId === HUMAN_WORKSPACE_ID),
    ).toBe(false);

    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error(res.error.code);
    expect(res.memberId).toBe(HUMAN_MEMBER_ID);
    // postcondition: human is now a member (observe → participate).
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
    // Exact key set — no memberName (renderer substitutes localized "Me"), hardcoded principal.
    expect(human).toEqual({
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      joinedAt: 1_700_000_000_000,
      historyFromSeq: 0,
      lastReadSeq: 0, // right after create nextSeq=1 → nextSeq-1
      principalId: HUMAN_SELF_PRINCIPAL_ID,
    });
    expect(human).not.toHaveProperty('memberName');
  });

  it('IGNORES injected garbage params (member / includeHistory / workspaceId) — constant seat only', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // Attempt P5-style injection on raw params (forced via any cast — not on type surface).
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
    // Injected ws-evil/evil-seat seat must not exist.
    expect(rows.some((m) => m.workspaceId === 'ws-evil' || m.memberId === 'evil-seat')).toBe(false);
    const human = rows.find((m) => m.memberId === HUMAN_MEMBER_ID);
    // Seat is constant: principal HUMAN_SELF, historyFromSeq 0 (not injected 999).
    expect(human?.principalId).toBe(HUMAN_SELF_PRINCIPAL_ID);
    expect(human?.historyFromSeq).toBe(0);
  });

  it('appends a server-published system message that consumes a seq (durable audit)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const before = svc.get(channelId, 'ws-agent');
    expect(before?.nextSeq).toBe(1);

    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

    // seq consumed: nextSeq advances by 1.
    const after = svc.get(channelId, 'ws-agent');
    expect(after?.nextSeq).toBe(2);
    // One systemKind marker in history.
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

    // Agent creator unread — unreadFor() systemKind exemption is the actual device
    // blocking wake worker plain-unread nudge (3-model review consensus). Marker
    // must consume seq (headSeq advances) but create unread for nobody.
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
    writer.setFailNext(); // next saveImmediate (=operatorJoin persist) fails.

    const res = await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(res).toMatchObject({ ok: false, error: { code: 'PERSIST_FAILED' } });

    // seat not added.
    const rows = svc.getMembers(channelId, 'ws-agent');
    expect(rows.some((m) => m.memberId === HUMAN_MEMBER_ID)).toBe(false);
    // message not appended.
    expect(svc.getMessages(channelId, undefined, 'ws-agent')).toHaveLength(0);
    // nextSeq restored (1).
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
    // system message live fan-out also fires (includes systemKind).
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
    // human leaves.
    await svc.leave({
      channelId,
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    expect(svc.getMembers(channelId, 'ws-agent').some((m) => m.memberId === HUMAN_MEMBER_ID)).toBe(false);
    // re-entry — fresh seat lastReadSeq = nextSeq-1 at re-entry (no state carry).
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
    // Exact key set — projection fields only.
    expect(Object.keys(list[0]).sort()).toEqual(
      ['createdAt', 'id', 'memberCount', 'name', 'status', 'visibility'].sort(),
    );
    expect(list[0]).not.toHaveProperty('messages');
    expect(list[0]).not.toHaveProperty('members');
  });

  it('includes private channels the caller is NOT a member of', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // human is non-member but visible in operatorList (discovery affordance).
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
    // create two channels with same now() to force createdAt tie → id tiebreak check.
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
    // createdAt tied, so deterministic by id lex order.
    const expected = [a.channel.id, b.channel.id].sort((x, y) => x.localeCompare(y));
    expect(ids).toEqual(expected);
  });

  it('rejects (empty list) a missing verifiedWorkspaceId', async () => {
    const { svc } = makeService();
    await makePrivateAgentChannel(svc);
    expect(svc.operatorList({ verifiedWorkspaceId: '' })).toEqual([]);
  });
});

// ─── replay applier: operator-join event atomicity + idempotency ─────────────────────
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

// ─── boundary lock: operator methods absent from MCP tool surface ──────────────────────────
describe('operator methods are absent from the bundled MCP tool surface', () => {
  it('src/mcp/channels.ts never references operatorJoin / operatorList', () => {
    // vitest runs from repo root (worktree) — read source via cwd-relative path.
    const channelsTool = readFileSync(resolve(process.cwd(), 'src/mcp/channels.ts'), 'utf8');
    expect(channelsTool).not.toContain('operatorJoin');
    expect(channelsTool).not.toContain('operatorList');
  });
});
