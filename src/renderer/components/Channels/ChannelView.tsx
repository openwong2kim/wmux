// ─── Active-channel message view (U8) ────────────────────────────────────
//
// Two-component file mirroring the `NotificationPanel` / `WorkspaceItem`
// view/container split so the renderToStaticMarkup tests can drive the
// pure view with controlled props.
//
// The view renders the active channel's metadata header, the ordered
// message list (filtered to the viewer's `historyFromSeq`), and a
// per-message footer that surfaces the per-recipient delivery status on
// the viewer's own posts. The container resolves activeChannelId,
// channel, messages, and viewer member id from the store and passes
// them in as props.
//
// Plan ref: U8, R21, R22.

import { useEffect, useMemo, useCallback, useState } from 'react';
import type {
  Channel,
  ChannelMessage,
  ChannelMember,
} from '../../../shared/channels';
import { useStore } from '../../stores';
import { loadChannelHistory } from '../../hooks/useChannelsHydration';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { IconX, IconArchive, IconCheck } from '../icons';
import { Composer } from './Composer';
import { ChannelMembersControl } from './ChannelMembers';

// Stable empty references for the store selectors below. A selector that
// returns `s.channelMessages[id] ?? []` would mint a FRESH `[]` on every
// render when the entry is undefined (active channel whose messages/members
// aren't hydrated yet); Zustand's Object.is equality then sees a new
// reference each render and re-renders forever → "Maximum update depth
// exceeded". Returning these module-level singletons keeps the reference
// stable so an unhydrated active channel renders an empty list instead of
// looping.
const EMPTY_MESSAGES: ChannelMessage[] = [];
const EMPTY_MEMBERS: ChannelMember[] = [];

// ─── Pure helpers (exported for tests) ───────────────────────────────────

/** A message is visible to a viewer iff its `seq` is at or above the
 *  viewer's `historyFromSeq`. The slice's `appendMessageFromEvent`
 *  already filters by recipient scope (workspaceId); the per-member
 *  `historyFromSeq` filter is the second of the two. */
export function isMessageVisibleToViewer(
  message: ChannelMessage,
  viewer: ChannelMember | null,
): boolean {
  if (!viewer) return false;
  return message.seq >= viewer.historyFromSeq;
}

/** Sort messages by `seq` ascending. The slice appends in seq order,
 *  but defensive sort protects against a future change (e.g. a
 *  re-hydration from a resync). Stable sort — two messages with the
 *  same seq keep their relative order. */
export function sortMessagesBySeq(
  messages: ChannelMessage[],
): ChannelMessage[] {
  return messages.slice().sort((a, b) => a.seq - b.seq);
}

/** Pick the viewer's own entry out of the per-recipient snapshot. The
 *  plan's R22 says the message row should show a per-recipient delivery
 *  status indicator "for the current viewer's entry". Returns
 *  `undefined` when the snapshot is missing (pre-U2 messages) or
 *  the viewer isn't in the snapshot (e.g. a member who was removed
 *  between post and view). */
export function viewerDeliveryStatus(
  message: ChannelMessage,
  viewerMemberId: string | null,
): ChannelMessage['deliveryStatus'] | undefined {
  if (!viewerMemberId) return undefined;
  if (message.memberId !== viewerMemberId) return undefined;
  const snap = message.recipientSnapshot;
  if (!snap) return message.deliveryStatus;
  const me = snap.find((s) => s.memberId === viewerMemberId);
  return me?.status;
}

// ─── Pure view ──────────────────────────────────────────────────────────

export interface ChannelViewContentProps {
  channel: Channel;
  messages: ChannelMessage[];
  viewer: ChannelMember | null;
  onClose: () => void;
  /** Archive the channel (one-way). Provided only when the viewer may archive
   *  it (the creator). Absent → no archive affordance is rendered. */
  onArchive?: () => void;
  /** Translator — defaults to identity. Tests pass a stub. */
  t?: (key: string) => string;
  /** Wrapper rendered after the message list; the composer lives here. */
  composerSlot: React.ReactNode;
  /** Header control for the members roster (count + join/leave popover).
   *  Slotted so the pure view stays store-free for the test harness. */
  membersSlot?: React.ReactNode;
}

/** The presentational surface — all data comes via props, no store reads. */
export function ChannelViewContent({
  channel,
  messages,
  viewer,
  onClose,
  onArchive,
  composerSlot,
  membersSlot,
  t: tProp,
}: ChannelViewContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  // Two-click confirm for the one-way archive: first click arms (button turns
  // red + shows a check), second commits; blur cancels.
  const [archiveArmed, setArchiveArmed] = useState(false);
  const visible = useMemo(
    () => sortMessagesBySeq(messages).filter((m) => isMessageVisibleToViewer(m, viewer)),
    [messages, viewer],
  );

  return (
    <div
      data-channel-view
      data-channel-id={channel.id}
      data-channel-status={channel.status}
      data-message-count={visible.length}
      className="flex flex-col h-full bg-[var(--bg-base)] border-l border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgBase', 'bg')}
      {...tokenAttrs('bgSurface', 'border')}
    >
      {/* Header — channel name + close affordance */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-[var(--bg-surface)] shrink-0"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[var(--text-muted)] font-mono text-[11px]" aria-hidden="true">#</span>
          <span className="text-[var(--text-main)] font-mono text-[12px] truncate" {...tokenAttrs('textMain', 'text')}>
            {channel.name}
          </span>
          {channel.status === 'archived' && (
            <span
              data-channel-archived-badge
              className="text-[9px] font-mono uppercase tracking-widest text-[var(--text-muted)]"
              {...tokenAttrs('textMuted', 'text')}
            >
              {t('channels.archived') || 'archived'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {membersSlot}
          {onArchive && channel.status !== 'archived' && (
            <button
              type="button"
              aria-label={archiveArmed ? (t('channels.archiveConfirm') || 'Confirm archive (read-only, one-way)') : (t('channels.archiveTooltip') || 'Archive channel')}
              title={archiveArmed ? (t('channels.archiveConfirm') || 'Confirm archive — read-only, one-way') : (t('channels.archiveTooltip') || 'Archive channel (read-only, one-way)')}
              onClick={() => {
                if (archiveArmed) { setArchiveArmed(false); onArchive(); }
                else { setArchiveArmed(true); }
              }}
              onBlur={() => setArchiveArmed(false)}
              className={`flex items-center justify-center w-5 h-5 rounded transition-colors duration-150 ${FOCUS_RING} ${
                archiveArmed
                  ? 'text-[var(--accent-red)] bg-[rgba(var(--bg-surface-rgb),0.6)]'
                  : 'text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)]'
              }`}
              data-channel-view-archive
              data-armed={archiveArmed ? 'true' : 'false'}
              {...tokenAttrs('textSub', 'text')}
            >
              {archiveArmed ? <IconCheck size={11} /> : <IconArchive size={11} />}
            </button>
          )}
          <button
            type="button"
            aria-label={t('channels.closeTooltip') || 'Close channel'}
            title={t('channels.closeTooltip') || 'Close channel'}
            onClick={onClose}
            className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-subtle)] hover:text-[var(--accent-red)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
            data-channel-view-close
            {...tokenAttrs('textSub', 'text')}
          >
            <IconX size={11} />
          </button>
        </div>
      </div>

      {/* Message list — scrollable. Empty-state copy when the channel
            has nothing visible to the viewer yet. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2"
        data-channel-view-messages
      >
        {visible.length === 0 ? (
          <div
            data-channel-view-empty
            className="text-[11px] font-mono text-[var(--text-muted)] text-center py-8"
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('channels.emptyMessages') || 'No messages yet — be the first to post.'}
          </div>
        ) : (
          visible.map((m) => {
            const myStatus = viewerDeliveryStatus(m, viewer?.memberId ?? null);
            return (
              <div
                key={`${channel.id}:${m.seq}`}
                data-channel-message
                data-seq={m.seq}
                data-member-id={m.memberId}
                data-delivery={myStatus ?? 'unknown'}
                className="flex flex-col gap-0.5"
              >
                <div className="flex items-baseline gap-2">
                  <span
                    className="text-[11px] font-mono font-bold text-[var(--text-main)]"
                    data-channel-message-author
                    {...tokenAttrs('textMain', 'text')}
                  >
                    {m.memberName}
                  </span>
                  <span
                    className="text-[9px] font-mono text-[var(--text-muted)]"
                    data-channel-message-time
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {new Date(m.postedAt).toISOString().slice(11, 19)}
                  </span>
                </div>
                <div
                  className="text-[12px] font-mono text-[var(--text-main)] whitespace-pre-wrap break-words"
                  data-channel-message-text
                  {...tokenAttrs('textMain', 'text')}
                >
                  {m.text}
                </div>
                {myStatus && (
                  <div
                    className="text-[9px] font-mono text-[var(--text-muted)] self-end"
                    data-channel-message-delivery
                    data-delivery-status={myStatus}
                    {...tokenAttrs('textMuted', 'text')}
                  >
                    {myStatus === 'delivered' ? '✓ delivered' : myStatus === 'pending' ? '… sending' : '✗ target gone'}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Composer — slotted by the container so the test surface can
            inject a fake composer without rendering the real one
            (which depends on store mutations and effects). */}
      <div
        className="border-t border-[var(--bg-surface)] shrink-0"
        style={{ borderColor: 'var(--border-soft)' }}
        {...tokenAttrs('bgSurface', 'border')}
      >
        {composerSlot}
      </div>
    </div>
  );
}

// ─── Container ─────────────────────────────────────────────────────────

/** Resolves the active channel + messages + viewer from the store and
 *  hands them to the pure view. Mounts the real Composer; closes by
 *  clearing `activeChannelId`. */
export function ChannelView(): React.ReactElement | null {
  const t = useT();
  const activeChannelId = useStore((s) => s.activeChannelId);
  const channel = useStore((s) => (activeChannelId ? s.channels[activeChannelId] : undefined));
  const messages = useStore((s) =>
    activeChannelId ? s.channelMessages[activeChannelId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES,
  );
  const members = useStore((s) =>
    activeChannelId ? s.channelMembers[activeChannelId] ?? EMPTY_MEMBERS : EMPTY_MEMBERS,
  );
  const company = useStore((s) => s.company);
  // Channels are decoupled from in-app Company mode: the active workspace is
  // the renderer's "self" identity when no company is set (mirrors
  // useChannelsHydration / ChannelsPanel).
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setActiveChannel = useStore((s) => s.setActiveChannel);
  const pushToast = useStore((s) => s.pushToast);
  const archiveChannelDaemon = useStore((s) => s.archiveChannelDaemon);

  const handleClose = useCallback(() => setActiveChannel(null), [setActiveChannel]);

  // The renderer's "self" workspace — same expression as `viewer` below (the
  // company CEO when set, else the active workspace).
  const selfWs = company?.ceoWorkspaceId ?? activeWorkspaceId ?? '';
  // Archive is creator-only (the daemon also enforces this). Offer the affordance
  // only when this workspace created the channel, so a non-creator never sees a
  // button that would just toast NOT_AUTHORIZED.
  const canArchive = !!selfWs && !!channel && channel.createdBy === selfWs;
  const handleArchive = useCallback(() => {
    if (!activeChannelId || !selfWs) return;
    void archiveChannelDaemon(activeChannelId, selfWs).then((res) => {
      if (!res.ok) pushToast({ message: res.error.message, level: 'error' });
    });
  }, [activeChannelId, selfWs, archiveChannelDaemon, pushToast]);

  // Pick a stable viewer — first member whose workspaceId matches the
  // current renderer's workspace (the company's `ceoWorkspaceId` is the
  // closest available stand-in for the renderer's own identity, since
  // the slice doesn't carry per-renderer identity yet), falling back
  // to the first member of the channel. The fallback matters when the
  // renderer's own workspace is not a member of the channel — e.g. a
  // private channel from another workspace that the renderer is
  // previewing. Multi-workspace subscription is a known gap (see
  // plan Open Questions `FIX-MULTI-WS`).
  //
  // Rules of hooks: the `useMemo` MUST run on every render, including
  // the early-return path below. Earlier versions had the `useMemo`
  // after the `if (!activeChannelId || !channel) return null;` early
  // return, which violates the rule (hook order depends on whether
  // `channel` is defined). Hoisting the `useMemo` above the early
  // return makes the hook order stable across renders.
  const viewer = useMemo<ChannelMember | null>(() => {
    if (members.length === 0) return null;
    const ownWorkspaceId = company?.ceoWorkspaceId ?? activeWorkspaceId;
    if (ownWorkspaceId) {
      const own = members.find((m) => m.workspaceId === ownWorkspaceId);
      if (own) return own;
    }
    return members[0] ?? null;
  }, [members, company?.ceoWorkspaceId, activeWorkspaceId]);

  // P0: load RECENT message history into the store when a channel is opened.
  // The view renders `store.channelMessages` only (it never calls getMessages
  // itself), so without this an opened channel shows the empty-state even when
  // it has history. `selfWs` MUST match the `viewer` workspace expression above
  // so the daemon's per-member historyFromSeq floor and the view's filter agree.
  // Hook order is stable — this runs on every render, before the early return.
  useEffect(() => {
    if (!activeChannelId) return;
    const bridge = useStore.getState().channelsRpc();
    if (!bridge) return;
    const selfWs = company?.ceoWorkspaceId ?? activeWorkspaceId ?? '';
    if (!selfWs) return;
    // Read nextSeq fresh — the `channel` prop may be a render behind a
    // just-arrived catalog refresh.
    const nextSeq = useStore.getState().channels[activeChannelId]?.nextSeq ?? 1;
    let disposed = false;
    void loadChannelHistory({
      rpc: bridge.rpc,
      channelId: activeChannelId,
      nextSeq,
      workspaceId: selfWs,
      apply: useStore.getState().hydrateChannelMessages,
      isCurrent: () => !disposed,
    });
    return () => {
      disposed = true;
    };
  }, [activeChannelId, company?.ceoWorkspaceId, activeWorkspaceId]);

  if (!activeChannelId || !channel) {
    // The activeChannelId-but-channel-undefined case can fire on a
    // catalog refresh that dropped the channel. Treat it as a
    // "no view" state — the slice will reconcile and the next
    // selection will mount a fresh view. The `useMemo` above ran
    // before this branch so the hook order is stable.
    return null;
  }

  // Dock content (not a fixed overlay anymore). The ChannelDock owns width +
  // positioning; ChannelView fills the dock's remaining height below the list.
  return (
    <div className="flex flex-col flex-1 min-h-0" data-channel-view-wrapper>
      <ChannelViewContent
        channel={channel}
        messages={messages}
        viewer={viewer}
        onClose={handleClose}
        onArchive={canArchive ? handleArchive : undefined}
        t={t}
        membersSlot={<ChannelMembersControl channel={channel} />}
        composerSlot={
          channel.status === 'archived' ? (
            <div
              data-channel-archived-composer
              className="px-4 py-2 text-[10px] font-mono text-[var(--text-muted)]"
            >
              {t('channels.archivedReadOnly') || 'Archived channels are read-only.'}
            </div>
          ) : (
            <Composer channelId={channel.id} onError={pushToast} />
          )
        }
      />
    </div>
  );
}

export default ChannelView;
