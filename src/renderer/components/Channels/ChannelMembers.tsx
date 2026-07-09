// ─── Channel members roster + join/leave (membership v1) ─────────────────────
//
// The keystone the UX panel called out: make channel membership VISIBLE, give
// `leave` a home, and add a discoverable, keyboard-operable join — so a human
// can actually participate in an agent channel (you only receive a channel's
// live messages if your workspace is a member / in recipientWorkspaceIds).
//
// view/container split (mirrors ChannelView / ChannelViewContent):
//   - ChannelMembersView  — pure, props-driven, internal popover open-state.
//     `useState` is SSR-safe for the renderToStaticMarkup test harness.
//   - ChannelMembersControl — store-connected; resolves identity, the joinable
//     workspace list, and wires join/leave + the self-leave view cleanup.
//
// Scope (P5 — unified human seat):
//   - Remove (✕) is SELF-ONLY and shows on the exact (self ws, self memberId)
//     row — you can leave, not eject (matches daemon leave() capability).
//   - There is ONE app-wide human seat (ws-human); agents join as panes via the
//     "add an agent pane" picker. The old "add a workspace" picker is retired —
//     the container passes an empty joinableWorkspaces list.
//   - On a successful self-leave of the active channel, the container clears
//     activeChannelId so the dock doesn't show a dead/blank pane.
//
// No hex literals — theme tokens only. Agents keep per-agent membership via the
// MCP channel_post member_id; the human UI identity is the single reserved seat
// (HUMAN_MEMBER_ID on HUMAN_WORKSPACE_ID).

import { useState } from 'react';
import type { Channel, ChannelMember } from '../../../shared/channels';
import { HUMAN_WORKSPACE_ID, HUMAN_MEMBER_ID } from '../../../shared/channels';
import { panePrincipalId } from '../../../shared/principals';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { IconX, IconUsers } from '../icons';
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { rosterMemberLabel } from '../../channels/authorDisplay';
import { buildMentionCandidates } from './Composer';

export interface JoinableWorkspace {
  id: string;
  name: string;
}

/** R2 — explicit-join candidate: a live agent pane that is not a member yet. */
export interface JoinablePane {
  workspaceId: string;
  paneId: string;
  /** auto name that becomes the channel memberId (same scheme as the mention token, e.g. "w8-1(claude)"). */
  autoName: string;
  /** display name reflecting any user rename. */
  displayName: string;
  /** stable principal coordinate — recorded on the member row, it is the key for liveness/wake targeting. */
  principalId: string;
}

export interface ChannelMembersViewProps {
  members: ChannelMember[];
  /**
   * Channels v2 — highest message seq the renderer has loaded for this
   * channel. Drives the per-member "N behind" badge derived from the durable
   * read cursor (`member.lastReadSeq`): the roster shows how far each AGENT
   * member's consumption lags, from persisted fact rather than guesswork.
   * Omit (or 0) → no badges (e.g. roster opened before messages hydrate).
   */
  headSeq?: number;
  /** workspaceId → human-readable label (workspace name, falls back to id). */
  workspaceLabel: (workspaceId: string) => string;
  /** The human's own workspace (null when none resolvable). */
  selfWorkspaceId: string | null;
  selfMemberId: string;
  /** Workspaces the human can add (not already members). Only meaningful when
   *  `canJoin` is true. */
  joinableWorkspaces: JoinableWorkspace[];
  /** R2 — live agent panes that are not members yet (explicit join, §8.1 decision).
   *  Optional: defaults to an empty list (backward-compat for old callers/tests). */
  joinablePanes?: JoinablePane[];
  /** True for public, non-archived channels with a resolvable self workspace. */
  canJoin: boolean;
  onJoin: (workspaceId: string) => void;
  /** R2 — join one agent pane as a first-class member. */
  onJoinPane?: (pane: JoinablePane) => void;
  /** R2 — liveness of an agent row (live when the pane is alive and an agent is detected).
   *  Rows without a principalId (legacy/external MCP memberId) → undefined → no badge. */
  agentLiveness?: (m: ChannelMember) => 'live' | 'stale' | undefined;
  onLeave: (memberId: string, workspaceId: string) => void;
  /** Eject ANOTHER member (humans-only). Shown on NON-self rows only when
   *  provided (a resolvable human identity + non-archived channel). Absent →
   *  no kick affordance (e.g. no self workspace, or an archived channel). */
  onKick?: (memberId: string, workspaceId: string) => void;
  t?: (key: string) => string;
}

/** Header control: a member-count button that opens a roster popover with
 *  per-row self-leave, humans-only kick of other members, and a "+ member" picker. */
export function ChannelMembersView({
  members,
  headSeq,
  workspaceLabel,
  selfWorkspaceId,
  selfMemberId,
  joinableWorkspaces,
  joinablePanes = [],
  canJoin,
  onJoin,
  onJoinPane = () => {},
  agentLiveness,
  onLeave,
  onKick,
  t: tProp,
}: ChannelMembersViewProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const [open, setOpen] = useState(false);

  const isSelf = (m: ChannelMember): boolean =>
    m.workspaceId === selfWorkspaceId && m.memberId === selfMemberId;

  return (
    <div className="relative flex-shrink-0" data-channel-members>
      <button
        type="button"
        data-channel-members-button
        aria-expanded={open}
        aria-label={t('channels.members') || 'Members'}
        title={t('channels.members') || 'Members'}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 px-1.5 h-5 rounded text-[10px] font-mono text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
        {...tokenAttrs('textSub', 'text')}
      >
        <IconUsers size={11} />
        <span data-channel-members-count>{members.length}</span>
      </button>

      {open && (
        <div
          data-channel-members-popover
          className="absolute right-0 top-6 z-20 w-56 max-h-[60vh] overflow-y-auto rounded-md shadow-xl py-1 bg-[var(--bg-surface)]"
          style={{ border: '1px solid var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'bg')}
        >
          <div className="px-3 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
            {t('channels.members') || 'Members'} ({members.length})
          </div>

          {/* P2: clarify the membership model — it is per-workspace, not
                per-agent (the office-hours mental-model fix). Any agent in a
                member workspace can read + post; the roster lists agents only
                for attribution. */}
          <div
            className="px-3 pb-1 text-[9px] font-mono leading-snug text-[var(--text-muted)]"
            data-channel-members-note
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('channels.membershipNote') || 'Anyone in a member workspace can read and post.'}
          </div>

          {members.length === 0 ? (
            <div className="px-3 py-1.5 text-[10px] font-mono text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
              {t('channels.noMembers') || 'No members yet.'}
            </div>
          ) : (
            members.map((m) => {
              const self = isSelf(m);
              const isHuman = m.memberId === selfMemberId;
              // Channels v2 — consumption lag from the durable cursor. Only
              // meaningful for agent rows (humans advance the ws-wide cursor
              // just by reading the dock) and only when the head is known.
              // A pre-v2 row without lastReadSeq shows no badge (never a
              // fabricated number).
              const behind =
                !self && !isHuman && typeof headSeq === 'number' && headSeq > 0 && typeof m.lastReadSeq === 'number'
                  ? Math.max(0, headSeq - m.lastReadSeq)
                  : 0;
              // R2: agent row liveness — when stale, dim it + gray dot.
              const liveness = !isHuman ? agentLiveness?.(m) : undefined;
              // R2 (drop local-ui labeling) + identity audit C-A3: only the
              // viewer's OWN row reads "Me" — every workspace's GUI seat shares
              // the reserved member id, so keying on isHuman alone labeled ALL
              // of them "Me". Another workspace's human seat now reads as its
              // workspace name (rosterMemberLabel).
              const wsLabel = workspaceLabel(m.workspaceId);
              const label = rosterMemberLabel(m, selfWorkspaceId, selfMemberId, wsLabel);
              const primary = label.primary || (t('channels.me') || 'Me');
              return (
                <div
                  key={`${m.workspaceId}:${m.memberId}`}
                  data-channel-member-row
                  data-self={self ? 'true' : undefined}
                  data-liveness={liveness}
                  className={`group flex items-center gap-2 px-3 py-1 text-caption font-mono ${liveness === 'stale' ? 'opacity-60' : ''}`}
                >
                  {liveness && (
                    <span
                      data-channel-member-liveness
                      aria-hidden="true"
                      title={liveness === 'live' ? (t('channels.memberLiveTitle') || 'Agent pane is live') : (t('channels.memberStaleTitle') || 'Agent pane is gone or restarting')}
                      className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                      style={{ backgroundColor: liveness === 'live' ? 'var(--accent-green)' : 'var(--text-subtle)' }}
                    />
                  )}
                  <span className="truncate flex-1 min-w-0 text-[var(--text-sub)]" {...tokenAttrs('textSub', 'text')} title={label.showWorkspaceSuffix ? `${primary} · ${wsLabel}` : primary}>
                    {primary}
                    {label.showWorkspaceSuffix && (
                      <span className="text-[var(--text-muted)]"> · {wsLabel}</span>
                    )}
                  </span>
                  {behind > 0 && (
                    <span
                      data-channel-member-behind
                      className="flex-shrink-0 text-[9px] text-[var(--text-muted)]"
                      title={t('channels.memberBehindTitle') || 'Unread messages this member has not consumed (durable cursor)'}
                      {...tokenAttrs('textMuted', 'text')}
                    >
                      {behind} {t('channels.memberBehind') || 'behind'}
                    </span>
                  )}
                  {self ? (
                    <button
                      type="button"
                      data-channel-member-leave
                      aria-label={t('channels.leaveChannel') || 'Leave channel'}
                      title={t('channels.leaveChannel') || 'Leave channel'}
                      onClick={() => onLeave(m.memberId, m.workspaceId)}
                      className={`flex items-center justify-center w-4 h-4 rounded text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors ${FOCUS_RING}`}
                      {...tokenAttrs('textSub', 'text')}
                    >
                      <IconX size={10} />
                    </button>
                  ) : (
                    onKick && (
                      <button
                        type="button"
                        data-channel-member-kick
                        aria-label={t('channels.removeMember') || 'Remove from channel'}
                        title={t('channels.removeMember') || 'Remove from channel'}
                        onClick={() => onKick(m.memberId, m.workspaceId)}
                        className={`flex items-center justify-center w-4 h-4 rounded text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors ${FOCUS_RING}`}
                        {...tokenAttrs('textSub', 'text')}
                      >
                        <IconX size={10} />
                      </button>
                    )
                  )}
                </div>
              );
            })
          )}

          {canJoin && (
            <div className="mt-1 border-t border-[var(--border-soft)] pt-1" style={{ borderColor: 'var(--border-soft)' }}>
              {/* R2 explicit join (§8.1 decision: no automatic bulk join) — pick
                    live agent panes one at a time and add them as first-class
                    members. Adding a workspace (the human subscription row) stays
                    the existing section below. */}
              <div className="px-3 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                {t('channels.addAgentPane') || 'Add an agent pane'}
              </div>
              {joinablePanes.length === 0 ? (
                <div className="px-3 py-1.5 text-[10px] font-mono text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                  {t('channels.noAgentPanes') || 'No live agent panes to add.'}
                </div>
              ) : (
                joinablePanes.map((p) => (
                  <button
                    key={p.principalId}
                    type="button"
                    data-channel-pane-add
                    onClick={() => onJoinPane(p)}
                    className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-caption font-mono text-[var(--text-sub)] hover:bg-[var(--bg-overlay)] transition-colors ${FOCUS_RING}`}
                    {...tokenAttrs('textSub', 'text')}
                  >
                    <span className="text-[var(--accent-blue)]" aria-hidden="true">+</span>
                    <span className="truncate">{p.displayName}</span>
                    <span className="truncate text-[var(--text-muted)]">· {workspaceLabel(p.workspaceId)}</span>
                  </button>
                ))
              )}

              {/* P5: the "add a workspace" section only renders when a caller
                    still supplies candidates (legacy/tests) — the container now
                    passes [] because the human is one seat and agents join as
                    panes. Section removal proper rides the P6 roster rework. */}
              {joinableWorkspaces.length > 0 && (
                <div className="px-3 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                  {t('channels.addMember') || 'Add a workspace'}
                </div>
              )}
              {joinableWorkspaces.length > 0 && (
                joinableWorkspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    data-channel-member-add
                    onClick={() => onJoin(w.id)}
                    className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-caption font-mono text-[var(--text-sub)] hover:bg-[var(--bg-overlay)] transition-colors ${FOCUS_RING}`}
                    {...tokenAttrs('textSub', 'text')}
                  >
                    <span className="text-[var(--accent-blue)]" aria-hidden="true">+</span>
                    <span className="truncate">{w.name}</span>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Container ───────────────────────────────────────────────────────────────

/** Store-connected: resolves identity + joinable workspaces and wires
 *  join/leave (self-leave of the active channel clears the view). */
export function ChannelMembersControl({ channel }: { channel: Channel }): React.ReactElement {
  const t = useT();
  const members = useStore((s) => s.channelMembers[channel.id] ?? EMPTY_MEMBERS);
  // Channels v2 — head seq for the "N behind" cursor badges, derived from the
  // loaded message tail (the render cap keeps the array bounded; the LAST
  // element carries the highest seq the renderer knows).
  const headSeq = useStore((s) => {
    const msgs = s.channelMessages[channel.id];
    return msgs && msgs.length > 0 ? msgs[msgs.length - 1].seq : 0;
  });
  const workspaces = useStore((s) => s.workspaces);
  const company = useStore((s) => s.company);
  const pushToast = useStore((s) => s.pushToast);
  // R2: agent-detection mirror used to compute explicit-join candidates + liveness.
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const paneLabel = useStore((s) => s.paneLabel);

  // P5 (unified human identity): self is the reserved human workspace —
  // isSelf/leave/kick authz no longer depend on which workspace is active.
  const selfWorkspaceId: string | null = HUMAN_WORKSPACE_ID;
  const workspaceLabel = (workspaceId: string): string =>
    workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;

  const selfIsMember =
    !!selfWorkspaceId && members.some((m) => m.workspaceId === selfWorkspaceId);
  // Company CEO (only when Company mode is active) may moderate without being a
  // member — mirrors the daemon kick() CEO override (B5). In the default build
  // `company` is undefined, so this is always false and kick is membership-gated.
  const isCeo =
    !!company?.ceoWorkspaceId && company.ceoWorkspaceId === selfWorkspaceId;

  // Operator model: the roster shows ALL members, every workspace treated the
  // same — there is no privileged "owner" in the panel. Previously the creating
  // workspace's human placeholder was hidden, so a channel you own read as "0
  // members" (which a user reads as "wmux mis-recognized my workspace"). It is
  // now just another member row. Agents render as per-member rows for attribution.
  const rosterMembers = members;

  // P5: "add a WORKSPACE" is gone as a membership concept — the human is ONE
  // seat (ws-human) and agents join as panes. An empty list keeps the section
  // unrendered (the view gates on length) without churning the props contract;
  // full prop removal rides the P6 roster rework.
  const joinableWorkspaces: JoinableWorkspace[] = [];

  // R2 — explicit-join candidates: live agent panes across all workspaces that
  // are not yet members of this channel. The candidate predicate (live agent
  // pane) and the auto name reuse exactly the same logic as the mention picker
  // (buildMentionCandidates) — the roster and the @-candidates always sharing
  // the same naming scheme is P2's core invariant.
  const joinablePanes: JoinablePane[] = buildMentionCandidates({
    workspaces,
    surfaceAgent,
    paneLabel,
    memberWorkspaceIds: new Set(workspaces.map((w) => w.id)),
    selfWorkspaceId,
  })
    .map((c) => ({
      workspaceId: c.workspaceId,
      paneId: c.paneId,
      autoName: c.insertToken,
      displayName: c.displayName,
      principalId: panePrincipalId(c.workspaceId, c.paneId),
    }))
    .filter(
      (p) =>
        !members.some(
          (m) =>
            m.principalId === p.principalId ||
            (m.workspaceId === p.workspaceId && m.memberId === p.autoName),
        ),
    );

  // R2 — agent row liveness: live when the principal coordinate's pane still
  // exists and holds a live agent. If the coordinate is gone (right after a pane
  // close / workspace delete, before the catalog has synced) → stale. Rows with
  // no principalId (legacy/external MCP) can't be judged → no badge (we don't
  // fabricate facts we don't have).
  const agentLiveness = (m: ChannelMember): 'live' | 'stale' | undefined => {
    if (!m.principalId) return undefined;
    const w = workspaces.find((x) => x.id === m.workspaceId);
    if (!w) return 'stale';
    for (const leaf of findLeafPanes(w.rootPane)) {
      if (panePrincipalId(w.id, leaf.id) !== m.principalId) continue;
      const live = leaf.surfaces.some(
        (sf) => sf.surfaceType !== 'browser' && !!sf.ptyId && !!surfaceAgent[sf.ptyId]?.name,
      );
      return live ? 'live' : 'stale';
    }
    return 'stale';
  };

  // Show the picker only when the self ws can actually act on the channel: a
  // public channel anyone can self-join, but a private channel can only be
  // invited into by a current member (the daemon gates invite on the inviter
  // being a member). Without the membership clause, a private-channel preview
  // from a NON-member ws (the multi-workspace subscription path documented in
  // ChannelView) would show a dead picker that only toasts NOT_AUTHORIZED.
  const canJoin =
    channel.status !== 'archived' &&
    !!selfWorkspaceId &&
    (channel.visibility === 'public' || selfIsMember);

  const handleJoin = (workspaceId: string): void => {
    const label = workspaceLabel(workspaceId);
    // Route by the channel's visibility, not by whether the target is the active
    // workspace:
    //   - public: the target SELF-JOINS. joinChannelDaemon pins membership to the
    //     supplied workspaceId, and a public channel is joinable by any workspace,
    //     so the GUI can drop any local workspace in — even one that is not the
    //     active workspace and not yet a member.
    //   - private: the target is INVITED by the active workspace. A private
    //     channel is only visible to its members, so this popover being open
    //     proves the active (self) workspace is a member and may invite — the one
    //     path a non-member workspace gets into a private channel.
    const action =
      channel.visibility === 'public'
        ? useStore
            .getState()
            .joinChannelDaemon(channel.id, { workspaceId, memberId: HUMAN_MEMBER_ID, memberName: label }, workspaceId)
        : useStore
            .getState()
            .inviteChannelDaemon(channel.id, { workspaceId, memberId: HUMAN_MEMBER_ID, memberName: label }, selfWorkspaceId ?? workspaceId);
    void action.then((result) => {
      if (result.ok) {
        pushToast({ level: 'info', message: t('channels.joinedToast', { workspace: label, channel: channel.name }) });
      } else if (result.error.message.includes('DUPLICATE')) {
        pushToast({ level: 'info', message: t('channels.alreadyMemberToast', { workspace: label, channel: channel.name }) });
      } else {
        pushToast({ level: 'error', message: t('channels.joinFailedToast', { workspace: label }) });
      }
    });
  };

  // R2 — join one agent pane as a first-class member. memberId = auto name (same
  // as the mention token), principalId = stable coordinate. Public channels
  // self-join (pinned to the target ws); private ones are invited by the current
  // member self ws — the same routing rule as handleJoin.
  const handleJoinPane = (p: JoinablePane): void => {
    const member = {
      workspaceId: p.workspaceId,
      memberId: p.autoName,
      memberName: p.displayName,
      principalId: p.principalId,
    };
    const action =
      channel.visibility === 'public'
        ? useStore.getState().joinChannelDaemon(channel.id, member, p.workspaceId)
        : useStore.getState().inviteChannelDaemon(channel.id, member, selfWorkspaceId ?? p.workspaceId);
    void action.then((result) => {
      if (result.ok) {
        pushToast({ level: 'info', message: t('channels.joinedToast', { workspace: p.displayName, channel: channel.name }) });
      } else if (result.error.message.includes('DUPLICATE')) {
        pushToast({ level: 'info', message: t('channels.alreadyMemberToast', { workspace: p.displayName, channel: channel.name }) });
      } else {
        pushToast({ level: 'error', message: t('channels.joinFailedToast', { workspace: p.displayName }) });
      }
    });
  };

  const handleLeave = (memberId: string, workspaceId: string): void => {
    void useStore
      .getState()
      .leaveChannelDaemon(channel.id, memberId, workspaceId)
      .then((result) => {
        if (result.ok) {
          // Self-leave of the channel we're viewing → clear the view so the
          // dock doesn't show a dead/blank pane (a non-member can't read it).
          if (useStore.getState().activeChannelId === channel.id) {
            useStore.getState().setActiveChannel(null);
          }
          pushToast({ level: 'info', message: t('channels.leftToast', { channel: channel.name }) });
        } else {
          pushToast({ level: 'error', message: t('channels.leaveFailedToast') });
        }
      });
  };

  // Eject ANOTHER member (HUMANS-ONLY). selfWorkspaceId is the verified human
  // attribution; the daemon kick() rides the renderer-only path, so this is a
  // first-party-GUI action no agent can perform. Only show the affordance when
  // the actor can actually kick — the daemon gates kick() on the caller being a
  // member (or the company CEO), so a non-member would only get NOT_AUTHORIZED.
  // Now that the roster reveals every member (incl. other workspaces), gating on
  // membership keeps the popover from sprouting dead kick buttons.
  const canKick = (selfIsMember || isCeo) && channel.status !== 'archived';
  const handleKick = (memberId: string, workspaceId: string): void => {
    if (!selfWorkspaceId) return;
    const label = workspaceLabel(workspaceId);
    void useStore
      .getState()
      .kickChannelDaemon(channel.id, memberId, workspaceId, selfWorkspaceId)
      .then((result) => {
        if (result.ok) {
          pushToast({
            level: 'info',
            message: t('channels.removedToast', { workspace: label, channel: channel.name }),
          });
        } else {
          pushToast({ level: 'error', message: t('channels.removeFailedToast', { workspace: label }) });
        }
      });
  };

  return (
    <ChannelMembersView
      members={rosterMembers}
      headSeq={headSeq}
      workspaceLabel={workspaceLabel}
      selfWorkspaceId={selfWorkspaceId}
      selfMemberId={HUMAN_MEMBER_ID}
      joinableWorkspaces={joinableWorkspaces}
      joinablePanes={joinablePanes}
      canJoin={canJoin}
      onJoin={handleJoin}
      onJoinPane={handleJoinPane}
      agentLiveness={agentLiveness}
      onLeave={handleLeave}
      onKick={canKick ? handleKick : undefined}
      t={t}
    />
  );
}

const EMPTY_MEMBERS: ChannelMember[] = [];

export default ChannelMembersControl;
