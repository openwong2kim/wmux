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
    ...(state.observerCursors ? { observerCursors: { ...state.observerCursors } } : {}),
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

    // Public + no seat: neither an observed stamp nor a seat cursor (withObservedFlag rule).
    // #1318: mentions reach the human without a seat, so the row counts them —
    // under their own field, so the seat fields still mean "seated".
    expect(pub.visibility).toBe('public');
    expect('observed' in pub).toBe(false);
    expect('lastReadSeq' in pub).toBe(false);
    expect('unreadMentions' in pub).toBe(false);
    expect(pub.observerUnreadMentions).toBe(0);

    // Private without a seat: observed:true, all seat cursor/unread fields absent;
    // #1318 adds observerUnreadMentions (the observer cursor has not moved yet →
    // no observerLastReadSeq).
    expect(observed.visibility).toBe('private');
    expect(observed.observed).toBe(true);
    expect('lastReadSeq' in observed).toBe(false);
    expect('unread' in observed).toBe(false);
    expect('unreadMentions' in observed).toBe(false);
    expect('observerLastReadSeq' in observed).toBe(false);
    expect(observed.observerUnreadMentions).toBe(0);

    // Seated rows never carry the observer fields.
    expect('observerUnreadMentions' in joined).toBe(false);

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

  it('D6 (#1318): ack on an observed channel without a seat advances the observer cursor — clamped, advance-only, no seat created', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'secret', 'private');
    await post(svc, id, 'one'); // seq 1
    await post(svc, id, 'two'); // seq 2
    await expect(svc.ackAsPhone(id, 99)).resolves.toEqual({ ok: true, lastReadSeq: 2 });
    await expect(svc.ackAsPhone(id, 1)).resolves.toEqual({ ok: true, lastReadSeq: 2 });
    expect(svc.listForPhone().find((r) => r.channelId === id)).toMatchObject({ observed: true, observerLastReadSeq: 2 });
    expect(svc.getMembers(id, HUMAN_WORKSPACE_ID).some((m) => m.workspaceId === HUMAN_WORKSPACE_ID)).toBe(false);
  });
});

describe('phone channel Inbox — mention promotion (D7)', () => {
  it('D7: a mention post fires channel.mention for the human — a channel the human cannot observe (trashed) carries no mention and no event', async () => {
    const { svc } = makeService();
    const seatedId = await createChannel(svc, 'seated', 'private');
    await takeSeat(svc, seatedId);
    // #1318: a seat is no longer required, observation is. The one live
    // channel the human cannot observe is a trashed one, and the trash also
    // archives it, so the post itself is refused — nothing to deliver or count.
    const trashedId = await createChannel(svc, 'trashed', 'private');
    expect((await svc.trash({ channelId: trashedId, verifiedWorkspaceId: HUMAN_WORKSPACE_ID })).ok).toBe(true);

    const seen: ChannelMentionNotification[] = [];
    svc.onMention((n) => seen.push(n));

    const refused = await svc.post({
      channelId: trashedId,
      sender: AGENT,
      text: '@operator mention nobody can see',
      verifiedWorkspaceId: AGENT.workspaceId,
      mentions: [{ workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' }],
    });
    expect(refused).toMatchObject({ ok: false, error: { code: 'CHANNEL_ARCHIVED' } });
    expect(seen).toHaveLength(0);
    expect(svc.listForPhone().some((r) => r.channelId === trashedId)).toBe(false);

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
    // #1318: a mention before the seat already reaches the observing human.
    await post(svc, id, '@operator (before join)', [{ workspaceId: HUMAN_WORKSPACE_ID }]);
    expect(seen).toHaveLength(1);

    // join: the pre-join mention consumed seq 3 and the system message
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

    // Mentions keep firing after the join.
    await post(svc, id, '@operator visible now', [{ workspaceId: HUMAN_WORKSPACE_ID }]);
    expect(seen).toHaveLength(2);

    // Idempotent re-join — alreadyMember rather than an error, and no event.
    const again = await svc.joinAsPhone(id);
    expect(again).toMatchObject({ ok: true, alreadyMember: true, lastReadSeq: 3 });
    expect(seen).toHaveLength(2);
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

  it('#1318: seat vs observer is decided under the lock — a seat taken while the ack waits gets the ack', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'race-join', 'private');
    await post(svc, id, '@operator before', [{ workspaceId: HUMAN_WORKSPACE_ID }]); // seq 1
    // The join holds the channel lock first; the ack queues behind it.
    const joining = takeSeat(svc, id); // seat cursor 1, system message seq 2
    const acking = svc.ackAsPhone(id, 2);
    expect((await joining).ok).toBe(true);
    await expect(acking).resolves.toEqual({ ok: true, lastReadSeq: 2 });
    const row = svc.listForPhone().find((r) => r.channelId === id)!;
    expect(row.lastReadSeq).toBe(2);
    expect('observerLastReadSeq' in row).toBe(false);
  });

  it('#1318: a seat left while the ack waits sends it to the observer cursor, not an error', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'race-leave', 'private');
    await takeSeat(svc, id); // system message seq 1
    await post(svc, id, 'chatter'); // seq 2
    const leaving = svc.leave({
      channelId: id,
      workspaceId: HUMAN_WORKSPACE_ID,
      memberId: HUMAN_MEMBER_ID,
      verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
    });
    const acking = svc.ackAsPhone(id, 2);
    expect((await leaving).ok).toBe(true);
    await expect(acking).resolves.toEqual({ ok: true, lastReadSeq: 2 });
    expect(svc.listForPhone().find((r) => r.channelId === id)).toMatchObject({ observerLastReadSeq: 2 });
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

describe('a mention reaches the observing human without a seat (#1318)', () => {
  const mentionHuman = [{ workspaceId: HUMAN_WORKSPACE_ID }];
  const humanRows = (svc: ChannelService, id: string) =>
    svc.getMembers(id, HUMAN_WORKSPACE_ID).filter((m) => m.workspaceId === HUMAN_WORKSPACE_ID);
  const rowOf = (svc: ChannelService, id: string) => svc.listForPhone().find((r) => r.channelId === id);

  it('kept, delivered and counted on the observed row — membership, seqs and member cursors untouched', async () => {
    const { svc, emit } = makeService();
    const id = await createChannel(svc, 'mission', 'private');
    await post(svc, id, 'before'); // seq 1
    const seen: ChannelMentionNotification[] = [];
    svc.onMention((n) => seen.push(n));

    const res = await post(svc, id, '@operator build is green', mentionHuman);

    expect(res.droppedMentions).toBeUndefined();
    expect(res.message.seq).toBe(2);
    expect(res.message.mentions).toEqual([{ workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' }]);
    // Not a recipient, not a member, no system row.
    expect(res.message.recipientSnapshot?.map((r) => r.workspaceId)).toEqual([AGENT.workspaceId]);
    expect(humanRows(svc, id)).toEqual([]);
    expect(svc.getMessages(id, 0, HUMAN_WORKSPACE_ID).some((m) => m.systemKind)).toBe(false);
    // A caught-up sender still rides its cursor over its own post.
    expect(svc.getMembers(id, AGENT.workspaceId)[0].lastReadSeq).toBe(2);
    // Delivered: the phone event, and the same mentions on the desktop's channel.message.
    expect(seen.map((n) => [n.channelId, n.seq])).toEqual([[id, 2]]);
    const event = emit.mock.calls.map((c) => c[0]).find((e) => e.type === 'channel.message' && e.seq === 2);
    expect(event && 'message' in event ? event.message.mentions : undefined).toEqual(res.message.mentions);
    // Counted for the observer until read.
    expect(rowOf(svc, id)).toMatchObject({ observed: true, observerUnreadMentions: 1 });
    expect('unread' in rowOf(svc, id)!).toBe(false);
  });

  it('the phone ack clears it; a later mention counts again', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'room', 'public');
    const first = await post(svc, id, '@operator one', mentionHuman);
    expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
    await expect(svc.ackAsPhone(id, first.message.seq)).resolves.toEqual({ ok: true, lastReadSeq: first.message.seq });
    expect(rowOf(svc, id)).toMatchObject({ observerUnreadMentions: 0, observerLastReadSeq: first.message.seq });
    await post(svc, id, 'plain chatter');
    await post(svc, id, '@operator two', mentionHuman);
    expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
  });

  it('opening the channel at the desktop moves the same observer cursor (one read state for both surfaces)', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'room', 'private');
    const m = await post(svc, id, '@operator ping', mentionHuman);
    // The renderer's open-channel ack: ws-human, no memberId.
    await expect(
      svc.ack({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID, uptoSeq: m.message.seq }),
    ).resolves.toEqual({ ok: true, acked: 0 });
    expect(rowOf(svc, id)).toMatchObject({ observerUnreadMentions: 0, observerLastReadSeq: m.message.seq });
    expect(humanRows(svc, id)).toEqual([]);
  });

  it('a mention from while the human held a seat is not re-counted after it leaves', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'room', 'private');
    await takeSeat(svc, id);
    await post(svc, id, '@operator seated-era', mentionHuman);
    expect(
      (
        await svc.leave({
          channelId: id,
          workspaceId: HUMAN_WORKSPACE_ID,
          memberId: HUMAN_MEMBER_ID,
          verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
        })
      ).ok,
    ).toBe(true);
    expect(rowOf(svc, id)).toMatchObject({ observed: true, observerUnreadMentions: 0 });
  });

  it('a mention from before a join stays read after the human leaves again (joining moves the observer cursor)', async () => {
    for (const join of ['operatorJoin', 'join'] as const) {
      const { svc } = makeService();
      const id = await createChannel(svc, `cycle-${join}`, 'public');
      await post(svc, id, '@operator before the join', mentionHuman);
      expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
      const joined =
        join === 'operatorJoin'
          ? await takeSeat(svc, id)
          : await svc.join({
              channelId: id,
              member: { workspaceId: HUMAN_WORKSPACE_ID, memberId: HUMAN_MEMBER_ID },
              verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
            });
      expect(joined.ok).toBe(true);
      const left = await svc.leave({
        channelId: id,
        workspaceId: HUMAN_WORKSPACE_ID,
        memberId: HUMAN_MEMBER_ID,
        verifiedWorkspaceId: HUMAN_WORKSPACE_ID,
      });
      expect(left.ok).toBe(true);
      expect(rowOf(svc, id)?.observerUnreadMentions).toBe(0);
      // A mention after the leave counts again.
      await post(svc, id, '@operator after the leave', mentionHuman);
      expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
    }
  });

  it('the desktop open of a seatless channel still flips the human receipts left from a seat it gave up', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'once-seated', 'public');
    await takeSeat(svc, id); // seq 1 (system)
    const posted = await post(svc, id, 'while seated'); // seq 2, ws-human receipt pending
    expect(posted.message.recipientSnapshot?.some((r) => r.workspaceId === HUMAN_WORKSPACE_ID && r.status === 'pending')).toBe(true);
    await svc.leave({ channelId: id, workspaceId: HUMAN_WORKSPACE_ID, memberId: HUMAN_MEMBER_ID, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    await expect(svc.ack({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID, uptoSeq: 2 })).resolves.toMatchObject({ ok: true, acked: 1 });
    const msg = svc.getMessages(id, 0, HUMAN_WORKSPACE_ID).find((m) => m.seq === 2);
    expect(msg?.recipientSnapshot?.find((r) => r.workspaceId === HUMAN_WORKSPACE_ID)?.status).toBe('delivered');
    expect(rowOf(svc, id)).toMatchObject({ observerLastReadSeq: 2 });
  });

  it('a leave carries the seat cursor over, so the seatless row is not left behind what the human read', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'read-then-leave', 'public');
    await takeSeat(svc, id); // seat cursor 0, system seq 1
    for (const t of ['a', 'b', 'c']) await post(svc, id, t); // seq 2..4
    await svc.ackAsPhone(id, 4); // seat cursor 4
    await svc.leave({ channelId: id, workspaceId: HUMAN_WORKSPACE_ID, memberId: HUMAN_MEMBER_ID, verifiedWorkspaceId: HUMAN_WORKSPACE_ID });
    expect(rowOf(svc, id)).toMatchObject({ observerUnreadMentions: 0, observerLastReadSeq: 4 });
  });

  it('a pane-pinned mention of the human is delivered without reporting the human dropped', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'pinned', 'private');
    const res = await svc.post({
      channelId: id,
      sender: AGENT,
      text: '@operator',
      verifiedWorkspaceId: AGENT.workspaceId,
      mentions: [{ workspaceId: HUMAN_WORKSPACE_ID, paneId: 'p1', name: 'Operator' }],
    });
    if (!res.ok) throw new Error(res.error.code);
    expect(res.droppedMentions).toBeUndefined();
    expect(res.message.mentions).toEqual([{ workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' }]);
    expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
  });

  it('the desktop catalog carries the same count (ws-human only, seatless only) and a read signals it to re-hydrate', async () => {
    const { svc, emit } = makeService();
    const seatless = await createChannel(svc, 'seatless', 'public');
    const seated = await createChannel(svc, 'seated', 'public');
    await takeSeat(svc, seated);
    await post(svc, seatless, '@operator one', mentionHuman);
    await post(svc, seatless, 'chatter');
    await post(svc, seatless, '@operator two', mentionHuman);
    const human = svc.list(HUMAN_WORKSPACE_ID);
    expect(human.find((c) => c.id === seatless)?.observerUnreadMentions).toBe(2);
    expect('observerUnreadMentions' in human.find((c) => c.id === seated)!).toBe(false);
    expect('observerUnreadMentions' in svc.list(AGENT.workspaceId).find((c) => c.id === seatless)!).toBe(false);
    expect(svc.get(seatless, HUMAN_WORKSPACE_ID)?.observerUnreadMentions).toBe(2);
    // The live row is never stamped (the field must not persist).
    expect('observerUnreadMentions' in (svc as unknown as { state: ChannelState }).state.channels.find((c) => c.id === seatless)!).toBe(false);

    emit.mockClear();
    await svc.ackAsPhone(seatless, 1);
    expect(svc.list(HUMAN_WORKSPACE_ID).find((c) => c.id === seatless)?.observerUnreadMentions).toBe(1);
    expect(
      emit.mock.calls.some(
        ([e]) => e.type === 'channel.catalog' && e.channelId === seatless && e.recipientWorkspaceIds.includes(HUMAN_WORKSPACE_ID),
      ),
    ).toBe(true);
    // More posts after the ack are counted on top (the count resumes, not rescans).
    await post(svc, seatless, '@operator three', mentionHuman);
    expect(rowOf(svc, seatless)?.observerUnreadMentions).toBe(2);
  });

  it('destroying a channel drops its observer-count memo (no message array kept alive)', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'short-lived', 'public');
    await post(svc, id, '@operator ping', mentionHuman);
    expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
    const memo = (svc as unknown as { observerMentionMemo: Map<string, unknown> }).observerMentionMemo;
    expect(memo.has(id)).toBe(true);
    expect((await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID })).ok).toBe(true);
    expect((await svc.destroy({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID })).ok).toBe(true);
    expect(memo.has(id)).toBe(false);
  });

  it('the desktop open of a trashed channel writes no observer cursor', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'binned', 'public');
    await post(svc, id, '@operator ping', mentionHuman);
    expect((await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID })).ok).toBe(true);
    await svc.ack({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID, uptoSeq: 1 });
    expect((svc as unknown as { state: ChannelState }).state.observerCursors?.[id]).toBeUndefined();
  });

  it('only the human is exempt: a mention of another non-member workspace is still dropped', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'room', 'private');
    const other = await post(svc, id, '@other', [{ workspaceId: 'ws-other' }]);
    expect(other.droppedMentions?.map((d) => d.workspaceId)).toEqual(['ws-other']);
    expect(other.message.mentions).toBeUndefined();
    expect(rowOf(svc, id)?.observerUnreadMentions).toBe(0);
  });

  it('mixed scopes for the human in one post: delivered once, never also reported dropped (either order)', async () => {
    for (const order of ['scoped-first', 'unscoped-first'] as const) {
      const { svc } = makeService();
      const id = await createChannel(svc, `room-${order}`, 'private');
      const seen: ChannelMentionNotification[] = [];
      svc.onMention((n) => seen.push(n));
      const scoped = { workspaceId: HUMAN_WORKSPACE_ID, memberId: 'someone-else', name: 'X' };
      const unscoped = { workspaceId: HUMAN_WORKSPACE_ID, name: 'Operator' };
      const res = await svc.post({
        channelId: id,
        sender: AGENT,
        text: '@operator @X',
        verifiedWorkspaceId: AGENT.workspaceId,
        mentions: order === 'scoped-first' ? [scoped, unscoped] : [unscoped, scoped],
      });
      if (!res.ok) throw new Error(res.error.code);
      expect(res.droppedMentions).toBeUndefined();
      expect(res.message.mentions?.map((m) => m.workspaceId)).toEqual([HUMAN_WORKSPACE_ID]);
      // Any scope on a seatless human mention is the human's one seat id.
      expect([undefined, HUMAN_MEMBER_ID]).toContain(res.message.mentions?.[0].memberId);
      expect(seen).toHaveLength(1);
      expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
    }
  });

  it('a trashed channel is not observable to the phone: left out of the list, its ack is CHANNEL_NOT_FOUND', async () => {
    const { svc } = makeService();
    const id = await createChannel(svc, 'doomed', 'public');
    await post(svc, id, '@operator before the trash', mentionHuman);
    expect(rowOf(svc, id)?.observerUnreadMentions).toBe(1);
    expect((await svc.trash({ channelId: id, verifiedWorkspaceId: HUMAN_WORKSPACE_ID })).ok).toBe(true);
    expect(rowOf(svc, id)).toBeUndefined();
    await expect(svc.ackAsPhone(id, 1)).resolves.toMatchObject({ ok: false, error: { code: 'CHANNEL_NOT_FOUND' } });
  });

  it('the observer cursor survives a restart (legacy state reload)', async () => {
    const { svc, writer } = makeService();
    const id = await createChannel(svc, 'room', 'private');
    const first = await post(svc, id, '@operator one', mentionHuman);
    await post(svc, id, '@operator two', mentionHuman);
    await svc.ackAsPhone(id, first.message.seq);
    expect(rowOf(svc, id)).toMatchObject({ observerUnreadMentions: 1, observerLastReadSeq: first.message.seq });

    const reloaded = makeService(writer.load()).svc;
    expect(rowOf(reloaded, id)).toMatchObject({ observed: true, observerUnreadMentions: 1, observerLastReadSeq: first.message.seq });
  });

  it('state written before observer cursors existed loads: no cursor reads as 0, nothing new is counted', async () => {
    const { svc, writer } = makeService();
    const id = await createChannel(svc, 'room', 'private');
    await post(svc, id, 'plain');
    const old = writer.load();
    delete old.observerCursors;
    expect('observerCursors' in old).toBe(false);
    const reloaded = makeService(old).svc;
    expect(rowOf(reloaded, id)).toMatchObject({ observed: true, observerUnreadMentions: 0 });
    expect('observerLastReadSeq' in rowOf(reloaded, id)!).toBe(false);
    // And the first ack on it starts the map.
    await expect(reloaded.ackAsPhone(id, 1)).resolves.toEqual({ ok: true, lastReadSeq: 1 });
  });
});
