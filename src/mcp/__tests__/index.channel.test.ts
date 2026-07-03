// Tests for the standard `channel_*` MCP tools that expose the
// `a2a.channel.*` pipe RPC surface to first-party MCP clients.
//
// Coverage:
//  1. All eight tools register (channel_create / channel_post / channel_join /
//     channel_leave / channel_list / channel_read / channel_invite /
//     channel_get_members). There is deliberately NO channel_archive tool —
//     archive is humans-only (renderer-IPC), like kick.
//  2. Each tool's params are forwarded to the right `a2a.channel.*` RPC and
//     the typed `{ ok, ... }` / `{ ok: false, error }` envelope is reflected
//     in `isError`.
//  3. `channel_post` surfaces a `PERSIST_FAILED` error from the daemon as
//     `isError: true` (the maintainer directive on U2: don't swallow
//     saveImmediate failures on the post path).
//  4. `channel_post` with `client_msg_id` reaches the daemon with the same
//     key on a second call (idempotency is end-to-end through the MCP
//     layer — the daemon side is responsible for the dedup; the MCP layer
//     must not strip or transform the key).
//  5. WorkspaceId is forwarded by every tool (the caller's resolved
//     `workspaceId`), and the omission of `workspaceId` from a write tool
//     throws (Path D closure at the resolver boundary; MCP tools must
//     pass it).
//  6. Non-first-party client identity (no envelope) does NOT affect tool
//     registration; the allowlist gate is upstream at the substrate enforcer.
//  7. FIRST_PARTY_METHODS includes all nine AGENT-REACHABLE a2a.channel.*
//     methods (list/get/getMessages/getMembers/create/join/leave/post/invite)
//     so the bundled first-party MCP server isn't deadlocked under enforce
//     mode (plans/first-party-mcp-trust.md §2) — and excludes archive + kick,
//     which are humans-only.
//
// The `a2a.channel.send` capability is enforced upstream in RpcRouter via
// methodCapabilityMap.ts; the MCP tool layer is a thin pass-through. The
// test that "non-first-party without capability is rejected" is covered by
// PermissionEnforcer.firstParty.test.ts and methodCapabilityMap.test.ts —
// this file scopes to the MCP tool surface.

import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the RPC transport. The tool handler reads sendRpc and the resolved
// MY_WORKSPACE_ID via resolveWorkspaceId (PID-map lookup + env fallback);
// the cleanest mock is to stub sendRpc so the lookup returns a known id.
vi.mock('../wmux-client', () => ({
  sendRpc: vi.fn(),
  setClientIdentity: vi.fn(),
  clearClientIdentity: vi.fn(),
}));

import { sendRpc } from '../wmux-client';
import { registerChannelTools } from '../channels';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

// Minimal McpServer stand-in that captures each registered tool's handler.
function collectTools(): Map<string, ToolHandler> {
  const tools = new Map<string, ToolHandler>();
  const server = {
    tool: (name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    },
  };
  // The tools need a way to resolve a workspaceId. The real index.ts injects
  // its own resolver; for tests we pass an identity one so every call sees
  // `ws-test` as the caller's workspace (matches the FIRST_PARTY verified
  // hit pattern in src/mcp/index.ts).
  registerChannelTools(server as never, { resolveWorkspaceId: async () => 'ws-test' });
  return tools;
}

const tools = collectTools();
const channelCreate = tools.get('channel_create');
const channelPost = tools.get('channel_post');
const channelJoin = tools.get('channel_join');
const channelLeave = tools.get('channel_leave');
const channelList = tools.get('channel_list');
const channelRead = tools.get('channel_read');
const channelInvite = tools.get('channel_invite');
const channelGetMembers = tools.get('channel_get_members');
const channelAck = tools.get('channel_ack');
const channelUnread = tools.get('channel_unread');

if (
  !channelCreate ||
  !channelPost ||
  !channelJoin ||
  !channelLeave ||
  !channelList ||
  !channelRead ||
  !channelInvite ||
  !channelGetMembers ||
  !channelAck ||
  !channelUnread
) {
  throw new Error('channel tools failed to register');
}

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('channel_* tools: registration', () => {
  it('registers all ten standard tools', () => {
    // channel_read exposes message history; channel_invite adds another
    // workspace (the only path into a private channel); channel_get_members
    // exposes the roster (who is in the channel). Channels v2 adds
    // channel_ack (durable-inbox consume signal) + channel_unread (cheap poll).
    expect(channelCreate).toBeDefined();
    expect(channelPost).toBeDefined();
    expect(channelJoin).toBeDefined();
    expect(channelLeave).toBeDefined();
    expect(channelList).toBeDefined();
    expect(channelRead).toBeDefined();
    expect(channelInvite).toBeDefined();
    expect(channelGetMembers).toBeDefined();
    expect(channelAck).toBeDefined();
    expect(channelUnread).toBeDefined();
  });

  it('does not register a channel_history tool (history is exposed via channel_read)', () => {
    expect(tools.get('channel_history')).toBeUndefined();
  });

  it('does not register a channel_archive tool (archive is humans-only, renderer-IPC path)', () => {
    // Archiving tears a channel down for everyone — like kick it is a humans-only
    // action that never reaches the agent/MCP surface (see a2a.channel.rpc.ts).
    expect(tools.get('channel_archive')).toBeUndefined();
  });
});

describe('channel_list', () => {
  it('calls a2a.channel.list and forwards workspaceId + verifiedWorkspaceId', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, channels: [] });
    const res = await channelList({});
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.list', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
    });
    expect(res.isError).toBeUndefined();
  });

  it('passes through the typed RPC envelope', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      channels: [{ id: 'ch-1', name: 'general', status: 'active' }],
    });
    const res = await channelList({});
    expect(res.content[0].text).toContain('ch-1');
  });
});

describe('channel_read', () => {
  it('forwards channel_id + default limit (50) and no sinceSeq when since_seq omitted', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, messages: [] });
    const res = await channelRead({ channel_id: 'ch-123' });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.getMessages', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-123',
      limit: 50,
    });
    expect(res.isError).toBeUndefined();
  });

  it('forwards since_seq and an explicit limit when provided', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, messages: [] });
    await channelRead({ channel_id: 'ch-123', since_seq: 42, limit: 10 });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.getMessages', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-123',
      limit: 10,
      sinceSeq: 42,
    });
  });

  it('surfaces a daemon error envelope as isError', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND', message: 'No such channel: ch-x' },
    });
    const res = await channelRead({ channel_id: 'ch-x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('CHANNEL_NOT_FOUND');
  });
});

describe('channel_create', () => {
  it('forwards name/visibility/topic/createdBy + verifiedWorkspaceId to a2a.channel.create', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, channel: { id: 'ch-new' } });
    const res = await channelCreate({
      name: 'release-notes',
      visibility: 'public',
      topic: 'Per-release changelog',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.create', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      name: 'release-notes',
      visibility: 'public',
      topic: 'Per-release changelog',
      createdBy: { workspaceId: 'ws-test', memberId: 'm-1', memberName: 'Lead' },
    });
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('ch-new');
  });

  it('surfaces INVALID_NAME from the daemon as isError', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'INVALID_NAME', message: 'Invalid channel name: !!!' },
    });
    const res = await channelCreate({
      name: '!!!',
      visibility: 'public',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('INVALID_NAME');
  });

  it('accepts missing topic (optional)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, channel: { id: 'ch-x' } });
    await channelCreate({
      name: 'general',
      visibility: 'public',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.topic).toBeUndefined();
  });
});

describe('channel_post', () => {
  it('forwards channelId/text/sender/client_msg_id + verifiedWorkspaceId to a2a.channel.post', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, message: { seq: 1 } });
    const res = await channelPost({
      channel_id: 'ch-1',
      text: 'hello channel',
      member_id: 'm-1',
      member_name: 'Lead',
      client_msg_id: 'msg-001',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.post', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      sender: { workspaceId: 'ws-test', memberId: 'm-1', memberName: 'Lead' },
      text: 'hello channel',
      clientMsgId: 'msg-001',
    });
    expect(res.isError).toBeUndefined();
  });

  it('surfaces PERSIST_FAILED from the daemon as isError (U2 directive)', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'PERSIST_FAILED', message: 'Failed to persist post' },
    });
    const res = await channelPost({
      channel_id: 'ch-1',
      text: 'will fail',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('PERSIST_FAILED');
  });

  it('surfaces CHANNEL_ARCHIVED as isError (read-only channel rejects new posts)', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'CHANNEL_ARCHIVED', message: 'Channel is archived' },
    });
    const res = await channelPost({
      channel_id: 'ch-archived',
      text: 'no go',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('CHANNEL_ARCHIVED');
  });

  it('surfaces NOT_AUTHORIZED when the sender workspaceId disagrees with verifiedWorkspaceId', async () => {
    // The sender-pin gate (R5) lives in the daemon. The MCP layer just
    // forwards `verifiedWorkspaceId` from the resolver; if the daemon
    // rejects the call as NOT_AUTHORIZED, the tool surfaces that to the
    // agent verbatim. This test pins the contract end-to-end.
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: {
        code: 'NOT_AUTHORIZED',
        message: 'sender.workspaceId does not match the verified caller identity',
      },
    });
    const res = await channelPost({
      channel_id: 'ch-1',
      text: 'spoofed',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_AUTHORIZED');
  });

  it('forwards client_msg_id unchanged on repeat calls (idempotency is end-to-end through the MCP layer)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, message: { seq: 7 }, idempotent: true });
    await channelPost({
      channel_id: 'ch-1',
      text: 'dup',
      member_id: 'm-1',
      member_name: 'Lead',
      client_msg_id: 'same-key',
    });
    await channelPost({
      channel_id: 'ch-1',
      text: 'dup',
      member_id: 'm-1',
      member_name: 'Lead',
      client_msg_id: 'same-key',
    });
    expect(mockSendRpc).toHaveBeenCalledTimes(2);
    const first = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    const second = mockSendRpc.mock.calls[1][1] as Record<string, unknown>;
    expect(first.clientMsgId).toBe('same-key');
    expect(second.clientMsgId).toBe('same-key');
    // Both calls forwarded the same key; the daemon returns the same `seq`
    // on the second call (asserted via mockResolvedValue). The MCP layer
    // MUST NOT strip or transform the key — see plan R9/R13.
  });

  it('omits clientMsgId from the params when not provided', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, message: { seq: 1 } });
    await channelPost({
      channel_id: 'ch-1',
      text: 'no key',
      member_id: 'm-1',
      member_name: 'Lead',
    });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.clientMsgId).toBeUndefined();
  });
});

describe('channel_join', () => {
  it('forwards channelId + member + include_history + verifiedWorkspaceId to a2a.channel.join', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    await channelJoin({
      channel_id: 'ch-1',
      member_id: 'm-2',
      member_name: 'Backend',
      include_history: false,
    });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.join', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      member: { workspaceId: 'ws-test', memberId: 'm-2', memberName: 'Backend' },
      includeHistory: false,
    });
  });

  it('defaults includeHistory to true when omitted', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    await channelJoin({
      channel_id: 'ch-1',
      member_id: 'm-2',
      member_name: 'Backend',
    });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.includeHistory).toBe(true);
  });
});

describe('channel_leave', () => {
  it('forwards channelId/workspaceId/memberId + verifiedWorkspaceId to a2a.channel.leave', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    await channelLeave({
      channel_id: 'ch-1',
      member_id: 'm-2',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.leave', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      memberId: 'm-2',
    });
  });

  it('surfaces NOT_A_MEMBER from the daemon as isError', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_A_MEMBER', message: 'Not a member' },
    });
    const res = await channelLeave({
      channel_id: 'ch-1',
      member_id: 'm-not-in-channel',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_A_MEMBER');
  });
});

// NOTE: there is no channel_archive tool to test — archive is humans-only and
// rides the renderer-only channels:mutate-local IPC, never the MCP surface (see
// the registration test above + a2a.channel.rpc.ts). The daemon-side archive
// authz (member/CEO) is covered in ChannelService.test.ts.

describe('channel_invite', () => {
  it('forwards channelId + invitedMember + verifiedWorkspaceId to a2a.channel.invite (include_history default true)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    const res = await channelInvite({
      channel_id: 'ch-1',
      invited_workspace_id: 'ws-2',
      member_id: 'm-2',
      member_name: 'Bob',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.invite', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      invitedMember: { workspaceId: 'ws-2', memberId: 'm-2', memberName: 'Bob' },
      includeHistory: true,
    });
    expect(res.isError).toBeUndefined();
  });

  it('passes include_history:false through', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    await channelInvite({
      channel_id: 'ch-1',
      invited_workspace_id: 'ws-2',
      member_id: 'm-2',
      member_name: 'Bob',
      include_history: false,
    });
    expect(mockSendRpc).toHaveBeenCalledWith(
      'a2a.channel.invite',
      expect.objectContaining({ includeHistory: false }),
    );
  });

  it('surfaces a NOT_AUTHORIZED daemon error as isError', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_AUTHORIZED', message: 'Only a member may invite others to this channel' },
    });
    const res = await channelInvite({
      channel_id: 'ch-1',
      invited_workspace_id: 'ws-2',
      member_id: 'm-2',
      member_name: 'Bob',
    });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_AUTHORIZED');
  });
});

describe('channel_get_members', () => {
  it('forwards channelId + workspaceId + verifiedWorkspaceId to a2a.channel.getMembers', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, members: [] });
    const res = await channelGetMembers({ channel_id: 'ch-1' });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.getMembers', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
    });
    expect(res.isError).toBeUndefined();
  });

  it('passes through the typed RPC envelope (members list)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, members: [{ workspaceId: 'ws-1', memberId: 'lead' }] });
    const res = await channelGetMembers({ channel_id: 'ch-1' });
    expect(res.content[0].text).toContain('lead');
  });
});

describe('FIRST_PARTY_METHODS allowlist (channel coverage)', () => {
  it('grants the bundled first-party MCP server access to all eleven agent-reachable a2a.channel.* methods', () => {
    // Without these, the bundled Claude/Codex MCP server is deadlocked in
    // enforce mode (plans/first-party-mcp-trust.md §2). archive + kick are
    // humans-only (renderer-IPC, never the pipe/MCP) so they are deliberately
    // absent — see the negative assertion below. v2 adds ack + unread: ack is
    // the durable-inbox consume signal, so denying it to agents would leave
    // the wake worker re-pinging them forever.
    for (const m of [
      'a2a.channel.list',
      'a2a.channel.get',
      'a2a.channel.getMessages',
      'a2a.channel.getMembers',
      'a2a.channel.create',
      'a2a.channel.join',
      'a2a.channel.leave',
      'a2a.channel.post',
      'a2a.channel.invite',
      'a2a.channel.ack',
      'a2a.channel.unread',
    ] as const) {
      expect(
        FIRST_PARTY_METHODS.has(m),
        `${m} is missing from FIRST_PARTY_METHODS — add it or the bundled MCP server will deadlock under enforce mode`,
      ).toBe(true);
    }
  });

  it('does NOT grant archive or kick (humans-only — must never be agent-reachable)', () => {
    expect(FIRST_PARTY_METHODS.has('a2a.channel.archive')).toBe(false);
    expect(FIRST_PARTY_METHODS.has('a2a.channel.kick')).toBe(false);
  });
});

describe('channel_ack (Channels v2)', () => {
  it('forwards channelId/uptoSeq/memberId + verifiedWorkspaceId to a2a.channel.ack', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, acked: 0, lastReadSeq: 7 });
    const res = await channelAck({ channel_id: 'ch-1', upto_seq: 7, member_id: 'codex' });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.ack', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      uptoSeq: 7,
      memberId: 'codex',
    });
    expect(res.isError).toBeUndefined();
  });

  it('omits memberId when not provided (workspace-wide ack)', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, acked: 2, lastReadSeq: 3 });
    await channelAck({ channel_id: 'ch-1', upto_seq: 3 });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.ack', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      uptoSeq: 3,
    });
  });

  it('surfaces CHANNEL_NOT_FOUND as isError', async () => {
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: { code: 'CHANNEL_NOT_FOUND', message: 'No such channel' },
    });
    const res = await channelAck({ channel_id: 'ch-ghost', upto_seq: 1 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('CHANNEL_NOT_FOUND');
  });
});

describe('channel_unread (Channels v2)', () => {
  it('forwards verifiedWorkspaceId (+ optional memberId) to a2a.channel.unread', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, entries: [] });
    await channelUnread({ member_id: 'codex' });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.unread', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      memberId: 'codex',
    });
    await channelUnread({});
    expect(mockSendRpc).toHaveBeenLastCalledWith('a2a.channel.unread', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
    });
  });

  it('passes through the entries envelope', async () => {
    mockSendRpc.mockResolvedValue({
      ok: true,
      entries: [
        {
          channelId: 'ch-1',
          name: 'general',
          memberId: 'codex',
          lastReadSeq: 3,
          headSeq: 5,
          unread: 2,
          mentionUnread: 1,
          trimmedBeforeCursor: 0,
        },
      ],
    });
    const res = await channelUnread({});
    expect(res.isError).toBeUndefined();
    expect(res.content[0].text).toContain('"unread": 2');
    expect(res.content[0].text).toContain('"trimmedBeforeCursor": 0');
  });
});
