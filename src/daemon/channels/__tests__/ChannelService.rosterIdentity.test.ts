// ─── 1b/1c — server-owned roster identity ────────────────────────────
// 1b: member rows carry a daemon-derived `memberName` (principal registry
// display, else the memberId); post() renders the message identity from the
// ROSTER ROW, never the caller's free text once a row is known.
// 1c: a post whose memberId matches no roster row of its (verified)
// workspace is mapped onto the workspace's SINGLE row (fixing the
// self-cursor-ride miss that made the wake worker re-nudge a sender about
// its own message); with multiple rows it keeps the client id and echoes
// `unmatchedMemberId`.
//
// Plan reference: channels-remediation-plan-2026-07-05.md §1b/§1c.

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

function makeService(opts: {
  initialState?: ChannelState;
  resolvePrincipalDisplay?: (principalId: string) => string | undefined;
  /** Panes the pin gate should be able to prove. Omit when the test posts no
   *  pane-pinned mention — an absent resolver refuses every pin by design. */
  panes?: { workspaceId: string; paneId: string; ptyId: string }[];
} = {}) {
  const writer = makeFakeWriter(opts.initialState);
  const emit = vi.fn<ChannelServiceEmit>();
  const svc = new ChannelService({
    writer: writer as unknown as ConstructorParameters<typeof ChannelService>[0]['writer'],
    companyId: COMPANY,
    emit,
    now: () => 1_700_000_000_000,
    resolvePrincipalDisplay: opts.resolvePrincipalDisplay,
    ...(opts.panes
      ? {
          resolvePanePrincipal: (workspaceId: string, paneId: string) => {
            const hit = opts.panes?.find(
              (p) => p.workspaceId === workspaceId && p.paneId === paneId,
            );
            return hit ? { ptyId: hit.ptyId } : undefined;
          },
        }
      : {}),
  });
  return { svc, writer, emit };
}

async function createChannel(svc: ChannelService, extra: Partial<Parameters<ChannelService['create']>[0]> = {}) {
  const created = await svc.create({
    name: 'general',
    visibility: 'public',
    createdBy: { workspaceId: 'ws-1', memberId: 'w1-1(claude)' },
    verifiedWorkspaceId: 'ws-1',
    ...extra,
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  return created.channel;
}

describe('1b — roster rows carry a server-derived memberName', () => {
  it('create: creator + seeded members derive from the principal registry, falling back to memberId', async () => {
    const registry: Record<string, string> = { 'pane:ws-2/p-9': 'w2-1(codex)' };
    const { svc } = makeService({ resolvePrincipalDisplay: (id) => registry[id] });
    const channel = await createChannel(svc, {
      members: [
        // Registry hit → display name.
        { workspaceId: 'ws-2', memberId: 'raw-id', principalId: 'pane:ws-2/p-9' },
        // Registry miss → memberId fallback.
        { workspaceId: 'ws-3', memberId: 'w3-1(gemini)', principalId: 'pane:ws-3/p-1' },
      ],
    });
    const members = svc.getMembers(channel.id, 'ws-1');
    const byWs = Object.fromEntries(members.map((m) => [m.workspaceId, m.memberName]));
    expect(byWs['ws-1']).toBe('w1-1(claude)'); // creator: no principal → memberId
    expect(byWs['ws-2']).toBe('w2-1(codex)'); // registry display
    expect(byWs['ws-3']).toBe('w3-1(gemini)'); // miss → memberId
  });

  it('join and invite derive the same way, and a resolver throw degrades to the memberId', async () => {
    const resolver = vi.fn((id: string) => {
      if (id === 'pane:ws-4/p-2') return 'w4-1(aider)';
      throw new Error('registry unavailable');
    });
    const { svc } = makeService({ resolvePrincipalDisplay: resolver });
    const channel = await createChannel(svc);
    const joined = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'raw-join-id', principalId: 'pane:ws-4/p-2' },
      verifiedWorkspaceId: 'ws-4',
    });
    expect(joined.ok).toBe(true);
    const invited = await svc.invite({
      channelId: channel.id,
      invitedMember: { workspaceId: 'ws-5', memberId: 'w5-1(x)', principalId: 'pane:ws-5/p-3' },
      verifiedWorkspaceId: 'ws-1',
    });
    expect(invited.ok).toBe(true);
    const members = svc.getMembers(channel.id, 'ws-1');
    const byWs = Object.fromEntries(members.map((m) => [m.workspaceId, m.memberName]));
    expect(byWs['ws-4']).toBe('w4-1(aider)');
    expect(byWs['ws-5']).toBe('w5-1(x)'); // resolver threw → memberId fallback
  });

  it('post renders the message name from the ROSTER row, not the caller free text', async () => {
    const { svc } = makeService({ resolvePrincipalDisplay: () => 'Roster Display' });
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-2', memberId: 'w2-1(codex)', principalId: 'pane:x' }],
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-2', memberId: 'w2-1(codex)', memberName: 'Forged Fancy Name' },
      text: 'hello',
      verifiedWorkspaceId: 'ws-2',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) {
      expect(posted.message.memberName).toBe('Roster Display');
      expect(posted.message.memberId).toBe('w2-1(codex)');
    }
  });

  it('legacy roster rows without memberName fall back to the row memberId (no migration)', async () => {
    // Simulate a pre-1b persisted state: member row lacks memberName.
    const state = freshState();
    state.channels.push({
      id: 'ch-legacy', companyId: COMPANY, name: 'old', visibility: 'public',
      status: 'active', createdAt: 1, createdBy: 'ws-1', nextSeq: 1,
    });
    state.members['ch-legacy'] = [
      { workspaceId: 'ws-1', memberId: 'legacy-agent', joinedAt: 1, historyFromSeq: 0, lastReadSeq: 0 },
    ];
    state.messages['ch-legacy'] = [];
    state.idempotency['ch-legacy'] = {};
    const { svc } = makeService({ initialState: state });
    const posted = await svc.post({
      channelId: 'ch-legacy',
      sender: { workspaceId: 'ws-1', memberId: 'legacy-agent', memberName: 'Client Sent This' },
      text: 'hi',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) expect(posted.message.memberName).toBe('legacy-agent');
  });

  it('sender.memberName is fully optional (new MCP wire shape)', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc);
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'w1-1(claude)' },
      text: 'no name field at all',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) expect(posted.message.memberName).toBe('w1-1(claude)');
  });
});

describe('1c — ghost memberId mapping and feedback', () => {
  it('single-row workspace: a ghost memberId maps onto the roster row AND rides its cursor (self-re-nudge fix)', async () => {
    const { svc, emit } = makeService();
    const channel = await createChannel(svc); // single row: (ws-1, 'w1-1(claude)'), lastReadSeq 0
    const posted = await svc.post({
      channelId: channel.id,
      // The classic ghost: MCP/CLI posting under a stale default while the
      // roster row uses the auto-name.
      sender: { workspaceId: 'ws-1', memberId: 'agent', memberName: 'agent' },
      text: 'mapped?',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.memberId).toBe('w1-1(claude)'); // mapped, not 'agent'
    expect(posted.unmatchedMemberId).toBeUndefined();
    // Cursor rode: the sender's ROW consumed its own message → no self-unread.
    const members = svc.getMembers(channel.id, 'ws-1');
    expect(members[0].lastReadSeq).toBe(posted.message.seq);
    // The broadcast event mirrors the RESOLVED identity.
    const messageEvent = emit.mock.calls.map(([e]) => e).find((e) => e.type === 'channel.message') as
      | { sender: { memberId: string } }
      | undefined;
    expect(messageEvent?.sender.memberId).toBe('w1-1(claude)');
  });

  it('multi-row workspace: an unmatched memberId keeps the client id, echoes unmatchedMemberId, and rides NO cursor', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-1', memberId: 'w1-2(codex)' }], // second seat, same workspace
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'ghost', memberName: 'ghost' },
      text: 'ambiguous',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.memberId).toBe('ghost');
    expect(posted.unmatchedMemberId).toBe('ghost');
    const members = svc.getMembers(channel.id, 'ws-1');
    // Neither seat's cursor moved — the daemon must not guess between seats.
    for (const m of members) {
      expect(m.lastReadSeq).toBe(0);
    }
  });

  it('regression: create→post with a DIFFERENT memberId still succeeds (the old NOT_A_MEMBER bug stays dead)', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc);
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'other-id', memberName: 'x' },
      text: 'still allowed',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    // GLM review: pin the 1c behavior too — single-row workspace maps the
    // ghost id onto the roster seat with no warning.
    if (posted.ok) {
      expect(posted.message.memberId).toBe('w1-1(claude)');
      expect(posted.unmatchedMemberId).toBeUndefined();
    }
  });

  it('exact (workspaceId, memberId) match is used verbatim — no mapping, no warning', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-1', memberId: 'w1-2(codex)' }],
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'w1-2(codex)', memberName: 'ignored' },
      text: 'exact',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.message.memberId).toBe('w1-2(codex)');
    expect(posted.unmatchedMemberId).toBeUndefined();
  });
});


describe('1c — feedback + mention hardening (code-review round)', () => {
  it('idempotent replay re-emits unmatchedMemberId (Codex #2)', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-1', memberId: 'w1-2(codex)' }], // multi-row ws-1
    });
    const first = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'ghost', memberName: 'ghost' },
      text: 'retry me',
      clientMsgId: 'c-1',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.unmatchedMemberId).toBe('ghost');
    const replay = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'ghost', memberName: 'ghost' },
      text: 'retry me',
      clientMsgId: 'c-1',
      verifiedWorkspaceId: 'ws-1',
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.idempotent).toBe(true);
      expect(replay.unmatchedMemberId).toBe('ghost'); // warning survives the retry
    }
  });

  it('mention memberId maps onto a single-row target workspace; multi-row stays verbatim (Codex #3)', async () => {
    // p-2 must be registry-proven: the third mention is identified by its pane
    // pin, and the daemon strips a pin it cannot prove.
    const { svc } = makeService({ panes: [{ workspaceId: 'ws-3', paneId: 'p-2', ptyId: 'pty-3-2' }] });
    const channel = await createChannel(svc, {
      members: [
        { workspaceId: 'ws-2', memberId: 'w2-1(codex)' },          // single row
        { workspaceId: 'ws-3', memberId: 'w3-1(a)' },
        { workspaceId: 'ws-3', memberId: 'w3-2(b)' },              // multi row
      ],
    });
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-1', memberId: 'w1-1(claude)' },
      text: 'pings',
      mentions: [
        { workspaceId: 'ws-2', name: 'x', memberId: 'stale-id' },  // ghost → map
        { workspaceId: 'ws-3', name: 'y', memberId: 'ghost-3' },   // ambiguous → verbatim
        { workspaceId: 'ws-3', name: 'z', memberId: 'w3-2(b)', paneId: 'p-2' }, // exact → keep
      ],
      verifiedWorkspaceId: 'ws-1',
    });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    const mns = posted.message.mentions ?? [];
    expect(mns.find((m) => m.workspaceId === 'ws-2')?.memberId).toBe('w2-1(codex)');
    expect(mns.find((m) => m.workspaceId === 'ws-3' && !m.paneId)?.memberId).toBe('ghost-3');
    expect(mns.find((m) => m.paneId === 'p-2')?.memberId).toBe('w3-2(b)');
  });
});

describe('1b — post-time roster name refresh (Codex #4)', () => {
  it('an agent swap on the pane refreshes the roster name on the next post', async () => {
    let display = 'w2-1(claude)';
    const { svc } = makeService({ resolvePrincipalDisplay: () => display });
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-2', memberId: 'seat-2', principalId: 'pane:ws-2/p-1' }],
    });
    display = 'w2-1(codex)'; // agent swap: registry display moved on
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-2', memberId: 'seat-2' },
      text: 'after swap',
      verifiedWorkspaceId: 'ws-2',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) expect(posted.message.memberName).toBe('w2-1(codex)');
    const row = svc.getMembers(channel.id, 'ws-2').find((m) => m.memberId === 'seat-2');
    expect(row?.memberName).toBe('w2-1(codex)'); // row persisted with the fresh name
  });

  it('a registry MISS never downgrades an existing roster name', async () => {
    let hit = true;
    const { svc } = makeService({
      resolvePrincipalDisplay: () => (hit ? 'w2-1(claude)' : undefined),
    });
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-2', memberId: 'seat-2', principalId: 'pane:ws-2/p-1' }],
    });
    hit = false; // registry transiently empty (e.g. daemon restart backfill)
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-2', memberId: 'seat-2' },
      text: 'registry down',
      verifiedWorkspaceId: 'ws-2',
    });
    expect(posted.ok).toBe(true);
    if (posted.ok) expect(posted.message.memberName).toBe('w2-1(claude)'); // kept
  });
});

describe('1b/1d bridge — join resolves the pane principal from senderPtyId (review F1/F2)', () => {
  const PANE_PRINCIPAL = { id: 'pane:ws-4/p-7', display: 'w4-1(claude)', memberId: 'w4-1(claude)' };
  const byPty = (ptyId: string) => (ptyId === 'pty-77' ? PANE_PRINCIPAL : undefined);

  it('a spawn-stamped default (memberId === senderPtyId) converges onto the canonical auto-name seat', async () => {
    const { svc } = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = byPty;
    const channel = await createChannel(svc);
    const joined = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'pty-77' }, // the 1d default
      verifiedWorkspaceId: 'ws-4',
      senderPtyId: 'pty-77',
    });
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(joined.memberId).toBe('w4-1(claude)');
    const row = svc.getMembers(channel.id, 'ws-4').find((m) => m.workspaceId === 'ws-4');
    expect(row?.memberId).toBe('w4-1(claude)');
    expect(row?.memberName).toBe('w4-1(claude)');
    expect(row?.principalId).toBe('pane:ws-4/p-7');
  });

  it('an EXPLICIT member id is respected (no convergence) but still gets the principal display', async () => {
    const { svc } = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = byPty;
    const channel = await createChannel(svc);
    const joined = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'lead' }, // human-chosen id ≠ senderPtyId
      verifiedWorkspaceId: 'ws-4',
      senderPtyId: 'pty-77',
    });
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(joined.memberId).toBe('lead');
    const row = svc.getMembers(channel.id, 'ws-4').find((m) => m.memberId === 'lead');
    expect(row?.memberName).toBe('w4-1(claude)'); // registry display still wins for the label
  });

  it('the same PANE cannot be seated twice via different entry paths (F2 dedup)', async () => {
    const { svc } = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = byPty;
    const channel = await createChannel(svc);
    // GUI-add path: auto-name memberId + explicit principalId.
    const guiAdd = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'w4-1(claude)', principalId: 'pane:ws-4/p-7' },
      verifiedWorkspaceId: 'ws-4',
    });
    expect(guiAdd.ok).toBe(true);
    // CLI path for the SAME pane: spawn-stamped default + senderPtyId.
    const cliJoin = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'pty-77' },
      verifiedWorkspaceId: 'ws-4',
      senderPtyId: 'pty-77',
    });
    expect(cliJoin.ok).toBe(false);
    if (!cliJoin.ok) {
      expect(cliJoin.error.code).toBe('DUPLICATE_MEMBER');
      expect(cliJoin.error.message).toContain('w4-1(claude)');
    }
    expect(svc.getMembers(channel.id, 'ws-4').filter((m) => m.workspaceId === 'ws-4')).toHaveLength(1);
  });

  it('no registry hit → the join proceeds under the supplied id (headless/legacy)', async () => {
    const { svc } = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = () => undefined;
    const channel = await createChannel(svc);
    const joined = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-9', memberId: 'pty-unknown' },
      verifiedWorkspaceId: 'ws-9',
      senderPtyId: 'pty-unknown',
    });
    expect(joined.ok).toBe(true);
    if (joined.ok) expect(joined.memberId).toBe('pty-unknown');
  });
});


describe('delta re-review fixes (Codex P1 + Claude reproduced defects)', () => {
  it('a REJECTED post (body clamp) never mutates the roster name (refresh sits after all validations)', async () => {
    let display = 'w2-1(claude)';
    const { svc, writer } = makeService({ resolvePrincipalDisplay: () => display });
    const channel = await createChannel(svc, {
      members: [{ workspaceId: 'ws-2', memberId: 'seat-2', principalId: 'pane:ws-2/p-1' }],
    });
    display = 'w2-1(codex)'; // agent swap happened
    const savesBefore = writer.saveImmediate.mock.calls.length;
    const posted = await svc.post({
      channelId: channel.id,
      sender: { workspaceId: 'ws-2', memberId: 'seat-2' },
      text: 'x'.repeat(100_000), // over CHANNEL_BODY_MAX → early return
      verifiedWorkspaceId: 'ws-2',
    });
    expect(posted.ok).toBe(false);
    // No persist happened AND the in-memory row still matches disk.
    expect(writer.saveImmediate.mock.calls.length).toBe(savesBefore);
    const row = svc.getMembers(channel.id, 'ws-2').find((m) => m.memberId === 'seat-2');
    expect(row?.memberName).toBe('w2-1(claude)');
  });

  it('registry-timing double seat is closed: raw-ptyId seat blocks a later converged join (Claude delta ①)', async () => {
    const { svc } = makeService();
    const channel = await createChannel(svc);
    // 1st join: agent not detected yet → registry miss → raw ptyId seat.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = () => undefined;
    const first = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'pty-77' },
      verifiedWorkspaceId: 'ws-4',
      senderPtyId: 'pty-77',
    });
    expect(first.ok).toBe(true);
    // Agent detected between the joins → registry now resolves.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = () => ({
      id: 'pane:ws-4/p-7', display: 'w4-1(claude)', memberId: 'w4-1(claude)',
    });
    const second = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-4', memberId: 'pty-77' },
      verifiedWorkspaceId: 'ws-4',
      senderPtyId: 'pty-77',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.code).toBe('DUPLICATE_MEMBER');
      expect(second.error.message).toContain('pty-77'); // names the pre-registry seat
    }
    expect(svc.getMembers(channel.id, 'ws-4').filter((m) => m.workspaceId === 'ws-4')).toHaveLength(1);
  });

  it('the human seat never takes the pane-principal path even with a forged senderPtyId', async () => {
    const { svc } = makeService();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (svc as any).resolvePrincipalByPtyId = () => ({
      id: 'pane:ws-1/p-9', display: 'w1-1(claude)', memberId: 'w1-1(claude)',
    });
    const channel = await createChannel(svc);
    const joined = await svc.join({
      channelId: channel.id,
      member: { workspaceId: 'ws-human', memberId: 'local-ui' },
      verifiedWorkspaceId: 'ws-human',
      senderPtyId: 'pty-forged',
    });
    expect(joined.ok).toBe(true);
    const row = svc.getMembers(channel.id, 'ws-human').find((m) => m.workspaceId === 'ws-human');
    expect(row?.memberId).toBe('local-ui');       // no convergence
    expect(row?.memberName).toBe('local-ui');      // no pane display stamped
    expect(row?.principalId).toBe('human:me');     // human principal intact
  });
});
