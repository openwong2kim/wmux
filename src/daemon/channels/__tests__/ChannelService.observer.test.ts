// ─── W1 operator-observation tests ───────────────────────────────────────────
// The local human operator (ws-human) OBSERVES private agent channels read-only:
// get/getMessages/getMembers/list open to ws-human even for a channel it is not a
// member of, list flags such rows `observed`, and a private channel's catalog
// events fan out to ws-human. Crucially, observation grants NO write: post / join
// / leave stay closed, and a non-human non-member is still blocked on every read
// (fail-closed regression guard).

import { describe, it, expect, vi } from 'vitest';
import { ChannelService } from '../ChannelService';
import type { ChannelServiceEmit, ChannelCatalogEvent } from '../ChannelService';
import { HUMAN_WORKSPACE_ID, type ChannelState } from '../../../shared/channels';

// In-memory fake writer (same contract as ChannelService.test.ts) — legacy mode.
function makeFakeWriter() {
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
      lastSaved = state;
      return true;
    }),
    load: vi.fn((): ChannelState => (lastSaved ? clone(lastSaved) : freshState())),
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

/** A private channel created by an agent (the human is NOT a member). */
async function makePrivateAgentChannel(svc: ChannelService, name = 'secret-room'): Promise<string> {
  const created = await svc.create({
    name,
    visibility: 'private',
    createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
    verifiedWorkspaceId: 'ws-agent',
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  return created.channel.id;
}

async function post(svc: ChannelService, channelId: string, text: string): Promise<void> {
  const res = await svc.post({
    channelId,
    sender: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
    text,
    verifiedWorkspaceId: 'ws-agent',
  });
  if (!res.ok) throw new Error(`post failed: ${res.error.code}`);
}

describe('W1 operator observation — read paths open to ws-human', () => {
  it('ws-human (non-member) can get a private channel it does not belong to', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    expect(svc.get(channelId, HUMAN_WORKSPACE_ID)).not.toBeNull();
  });

  it('ws-human (non-member) can read the roster of a private channel', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const rows = svc.getMembers(channelId, HUMAN_WORKSPACE_ID);
    expect(rows.some((m) => m.workspaceId === 'ws-agent')).toBe(true);
    // ws-human is NOT in the roster — it observes without a seat.
    expect(rows.some((m) => m.workspaceId === HUMAN_WORKSPACE_ID)).toBe(false);
  });

  it('ws-human observer sees the FULL history (no per-member floor)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await post(svc, channelId, 'first');
    await post(svc, channelId, 'second');
    const msgs = svc.getMessages(channelId, undefined, HUMAN_WORKSPACE_ID);
    expect(msgs.map((m) => m.text)).toEqual(['first', 'second']);
  });
});

describe('W1 operator observation — write gate stays CLOSED for ws-human', () => {
  it('post as ws-human is rejected (not a member — observation grants no voice)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const res = await svc.post({
      channelId,
      sender: { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'me', memberName: 'Me' },
      text: 'hello',
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_A_MEMBER' } });
  });

  it('join as ws-human is rejected by the #288 gate (write path uses isVisibleTo, not observation)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const res = await svc.join({
      channelId,
      member: { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'me', memberName: 'Me' },
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    // CHANNEL_NOT_FOUND (not a distinct authz code) — a non-member cannot
    // distinguish a locked private channel from a missing id via join.
    expect(res).toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_FOUND' } });
  });

  it('leave as ws-human (never a member) is rejected', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const res = await svc.leave({
      channelId,
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: 'me',
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    expect(res).toMatchObject({ ok: false, error: { code: 'NOT_A_MEMBER' } });
  });
});

describe('W1 operator observation — a NON-human non-member stays fail-closed', () => {
  it('a different workspace is still blocked on every read (no regression)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    expect(svc.get(channelId, 'ws-other')).toBeNull();
    expect(svc.getMessages(channelId, undefined, 'ws-other')).toEqual([]);
    expect(svc.getMembers(channelId, 'ws-other')).toEqual([]);
    expect(svc.list('ws-other').some((c) => c.id === channelId)).toBe(false);
  });
});

describe('W1 operator observation — list() observed flag', () => {
  it('list(ws-human) returns the private channel flagged observed:true', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const row = svc.list(HUMAN_WORKSPACE_ID).find((c) => c.id === channelId);
    expect(row).toBeDefined();
    expect(row?.observed).toBe(true);
  });

  it('list() for a MEMBER returns the channel WITHOUT the observed flag', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    const row = svc.list('ws-agent').find((c) => c.id === channelId);
    expect(row).toBeDefined();
    expect(row?.observed).toBeUndefined();
  });

  it('after operatorJoin, ws-human is a member so the row is no longer observed', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    const row = svc.list(HUMAN_WORKSPACE_ID).find((c) => c.id === channelId);
    expect(row?.observed).toBeUndefined();
  });

  it('a public channel is never flagged observed (already visible to all)', async () => {
    const { svc } = makeService();
    const created = await svc.create({
      name: 'town-square',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error(created.error.code);
    const row = svc.list(HUMAN_WORKSPACE_ID).find((c) => c.id === created.channel.id);
    expect(row?.observed).toBeUndefined();
  });

  it('does not mutate the persisted channel row (observed is caller-relative)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // Observing as ws-human stamps observed on the returned copy...
    expect(svc.list(HUMAN_WORKSPACE_ID).find((c) => c.id === channelId)?.observed).toBe(true);
    // ...but the member's own view is untouched (no leaked flag on shared state).
    expect(svc.list('ws-agent').find((c) => c.id === channelId)?.observed).toBeUndefined();
  });

  it('get() stamps observed identically to list() (GLM P3 — mirror-from-get consistency)', async () => {
    const { svc } = makeService();
    const channelId = await makePrivateAgentChannel(svc);
    // Observer: flagged on get, same as list.
    expect(svc.get(channelId, HUMAN_WORKSPACE_ID)?.observed).toBe(true);
    // Member: never flagged.
    expect(svc.get(channelId, 'ws-agent')?.observed).toBeUndefined();
    // After the operator joins, the flag clears on get too (member now).
    await svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(svc.get(channelId, HUMAN_WORKSPACE_ID)?.observed).toBeUndefined();
  });
});

describe('W1 operator observation — catalog fan-out to ws-human', () => {
  it('creating a PRIVATE channel emits a catalog event addressed to ws-human', async () => {
    const { svc, emit } = makeService();
    await makePrivateAgentChannel(svc);
    const catalog = emit.mock.calls
      .map((c) => c[0])
      .find((e): e is ChannelCatalogEvent => e.type === 'channel.catalog');
    expect(catalog).toBeDefined();
    expect(catalog?.recipientWorkspaceIds).toContain(HUMAN_WORKSPACE_ID);
    // Never '*' — a broadcast would leak the private channel's existence to agents.
    expect(catalog?.recipientWorkspaceIds).not.toContain('*');
  });

  it('creating a PUBLIC channel broadcasts ("*") and does NOT single out ws-human', async () => {
    const { svc, emit } = makeService();
    const created = await svc.create({
      name: 'town-square',
      visibility: 'public',
      createdBy: { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' },
      verifiedWorkspaceId: 'ws-agent',
    });
    if (!created.ok) throw new Error(created.error.code);
    const catalog = emit.mock.calls
      .map((c) => c[0])
      .find((e): e is ChannelCatalogEvent => e.type === 'channel.catalog');
    expect(catalog?.recipientWorkspaceIds).toContain('*');
    expect(catalog?.recipientWorkspaceIds).not.toContain(HUMAN_WORKSPACE_ID);
  });
});
