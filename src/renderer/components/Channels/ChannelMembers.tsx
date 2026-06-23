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
// Scope (v1, locked by design + spec review):
//   - Remove (✕) is SELF-ONLY and shows on the exact (self ws, self memberId)
//     row — you can leave, not eject (matches daemon leave() capability).
//   - "+ member" appears only for PUBLIC, non-archived channels (private join is
//     an unresolved daemon-authz question — design Security note). The picker
//     adds one of the human's own workspaces.
//   - On a successful self-leave of the active channel, the container clears
//     activeChannelId so the dock doesn't show a dead/blank pane.
//
// No hex literals — theme tokens only. Agents keep per-agent membership via the
// MCP channel_post member_id; the UI identity is workspace-level (memberId
// 'local-ui'), which is correct (one human per workspace).

import { useState } from 'react';
import type { Channel, ChannelMember } from '../../../shared/channels';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { IconX } from '../icons';

/** Stable UI member id — the human/GUI participates as one member per
 *  workspace. Mirrors the value the composer + create path already send. */
const UI_MEMBER_ID = 'local-ui';

export interface JoinableWorkspace {
  id: string;
  name: string;
}

export interface ChannelMembersViewProps {
  members: ChannelMember[];
  /** workspaceId → human-readable label (workspace name, falls back to id). */
  workspaceLabel: (workspaceId: string) => string;
  /** The human's own workspace (null when none resolvable). */
  selfWorkspaceId: string | null;
  selfMemberId: string;
  /** Workspaces the human can add (not already members). Only meaningful when
   *  `canJoin` is true. */
  joinableWorkspaces: JoinableWorkspace[];
  /** True for public, non-archived channels with a resolvable self workspace. */
  canJoin: boolean;
  onJoin: (workspaceId: string) => void;
  onLeave: (memberId: string, workspaceId: string) => void;
  t?: (key: string) => string;
}

/** Header control: a member-count button that opens a roster popover with
 *  per-row self-leave and a public-channel "+ member" picker. */
export function ChannelMembersView({
  members,
  workspaceLabel,
  selfWorkspaceId,
  selfMemberId,
  joinableWorkspaces,
  canJoin,
  onJoin,
  onLeave,
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
        <span aria-hidden="true">👥</span>
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

          {members.length === 0 ? (
            <div className="px-3 py-1.5 text-[10px] font-mono text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
              {t('channels.noMembers') || 'No members yet.'}
            </div>
          ) : (
            members.map((m) => {
              const self = isSelf(m);
              return (
                <div
                  key={`${m.workspaceId}:${m.memberId}`}
                  data-channel-member-row
                  data-self={self ? 'true' : undefined}
                  className="group flex items-center gap-2 px-3 py-1 text-[11px] font-mono"
                >
                  <span className="truncate flex-1 min-w-0 text-[var(--text-sub)]" {...tokenAttrs('textSub', 'text')} title={`${workspaceLabel(m.workspaceId)} · ${m.memberId}`}>
                    {workspaceLabel(m.workspaceId)}
                    <span className="text-[var(--text-muted)]"> · {m.memberId}</span>
                    {self && <span className="text-[var(--accent-blue)]"> ({t('channels.you') || 'you'})</span>}
                  </span>
                  {self && (
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
                  )}
                </div>
              );
            })
          )}

          {canJoin && (
            <div className="mt-1 border-t border-[var(--border-soft)] pt-1" style={{ borderColor: 'var(--border-soft)' }}>
              <div className="px-3 py-1 text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                {t('channels.addMember') || 'Add a workspace'}
              </div>
              {joinableWorkspaces.length === 0 ? (
                <div className="px-3 py-1.5 text-[10px] font-mono text-[var(--text-muted)]" {...tokenAttrs('textMuted', 'text')}>
                  {t('channels.allWorkspacesMembers') || 'All workspaces are members.'}
                </div>
              ) : (
                joinableWorkspaces.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    data-channel-member-add
                    onClick={() => onJoin(w.id)}
                    className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11px] font-mono text-[var(--text-sub)] hover:bg-[var(--bg-overlay)] transition-colors ${FOCUS_RING}`}
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
  const workspaces = useStore((s) => s.workspaces);
  const company = useStore((s) => s.company);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const pushToast = useStore((s) => s.pushToast);

  const selfWorkspaceId = company?.ceoWorkspaceId ?? activeWorkspaceId ?? null;
  const workspaceLabel = (workspaceId: string): string =>
    workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;

  // The human adds one of their OWN workspaces (tabs) that isn't a member yet.
  const joinableWorkspaces: JoinableWorkspace[] = workspaces
    .filter((w) => !members.some((m) => m.workspaceId === w.id))
    .map((w) => ({ id: w.id, name: w.name }));

  // v1: join only public, non-archived channels (private join = unresolved
  // daemon-authz question, design Security note). Need a resolvable self ws.
  const canJoin =
    channel.visibility === 'public' && channel.status !== 'archived' && !!selfWorkspaceId;

  const handleJoin = (workspaceId: string): void => {
    const label = workspaceLabel(workspaceId);
    void useStore
      .getState()
      .joinChannelDaemon(channel.id, { workspaceId, memberId: UI_MEMBER_ID, memberName: label }, workspaceId)
      .then((result) => {
        if (result.ok) {
          pushToast({ level: 'info', message: t('channels.joinedToast', { workspace: label, channel: channel.name }) });
        } else if (result.error.message.includes('DUPLICATE')) {
          pushToast({ level: 'info', message: t('channels.alreadyMemberToast', { workspace: label, channel: channel.name }) });
        } else {
          pushToast({ level: 'error', message: t('channels.joinFailedToast', { workspace: label }) });
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

  return (
    <ChannelMembersView
      members={members}
      workspaceLabel={workspaceLabel}
      selfWorkspaceId={selfWorkspaceId}
      selfMemberId={UI_MEMBER_ID}
      joinableWorkspaces={joinableWorkspaces}
      canJoin={canJoin}
      onJoin={handleJoin}
      onLeave={handleLeave}
      t={t}
    />
  );
}

const EMPTY_MEMBERS: ChannelMember[] = [];

export default ChannelMembersControl;
