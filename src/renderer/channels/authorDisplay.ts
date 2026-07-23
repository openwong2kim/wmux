// ─── Channel sender identity display (identity audit 1a) ─────────────────
//
// The transcript used to render `memberName` alone — a free-form string the
// SENDER supplies on every post (MCP `channel_post` `member_name`). Every
// Claude Code pane passes the same product name, so multiple agents collapsed
// into one indistinguishable "Claude Code" author. The forgery-resistant
// disambiguators the daemon already persists on the message — `memberId`
// (the pane auto-name, e.g. "w26-1(claude)") and `workspaceId` — were never
// shown. This module derives the author line from those stored fields:
//
//   agent → primary = memberName (fallback memberId), chip = memberId
//           (skipped when the primary already carries it)
//   human → primary = the localized "Me" (substituted by the component),
//           chip = null for a post from the unified ws-human seat (one human,
//           no chip needed); a pre-P5 human post keeps its workspace-name chip
//           as historical context
//
// Server-owned roster names (remediation plan Phase 1b) will replace the
// free-form primary later; this layer is schema-free and works on history.

import { HUMAN_MEMBER_ID, HUMAN_WORKSPACE_ID } from '../../shared/channels';

export interface ChannelAuthorDisplay {
  kind: 'human' | 'agent';
  /** Primary author label. Empty for a human sender — the component
   *  substitutes the localized "Me" (i18n stays out of this module). */
  primary: string;
  /** Muted identity chip: the pane memberId for agents, the workspace name
   *  for humans. null when it would only repeat the primary label. */
  chip: string | null;
  /** Stable per-workspace hue (0-359) for the author color badge. */
  hue: number;
}

/** Deterministic workspaceId → hue. The same workspace always renders the
 *  same badge color across sessions; distinct workspaces usually differ. */
export function workspaceHue(workspaceId: string): number {
  let h = 0;
  for (let i = 0; i < workspaceId.length; i++) {
    h = (h * 31 + workspaceId.charCodeAt(i)) >>> 0;
  }
  return h % 360;
}

/** Shorten an opaque id for display when no name resolves ("ws-72ca48f2…"). */
function shortId(id: string): string {
  return id.length > 11 ? `${id.slice(0, 11)}…` : id;
}

/**
 * Derive the transcript author line for one message. `memberName` is typed
 * `string` in the schema, but live data contains `null` (legacy renderer
 * posts) — treated as absent rather than rendered as a blank author line.
 */
export function formatChannelAuthor(
  message: { workspaceId: string; memberId: string; memberName?: string | null },
  resolveWorkspaceName: (workspaceId: string) => string | undefined,
): ChannelAuthorDisplay {
  const hue = workspaceHue(message.workspaceId);
  const memberId = typeof message.memberId === 'string' ? message.memberId.trim() : '';
  const memberName = typeof message.memberName === 'string' ? message.memberName.trim() : '';

  // Keyed on memberId ONLY: memberName is sender-supplied free text, so an
  // agent naming itself "local-ui" must NOT render as the human seat (the
  // pipe rejects that name, but the display layer pins it too; ship review).
  if (memberId === HUMAN_MEMBER_ID) {
    // P5: a post from the unified human seat needs NO chip — there is exactly
    // one human, "Me" alone identifies them. Pre-P5 posts carry the real
    // workspace they were sent from; keep that chip as historical context.
    if (message.workspaceId === HUMAN_WORKSPACE_ID) {
      return { kind: 'human', primary: '', chip: null, hue };
    }
    const ws = resolveWorkspaceName(message.workspaceId)?.trim();
    return { kind: 'human', primary: '', chip: ws || shortId(message.workspaceId), hue };
  }

  const primary = memberName || memberId || shortId(message.workspaceId);
  // Skip the chip when the primary already carries the pane identity — e.g.
  // memberName "w16-1(claude)" with memberId "w16-1" (live naming drift).
  const chip = memberId && !primary.includes(memberId) ? memberId : null;
  return { kind: 'agent', primary, chip, hue };
}

export interface RosterMemberLabel {
  /** Primary roster label. Empty for the viewer's own row — the component
   *  substitutes the localized "Me". */
  primary: string;
  /** Append the " · <workspace>" suffix. Skipped when the primary already
   *  IS the workspace label (a non-self human seat). */
  showWorkspaceSuffix: boolean;
}

/**
 * Roster row label (identity audit C-A3). Keying on `memberId ===
 * selfMemberId` alone mislabels EVERY workspace's GUI seat as "Me" — they
 * all share the reserved member id. Only the viewer's own (workspace,
 * member) row is "Me"; another workspace's human seat reads as that
 * workspace's name.
 */
export function rosterMemberLabel(
  member: { workspaceId: string; memberId: string; memberName?: string | null },
  selfWorkspaceId: string | null,
  selfMemberId: string,
  workspaceLabel: string,
): RosterMemberLabel {
  const isSelf = member.workspaceId === selfWorkspaceId && member.memberId === selfMemberId;
  // P5: the unified human row is the ONLY human row — "Me" alone is
  // unambiguous, and its workspace is the reserved virtual one (a raw
  // 'ws-human' suffix would just leak an internal token).
  if (isSelf) return { primary: '', showWorkspaceSuffix: false };
  if (member.memberId === selfMemberId) {
    // Another workspace's human seat — the workspace is its identity.
    return { primary: workspaceLabel, showWorkspaceSuffix: false };
  }
  // 1b: prefer the SERVER-derived roster name (this is the replacement the
  // module header anticipated). GUI-added rows are unchanged (their memberId
  // IS the auto-name the daemon derives), but a CLI-joined row whose
  // memberId is the opaque spawn-stamped ptyId now reads as its registry
  // display instead (review F1).
  const memberName = typeof member.memberName === 'string' ? member.memberName.trim() : '';
  return { primary: memberName || member.memberId, showWorkspaceSuffix: true };
}
