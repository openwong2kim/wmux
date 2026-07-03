// ─── `wmux channel` — the universal agent surface for Channels v2 ─────────
//
// Any shell-capable agent running inside a wmux pane (Codex, OpenCode,
// Hermes, a bash loop…) participates in channels through these subcommands —
// no MCP client required. This file is deliberately the onboarding doc: an
// agent that can read `wmux channel --help` can be a channel member.
//
// Transport: the DAEMON control pipe, directly (`sendDaemonRequest`) — NOT
// the main-process pipe. Rationale (design doc "두 RPC 표면과 신뢰 모델"):
// the daemon owns channel state and survives the GUI, so `wmux channel`
// keeps working headless (GUI closed, reboot-recovery window) — which is the
// money-demo path. Identity: we attach `senderPtyId` and the daemon stamps
// `verifiedWorkspaceId` server-side from its OWN session record
// (channelCallerIdentity.ts) — the CLI never claims a workspace.
//
// senderPtyId resolution ladder:
//   1. verified PID-map walk via the MAIN pipe (resolveSelfContext, X4) —
//      strongest, but needs the GUI alive;
//   2. env WMUX_PTY_ID — stamped into the pane env at spawn by the daemon
//      session itself; survives headless. Same-user forgeable (#113 ceiling,
//      accepted): the daemon still derives the WORKSPACE from its own record.
// Outside a wmux pane both fail → mutations fail closed (NOT_AUTHORIZED).

import { sendRequest, sendDaemonRequest } from '../client';
import { parseFlag } from '../utils';
import { resolveSelfContext, getParentPidDefault } from '../identity';
import type { RpcMethod, RpcResponse } from '../../shared/rpc';
import { ENV_KEYS } from '../../shared/constants';

export const CHANNEL_HELP = `
wmux channel — durable agent messaging (Channels v2)

  You are (probably) an agent in a wmux pane. Teammates post messages to
  channels; you read them, reply, and ACK what you consumed. While you have
  unread mentions you will be re-nudged — ack is what makes it stop.

  wmux channel unread [--member <id>]
      Your per-channel unread + mention counts. Cheap; call when nudged.
  wmux channel read <channel> [--since <seq>] [--limit <n>]
      Print messages, oldest first, paging forward. Without --since it
      starts from YOUR unread cursor (when you have one member row here).
      A full page prints a continue hint. <channel> is an id (ch-…) or name.
  wmux channel post <channel> <text…> [--member <id>] [--name <display>]
      Post a message. Your workspace identity is stamped server-side.
      Body may contain flag-like tokens after a bare --:
        wmux channel post dev -- try again with --limit 5
  wmux channel ack <channel> <uptoSeq|all> [--member <id>]
      Mark messages ≤ uptoSeq consumed ('all' = everything currently there).
      Advance-only; clears unread; stops re-nudges. Ack only what you read.
  wmux channel join <channel> [--member <id>] [--name <display>]
      Join a public channel as <member>.
  wmux channel list
      Channels visible to your workspace.

  --member is your member id in the channel. Defaults to $WMUX_MEMBER_ID;
  post/ack without it resolve your workspace's SINGLE member row in that
  channel (two+ rows → pass --member; never guessed). join defaults to
  "agent" — pick a stable, short id (e.g. "codex") so humans can tell
  agents apart in the roster.
  --json on any subcommand prints the raw RPC payload.

  Typical loop when nudged: unread → read → do the work → post → ack.
`;

interface ChannelCallOpts {
  /** Require a resolvable pane identity before issuing the call. */
  mutating: boolean;
}

/** senderPtyId ladder: verified walk (main pipe) → pane env → ''. */
async function resolveSenderPtyId(): Promise<string> {
  try {
    const ctx = await resolveSelfContext({
      sendRequest,
      env: process.env,
      ppid: process.ppid,
      getParentPid: getParentPidDefault,
    });
    if (ctx.ptyId) return ctx.ptyId;
  } catch {
    // main pipe down (headless) — fall through to the env hint
  }
  const envPty = process.env[ENV_KEYS.PTY_ID];
  return typeof envPty === 'string' && envPty.trim().length > 0 ? envPty.trim() : '';
}

function exitNoPaneIdentity(): never {
  console.error(
    'Error: not inside a wmux pane (no resolvable pane identity — PID walk missed and WMUX_PTY_ID is unset).\n' +
      'Channel mutations are fail-closed without one. Run this from a shell inside a wmux pane.',
  );
  process.exit(1);
}

/** Mutations fail closed BEFORE any RPC (including helper lookups). */
async function requirePaneIdentityOrExit(): Promise<void> {
  if (!(await resolveSenderPtyId())) exitNoPaneIdentity();
}

/**
 * Issue one channel RPC on the daemon pipe with senderPtyId attached, and
 * unwrap the two-layer envelope (pipe RpcResponse → ChannelService Result).
 * Exits the process with a readable error on either layer's failure.
 */
async function callChannel(
  method: RpcMethod,
  params: Record<string, unknown>,
  opts: ChannelCallOpts,
): Promise<Record<string, unknown>> {
  const senderPtyId = await resolveSenderPtyId();
  if (!senderPtyId && opts.mutating) exitNoPaneIdentity();
  let response: RpcResponse;
  try {
    response = await sendDaemonRequest(method, {
      ...params,
      ...(senderPtyId ? { senderPtyId } : {}),
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!response.ok) {
    console.error(`Error: ${response.error}`);
    process.exit(1);
  }
  const result = response.result as Record<string, unknown> | null;
  if (result !== null && typeof result === 'object' && result['ok'] === false) {
    const err = result['error'] as { code?: string; message?: string } | undefined;
    console.error(`Error [${err?.code ?? 'UNKNOWN'}]: ${err?.message ?? 'channel call failed'}`);
    process.exit(1);
  }
  return result ?? {};
}

/**
 * `<channel>` accepts a channel id or a name. Channel NAMES may legally
 * start with "ch-" too (lowercase letters/digits/hyphens), so a prefix
 * check cannot separate the two (Codex round-3: a channel named
 * "ch-release" was unreachable by name). Resolution: exact id in the
 * caller's visible listing wins, then exact unique name; an unmatched
 * ch-… ref passes through so the daemon answers authoritatively.
 */
async function resolveChannelId(ref: string): Promise<string> {
  const result = await callChannel('a2a.channel.list' as RpcMethod, {}, { mutating: false });
  const channels = (result['channels'] as Array<{ id?: string; name?: string; status?: string }> | undefined) ?? [];
  if (channels.some((c) => c.id === ref)) return ref;
  const matches = channels.filter((c) => c.name === ref);
  if (matches.length === 1 && typeof matches[0].id === 'string') return matches[0].id;
  if (matches.length > 1) {
    console.error(`Error: channel name "${ref}" is ambiguous (${matches.length} matches) — use the channel id.`);
    process.exit(1);
  }
  if (ref.startsWith('ch-')) return ref;
  console.error(
    `Error: no visible channel named "${ref}". Run \`wmux channel list\` to see what your workspace can reach.`,
  );
  process.exit(1);
}

function memberIdFrom(args: string[]): string {
  return parseFlag(args, '--member') ?? process.env['WMUX_MEMBER_ID'] ?? 'agent';
}

/**
 * Which member row is THIS caller in <channelId>? Explicit `--member` (or
 * $WMUX_MEMBER_ID) wins; otherwise resolve from the caller's own unread
 * entries — server-filtered to the verified workspace, so the rows ARE the
 * identities this caller can legitimately act as. Wake-worker discipline:
 * never guess. A made-up default ("agent") used to no-op the ack against the
 * REAL row (codex/opencode/…) while printing success, leaving the wake
 * worker re-nudging forever (Codex review). Two+ rows without an explicit
 * choice is an error; zero rows returns undefined (let the daemon speak).
 */
async function resolveOwnMemberId(channelId: string, args: string[]): Promise<string | undefined> {
  const explicit = parseFlag(args, '--member') ?? process.env['WMUX_MEMBER_ID'];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const result = await callChannel('a2a.channel.unread' as RpcMethod, {}, { mutating: false });
  const entries = (result['entries'] as Array<{ channelId: string; memberId: string }> | undefined) ?? [];
  const ids = Array.from(new Set(entries.filter((e) => e.channelId === channelId).map((e) => e.memberId)));
  if (ids.length > 1) {
    console.error(
      `Error: your workspace has ${ids.length} member identities in this channel (${ids.join(', ')}) — pass --member <id> so the right cursor moves.`,
    );
    process.exit(1);
  }
  return ids[0];
}

/**
 * Best-effort variant of the row lookup for READ-path hints: never exits,
 * returns [] on any failure. Read output must not be killed by a failed
 * auxiliary call after the messages already printed.
 */
async function quietOwnMemberRows(
  channelId: string,
): Promise<Array<{ memberId: string; lastReadSeq: number }>> {
  try {
    const senderPtyId = await resolveSenderPtyId();
    const response = await sendDaemonRequest('a2a.channel.unread' as RpcMethod, {
      ...(senderPtyId ? { senderPtyId } : {}),
    });
    if (!response.ok) return [];
    const result = response.result as {
      ok?: boolean;
      entries?: Array<{ channelId?: string; memberId?: string; lastReadSeq?: number }>;
    } | null;
    if (!result || result.ok === false || !Array.isArray(result.entries)) return [];
    return result.entries
      .filter((e) => e.channelId === channelId && typeof e.memberId === 'string')
      .map((e) => ({
        memberId: e.memberId as string,
        lastReadSeq: typeof e.lastReadSeq === 'number' ? e.lastReadSeq : 0,
      }));
  } catch {
    return [];
  }
}

/**
 * Strip the channel option flags (and their values) so the remainder is pure
 * positional payload — mirrors input.ts stripInputFlags. Without this a flag
 * VALUE (`--since 3`) would be mistaken for a positional (`read 3 …`), and a
 * post body containing a token that starts with `-` would be silently eaten.
 */
const VALUE_FLAGS = new Set(['--member', '--name', '--since', '--limit']);
function positionalsOf(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUE_FLAGS.has(a)) {
      i++; // skip the flag's value
      continue;
    }
    if (a === '--json') continue;
    out.push(a);
  }
  return out;
}

const fmtMsg = (m: { seq?: number; memberName?: string; memberId?: string; text?: string }): string =>
  `[seq ${m.seq}] ${m.memberName ?? m.memberId ?? '?'}: ${m.text ?? ''}`;

export async function handleChannel(sub: string | undefined, args: string[], jsonMode: boolean): Promise<void> {
  // A bare `--` ends option parsing: everything after it is verbatim
  // positional payload — post bodies often contain flag-like tokens
  // (`wmux channel post dev -- try --limit 5`), and the pair-aware stripper
  // below would otherwise eat them as channel options (Codex re-review P3).
  // The global --json/--help flags are consumed by the CLI entry before argv
  // reaches subcommands, so those two cannot ride a body either way.
  const dd = args.indexOf('--');
  const verbatim = dd === -1 ? [] : args.slice(dd + 1);
  args = dd === -1 ? args : args.slice(0, dd);
  const positionals = positionalsOf(args).concat(verbatim);
  switch (sub) {
    case 'unread': {
      // Same identity ladder as post/ack (GLM review): explicit --member, then
      // $WMUX_MEMBER_ID — so a multi-agent workspace that pins its member id in
      // the env gets a filtered summary here too, not the whole workspace's rows.
      // Absent both = every row (the daemon's default).
      const memberId = parseFlag(args, '--member') ?? (process.env['WMUX_MEMBER_ID'] || undefined);
      const result = await callChannel(
        'a2a.channel.unread' as RpcMethod,
        { ...(memberId !== undefined ? { memberId } : {}) },
        { mutating: false },
      );
      const entries =
        (result['entries'] as Array<{
          channelId: string;
          name: string;
          memberId: string;
          lastReadSeq: number;
          headSeq: number;
          unread: number;
          mentionUnread: number;
          trimmedBeforeCursor: number;
        }> | undefined) ?? [];
      if (jsonMode) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      const owed = entries.filter((e) => e.unread > 0 || e.trimmedBeforeCursor > 0);
      if (owed.length === 0) {
        console.log('No unread channel messages.');
        return;
      }
      for (const e of owed) {
        const trimmed = e.trimmedBeforeCursor > 0 ? `  [WARNING: ${e.trimmedBeforeCursor} message(s) trimmed before you read them]` : '';
        console.log(
          `#${e.name} (${e.channelId}) member=${e.memberId}: ${e.unread} unread` +
            (e.mentionUnread > 0 ? ` (${e.mentionUnread} mention you)` : '') +
            ` — read: wmux channel read ${e.channelId} --since ${e.lastReadSeq + 1}${trimmed}`,
        );
      }
      return;
    }

    case 'read': {
      const [ref] = positionals;
      if (!ref) {
        console.error('Usage: wmux channel read <channel> [--since <seq>] [--limit <n>]');
        process.exit(1);
      }
      const channelId = await resolveChannelId(ref);
      const since = parseFlag(args, '--since');
      const limit = parseFlag(args, '--limit');
      // Consume-oriented default (Codex re-review P1): with no --since, start
      // from YOUR cursor when this workspace has exactly one member row here.
      // Pages are then oldest-first and contiguous, so the printed ack hint
      // can never jump the cursor over messages you haven't seen. No single
      // row (browsing / multi-agent workspace / not a member) → the newest-N
      // display window, and the hints below adapt.
      const rows = await quietOwnMemberRows(channelId);
      let sinceUsed: number | undefined;
      if (since !== undefined) sinceUsed = Number(since);
      else if (rows.length === 1) sinceUsed = rows[0].lastReadSeq + 1;
      const limitUsed = limit !== undefined ? Number(limit) : 50;
      const params: Record<string, unknown> = { channelId, limit: limitUsed };
      if (sinceUsed !== undefined) params['sinceSeq'] = sinceUsed;
      const result = await callChannel('a2a.channel.getMessages' as RpcMethod, params, { mutating: false });
      const messages = (result['messages'] as Array<{ seq: number; memberName?: string; memberId?: string; text?: string }> | undefined) ?? [];
      if (jsonMode) {
        console.log(JSON.stringify(messages, null, 2));
        return;
      }
      if (messages.length === 0) {
        console.log('(no messages)');
        return;
      }
      for (const m of messages) console.log(fmtMsg(m));
      const last = messages[messages.length - 1];
      if (sinceUsed !== undefined && messages.length === limitUsed) {
        console.log(`(full page — more may remain: wmux channel read ${channelId} --since ${last.seq + 1})`);
      }
      if (rows.length > 1) {
        // Multi-row workspace: a bare ack would hit the never-guess error, so
        // the hint must carry the member (Codex round-3) — from an explicit
        // --member on this read, or by mapping --since back to the ONE row
        // whose cursor it came from (the unread output prints per-row
        // `--since cursor+1`, so the mapping is usually exact).
        const explicit = parseFlag(args, '--member');
        const matched = sinceUsed !== undefined ? rows.filter((r) => r.lastReadSeq + 1 === sinceUsed) : [];
        const hintId = explicit ?? (matched.length === 1 ? matched[0].memberId : undefined);
        if (hintId !== undefined) {
          console.log(`(consumed? then: wmux channel ack ${channelId} ${last.seq} --member ${hintId})`);
        } else {
          // No safe attribution (tail browse / ambiguous cursor match) —
          // route through the per-row cursors instead of printing a command
          // that either errors or jumps a cursor over unseen messages.
          console.log(
            `(this workspace has ${rows.length} member rows — run: wmux channel unread, then read --since <cursor+1> and ack --member <id>)`,
          );
        }
      } else if (rows.length === 1) {
        console.log(`(consumed? then: wmux channel ack ${channelId} ${last.seq})`);
      }
      // rows.length === 0 (not a member / browsing) prints NO ack hint (GLM
      // review): this caller has no cursor, so an ack would be a receipt-only
      // no-op — a hint here just invites a command that does nothing.
      return;
    }

    case 'post': {
      const [ref, ...textParts] = positionals;
      const text = textParts.join(' ');
      if (!ref || !text) {
        console.error('Usage: wmux channel post <channel> <text…> [--member <id>] [--name <display>]');
        process.exit(1);
      }
      await requirePaneIdentityOrExit();
      const channelId = await resolveChannelId(ref);
      // Post AS the row you actually occupy: an invented default would
      // misattribute the message in the roster AND defeat the self-unread
      // exemption (your own post would nudge you). Zero rows falls back to
      // the legacy default and lets the daemon's NOT_A_MEMBER speak.
      const memberId = (await resolveOwnMemberId(channelId, args)) ?? memberIdFrom(args);
      const memberName = parseFlag(args, '--name') ?? memberId;
      const result = await callChannel(
        'a2a.channel.post' as RpcMethod,
        {
          channelId,
          text,
          // sender.workspaceId is deliberately ABSENT — the daemon backfills
          // it from the server-side stamp (channelCallerIdentity.ts).
          sender: { memberId, memberName },
        },
        { mutating: true },
      );
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      const message = result['message'] as { seq?: number } | undefined;
      console.log(`Posted to ${channelId} as ${memberId} (seq ${message?.seq ?? '?'}).`);
      const dropped = result['droppedMentions'] as Array<{ workspaceId: string }> | undefined;
      if (dropped && dropped.length > 0) {
        console.log(`WARNING: ${dropped.length} @mention(s) did NOT land (target not a channel member): ${dropped.map((d) => d.workspaceId).join(', ')}`);
      }
      return;
    }

    case 'ack': {
      const [ref, uptoRaw] = positionals;
      if (!ref || !uptoRaw) {
        console.error("Usage: wmux channel ack <channel> <uptoSeq|all> [--member <id>]");
        process.exit(1);
      }
      // Validate the seq BEFORE any network round-trip (fail fast on a local
      // arg). 'all' = everything currently in the channel; the daemon clamps
      // to head. Require a whole seq (GLM review): the daemon rejects
      // fractional/oversized uptoSeq by clamping to 0 (a no-op), but then
      // echoes the row's ACTUAL cursor — so `ack ch 1.5` would print
      // "Acked … up to seq <current>" and look successful while nothing moved.
      // MAX_SAFE_INTEGER ('all') is itself a safe integer, so the sentinel passes.
      const uptoSeq = uptoRaw === 'all' ? Number.MAX_SAFE_INTEGER : Number(uptoRaw);
      if (!Number.isSafeInteger(uptoSeq) || uptoSeq < 0) {
        console.error(`Error: uptoSeq must be a non-negative whole number or 'all' (got "${uptoRaw}").`);
        process.exit(1);
      }
      await requirePaneIdentityOrExit();
      const channelId = await resolveChannelId(ref);
      // Which cursor moves? Resolve MY row — never a made-up default (see
      // resolveOwnMemberId). undefined (not a member) sends no memberId so
      // the daemon answers honestly instead of no-opping a phantom row.
      const memberId = await resolveOwnMemberId(channelId, args);
      const result = await callChannel(
        'a2a.channel.ack' as RpcMethod,
        { channelId, uptoSeq, ...(memberId !== undefined ? { memberId } : {}) },
        { mutating: true },
      );
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (memberId !== undefined) {
        console.log(`Acked ${channelId} up to seq ${result['lastReadSeq'] ?? uptoSeq} as ${memberId}.`);
      } else {
        // No member row here → the daemon recorded read receipts only; there
        // is no cursor to advance (and none was silently invented).
        console.log(`Recorded a read receipt for ${channelId} (no member row here — no cursor advanced).`);
      }
      return;
    }

    case 'join': {
      const [ref] = positionals;
      if (!ref) {
        console.error('Usage: wmux channel join <channel> [--member <id>] [--name <display>]');
        process.exit(1);
      }
      const channelId = await resolveChannelId(ref);
      const memberId = memberIdFrom(args);
      const memberName = parseFlag(args, '--name') ?? memberId;
      const result = await callChannel(
        'a2a.channel.join' as RpcMethod,
        { channelId, member: { memberId, memberName } },
        { mutating: true },
      );
      if (jsonMode) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Joined ${channelId} as ${memberId}. New messages from now count as your unread.`);
      return;
    }

    case 'list': {
      const result = await callChannel('a2a.channel.list' as RpcMethod, {}, { mutating: false });
      const channels = (result['channels'] as Array<{ id?: string; name?: string; visibility?: string; status?: string }> | undefined) ?? [];
      if (jsonMode) {
        console.log(JSON.stringify(channels, null, 2));
        return;
      }
      if (channels.length === 0) {
        console.log('No channels visible to this workspace.');
        return;
      }
      for (const c of channels) {
        console.log(`#${c.name}  ${c.id}  (${c.visibility ?? '?'}${c.status === 'archived' ? ', archived' : ''})`);
      }
      return;
    }

    case 'help':
    case undefined: {
      console.log(CHANNEL_HELP.trim());
      return;
    }

    default: {
      console.error(`Unknown channel subcommand: "${sub}".`);
      console.log(CHANNEL_HELP.trim());
      process.exit(1);
    }
  }
}
