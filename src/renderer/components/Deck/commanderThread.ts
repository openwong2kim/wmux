// ─── Command Deck — Commander thread pure helpers (Phase 1) ──────────────────
//
// Pure, store-free logic behind the Commander tab, kept out of the React
// component so it can be unit-tested directly (the packaged Electron UI can't
// be automated). Three concerns:
//
//   1. Resolving the reserved `#commander` channel out of the catalog.
//   2. Turning a flat message list into "one dispatch + its replies" threads
//      for the grouped render (P1d).
//   3. Deriving the invite-before-post target set from a fan-out's @mentions
//      (P1c) — each mentioned workspace must be a member before the post, or
//      the daemon drops the mention (validation is per-WORKSPACE).

import type { Channel, ChannelMention, ChannelMessage } from '../../../shared/channels';
import type { ChannelMemberAddress } from '../../stores/slices/channelsSlice';
import { panePrincipalId } from '../../../shared/principals';

/** Canonical name of the reserved Commander thread channel. A plain private
 *  channel (D1) — it also shows up under the Channels tab like any other room;
 *  the Commander view is just a specialized render over the same message list. */
export const COMMANDER_CHANNEL_NAME = 'commander';

/** Find the live `#commander` channel in the catalog mirror, or null. Picks an
 *  ACTIVE channel first (an archived commander channel should not be reused for
 *  a fresh fan-out); falls back to any name match so the view can still render
 *  history from an archived one. */
export function findCommanderChannel(
  channels: Record<string, Channel>,
): Channel | null {
  let archived: Channel | null = null;
  for (const ch of Object.values(channels)) {
    if (ch.name !== COMMANDER_CHANNEL_NAME) continue;
    if (ch.status === 'active') return ch;
    archived = archived ?? ch;
  }
  return archived;
}

/** One dispatch and the replies that followed it. A dispatch is a message from
 *  the human seat (`humanWorkspaceId`); replies are everything else until the
 *  next dispatch. `dispatch` is null for the rare group of replies that precede
 *  the first dispatch (e.g. an agent posted into the channel first). */
export interface CommanderThread {
  dispatch: ChannelMessage | null;
  replies: ChannelMessage[];
}

/**
 * Group a flat, seq-ordered message list into "one send + N replies" threads
 * (P1d). A new thread opens on every human dispatch; each following agent post
 * attaches to the open thread. The input is copied + sorted by seq so callers
 * can pass the store array directly. Pure — no store reads.
 */
export function groupCommanderThreads(
  messages: ChannelMessage[],
  humanWorkspaceId: string,
): CommanderThread[] {
  const sorted = [...messages].sort((a, b) => a.seq - b.seq);
  const threads: CommanderThread[] = [];
  let current: CommanderThread | null = null;
  for (const m of sorted) {
    if (m.workspaceId === humanWorkspaceId) {
      current = { dispatch: m, replies: [] };
      threads.push(current);
    } else if (current) {
      current.replies.push(m);
    } else {
      current = { dispatch: null, replies: [m] };
      threads.push(current);
    }
  }
  return threads;
}

/**
 * Derive the invite-before-post member set from a fan-out's @mentions (P1c).
 * The daemon validates mentions per-WORKSPACE (a mention lands iff its
 * workspace is a member), so one representative member per unique non-human
 * workspace is enough for delivery — but we key the member row on the pane's
 * auto name + stable principal coordinate (matching the ChannelMembers
 * "add an agent pane" flow) so the roster stays accurate. The human seat is
 * skipped (it is already the channel creator/member). Pure + exported for
 * unit tests.
 */
export function fanoutInviteMembers(
  mentions: ChannelMention[],
  humanWorkspaceId: string,
): ChannelMemberAddress[] {
  const byWorkspace = new Map<string, ChannelMemberAddress>();
  for (const m of mentions) {
    if (m.workspaceId === humanWorkspaceId) continue;
    if (byWorkspace.has(m.workspaceId)) continue;
    const member: ChannelMemberAddress = {
      workspaceId: m.workspaceId,
      memberId: m.name,
      memberName: m.name,
    };
    // The pane pin gives a stable coordinate for the member row's liveness /
    // wake targeting; omit it for a bare (workspace-only) mention.
    if (m.paneId) member.principalId = panePrincipalId(m.workspaceId, m.paneId);
    byWorkspace.set(m.workspaceId, member);
  }
  return [...byWorkspace.values()];
}
