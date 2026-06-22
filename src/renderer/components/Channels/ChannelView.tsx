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

import { useMemo, useCallback } from 'react';
import type {
  Channel,
  ChannelMessage,
  ChannelMember,
} from '../../../shared/channels';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { IconX } from '../icons';
import { Composer } from './Composer';

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
  /** Translator — defaults to identity. Tests pass a stub. */
  t?: (key: string) => string;
  /** Wrapper rendered after the message list; the composer lives here. */
  composerSlot: React.ReactNode;
}

/** The presentational surface — all data comes via props, no store reads. */
export function ChannelViewContent({
  channel,
  messages,
  viewer,
  onClose,
  composerSlot,
  t: tProp,
}: ChannelViewContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
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
  const setActiveChannel = useStore((s) => s.setActiveChannel);
  const pushToast = useStore((s) => s.pushToast);

  const handleClose = useCallback(() => setActiveChannel(null), [setActiveChannel]);

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
    const ownWorkspaceId = company?.ceoWorkspaceId;
    if (ownWorkspaceId !== undefined) {
      const own = members.find((m) => m.workspaceId === ownWorkspaceId);
      if (own) return own;
    }
    return members[0] ?? null;
  }, [members, company?.ceoWorkspaceId]);

  if (!activeChannelId || !channel) {
    // The activeChannelId-but-channel-undefined case can fire on a
    // catalog refresh that dropped the channel. Treat it as a
    // "no view" state — the slice will reconcile and the next
    // selection will mount a fresh view. The `useMemo` above ran
    // before this branch so the hook order is stable.
    return null;
  }

  return (
    <div
      className="fixed top-0 right-0 h-screen pointer-events-none"
      style={{ width: 360, zIndex: 40 }}
      data-channel-view-wrapper
    >
      <div className="h-full pointer-events-auto">
        <ChannelViewContent
          channel={channel}
          messages={messages}
          viewer={viewer}
          onClose={handleClose}
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
    </div>
  );
}

export default ChannelView;
