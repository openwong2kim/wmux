// ─── Channel tools for the bundled MCP server ───────────────────────────
//
// Standard MCP tools (thirteen — Channels v2 added channel_ack/channel_unread,
// and WorkTask J0 added the three mission tools) that expose the
// `a2a.channel.*` and `task.mission.*` pipe RPC surfaces to
// first-party MCP clients (Claude Code, Codex CLI). Each tool is a thin
// pass-through over `sendRpc` plus a per-call workspaceId resolved by the
// caller (index.ts injects `resolveWorkspaceId` so tests can stub it
// directly without booting the PID-map walk).
//
// Design notes:
//  - Tool names follow `channel_*` (NOT `a2a_channel_*`). The legacy
//    `a2a_task_send` alias pattern exists because A2A pre-dates the cleaner
//    naming; channels launch fresh and pick the cleaner form.
//  - The result envelope is the typed `{ ok: true, ... } | { ok: false,
//    error: { code, message } }` from `ChannelService`. When `ok: false`,
//    the tool surfaces `isError: true` with the structured error code in
//    the message text. Callers (agents) should branch on `isError` and
//    inspect the code rather than parse the message string.
//  - The `a2a.channel.send` capability is enforced upstream in RpcRouter
//    via methodCapabilityMap.ts. The MCP tool layer does not re-check it.
//  - `channel_read` exposes message history (the pull half of the attention
//    model), bounded to the most recent N to protect the agent's context.
//
// Plan reference: U5 (a2a-channels first-party MCP allowlist + tools).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendRpc } from './wmux-client';
import {
  defineWmuxTool,
  registerWmuxTools,
  type RegisterWmuxToolsOptions,
} from './toolCatalog';
import type { RpcMethod } from '../shared/rpc';
import type { ChannelVisibility } from '../shared/channels';

/** Resolver the parent module injects so tests can stub without booting the
 *  PID-map walk (src/mcp/index.ts uses its own verified resolver). */
export interface ChannelToolDeps {
  /** Returns the caller's workspace id (verified PID-map hit, env-hint
   *  fallback, or '' on miss — match the parent module's resolveWorkspaceId
   *  contract). */
  resolveWorkspaceId: () => Promise<string>;
  /** Returns the MCP server's OWN verified senderPtyId (its PID-map-walked
   *  ptyId, or '' on miss). The main-side a2a.channel handler resolves this
   *  to the owning workspace and stamps `verifiedWorkspaceId` server-side
   *  (D5) — so a forged client workspace id is ignored. Mutating channel
   *  calls fail closed without a resolvable senderPtyId. */
  getSenderPtyId: () => string;
}

/** Channel name pattern matches `CHANNEL_NAME_RE` in src/shared/channels.ts:
 *  1-64 chars, lowercase letter/digit start, `[a-z0-9-]` body. Tools
 *  accept the user-friendly shape and forward it to the daemon, which
 *  re-validates with `isValidChannelName` after canonicalization. */
const channelNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'Channel name must start with a letter or digit and contain only [a-z0-9-]')
  .describe('Channel name (lowercase, letters/digits/hyphens, 1-64 chars).');

const visibilitySchema = z
  .enum(['public', 'private'])
  .describe('Visibility: "public" (discoverable + joinable) or "private" (invite-only). Immutable post-creation.');

const topicSchema = z
  .string()
  .max(256)
  .optional()
  .describe('Optional human-readable topic. Max 256 chars.');

const memberIdSchema = z.string().describe('Agent member id within the workspace (e.g. "lead", "backend").');

// 1b (server-owned roster identity): display names are derived DAEMON-side
// from the roster row (principal registry display, else the memberId), so the
// client-supplied value is only a fallback for posts that match no roster row.
// Optional for wire compat — existing agents that still send it are ignored
// whenever a roster row exists.
const memberNameSchema = z
  .string()
  .optional()
  .describe('Display-name fallback; ignored whenever the server-owned channel roster has a row for this member.');

/** Helper: convert the typed `{ ok, ... } | { ok: false, error }` envelope
 *  into an MCP tool result with `isError` set on the failure branch. The
 *  error code is embedded in the text so the agent can branch on it. */
async function callChannelRpc(
  method: RpcMethod,
  params: Record<string, unknown>,
  // Per-registration resolver for the caller's verified senderPtyId (D5).
  // Passed in (not a module global) because the broker hosts MANY servers in
  // ONE process: a module-global would let the last-registered connection's
  // resolver win, stamping every connection's channel RPCs with the wrong
  // sender identity.
  resolveSenderPtyId: () => string,
): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  // D5: attach the MCP server's verified senderPtyId so the main-side
  // a2a.channel handler resolves the owning workspace and stamps
  // verifiedWorkspaceId server-side (any client-supplied value is ignored).
  const pty = resolveSenderPtyId();
  const withPty = pty ? { ...params, senderPtyId: pty } : params;
  try {
    const result = (await sendRpc(method, withPty)) as
      | { ok: true; [k: string]: unknown }
      | { ok: false; error: { code: string; message: string } }
      | undefined;
    if (result && result.ok === false) {
      return {
        content: [{ type: 'text', text: `Error [${result.error.code}]: ${result.error.message}` }],
        isError: true,
      };
    }
    const text = typeof result === 'string' ? result : JSON.stringify(result ?? {}, null, 2);
    return { content: [{ type: 'text', text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}

// Module-scope parameter shapes: hoisted out of the per-registration path so
// every createWmuxServer() instance shares one set of zod schema objects. The
// shapes carry no per-call state — the handlers (which close over `deps`) stay
// inside createChannelToolCatalog. channel_list takes no params, so its `{}` shape
// stays inline (no zod objects to share).
const CHANNEL_CREATE_SHAPE = {
  name: channelNameSchema,
  visibility: visibilitySchema,
  topic: topicSchema,
  member_id: memberIdSchema,
  member_name: memberNameSchema,
};

const CHANNEL_POST_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
  text: z.string().describe('Message body. Newlines are preserved.'),
  member_id: memberIdSchema,
  member_name: memberNameSchema,
  client_msg_id: z
    .string()
    .optional()
    .describe('Idempotency key: a repeat post with the same key returns the original seq instead of appending a duplicate.'),
  mentions: z
    .array(
      z.object({
        workspace_id: z.string().describe('Mentioned member workspace id; dropped unless a CURRENT channel member.'),
        name: z.string().optional().describe('Display name for the @mention (defaults to the workspace id).'),
        member_id: z.string().optional().describe('Narrow the mention to a specific member; omit for a workspace-level mention.'),
        // Refusal reasons the daemon returns for a bad pin, kept out of the
        // wire description because `droppedMentions` already names them at
        // runtime: "pane_not_in_workspace" (pane is not provably in
        // `workspace_id`) and "pane_not_live" (its session is gone).
        pane_id: z
          .string()
          .optional()
          .describe(
            'Pin the mention to ONE agent pane (paneId from a2a_discover / pane_list). A pinned mention lands in that agent\'s prompt at its next idle moment — the only mention shape that reaches an agent by itself; without it the mention is badge-only and waits for a poll. A pin outside `workspace_id`, or onto a dead session, is refused (reported in `droppedMentions`, mention still lands badge-only), never redirected to a sibling pane. Liveness means a live PTY, not a live agent: a pane at its shell accepts the pin and the text lands at the shell prompt.',
          ),
      }),
    )
    .optional()
    .describe('@-mentions to ping specific members; each must be a current channel member. A non-member target comes back in `droppedMentions`, never silently dropped. Mentioned workspaces are notified via their a2a inbox; add `pane_id` to actually reach an idle agent.'),
};

const CHANNEL_JOIN_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
  member_id: memberIdSchema,
  member_name: memberNameSchema,
  include_history: z
    .boolean()
    .optional()
    .describe('When true (default), the new member sees the channel\'s full history. When false, they see only posts after their join.'),
};

const CHANNEL_LEAVE_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
  member_id: memberIdSchema,
};

const CHANNEL_READ_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
  since_seq: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Return messages with seq >= since_seq (forward pagination). With limit you get the OLDEST ' +
        '`limit` messages at or after the floor, so pages are contiguous.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe('Max messages to return, taken from the newest end. Defaults to 50 to protect your context window.'),
};

const CHANNEL_INVITE_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
  invited_workspace_id: z.string().describe('Workspace id of the agent/workspace to add (the invitee, not you).'),
  member_id: z
    .string()
    .describe('Member id for the INVITED workspace (e.g. "lead", "backend"), not the caller.'),
  member_name: z
    .string()
    .optional()
    .describe('Display-name fallback for the INVITED member; ignored whenever the server-owned roster has a row.'),
  include_history: z
    .boolean()
    .optional()
    .describe('True (default) shows the invited member the full history; false starts them at the current message.'),
};

const CHANNEL_GET_MEMBERS_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
};

const CHANNEL_ACK_SHAPE = {
  channel_id: z.string().describe('Target channel id.'),
  upto_seq: z
    .number()
    .int()
    .min(0)
    .describe('Highest message seq you have consumed (inclusive) — the last seq returned by the channel_read page you just processed.'),
  member_id: z
    .string()
    .optional()
    .describe('YOUR member row in this channel (e.g. "codex"), required to advance the cursor; an id with no row errors rather than silently no-opping. Omit for read receipts only — a glance, not consumption.'),
};

const CHANNEL_UNREAD_SHAPE = {
  member_id: z
    .string()
    .optional()
    .describe('Narrow the summary to one of your member rows. Omit for every row your workspace holds.'),
};

const CHANNEL_MISSION_START_SHAPE = {
  title: z.string().min(1).max(256).describe('Human-readable mission title (max 256 chars). Also seeds the channel name.'),
  member_id: memberIdSchema,
  invite: z
    .array(
      z.object({
        workspace_id: z.string().describe('Workspace id of the member to seed into the mission channel.'),
        member_id: z.string().describe('Member id within that workspace.'),
      }),
    )
    .optional()
    .describe('Optional initial members to add to the mission channel alongside you.'),
  idempotency_key: z
    .string()
    .optional()
    .describe('Optional idempotency key. A retried start with the same key returns the original { taskId, channelId } instead of creating a duplicate.'),
};

const CHANNEL_MISSION_CLOSE_SHAPE = {
  task_id: z.string().describe('The WorkTask id returned by channel_mission_start.'),
  idempotency_key: z
    .string()
    .optional()
    .describe('Optional idempotency key. A retried close with the same key returns the original result.'),
};

// No inputs: the listing is scoped entirely by the server-verified identity.
// Module-scope so the shape object is shared across registrations.
const CHANNEL_MISSION_LIST_SHAPE = {};

/** Build the standard channel catalog for one MCP server instance. The
 *  parent module injects `resolveWorkspaceId` so workspace identity follows
 *  the same verification rules as the rest of the bundled server (verified
 *  PID-map hit first, env-hint fallback on miss). */
export function createChannelToolCatalog(deps: ChannelToolDeps) {
  // D5: the caller's verified-ptyId resolver, captured in THIS registration's
  // closure (not a module global) so concurrent broker-hosted connections each
  // stamp their own sender identity. `callRpc` binds it into every channel RPC.
  const resolveSenderPtyId = deps.getSenderPtyId;
  const callRpc = (
    method: RpcMethod,
    params: Record<string, unknown>,
  ): ReturnType<typeof callChannelRpc> => callChannelRpc(method, params, resolveSenderPtyId);
  // ── channel_list ──────────────────────────────────────────────────
  const channelList = defineWmuxTool({
    name: 'channel_list',
    description:
      'List all channels visible to the calling workspace. Returns the channel metadata (id, name, visibility, topic, status, members) but NOT the message history — use a follow-up get for history.',
    inputSchema: {},
    profiles: ['full', 'commander'],
    invoke: async () => {
      const workspaceId = await deps.resolveWorkspaceId();
      // U5: `verifiedWorkspaceId` is the transport-resolved caller
      // identity (PID-map hit + env-hint fallback). It is forwarded on
      // every a2a.channel.* call so the daemon can authoritatively pin
      // the sender / enforce archive authz (plan R5/R6). The daemon
      // today reads it only on `post` and `archive`; including it on
      // every call keeps the transport shape uniform.
      return callRpc('a2a.channel.list' as RpcMethod, { workspaceId, verifiedWorkspaceId: workspaceId });
    },
  });

  // ── channel_create ────────────────────────────────────────────────
  const channelCreate = defineWmuxTool({
    name: 'channel_create',
    description:
      // KTD10: the creator is auto-added as a member with full history.
      'Create a new channel; you are added as a member with full history. Visibility is immutable after creation, and a "private" channel can only be entered by invitation from an existing member. Topics are editable only through the daemon.',
    inputSchema: CHANNEL_CREATE_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ name, visibility, topic, member_id, member_name }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        name,
        visibility: visibility as ChannelVisibility,
        createdBy: {
          workspaceId,
          memberId: member_id,
          // 1b: optional — the daemon derives the roster row's memberName
          // itself; this survives only as the legacy message-snapshot fallback.
          ...(member_name !== undefined ? { memberName: member_name } : {}),
        },
      };
      if (topic !== undefined) params['topic'] = topic;
      return callRpc('a2a.channel.create' as RpcMethod, params);
    },
  });

  // ── channel_post ──────────────────────────────────────────────────
  // Post-path failures are returned as isError=true with the daemon's own
  // code + message, so the codes are not enumerated in the wire description:
  // PERSIST_FAILED (U2 maintainer directive — do not swallow saveImmediate
  // errors here), CHANNEL_ARCHIVED, CHANNEL_MENTIONS_TOO_MANY.
  const channelPost = defineWmuxTool({
    name: 'channel_post',
    description:
      'Post a message to a channel. A post is a NOTIFICATION, not a delivery: it does NOT start an idle agent\'s turn, so instructions can sit unread indefinitely while the sender reads the silence as "still working". To make an agent act, send it a task (a2a_task_send, pasted into its prompt) or @-mention it with `pane_id` set. Check `droppedMentions` on the result — a mention that did not land is reported there, never silently dropped.',
    inputSchema: CHANNEL_POST_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id, text, member_id, member_name, client_msg_id, mentions }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        sender: {
          workspaceId,
          memberId: member_id,
          // 1b: optional fallback — the daemon renders from the roster row.
          ...(member_name !== undefined ? { memberName: member_name } : {}),
        },
        text,
      };
      if (client_msg_id !== undefined) params['clientMsgId'] = client_msg_id;
      if (mentions !== undefined) {
        params['mentions'] = mentions.map((m) => ({
          workspaceId: m.workspace_id,
          name: m.name ?? m.workspace_id,
          ...(m.member_id !== undefined ? { memberId: m.member_id } : {}),
          // A1: the pane pin. There is deliberately no `pty_id` counterpart —
          // the daemon fills the route-time pty snapshot from the principal
          // registry after it has proven the pane belongs to workspace_id, so
          // the caller never carries (or forges) a second pane coordinate.
          ...(m.pane_id !== undefined ? { paneId: m.pane_id } : {}),
        }));
      }
      return callRpc('a2a.channel.post' as RpcMethod, params);
    },
  });

  // ── channel_join ──────────────────────────────────────────────────
  const channelJoin = defineWmuxTool({
    name: 'channel_join',
    description:
      'Join a channel as a member. By default joins with full history (historyFromSeq=0); pass include_history=false to start at the channel\'s current seq (no past messages). Public channels are joinable by any company member; private channels require an existing member to add you (not yet exposed via MCP — see plan Scope Boundaries).',
    inputSchema: CHANNEL_JOIN_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id, member_id, member_name, include_history }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        member: {
          workspaceId,
          memberId: member_id,
          // 1b: optional — the roster row's memberName is daemon-derived.
          ...(member_name !== undefined ? { memberName: member_name } : {}),
        },
        includeHistory: include_history !== false,
      };
      return callRpc('a2a.channel.join' as RpcMethod, params);
    },
  });

  // ── channel_leave ─────────────────────────────────────────────────
  const channelLeave = defineWmuxTool({
    name: 'channel_leave',
    description:
      'Leave a channel. The caller\'s (workspaceId, memberId) pair is removed from the member list. If the channel becomes empty, the 7-day empty-channel reaper (plan KTD8) will purge it.',
    inputSchema: CHANNEL_LEAVE_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id, member_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callRpc('a2a.channel.leave' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        memberId: member_id,
      });
    },
  });

  // NOTE: there is intentionally NO channel_archive MCP tool. Archiving tears a
  // channel down for everyone, so — like kicking a member — it is a HUMANS-ONLY
  // action that rides the renderer-only `channels:mutate-local` IPC and is absent
  // from the `a2a.channel.*` pipe router. Same-machine agent identity is forgeable
  // (#113), so an agent-reachable archive would let any member-workspace agent
  // destroy any channel. Agents do not need it: an abandoned channel is pruned by
  // the empty-channel reaper once every member has left.

  // ── channel_read ──────────────────────────────────────────────────
  // The pull half of the channel attention model: agents are pushed only
  // on @-mention, but can PULL recent history on demand here. `limit`
  // defaults to a small N at this tool layer (NOT in the daemon) to protect
  // the agent's context window — reading a busy channel is a token cost.
  const channelRead = defineWmuxTool({
    name: 'channel_read',
    description:
      'Read messages from a channel you can see (public, or private if you are a member). ' +
        'With `since_seq` (your channel_unread cursor + 1) it returns the OLDEST `limit` messages ' +
        'from that point as contiguous pages — ack the highest seq you read and repeat until fewer ' +
        'than `limit` come back, to drain safely. Without it you get the most recent `limit` ' +
        '(display). A private channel you are not in returns an empty list; a missing one errors.',
    inputSchema: CHANNEL_READ_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id, since_seq, limit }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        limit: limit ?? 50,
      };
      if (since_seq !== undefined) params['sinceSeq'] = since_seq;
      return callRpc('a2a.channel.getMessages' as RpcMethod, params);
    },
  });

  // ── channel_invite ────────────────────────────────────────────────
  // Add ANOTHER workspace to a channel. Unlike channel_join (self-join), this
  // adds a different workspace and is the only way into a PRIVATE channel.
  // Any member may invite (P1b authz); the daemon gates on the caller being a
  // current member. The invited workspace gains history + live messages.
  const channelInvite = defineWmuxTool({
    name: 'channel_invite',
    description:
      'Invite ANOTHER workspace/agent to a channel you belong to — the only way into a private channel, which cannot be self-joined. Any member may invite; the invitee gains history and live messages. To add YOURSELF to a public channel, use channel_join.',
    inputSchema: CHANNEL_INVITE_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id, invited_workspace_id, member_id, member_name, include_history }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callRpc('a2a.channel.invite' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        invitedMember: {
          workspaceId: invited_workspace_id,
          memberId: member_id,
          // 1b: optional — the roster row's memberName is daemon-derived.
          ...(member_name !== undefined ? { memberName: member_name } : {}),
        },
        includeHistory: include_history !== false,
      });
    },
  });

  // ── channel_get_members ───────────────────────────────────────────
  // The roster read: who is in a channel. Pairs with channel_invite (know who
  // is already a member before adding) and channel_read (attribute messages).
  // Wraps the existing a2a.channel.getMembers RPC; a private channel you are not
  // a member of returns an empty list (its membership is never leaked).
  const channelGetMembers = defineWmuxTool({
    name: 'channel_get_members',
    description:
      'List the members of a channel you can see. Returns each member\'s workspaceId, memberId, joinedAt, and history floor. A private channel you are not a member of returns an empty list (membership is not leaked to non-members).',
    inputSchema: CHANNEL_GET_MEMBERS_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callRpc('a2a.channel.getMembers' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
      });
    },
  });

  // ── channel_ack (Channels v2) ─────────────────────────────────────
  // The consume signal of the durable inbox: advances the caller's
  // per-member read cursor (lastReadSeq). The wake worker re-nudges a
  // member while it has unread mentions and STOPS on ack — so an agent
  // that reads a channel should ack the highest seq it processed, or it
  // will be re-pinged about the same messages.
  const channelAck = defineWmuxTool({
    name: 'channel_ack',
    description:
      'Acknowledge channel messages up to a seq (inclusive) as consumed. Call it after channel_read with the highest seq you actually processed — read oldest-first via since_seq until drained, and never ack past what you have seen. Advances your durable read cursor, clears the unread count and stops re-nudges. Advance-only (an older seq never rewinds) and clamped to the channel head.',
    inputSchema: CHANNEL_ACK_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ channel_id, upto_seq, member_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callRpc('a2a.channel.ack' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        uptoSeq: upto_seq,
        ...(member_id !== undefined ? { memberId: member_id } : {}),
      });
    },
  });

  // ── channel_unread (Channels v2) ──────────────────────────────────
  // The cheap "do I owe anything?" poll: per-channel unread + mention-unread
  // counts derived from the durable cursor. Reading this does NOT consume
  // messages (only channel_ack advances the cursor). `trimmedBeforeCursor`
  // > 0 means retention removed messages before you read them — the gap is
  // reported, never silently swallowed.
  const channelUnread = defineWmuxTool({
    name: 'channel_unread',
    description:
      'Summarize your unread channel messages: per-channel unread count, mention-unread count (messages that @-mention you), your cursor (lastReadSeq), the channel head seq, and trimmedBeforeCursor (messages lost to retention before you read them — never silently dropped). Cheap to call; does not consume messages. Follow up with channel_read + channel_ack.',
    inputSchema: CHANNEL_UNREAD_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ member_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callRpc('a2a.channel.unread' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        ...(member_id !== undefined ? { memberId: member_id } : {}),
      });
    },
  });

  // ── channel_mission_start (WorkTask J0) ───────────────────────────
  // Start a worktree mission: server mints a WorkTask (owner = you, born-owned)
  // AND creates a private mission channel bound to it, returning both ids. Thin
  // RPC caller over task.mission.start — identity, ownership, and the channel
  // are all server-constructed (§5.1): you supply only title + optional invites.
  const channelMissionStart = defineWmuxTool({
    name: 'channel_mission_start',
    description:
      'Start a mission: create a WorkTask (owned by you) plus a private mission channel bound to it, optionally seeded with members via invite. Returns { taskId, channelId }.',
    inputSchema: CHANNEL_MISSION_START_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ title, member_id, invite, idempotency_key }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        title,
        memberId: member_id,
      };
      if (invite !== undefined) {
        params['invite'] = invite.map((m) => ({ workspaceId: m.workspace_id, memberId: m.member_id }));
      }
      if (idempotency_key !== undefined) params['idempotencyKey'] = idempotency_key;
      return callRpc('task.mission.start' as RpcMethod, params);
    },
  });

  // ── channel_mission_close (WorkTask J0) ───────────────────────────
  // Close a mission you own (or as CEO): flips the WorkTask to closed and
  // archives its mission channel. Idempotent — closing an already-closed
  // mission is a no-op success, and the archive step is no-op-tolerant if the
  // channel was already archived or reaped.
  const channelMissionClose = defineWmuxTool({
    name: 'channel_mission_close',
    description:
      'Close a mission by task_id: mark the WorkTask closed and archive its mission channel. Only the task owner (or the CEO) may close. Re-closing an already-closed mission is a no-op success. Use idempotency_key to make a retried close safe.',
    inputSchema: CHANNEL_MISSION_CLOSE_SHAPE,
    profiles: ['full', 'commander'],
    invoke: async ({ task_id, idempotency_key }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        taskId: task_id,
      };
      if (idempotency_key !== undefined) params['idempotencyKey'] = idempotency_key;
      return callRpc('task.mission.close' as RpcMethod, params);
    },
  });

  // ── channel_mission_list (WorkTask J0 read) ───────────────────────
  // Owner-scoped listing of the caller's missions, including the J1
  // materialization fields (branch / worktreePath / paneGroupId) — so an agent
  // that started a fan-out can see where each task landed and whether it is
  // still open.
  //
  // Scoping, stated exactly: `callRpc` attaches this server's verified
  // senderPtyId, and the main-side handler resolves the owning workspace from
  // it and stamps `verifiedWorkspaceId` over whatever is sent. Unlike the other
  // reads here, the method fails closed when that ptyId does not resolve — the
  // rows it returns (branches, absolute worktree paths, channel ids) belong to
  // one owner, so falling back to a caller-supplied scope would hand them to
  // whoever named the workspace. The residual is the #113 same-user ceiling on
  // the ptyId itself, shared with every other method on this surface; the tool
  // description below must not promise more than that.
  const channelMissionList = defineWmuxTool({
    name: 'channel_mission_list',
    description:
      'List the missions (WorkTasks) you own, with their status and — once materialized — branch, worktreePath, paneGroupId (the task workspace) and missionChannelId. This is how you check on tasks started by fanout_start or channel_mission_start. The listing is scoped to the workspace the server resolves from your verified terminal — you cannot ask for another workspace\'s missions, and the call is refused outright if your identity cannot be verified.',
    inputSchema: CHANNEL_MISSION_LIST_SHAPE,
    profiles: ['full'],
    invoke: async () => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callRpc('task.mission.list' as RpcMethod, { workspaceId, verifiedWorkspaceId: workspaceId });
    },
  });

  return Object.freeze([
    channelList,
    channelCreate,
    channelPost,
    channelJoin,
    channelLeave,
    channelRead,
    channelInvite,
    channelGetMembers,
    channelAck,
    channelUnread,
    channelMissionStart,
    channelMissionClose,
    channelMissionList,
  ]);
}

/** Register the channel catalog through the wire-neutral current-SDK adapter. */
export function registerChannelTools(
  server: McpServer,
  deps: ChannelToolDeps,
  options: RegisterWmuxToolsOptions,
): void {
  registerWmuxTools(server, createChannelToolCatalog(deps), options);
}
