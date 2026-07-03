// ─── Channel tools for the bundled MCP server ───────────────────────────
//
// Standard MCP tools (eleven — Channels v2 added channel_ack/channel_unread)
// that expose the `a2a.channel.*` pipe RPC surface to
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
  getSenderPtyId?: () => string;
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

const memberNameSchema = z.string().describe('Display name shown in the channel UI.');

/** Helper: convert the typed `{ ok, ... } | { ok: false, error }` envelope
 *  into an MCP tool result with `isError` set on the failure branch. The
 *  error code is embedded in the text so the agent can branch on it. */
// Set by registerChannelTools so callChannelRpc can stamp the caller's
// verified senderPtyId (D5) on every channel RPC without threading it through
// each of the tool handlers.
let resolveSenderPtyId: () => string = () => '';

async function callChannelRpc(
  method: RpcMethod,
  params: Record<string, unknown>,
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

/** Register the standard channel tools on the given MCP server. The
 *  parent module injects `resolveWorkspaceId` so workspace identity follows
 *  the same verification rules as the rest of the bundled server (verified
 *  PID-map hit first, env-hint fallback on miss). */
export function registerChannelTools(server: McpServer, deps: ChannelToolDeps): void {
  // D5: capture the caller's verified-ptyId resolver for callChannelRpc.
  resolveSenderPtyId = deps.getSenderPtyId ?? (() => '');
  // ── channel_list ──────────────────────────────────────────────────
  server.tool(
    'channel_list',
    'List all channels visible to the calling workspace. Returns the channel metadata (id, name, visibility, topic, status, members) but NOT the message history — use a follow-up get for history.',
    {},
    async () => {
      const workspaceId = await deps.resolveWorkspaceId();
      // U5: `verifiedWorkspaceId` is the transport-resolved caller
      // identity (PID-map hit + env-hint fallback). It is forwarded on
      // every a2a.channel.* call so the daemon can authoritatively pin
      // the sender / enforce archive authz (plan R5/R6). The daemon
      // today reads it only on `post` and `archive`; including it on
      // every call keeps the transport shape uniform.
      return callChannelRpc('a2a.channel.list' as RpcMethod, { workspaceId, verifiedWorkspaceId: workspaceId });
    },
  );

  // ── channel_create ────────────────────────────────────────────────
  server.tool(
    'channel_create',
    'Create a new channel. The creator is auto-added as a member with full history (plan KTD10). Visibility is immutable post-creation; a "private" channel must be joined by an existing member. Topics are optional and editable only via the underlying daemon.',
    {
      name: channelNameSchema,
      visibility: visibilitySchema,
      topic: topicSchema,
      member_id: memberIdSchema,
      member_name: memberNameSchema,
    },
    async ({ name, visibility, topic, member_id, member_name }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        name,
        visibility: visibility as ChannelVisibility,
        createdBy: {
          workspaceId,
          memberId: member_id,
          memberName: member_name,
        },
      };
      if (topic !== undefined) params['topic'] = topic;
      return callChannelRpc('a2a.channel.create' as RpcMethod, params);
    },
  );

  // ── channel_post ──────────────────────────────────────────────────
  server.tool(
    'channel_post',
    'Post a message to a channel. Returns isError=true with code PERSIST_FAILED when persistence fails (U2 maintainer directive: do not swallow saveImmediate errors on the post path), CHANNEL_ARCHIVED for read-only channels, and CHANNEL_MENTIONS_TOO_MANY when a single post lists too many @mentions. Use client_msg_id for at-most-once delivery — a repeat post with the same key returns the original `seq` instead of appending a duplicate. IMPORTANT: check `droppedMentions` on the result — any @mention whose target workspace is NOT a channel member is reported there (not silently dropped), so you know that ping did not land.',
    {
      channel_id: z.string().describe('Target channel id.'),
      text: z.string().describe('Message body. Newlines are preserved.'),
      member_id: memberIdSchema,
      member_name: memberNameSchema,
      client_msg_id: z
        .string()
        .optional()
        .describe('Optional idempotency key. Two posts with the same key on the same channel return the original seq instead of appending a duplicate.'),
      mentions: z
        .array(
          z.object({
            workspace_id: z.string().describe('Mentioned member workspace id. Dropped server-side unless it is a CURRENT channel member.'),
            name: z.string().optional().describe('Display name for the @mention (defaults to the workspace id).'),
            member_id: z.string().optional().describe('Narrow the mention to a specific member; omit for a workspace-level mention.'),
          }),
        )
        .optional()
        .describe('@-mentions to ping specific members. Each must be a current channel member; a non-member target is returned in `droppedMentions` (not silently dropped) so you know it did not land. Mentioned workspaces are notified via their a2a inbox.'),
    },
    async ({ channel_id, text, member_id, member_name, client_msg_id, mentions }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        sender: {
          workspaceId,
          memberId: member_id,
          memberName: member_name,
        },
        text,
      };
      if (client_msg_id !== undefined) params['clientMsgId'] = client_msg_id;
      if (mentions !== undefined) {
        params['mentions'] = mentions.map((m) => ({
          workspaceId: m.workspace_id,
          name: m.name ?? m.workspace_id,
          ...(m.member_id !== undefined ? { memberId: m.member_id } : {}),
        }));
      }
      return callChannelRpc('a2a.channel.post' as RpcMethod, params);
    },
  );

  // ── channel_join ──────────────────────────────────────────────────
  server.tool(
    'channel_join',
    'Join a channel as a member. By default joins with full history (historyFromSeq=0); pass include_history=false to start at the channel\'s current seq (no past messages). Public channels are joinable by any company member; private channels require an existing member to add you (not yet exposed via MCP — see plan Scope Boundaries).',
    {
      channel_id: z.string().describe('Target channel id.'),
      member_id: memberIdSchema,
      member_name: memberNameSchema,
      include_history: z
        .boolean()
        .optional()
        .describe('When true (default), the new member sees the channel\'s full history. When false, they see only posts after their join.'),
    },
    async ({ channel_id, member_id, member_name, include_history }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        member: {
          workspaceId,
          memberId: member_id,
          memberName: member_name,
        },
        includeHistory: include_history !== false,
      };
      return callChannelRpc('a2a.channel.join' as RpcMethod, params);
    },
  );

  // ── channel_leave ─────────────────────────────────────────────────
  server.tool(
    'channel_leave',
    'Leave a channel. The caller\'s (workspaceId, memberId) pair is removed from the member list. If the channel becomes empty, the 7-day empty-channel reaper (plan KTD8) will purge it.',
    {
      channel_id: z.string().describe('Target channel id.'),
      member_id: memberIdSchema,
    },
    async ({ channel_id, member_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callChannelRpc('a2a.channel.leave' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        memberId: member_id,
      });
    },
  );

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
  server.tool(
    'channel_read',
    'Read messages from a channel you can see (public, or private if you are a member). ' +
      'With `since_seq` (pass your cursor + 1 from channel_unread) it returns the OLDEST `limit` ' +
      'messages from that point — contiguous pages, so ack the highest seq you read and repeat ' +
      'until fewer than `limit` return to drain safely. Without `since_seq` it returns the most ' +
      'recent `limit` messages (display). Reading consumes your context window, so prefer a small ' +
      '`limit`. A private channel you are not a member of returns an empty list; a missing channel ' +
      'returns an error.',
    {
      channel_id: z.string().describe('Target channel id.'),
      since_seq: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          'Return messages with seq >= since_seq (forward pagination). When combined with limit, the ' +
            'floor is applied first, then the most recent `limit` of the remainder.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max messages to return, taken from the newest end. Defaults to 50 to protect your context window.'),
    },
    async ({ channel_id, since_seq, limit }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      const params: Record<string, unknown> = {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        limit: limit ?? 50,
      };
      if (since_seq !== undefined) params['sinceSeq'] = since_seq;
      return callChannelRpc('a2a.channel.getMessages' as RpcMethod, params);
    },
  );

  // ── channel_invite ────────────────────────────────────────────────
  // Add ANOTHER workspace to a channel. Unlike channel_join (self-join), this
  // adds a different workspace and is the only way into a PRIVATE channel.
  // Any member may invite (P1b authz); the daemon gates on the caller being a
  // current member. The invited workspace gains history + live messages.
  server.tool(
    'channel_invite',
    'Invite ANOTHER workspace/agent to a channel you belong to. This is the only way to add someone to a private channel (you cannot self-join one). Any member may invite; the invited workspace gains the channel history and live messages. Use channel_join to add YOURSELF to a public channel instead.',
    {
      channel_id: z.string().describe('Target channel id.'),
      invited_workspace_id: z.string().describe('Workspace id of the agent/workspace to add (the invitee, not you).'),
      member_id: z
        .string()
        .describe('Member id for the INVITED workspace within the channel (e.g. "lead", "backend") — identifies the invitee, not the caller.'),
      member_name: z.string().describe('Display name for the INVITED member shown in the channel UI — the invitee, not the caller.'),
      include_history: z
        .boolean()
        .optional()
        .describe('When true (default) the invited member sees the full channel history; false starts them at the current message.'),
    },
    async ({ channel_id, invited_workspace_id, member_id, member_name, include_history }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callChannelRpc('a2a.channel.invite' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        invitedMember: {
          workspaceId: invited_workspace_id,
          memberId: member_id,
          memberName: member_name,
        },
        includeHistory: include_history !== false,
      });
    },
  );

  // ── channel_get_members ───────────────────────────────────────────
  // The roster read: who is in a channel. Pairs with channel_invite (know who
  // is already a member before adding) and channel_read (attribute messages).
  // Wraps the existing a2a.channel.getMembers RPC; a private channel you are not
  // a member of returns an empty list (its membership is never leaked).
  server.tool(
    'channel_get_members',
    'List the members of a channel you can see. Returns each member\'s workspaceId, memberId, joinedAt, and history floor. A private channel you are not a member of returns an empty list (membership is not leaked to non-members).',
    {
      channel_id: z.string().describe('Target channel id.'),
    },
    async ({ channel_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callChannelRpc('a2a.channel.getMembers' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
      });
    },
  );

  // ── channel_ack (Channels v2) ─────────────────────────────────────
  // The consume signal of the durable inbox: advances the caller's
  // per-member read cursor (lastReadSeq). The wake worker re-nudges a
  // member while it has unread mentions and STOPS on ack — so an agent
  // that reads a channel should ack the highest seq it processed, or it
  // will be re-pinged about the same messages.
  server.tool(
    'channel_ack',
    'Acknowledge channel messages up to a seq (inclusive) as consumed. Call this after channel_read with the highest seq you actually processed (read oldest-first via since_seq and repeat until drained — do not ack past messages you have not seen). Advances your durable read cursor, clears your unread count, and stops re-nudges. Advance-only (acking an older seq never rewinds) and clamped to the channel head. Requires member_id to move a cursor; an unknown member_id is an error, and omitting it records read receipts only.',
    {
      channel_id: z.string().describe('Target channel id.'),
      upto_seq: z
        .number()
        .int()
        .min(0)
        .describe('Highest message seq you have consumed (inclusive) — the last seq returned by the channel_read page you just processed.'),
      member_id: z
        .string()
        .optional()
        .describe('YOUR member row in this channel (e.g. "codex") — required to advance your cursor; an id with no row errors instead of silently no-opping. Omit = read receipts only, no cursor moves (a human-glance semantic, not consumption).'),
    },
    async ({ channel_id, upto_seq, member_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callChannelRpc('a2a.channel.ack' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        uptoSeq: upto_seq,
        ...(member_id !== undefined ? { memberId: member_id } : {}),
      });
    },
  );

  // ── channel_unread (Channels v2) ──────────────────────────────────
  // The cheap "do I owe anything?" poll: per-channel unread + mention-unread
  // counts derived from the durable cursor. Reading this does NOT consume
  // messages (only channel_ack advances the cursor). `trimmedBeforeCursor`
  // > 0 means retention removed messages before you read them — the gap is
  // reported, never silently swallowed.
  server.tool(
    'channel_unread',
    'Summarize your unread channel messages: per-channel unread count, mention-unread count (messages that @-mention you), your cursor (lastReadSeq), the channel head seq, and trimmedBeforeCursor (messages lost to retention before you read them — never silently dropped). Cheap to call; does not consume messages. Follow up with channel_read + channel_ack.',
    {
      member_id: z
        .string()
        .optional()
        .describe('Narrow the summary to one of your member rows. Omit for every row your workspace holds.'),
    },
    async ({ member_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callChannelRpc('a2a.channel.unread' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        ...(member_id !== undefined ? { memberId: member_id } : {}),
      });
    },
  );
}
