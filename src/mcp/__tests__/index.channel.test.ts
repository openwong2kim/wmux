// Tests for the standard `channel_*` MCP tools that expose the
// `a2a.channel.*` pipe RPC surface to first-party MCP clients.
//
// Coverage:
//  1. All thirteen tools register in their public order. There is deliberately
//     NO channel_archive tool — archive is humans-only (renderer-IPC), like
//     kick. channel_mission_list is full-profile only: it is absent from the
//     commander manifest, so the commander surface still registers twelve.
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
//  7. FIRST_PARTY_METHODS includes all eleven AGENT-REACHABLE a2a.channel.*
//     methods (list/get/getMessages/getMembers/create/join/leave/post/invite/
//     ack/unread)
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
import {
  createChannelToolCatalog,
  registerChannelTools,
  type ChannelToolDeps,
} from '../channels';
import type { WmuxToolProfile } from '../toolCatalog';
import {
  expectCommanderCatalogLockstep,
  expectCoreCatalogLockstep,
  expectFrozenCatalog,
} from './catalogAssertions';
import { FIRST_PARTY_METHODS } from '../../main/mcp/firstParty';

const mockSendRpc = sendRpc as unknown as ReturnType<typeof vi.fn>;

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}>;

interface ToolRegistration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

const DEFAULT_CHANNEL_DEPS: ChannelToolDeps = {
  resolveWorkspaceId: async () => 'ws-test',
  getSenderPtyId: () => '',
};

// registerTool-only stand-in: a regression to deprecated server.tool() must
// fail this suite instead of being normalized away by the harness.
function collectRegistrations(
  deps: ChannelToolDeps = DEFAULT_CHANNEL_DEPS,
  profile: WmuxToolProfile = 'full',
): ToolRegistration[] {
  const registrations: ToolRegistration[] = [];
  const server = {
    registerTool: (
      name: string,
      config: {
        description: string;
        inputSchema: Record<string, unknown>;
      },
      handler: ToolHandler,
    ) => {
      registrations.push({
        name,
        description: config.description,
        inputSchema: config.inputSchema,
        handler,
      });
    },
  };
  // The tools need a way to resolve a workspaceId. The real index.ts injects
  // its own resolver; for tests we pass an identity one so every call sees
  // `ws-test` as the caller's workspace (matches the FIRST_PARTY verified
  // hit pattern in src/mcp/index.ts).
  registerChannelTools(server as never, deps, {
    profile,
    context: { principal: { kind: 'unattributed' } },
  });
  return registrations;
}

function collectTools(
  deps?: ChannelToolDeps,
  profile: WmuxToolProfile = 'full',
): Map<string, ToolHandler> {
  return new Map(
    collectRegistrations(deps, profile).map(({ name, handler }) => [
      name,
      handler,
    ]),
  );
}

const CHANNEL_TOOL_NAMES = [
  'channel_list',
  'channel_create',
  'channel_post',
  'channel_join',
  'channel_leave',
  'channel_read',
  'channel_invite',
  'channel_get_members',
  'channel_ack',
  'channel_unread',
  'channel_mission_start',
  'channel_mission_close',
  'channel_mission_list',
] as const;

// channel_mission_list is not in COMMANDER_TOOL_SURFACE, so the commander
// profile registers everything except it, in the same relative order.
const CHANNEL_COMMANDER_TOOL_NAMES = CHANNEL_TOOL_NAMES.filter(
  (name) => name !== 'channel_mission_list',
);

const CHANNEL_SCHEMA_KEYS = {
  channel_list: [],
  channel_create: ['name', 'visibility', 'topic', 'member_id', 'member_name'],
  channel_post: [
    'channel_id',
    'text',
    'member_id',
    'member_name',
    'client_msg_id',
    'mentions',
  ],
  channel_join: ['channel_id', 'member_id', 'member_name', 'include_history'],
  channel_leave: ['channel_id', 'member_id'],
  channel_read: ['channel_id', 'since_seq', 'limit'],
  channel_invite: [
    'channel_id',
    'invited_workspace_id',
    'member_id',
    'member_name',
    'include_history',
  ],
  channel_get_members: ['channel_id'],
  channel_ack: ['channel_id', 'upto_seq', 'member_id'],
  channel_unread: ['member_id'],
  channel_mission_start: [
    'title',
    'member_id',
    'invite',
    'idempotency_key',
  ],
  channel_mission_close: ['task_id', 'idempotency_key'],
  channel_mission_list: [],
} satisfies Record<(typeof CHANNEL_TOOL_NAMES)[number], readonly string[]>;

const CHANNEL_INVOCATIONS: ReadonlyArray<{
  name: (typeof CHANNEL_TOOL_NAMES)[number];
  method: string;
  args: Record<string, unknown>;
}> = [
  { name: 'channel_list', method: 'a2a.channel.list', args: {} },
  {
    name: 'channel_create',
    method: 'a2a.channel.create',
    args: { name: 'general', visibility: 'public', member_id: 'lead' },
  },
  {
    name: 'channel_post',
    method: 'a2a.channel.post',
    args: { channel_id: 'ch-1', text: 'hello', member_id: 'lead' },
  },
  {
    name: 'channel_join',
    method: 'a2a.channel.join',
    args: { channel_id: 'ch-1', member_id: 'lead' },
  },
  {
    name: 'channel_leave',
    method: 'a2a.channel.leave',
    args: { channel_id: 'ch-1', member_id: 'lead' },
  },
  {
    name: 'channel_read',
    method: 'a2a.channel.getMessages',
    args: { channel_id: 'ch-1' },
  },
  {
    name: 'channel_invite',
    method: 'a2a.channel.invite',
    args: {
      channel_id: 'ch-1',
      invited_workspace_id: 'ws-b',
      member_id: 'dev',
    },
  },
  {
    name: 'channel_get_members',
    method: 'a2a.channel.getMembers',
    args: { channel_id: 'ch-1' },
  },
  {
    name: 'channel_ack',
    method: 'a2a.channel.ack',
    args: { channel_id: 'ch-1', upto_seq: 1 },
  },
  {
    name: 'channel_unread',
    method: 'a2a.channel.unread',
    args: {},
  },
  {
    name: 'channel_mission_start',
    method: 'task.mission.start',
    args: { title: 'Ship', member_id: 'lead' },
  },
  {
    name: 'channel_mission_close',
    method: 'task.mission.close',
    args: { task_id: 'task-1' },
  },
  {
    name: 'channel_mission_list',
    method: 'task.mission.list',
    args: {},
  },
];

const registrations = collectRegistrations();
const tools = new Map(
  registrations.map(({ name, handler }) => [name, handler]),
);
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
const channelMissionStart = tools.get('channel_mission_start');
const channelMissionClose = tools.get('channel_mission_close');
const channelMissionList = tools.get('channel_mission_list');

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
  !channelUnread ||
  !channelMissionStart ||
  !channelMissionClose ||
  !channelMissionList
) {
  throw new Error('channel tools failed to register');
}

beforeEach(() => {
  mockSendRpc.mockReset();
});

describe('channel_* tools: registration', () => {
  it('registers all thirteen tools in exact full order, twelve on commander', () => {
    expect([...tools.keys()]).toEqual(CHANNEL_TOOL_NAMES);
    expect(
      collectRegistrations(undefined, 'commander').map(({ name }) => name),
    ).toEqual(CHANNEL_COMMANDER_TOOL_NAMES);
  });

  it('keeps catalog profiles in commander-manifest lockstep and frozen', () => {
    const specs = createChannelToolCatalog(DEFAULT_CHANNEL_DEPS);

    expect(specs.map(({ name }) => name)).toEqual(CHANNEL_TOOL_NAMES);
    expect(specs.map(({ profiles }) => profiles)).toEqual(
      CHANNEL_TOOL_NAMES.map((name) =>
        name === 'channel_mission_list'
          ? ['full', 'core']
          : ['full', 'core', 'commander'],
      ),
    );
    expectCommanderCatalogLockstep(specs);
    expectCoreCatalogLockstep(specs);
    expectFrozenCatalog(specs);
  });

  it('pins every raw schema key order and reuses module-scope shapes', () => {
    expect(
      registrations.map(({ name, inputSchema }) => [
        name,
        Object.keys(inputSchema),
      ]),
    ).toEqual(
      CHANNEL_TOOL_NAMES.map((name) => [name, CHANNEL_SCHEMA_KEYS[name]]),
    );

    const registrationByName = new Map(
      registrations.map((registration) => [
        registration.name,
        registration,
      ]),
    );
    const nestedObjectKeys = (toolName: string, field: string): string[] => {
      const registration = registrationByName.get(toolName);
      if (!registration) throw new Error(`${toolName} failed to register`);
      const optionalArray = registration.inputSchema[field] as {
        unwrap(): {
          element: {
            shape: Record<string, unknown>;
          };
        };
      };
      return Object.keys(optionalArray.unwrap().element.shape);
    };
    expect(nestedObjectKeys('channel_post', 'mentions')).toEqual([
      'workspace_id',
      'name',
      'member_id',
      'pane_id',
    ]);
    expect(nestedObjectKeys('channel_mission_start', 'invite')).toEqual([
      'workspace_id',
      'member_id',
    ]);

    const secondByName = new Map(
      collectRegistrations().map((registration) => [
        registration.name,
        registration,
      ]),
    );
    for (const registration of registrations) {
      if (registration.name === 'channel_list') continue;
      const second = secondByName.get(registration.name);
      if (!second) {
        throw new Error(`${registration.name} failed to register twice`);
      }
      expect(second.inputSchema).toBe(registration.inputSchema);
    }
  });

  it('does not register a channel_history tool (history is exposed via channel_read)', () => {
    expect(tools.get('channel_history')).toBeUndefined();
  });

  it('does not register a channel_archive tool (archive is humans-only, renderer-IPC path)', () => {
    // Archiving tears a channel down for everyone — like kick it is a humans-only
    // action that never reaches the agent/MCP surface (see a2a.channel.rpc.ts).
    expect(tools.get('channel_archive')).toBeUndefined();
  });

  it('registers the WorkTask mission tools (J0)', () => {
    expect(channelMissionStart).toBeDefined();
    expect(channelMissionClose).toBeDefined();
  });

  it('registers channel_mission_list (J1 — the deferral ends with fan-out)', () => {
    // J0 kept task.mission.list pipe-only per §3 tool-surface minimalism and
    // deferred the tool to J1. J1 (fan-out on the wire) is the caller that
    // needs it: fanout_start returns before the tasks exist, so this listing is
    // how a caller follows what it spawned.
    expect(tools.get('channel_mission_list')).toBeDefined();
  });

  it('channel_mission_list forwards the resolved workspace', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, tasks: [] });
    const res = await channelMissionList({});
    expect(mockSendRpc).toHaveBeenCalledWith('task.mission.list', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
    });
    expect(res.isError).toBeUndefined();
  });

  it('channel_mission_list carries the verified senderPtyId, which is what actually scopes it', async () => {
    // The workspace ids above are NOT the scoping mechanism — the main-side
    // handler resolves the owning workspace from this ptyId and stamps it over
    // whatever the tool sent. `task.mission.list` now fails closed without it
    // (it returns branches and absolute worktree paths for one owner, and the
    // MCP workspace resolver falls back to the spoofable WMUX_WORKSPACE_ID env
    // hint on a PID-map miss). So a registration that stops attaching the
    // ptyId does not merely lose attribution — it loses the listing.
    const scopedTools = collectTools({
      resolveWorkspaceId: async () => 'ws-test',
      getSenderPtyId: () => 'pty-verified',
    });
    mockSendRpc.mockResolvedValue({ ok: true, tasks: [] });
    await scopedTools.get('channel_mission_list')!({});
    expect(mockSendRpc).toHaveBeenCalledWith('task.mission.list', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      senderPtyId: 'pty-verified',
    });
  });

  it('keeps the verified sender resolver isolated per server registration', async () => {
    const getSenderA = vi.fn(() => 'pty-a');
    const getSenderB = vi.fn(() => 'pty-b');
    const postA = collectTools({
      resolveWorkspaceId: async () => 'ws-a',
      getSenderPtyId: getSenderA,
    }).get('channel_post');
    const postB = collectTools({
      resolveWorkspaceId: async () => 'ws-b',
      getSenderPtyId: getSenderB,
    }).get('channel_post');
    if (!postA || !postB) {
      throw new Error('channel_post failed to register for connection isolation test');
    }
    mockSendRpc.mockResolvedValue({ ok: true, message: { seq: 1 } });

    await postA({ channel_id: 'ch-1', text: 'from A', member_id: 'a' });
    await postB({ channel_id: 'ch-1', text: 'from B', member_id: 'b' });

    expect(mockSendRpc.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        workspaceId: 'ws-a',
        verifiedWorkspaceId: 'ws-a',
        senderPtyId: 'pty-a',
      }),
    );
    expect(mockSendRpc.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        workspaceId: 'ws-b',
        verifiedWorkspaceId: 'ws-b',
        senderPtyId: 'pty-b',
      }),
    );
    expect(getSenderA).toHaveBeenCalledTimes(1);
    expect(getSenderB).toHaveBeenCalledTimes(1);
  });

  it('reads sender identity at invocation time instead of snapshotting it', async () => {
    let senderPtyId = '';
    const getSenderPtyId = vi.fn(() => senderPtyId);
    const list = collectTools({
      resolveWorkspaceId: async () => 'ws-live',
      getSenderPtyId,
    }).get('channel_list');
    if (!list) throw new Error('channel_list failed to register');
    senderPtyId = 'pty-live';
    mockSendRpc.mockResolvedValue({ ok: true, channels: [] });

    await list({});

    expect(mockSendRpc).toHaveBeenCalledWith(
      'a2a.channel.list',
      expect.objectContaining({ senderPtyId: 'pty-live' }),
    );
    expect(getSenderPtyId).toHaveBeenCalledTimes(1);
  });
});

describe('channel_* provenance and RPC closure', () => {
  it.each(CHANNEL_INVOCATIONS)(
    '$name resolves both identities once and calls $method once',
    async ({ name, method, args }) => {
      const resolveWorkspaceId = vi.fn(async () => 'ws-provenance');
      const getSenderPtyId = vi.fn(() => 'pty-provenance');
      const handler = collectTools({
        resolveWorkspaceId,
        getSenderPtyId,
      }).get(name);
      if (!handler) throw new Error(`${name} failed to register`);
      mockSendRpc.mockResolvedValue({ ok: true });

      await handler(args);

      expect(resolveWorkspaceId).toHaveBeenCalledTimes(1);
      expect(getSenderPtyId).toHaveBeenCalledTimes(1);
      expect(mockSendRpc).toHaveBeenCalledTimes(1);
      expect(mockSendRpc).toHaveBeenCalledWith(
        method,
        expect.objectContaining({
          workspaceId: 'ws-provenance',
          verifiedWorkspaceId: 'ws-provenance',
          senderPtyId: 'pty-provenance',
        }),
      );
    },
  );

  it('does not call the pipe when workspace resolution rejects', async () => {
    const list = collectTools({
      resolveWorkspaceId: async () => {
        throw new Error('workspace identity unavailable');
      },
      getSenderPtyId: () => 'pty-live',
    }).get('channel_list');
    if (!list) throw new Error('channel_list failed to register');

    await expect(list({})).rejects.toThrow('workspace identity unavailable');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('does not call the pipe when sender resolution rejects', async () => {
    const list = collectTools({
      resolveWorkspaceId: async () => 'ws-live',
      getSenderPtyId: () => {
        throw new Error('sender identity unavailable');
      },
    }).get('channel_list');
    if (!list) throw new Error('channel_list failed to register');

    await expect(list({})).rejects.toThrow('sender identity unavailable');
    expect(mockSendRpc).not.toHaveBeenCalled();
  });

  it('converts a pipe rejection into an MCP error result', async () => {
    mockSendRpc.mockRejectedValue(new Error('pipe unavailable'));

    const result = await channelList({});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toBe('Error: pipe unavailable');
  });
});

describe('channel_mission_start (J0)', () => {
  it('forwards title/memberId (+ verifiedWorkspaceId) to task.mission.start', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, taskId: 'wtask-1', channelId: 'ch-m' });
    const res = await channelMissionStart({ title: 'Ship it', member_id: 'lead' });
    expect(mockSendRpc).toHaveBeenCalledWith('task.mission.start', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      title: 'Ship it',
      memberId: 'lead',
    });
    expect(res.isError).toBeUndefined();
  });

  it('maps invite + idempotency_key to invite[] + idempotencyKey', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, taskId: 'wtask-2', channelId: 'ch-m2' });
    await channelMissionStart({
      title: 'T',
      member_id: 'lead',
      invite: [{ workspace_id: 'ws-b', member_id: 'dev' }],
      idempotency_key: 'k1',
    });
    expect(mockSendRpc).toHaveBeenCalledWith('task.mission.start', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      title: 'T',
      memberId: 'lead',
      invite: [{ workspaceId: 'ws-b', memberId: 'dev' }],
      idempotencyKey: 'k1',
    });
  });

  it('surfaces a daemon error envelope as isError', async () => {
    mockSendRpc.mockResolvedValue({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'nope' } });
    const res = await channelMissionStart({ title: 'T', member_id: 'lead' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('NOT_AUTHORIZED');
  });
});

describe('channel_mission_close (J0)', () => {
  it('forwards task_id (+ verifiedWorkspaceId) to task.mission.close', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, taskId: 'wtask-1' });
    const res = await channelMissionClose({ task_id: 'wtask-1' });
    expect(mockSendRpc).toHaveBeenCalledWith('task.mission.close', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      taskId: 'wtask-1',
    });
    expect(res.isError).toBeUndefined();
  });

  it('maps idempotency_key to idempotencyKey', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, taskId: 'wtask-1' });
    await channelMissionClose({ task_id: 'wtask-1', idempotency_key: 'k2' });
    expect(mockSendRpc).toHaveBeenCalledWith('task.mission.close', {
      workspaceId: 'ws-test',
      verifiedWorkspaceId: 'ws-test',
      taskId: 'wtask-1',
      idempotencyKey: 'k2',
    });
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

  it('A1: forwards a mention\'s pane_id as paneId (and no pty coordinate)', async () => {
    // The vocabulary this tool lacked: without pane_id an MCP caller could not
    // express "this agent", so an agent-addressed mention could never be
    // auto-delivered. There is deliberately no pty_id counterpart — the daemon
    // fills the pty snapshot from the principal registry after it proves the
    // pane belongs to workspace_id.
    mockSendRpc.mockResolvedValue({ ok: true, message: { seq: 2 } });
    await channelPost({
      channel_id: 'ch-1',
      text: '@worker step 2',
      member_id: 'm-1',
      mentions: [
        { workspace_id: 'ws-worker', name: 'worker', member_id: 'w1-2(claude)', pane_id: 'pane-2' },
        { workspace_id: 'ws-other', name: 'other' }, // unpinned → no paneId key
      ],
    });
    const params = mockSendRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(params.mentions).toEqual([
      { workspaceId: 'ws-worker', name: 'worker', memberId: 'w1-2(claude)', paneId: 'pane-2' },
      { workspaceId: 'ws-other', name: 'other' },
    ]);
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

  it('maps mention keys and defaults only an omitted display name', async () => {
    mockSendRpc.mockResolvedValue({ ok: true, message: { seq: 1 } });

    await channelPost({
      channel_id: 'ch-1',
      text: 'ping',
      member_id: 'lead',
      mentions: [
        { workspace_id: 'ws-default' },
        { workspace_id: 'ws-empty', name: '', member_id: 'dev' },
      ],
    });

    expect(mockSendRpc).toHaveBeenCalledWith(
      'a2a.channel.post',
      expect.objectContaining({
        mentions: [
          { workspaceId: 'ws-default', name: 'ws-default' },
          { workspaceId: 'ws-empty', name: '', memberId: 'dev' },
        ],
      }),
    );
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

describe('optional member display-name forwarding', () => {
  it('omits memberName rather than forwarding undefined', async () => {
    mockSendRpc.mockResolvedValue({ ok: true });

    await channelCreate({
      name: 'general',
      visibility: 'public',
      member_id: 'lead',
    });
    await channelPost({
      channel_id: 'ch-1',
      text: 'hello',
      member_id: 'lead',
    });
    await channelJoin({
      channel_id: 'ch-1',
      member_id: 'lead',
    });
    await channelInvite({
      channel_id: 'ch-1',
      invited_workspace_id: 'ws-b',
      member_id: 'dev',
    });

    const createParams = mockSendRpc.mock.calls[0]?.[1] as {
      createdBy: Record<string, unknown>;
    };
    const postParams = mockSendRpc.mock.calls[1]?.[1] as {
      sender: Record<string, unknown>;
    };
    const joinParams = mockSendRpc.mock.calls[2]?.[1] as {
      member: Record<string, unknown>;
    };
    const inviteParams = mockSendRpc.mock.calls[3]?.[1] as {
      invitedMember: Record<string, unknown>;
    };
    expect(createParams.createdBy).not.toHaveProperty('memberName');
    expect(postParams.sender).not.toHaveProperty('memberName');
    expect(joinParams.member).not.toHaveProperty('memberName');
    expect(inviteParams.invitedMember).not.toHaveProperty('memberName');
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
