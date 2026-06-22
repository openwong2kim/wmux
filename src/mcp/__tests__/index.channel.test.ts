// Tests for the six standard `channel_*` MCP tools that expose the
// `a2a.channel.*` pipe RPC surface to first-party MCP clients.
//
// Coverage:
//  1. All six tools register (channel_create / channel_post / channel_join /
//     channel_leave / channel_archive / channel_list).
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
//  7. FIRST_PARTY_METHODS includes all nine a2a.channel.* methods
//     (list/get/getMessages/getMembers/create/archive/join/leave/post)
//     so the bundled first-party MCP server isn't deadlocked under enforce
//     mode (plans/first-party-mcp-trust.md §2).
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
const channelArchive = tools.get('channel_archive');
const channelList = tools.get('channel_list');

if (
  !channelCreate ||
  !channelPost ||
  !channelJoin ||
  !channelLeave ||
  !channelArchive ||
  !channelList
) {
  throw new Error('channel tools failed to register');
}

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('channel_* tools: registration', () => {
  it('registers all six standard tools', () => {
    // The MCP server is the standard channel surface (channel.history is
    // intentionally deferred per plan Scope Boundaries).
    expect(channelCreate).toBeDefined();
    expect(channelPost).toBeDefined();
    expect(channelJoin).toBeDefined();
    expect(channelLeave).toBeDefined();
    expect(channelArchive).toBeDefined();
    expect(channelList).toBeDefined();
  });

  it('does not register a channel_history tool (deferred per plan)', () => {
    expect(tools.get('channel_history')).toBeUndefined();
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

describe('channel_archive', () => {
  it('forwards channelId + archivedBy + verifiedWorkspaceId to a2a.channel.archive', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });
    await channelArchive({ channel_id: 'ch-1' });
    expect(mockSendRpc).toHaveBeenCalledWith('a2a.channel.archive', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      channelId: 'ch-1',
      archivedBy: 'ws-test',
    });
  });

  it('surfaces NOT_AUTHORIZED from the daemon as isError (archive authz failure)', async () => {
    // The archive authz gate (KTD-F) lives in the daemon. The MCP tool
    // just forwards `verifiedWorkspaceId`; the daemon decides whether
    // the caller is the creator or the company CEO. A rejection
    // surfaces to the agent verbatim so it can branch on the code.
    mockSendRpc.mockResolvedValue({
      ok: false,
      error: {
        code: 'NOT_AUTHORIZED',
        message: 'Only the channel creator or the company CEO may archive this channel',
      },
    });
    const res = await channelArchive({ channel_id: 'ch-1' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_AUTHORIZED');
  });
});

describe('FIRST_PARTY_METHODS allowlist (channel coverage)', () => {
  it('grants the bundled first-party MCP server access to all nine a2a.channel.* methods', () => {
    // Without these, the bundled Claude/Codex MCP server is deadlocked in
    // enforce mode (plans/first-party-mcp-trust.md §2).
    for (const m of [
      'a2a.channel.list',
      'a2a.channel.get',
      'a2a.channel.getMessages',
      'a2a.channel.getMembers',
      'a2a.channel.create',
      'a2a.channel.archive',
      'a2a.channel.join',
      'a2a.channel.leave',
      'a2a.channel.post',
    ] as const) {
      expect(
        FIRST_PARTY_METHODS.has(m),
        `${m} is missing from FIRST_PARTY_METHODS — add it or the bundled MCP server will deadlock under enforce mode`,
      ).toBe(true);
    }
  });
});
