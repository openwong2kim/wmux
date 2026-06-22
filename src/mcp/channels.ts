// ─── Channel tools for the bundled MCP server ───────────────────────────
//
// Six standard MCP tools that expose the `a2a.channel.*` pipe RPC surface to
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
//  - `channel.history` is intentionally deferred per plan Scope Boundaries.
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

/** Register the six standard channel tools on the given MCP server. The
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
    'Post a message to a channel. Returns isError=true with code PERSIST_FAILED when persistence fails (U2 maintainer directive: do not swallow saveImmediate errors on the post path) and CHANNEL_ARCHIVED for read-only channels. Use client_msg_id for at-most-once delivery — a repeat post with the same key returns the original `seq` instead of appending a duplicate.',
    {
      channel_id: z.string().describe('Target channel id.'),
      text: z.string().describe('Message body. Newlines are preserved.'),
      member_id: memberIdSchema,
      member_name: memberNameSchema,
      client_msg_id: z
        .string()
        .optional()
        .describe('Optional idempotency key. Two posts with the same key on the same channel return the original seq instead of appending a duplicate.'),
    },
    async ({ channel_id, text, member_id, member_name, client_msg_id }) => {
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

  // ── channel_archive ───────────────────────────────────────────────
  server.tool(
    'channel_archive',
    'Archive a channel. Archive is one-way (R4); once archived the channel is read-only for new posts but existing members retain history access. The authz rule (plan KTD-F) is: caller is the creator (createdBy) or the company CEO — both are checked against the verified workspaceId, not the client-supplied `archivedBy`.',
    {
      channel_id: z.string().describe('Target channel id.'),
    },
    async ({ channel_id }) => {
      const workspaceId = await deps.resolveWorkspaceId();
      return callChannelRpc('a2a.channel.archive' as RpcMethod, {
        workspaceId,
        verifiedWorkspaceId: workspaceId,
        channelId: channel_id,
        archivedBy: workspaceId,
      });
    },
  );
}
