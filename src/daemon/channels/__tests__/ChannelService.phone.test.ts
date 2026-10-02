// ─── Phone channel Inbox (contract §9) service-layer tests ──────────────────
// Covers the service-owned cases of D1-D13 from test plan
// 2026-09-13-phone-channels-inbox.md: D1, D2, D4, D5, D6, D7, D9, D11, D12, D13
// (D3 paging semantics live here too; its HTTP 400 checks are in
// web/channelsApi.test.ts). The four *ForPhone methods take no identity
// parameter and read only the HUMAN_WORKSPACE_ID constant — every test below
// relies on that (server-side mapping, contract §9).

import { describe, it, expect, vi } from 'vitest';
import { ChannelService, PHONE_MENTION_EXCERPT_MAX } from '../ChannelService';
import type { ChannelServiceEmit, ChannelMentionNotification } from '../ChannelService';
import {
  HUMAN_WORKSPACE_ID,
  HUMAN_MEMBER_ID,
  OPERATOR_JOIN_SYSTEM_TEXT,
  type ChannelState,
} from '../../../shared/channels';

// In-memory fake writer (same contract as ChannelService.observer.test.ts) — legacy mode.
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

function makeService(initial?: ChannelState) {
  const writer = makeFakeWriter();
  if (initial) writer.saveImmediate(initial); // seed the writer so load() returns this state
  const emit = vi.fn<ChannelServiceEmit>();
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: 'co-test',
    emit,
    now: () => 1_700_000_000_000,
  });
  return { svc, writer, emit };
}

const AGENT = { workspaceId: 'ws-agent', memberId: 'agent-1', memberName: 'Agent' };

async function createChannel(
  svc: ChannelService,
  name: string,
  visibility: 'public' | 'private',
): Promise<string> {
  const res = await svc.create({
    name,
    visibility,
    createdBy: AGENT,
    verifiedWorkspaceId: AGENT.workspaceId,
  });
  if (!res.ok) throw new Error(`create failed: ${res.error.code}`);
  return res.channel.id;
}

async function post(
  svc: ChannelService,
  channelId: string,
  text: string,
  mentions?: Array<{ workspaceId: string; name?: string }>,
) {
  const res = await svc.post({
    channelId,
    sender: AGENT,
    text,
    verifiedWorkspaceId: AGENT.workspaceId,
    // ChannelMention.name is required, so fill a default (tests may omit it for readability).
    ...(mentions ? { mentions: mentions.map((m) => ({ ...m, name: m.name ?? 'Operator' })) } : {}),
  });
  if (!res.ok) throw new Error(`post failed: ${res.error.code}`);
  return res;
}

/** Take the human seat — same path as the desktop GUI's operator-join. */
const takeSeat = (svc: ChannelService, channelId: string) =>
  svc.operatorJoin({ channelId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });

describe('phone channel Inbox — listForPhone (D1, D2)', () => {
  it('D1: public/joined/observed-private returned per W1 rules — observed has observed:true and no cursor fields', async () => {
    const { svc } = makeService();
    const pubId = await createChannel(svc, 'pub', 'public');
    const observedId = await createChannel(svc, 'secret-room', 'private');
    const joinedId = await createChannel(svc, 'joined-room', 'private');
    await takeSeat(svc, joinedId);

    const rows = svc.listForPhone();
    expect(rows).toHaveLength(3);
    const pub = rows.find((r) => r.channelId === pubId)!;
    const observed = rows.find((r) => r.channelId === observedId)!;
    const joined = rows.find((r) => r.channelId === joinedId)!;

    // Public + no seat: neither an observed stamp nor a cursor (withObservedFlag rule).
    expect(pub.visibility).toBe('public');
    expect('observed' in pub).toBe(false);
    expect('lastReadSeq' in pub).toBe(false);

    // Private without a seat: observed:true, all cursor/unread fields absent.
    expect(observed.visibility).toBe('private');
    expect(observed.observed).toBe(true);
    expect('lastReadSeq' in observed).toBe(false);
    expect('unread' in observed).toBe(false);
    expect('unreadMentions' in observed).toBe(false);

    // Joined (seated): cursor/unread fields present, no observed.
    expect(joined.lastReadSeq).toBe(0); // head at join time (before seq 1 = operator-join system message)
    expect(joined.unread).toBe(0); // system messages are exempt from unread
    expect('observed' in joined).toBe(false);
  });

  it('D2: only channels with a human seat carry lastReadSeq/unread/unreadMentions — exactly the server-computed values (unreadFor)', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'mission', 'private');
    await takeSeat(svc, id);
    await post(svc, id, 'a');
    await post(svc, id, '@operator take a look', [{ workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' }]);
    await post(svc, id, 'c');
    // seq: 1 = operator-join system message, 2..4 = the three posts above.

    const row = svc.listForPhone().find((r) => r.channelId === id)!;
    const serverView = svc.unreadFor(HUMAN_WORKSPACE_ID, HUMAN_MEMBER_ID).find(
      (e) => e.channelId === id,
    )!;
    expect(row.lastReadSeq).toBe(serverView.lastReadSeq);
    expect(row.unread).toBe(serverView.unread);
    expect(row.unreadMentions).toBe(serverView.mentionUnread);
    expect(row.unread).toBe(3);
    expect(row.unreadMentions).toBe(1);
    expect(row.lastSeq).toBe(4);
    // The roster memberName is server-owned (deriveMemberName fallback = memberId).
    expect(row.lastPost).toEqual({ seq: 4, memberName: 'agent-1', postedAt: 1_700_000_000_000 });
  });
});

describe('phone channel Inbox — messagesForPhone (D3 paging, D4 floor, D9)', () => {
  it('D3: since/limit oldest-first paging + nextSince — since is an exclusive cursor (contract: "the last seq the client has")', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'pub', 'public');
    for (let i = 1; i <= 5; i++) await post(svc, id, `m${i}`);

    const p1 = svc.messagesForPhone(id, 0, 3);
    expect(p1.ok && p1.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(p1.ok && p1.nextSince).toBe(3);

    // since=3 → only after 3 (no resend).
    const p2 = svc.messagesForPhone(id, 3, 3);
    expect(p2.ok && p2.messages.map((m) => m.seq)).toEqual([4, 5]);
    expect(p2.ok && p2.nextSince).toBe(5);

    // Empty page once exhausted: cursor unchanged (idempotent no-op).
    const p3 = svc.messagesForPhone(id, 5, 3);
    expect(p3.ok && p3.messages).toEqual([]);
    expect(p3.ok && p3.nextSince).toBe(5);
  });

  it('D4: seqs below the seat\'s historyFromSeq floor are not exposed', async () => {
    // A human seat on a private channel with historyFromSeq > 0. Today's
    // entry paths (operatorJoin=0, P5 forbids invites) never produce this
    // shape, so it is staged via a writer seed — the floor is a getMessages
    // rule that applies only to private channels, and the phone must reuse
    // that gate as-is.
    const id = 'ch-floor';
    const msg = (seq: number, text: string) => ({
      channelId: id,
      seq,
      workspaceId: 'ws-agent',
      memberId: 'agent-1',
      memberName: 'agent-1',
      text,
      postedAt: 1_700_000_000_000,
      deliveryStatus: 'delivered' as const,
    });
    const seeded: ChannelState = {
      version: 1,
      channels: [
        {
          id,
          companyId: 'co-test',
          name: 'floor-room',
          visibility: 'private',
          status: 'active',
          createdAt: 1_700_000_000_000,
          createdBy: 'ws-agent',
          nextSeq: 4,
        },
      ],
      members: {
        [id]: [
          {
            workspaceId: 'ws-agent',
            memberId: 'agent-1',
            joinedAt: 1,
            historyFromSeq: 0,
            lastReadSeq: 3,
          },
          {
            workspaceId: HUMAN_WORKSPACE_ID,
            memberId: HUMAN_MEMBER_ID,
            joinedAt: 2,
            historyFromSeq: 2, // seat sees from seq 2 onward
            lastReadSeq: 3,
          },
        ],
      },
      messages: { [id]: [msg(1, 'hidden-1'), msg(2, 'visible-1'), msg(3, 'visible-2')] },
      idempotency: {},
    };
    const { svc } = makeService(seeded);

    const page = svc.messagesForPhone(id, 0, undefined);
    expect(page.ok && page.messages.map((m) => m.text)).toEqual(['visible-1', 'visible-2']);
  });

  it('D9: messages/ack/join on a non-observed (absent) channel → CHANNEL_NOT_FOUND — indistinguishable from a nonexistent channel', async () => {
    const { svc } = makeService();
    expect(svc.messagesForPhone('ch-nonexistent', 0, undefined)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
    await expect(svc.ackAsPhone('ch-nonexistent', 1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
    await expect(svc.joinAsPhone('ch-nonexistent')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
  });
});

describe('phone channel Inbox — ackAsPhone (D5, D6)', () => {
  it('D5: clamps to head; moving back is a no-op returning the current cursor (not 409) — reads are idempotent', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'mission', 'private');
    await takeSeat(svc, id);
    await post(svc, id, 'a');
    await post(svc, id, 'b');
    await post(svc, id, 'c'); // head = 4

    const over = await svc.ackAsPhone(id, 9999);
    expect(over).toMatchObject({ ok: true, lastReadSeq: 4 });
    const back = await svc.ackAsPhone(id, 1);
    expect(back).toMatchObject({ ok: true, lastReadSeq: 4 });

    // The advanced cursor is reflected in listForPhone's unread.
    expect(svc.listForPhone().find((r) => r.channelId === id)!.unread).toBe(0);
  });

  it('D6: ack on an observed channel without a seat → NO_SEAT (observing is legal; a cursor requires a seat)', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'secret', 'private');
    const res = await svc.ackAsPhone(id, 1);
    expect(res).toMatchObject({ ok: false, error: { code: 'NO_SEAT' } });
  });
});

describe('phone channel Inbox — mention promotion (D7)', () => {
  it('D7: a mention post fires channel.mention only when a human seat exists — without a seat the mention itself is dropped (droppedMentions, no event)', async () => {
    const { svc } = makeService();
    const seatedId = await createChannel(svc, 'seated', 'private');
    await takeSeat(svc, seatedId);
    const seatlessId = await createChannel(svc, 'seatless', 'private');

    const seen: ChannelMentionNotification[] = [];
    svc.onMention((n) => seen.push(n));

    // Seatless channel: the mention is dropped at post time and no event fires.
    const dropped = await post(svc, seatlessId, '@operator mention with no seat', [
      { workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' },
    ]);
    expect(dropped.droppedMentions).toEqual([
      { workspaceId: HUMAN_WORKSPACE_ID, reason: 'not_a_member', name: 'Operator' },
    ]);
    expect(seen).toHaveLength(0);

    // Seated channel: stays in the verified mentions and the event fires.
    const fired = await post(svc, seatedId, '@operator deploy done', [
      { workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' },
    ]);
    expect(fired.droppedMentions).toBeUndefined();
    expect(fired.message.mentions?.map((m) => m.workspaceId)).toEqual([HUMAN_WORKSPACE_ID]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      channelId: seatedId,
      fromMemberName: 'agent-1',
      text: '@operator deploy done',
    });
    expect(seen[0].seq).toBe(fired.message.seq);
    expect(seen[0].postedAt).toBe(fired.message.postedAt);

    // Excerpt cap: the event text is ≤PHONE_MENTION_EXCERPT_MAX.
    await post(svc, seatedId, `@operator ${'x'.repeat(300)}`, [
      { workspaceId: HUMAN_WORKSPACE_ID },
    ]);
    expect(seen).toHaveLength(2);
    expect(seen[1].text.length).toBeLessThanOrEqual(PHONE_MENTION_EXCERPT_MAX);
  });

  it('D7: listener exceptions do not propagate (best-effort — a failed promotion does not roll back the post)', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'boom', 'private');
    await takeSeat(svc, id);
    const failing = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const ok = vi.fn();
    svc.onMention(failing);
    svc.onMention(ok);
    const res = await post(svc, id, '@operator still fires', [
      { workspaceId: HUMAN_WORKSPACE_ID },
    ]);
    expect(res.ok).toBe(true);
    expect(ok).toHaveBeenCalledTimes(1);
  });
});

describe('phone channel Inbox — joinAsPhone (D11, D12, D13)', () => {
  it('D11: join on an observed channel → seat + operator-join system message committed atomically, cursor at head (unread=0), mentions start firing; re-join is alreadyMember', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'mission', 'private');
    await post(svc, id, 'past message 1'); // seq 1
    await post(svc, id, 'past message 2'); // seq 2

    const seen: ChannelMentionNotification[] = [];
    svc.onMention((n) => seen.push(n));
    // Mentions before the seat are dropped — notification value starts at join (contract §9).
    await post(svc, id, '@operator (before join)', [{ workspaceId: HUMAN_WORKSPACE_ID }]);
    expect(seen).toHaveLength(0);

    // join: the dropped pre-join mention consumed seq 3 and the system message
    // consumes seq 4 — the seat cursor sits just before it (3).
    const joined = await svc.joinAsPhone(id);
    expect(joined).toMatchObject({ ok: true, alreadyMember: false, lastReadSeq: 3 });

    const seat = svc
      .getMembers(id, HUMAN_WORKSPACE_ID)
      .find((m) => m.workspaceId === HUMAN_WORKSPACE_ID && m.memberId === HUMAN_MEMBER_ID)!;
    expect(seat.historyFromSeq).toBe(0);

    const row = svc.listForPhone().find((r) => r.channelId === id)!;
    expect(row.unread).toBe(0); // system message and past messages are all exempt from unread
    expect(row.lastSeq).toBe(4);

    // The operator-join system message is persisted in history.
    const msgs = svc.messagesForPhone(id, 0, undefined);
    expect(
      msgs.ok && msgs.messages.some((m) => m.seq === 4 && m.text === OPERATOR_JOIN_SYSTEM_TEXT),
    ).toBe(true);

    // Mentions fire from join onward.
    await post(svc, id, '@operator visible now', [{ workspaceId: HUMAN_WORKSPACE_ID }]);
    expect(seen).toHaveLength(1);

    // Idempotent re-join — alreadyMember rather than an error, and no event.
    const again = await svc.joinAsPhone(id);
    expect(again).toMatchObject({ ok: true, alreadyMember: true, lastReadSeq: 3 });
    expect(seen).toHaveLength(1);
  });

  it('D12: join on an archived channel → CHANNEL_ARCHIVED / absent → CHANNEL_NOT_FOUND', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'frozen', 'public');
    const archived = await svc.archive({
      channelId: id,
      archivedBy: AGENT.workspaceId,
      verifiedWorkspaceId: AGENT.workspaceId,
    });
    expect(archived.ok).toBe(true);
    await expect(svc.joinAsPhone(id)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_ARCHIVED' },
    });
    await expect(svc.joinAsPhone('ch-nonexistent')).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
  });

  it('D13: historyFromSeq 0 after join — full prior history readable (contrast with D4\'s late-join floor)', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'full-history', 'private');
    for (let i = 1; i <= 3; i++) await post(svc, id, `past-${i}`); // seq 1..3
    const joined = await svc.joinAsPhone(id);
    expect(joined.ok).toBe(true);

    // All 3 past messages + the operator-join system message (seq 4) are visible.
    const page = svc.messagesForPhone(id, 0, undefined);
    expect(page.ok && page.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
  });
});

// ─── Review-fix regressions (2026-09-13 code review) ────────────────────────

describe('phone channel Inbox — review-fix regressions (trash filter, TOCTOU, excerpt, self-mention)', () => {
  it('a trashed (pending deletion) channel drops out of the list and detail routes return CHANNEL_NOT_FOUND — contract: deleted channels collapse to 404', async () => {
    const { svc } = makeService();
    const liveId = await createChannel(svc, 'live', 'public');
    const trashedId = await createChannel(svc, 'doomed', 'public');
    const trashed = await svc.trash({
      channelId: trashedId,
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    expect(trashed.ok).toBe(true);

    // List: the pending-deletion channel is gone on the next fetch (no error surface).
    expect(svc.listForPhone().map((r) => r.channelId)).toEqual([liveId]);

    // messages/ack/join all return CHANNEL_NOT_FOUND — the trash does not exist for the phone.
    expect(svc.messagesForPhone(trashedId, 0, undefined)).toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
    await expect(svc.ackAsPhone(trashedId, 1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
    await expect(svc.joinAsPhone(trashedId)).resolves.toMatchObject({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND' },
    });
  });

  it('if the seat vanishes between the check and the ack, NOT_A_MEMBER also maps to NO_SEAT — no 500 internal leak', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'race', 'private');
    await takeSeat(svc, id);

    // ackAsPhone's outer seat check is advisory. This reproduces ack() returning
    // NOT_A_MEMBER after the seat is gone: remove the seat, then call ack — the
    // service layer must fold that error into NO_SEAT (contract §9: 400 no-seat).
    const leave = await svc.leave({
      channelId: id,
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    expect(leave.ok).toBe(true);

    // Ack without a seat — must answer with the same error code as the path that
    // slips past the outer check. (The service re-checks the seat before ack, so
    // the normal path yields NO_SEAT too; what this test pins is the contract that
    // NOT_A_MEMBER never leaks out as a 500 — the mapping happens inside ackAsPhone.)
    await expect(svc.ackAsPhone(id, 1)).resolves.toMatchObject({
      ok: false,
      error: { code: 'NO_SEAT' },
    });
  });

  it('the excerpt never cuts a surrogate pair (emoji) in half', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'emoji', 'private');
    await takeSeat(svc, id);
    const seen: ChannelMentionNotification[] = [];
    svc.onMention((n) => seen.push(n));

    // '🎉' is 2 UTF-16 code units — a code-unit slice(0, 200) would land the cap
    // mid-pair (at unit 199+1) and serialize a lone surrogate into JSON. With
    // code-point truncation 🎉 is exactly the 200th character: '@operator '
    // (10 chars) + 189 'a' = 199 code points, then 🎉.
    const text = `@operator ${'a'.repeat(189)}🎉🎉🎉`;
    await post(svc, id, text, [{ workspaceId: HUMAN_WORKSPACE_ID }]);

    expect(seen).toHaveLength(1);
    const excerpt = seen[0].text;
    // No replacement character or lone surrogate, and the last character is a whole emoji.
    expect(excerpt).not.toContain('�');
    expect(excerpt.endsWith('🎉')).toBe(true);
    expect(Array.from(excerpt).length).toBe(PHONE_MENTION_EXCERPT_MAX);
  });

  it('no event when the human\'s own post mentions themself — aligned with unreadFor\'s self-authored exemption', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'self', 'private');
    await takeSeat(svc, id);
    const seen: ChannelMentionNotification[] = [];
    svc.onMention((n) => seen.push(n));

    // A post by the desktop human seat that mentions itself — unreadFor does not
    // count it as owed (self-authored exemption), so channel.mention must not fire
    // either. If they diverged, the badge (unreadMentions=0) and the event would
    // disagree. (ws-human has a single row, so post's sender-row mapping always
    // resolves to HUMAN_MEMBER_ID — human posts from any other surface fall under
    // this exemption too.)
    const self = await svc.post({
      channelId: id,
      sender: {
        workspaceId: HUMAN_WORKSPACE_ID,
        memberId: HUMAN_MEMBER_ID,
        memberName: 'Operator',
      },
      text: 'note to self @operator',
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
      mentions: [{ workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' }],
    });
    expect(self.ok).toBe(true);
    expect(seen).toHaveLength(0);
  });
});

describe('phone channel Inbox — panel-review fixes (retention gap, archived unread, head clamp)', () => {
  it('a cursor below the oldest retained seq reports gap — on the page and on the seated list row', async () => {
    const seed = makeService();
    const id = await createChannel(seed.svc, 'busy', 'public');
    await takeSeat(seed.svc, id); // seq 1 = operator-join, cursor 1
    for (let i = 0; i < 10; i += 1) await post(seed.svc, id, `m${i + 2}`); // seqs 2..11
    // Simulate the per-channel retention cap: everything below seq 7 was evicted.
    const state = seed.writer.load();
    state.messages[id] = state.messages[id].filter((m) => m.seq >= 7);
    const { svc } = makeService(state);

    const page = svc.messagesForPhone(id, 1, 50);
    expect(page).toMatchObject({ ok: true, oldestRetainedSeq: 7, gap: true, nextSince: 11 });
    if (!page.ok) throw new Error('unreachable');
    expect(page.messages.map((m) => m.seq)).toEqual([7, 8, 9, 10, 11]);
    // Continuing from a retained cursor is contiguous again.
    expect(svc.messagesForPhone(id, 8, 50)).toMatchObject({ ok: true, gap: false });

    const row = svc.listForPhone().find((r) => r.channelId === id)!;
    expect(row).toMatchObject({ oldestRetainedSeq: 7, gap: true, unread: 5 });

    await svc.ackAsPhone(id, 11);
    const caughtUp = svc.listForPhone().find((r) => r.channelId === id)!;
    expect(caughtUp.unread).toBe(0);
    expect('gap' in caughtUp).toBe(false);
  });

  it('an archived seated channel keeps reporting its real unread and mentions, and can be acked', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'done', 'private');
    await takeSeat(svc, id);
    await post(svc, id, 'a');
    await post(svc, id, '@operator look', [{ workspaceId: HUMAN_WORKSPACE_ID }]);
    const archived = await svc.archive({ channelId: id, archivedBy: AGENT.workspaceId, verifiedWorkspaceId: AGENT.workspaceId });
    expect(archived.ok).toBe(true);
    expect(svc.listForPhone().find((r) => r.channelId === id)).toMatchObject({ unread: 2, unreadMentions: 1 });
    await expect(svc.ackAsPhone(id, 99)).resolves.toMatchObject({ ok: true });
    expect(svc.listForPhone().find((r) => r.channelId === id)).toMatchObject({ unread: 0, unreadMentions: 0 });
  });

  it('an empty page clamps nextSince to the channel head instead of echoing a cursor above it', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'quiet', 'public');
    await post(svc, id, 'only'); // seq 1
    expect(svc.messagesForPhone(id, 500, 50)).toMatchObject({ ok: true, messages: [], nextSince: 1, gap: false });
  });
});
