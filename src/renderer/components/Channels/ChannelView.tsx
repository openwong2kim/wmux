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

import { useEffect, useMemo, useCallback, useState, Fragment } from 'react';
import type {
  Channel,
  ChannelMessage,
  ChannelMember,
  ChannelMention,
} from '../../../shared/channels';
import { useStore } from '../../stores';
import { loadChannelHistory } from '../../hooks/useChannelsHydration';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { IconX, IconArchive, IconCheck, IconChevron } from '../icons';
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

// P3b — scrollback window. Render only the most recent N messages so a long
// channel doesn't mount thousands of rows; a "load earlier" affordance grows
// the window by another page. N is generous (most channels never hit it) so the
// common case renders the whole history exactly as before.
export const SCROLLBACK_PAGE = 200;

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

/** Render message text with its @mention tokens highlighted. Splits on the
 *  validated `mentions[].name` snapshots and wraps each `@name` occurrence in
 *  an accent span; longest names first so "@John Doe" wins over "@John".
 *  Returns the plain string when there are no mentions (the common case). */
export function renderMessageText(
  text: string,
  mentions?: ChannelMention[],
): React.ReactNode {
  if (!mentions || mentions.length === 0) return text;
  const names = Array.from(new Set(mentions.map((m) => m.name)))
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    if (text[i] === '@') {
      const matched = names.find((n) => text.startsWith(n, i + 1));
      if (matched) {
        parts.push(
          <span
            key={key++}
            data-channel-mention-token
            className="font-bold text-[var(--accent-blue)]"
            {...tokenAttrs('accent', 'text')}
          >
            @{matched}
          </span>,
        );
        i += 1 + matched.length;
        continue;
      }
    }
    // Accumulate plain text up to the next '@' (or end of string).
    let j = i + 1;
    while (j < text.length && text[j] !== '@') j++;
    parts.push(text.slice(i, j));
    i = j;
  }
  return parts;
}

// ─── Lightweight markdown (P3a) ──────────────────────────────────────────
//
// Agents emit markdown + code, so a plain-text view reads poorly. We render a
// safe SUBSET as real React nodes — never an HTML sink (no
// dangerouslySetInnerHTML): fenced ``` code blocks, inline `code`, and **bold**.
// Plain runs still flow through renderMessageText so @mentions keep highlighting;
// code spans/blocks are literal (mentions inside code are NOT highlighted, which
// is correct). Anything we don't recognise renders as plain text verbatim.

/** Split text into fenced ``` code blocks and the surrounding text segments. */
function splitFencedCode(text: string): { type: 'code' | 'text'; content: string }[] {
  const FENCE_RE = /```[^\n]*\n?([\s\S]*?)```/g;
  const segs: { type: 'code' | 'text'; content: string }[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', content: text.slice(last, m.index) });
    segs.push({ type: 'code', content: m[1].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', content: text.slice(last) });
  return segs;
}

/** Inline markdown within a non-code segment: `code` and **bold**, with the
 *  remaining plain runs passed to renderMessageText (so @mentions still
 *  highlight). Returns keyed nodes. */
function renderInline(
  text: string,
  mentions: ChannelMention[] | undefined,
  keyBase: string,
): React.ReactNode[] {
  const INLINE_RE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) {
      out.push(
        <Fragment key={`${keyBase}-t${k++}`}>
          {renderMessageText(text.slice(last, m.index), mentions)}
        </Fragment>,
      );
    }
    if (m[1]) {
      out.push(
        <code
          key={`${keyBase}-c${k++}`}
          data-md-code
          className="px-1 rounded bg-[var(--bg-surface)] text-[var(--text-main)]"
          {...tokenAttrs('bgSurface', 'bg')}
        >
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <strong key={`${keyBase}-b${k++}`} data-md-bold className="font-bold text-[var(--text-main)]">
          {m[2].slice(2, -2)}
        </strong>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    out.push(
      <Fragment key={`${keyBase}-t${k++}`}>
        {renderMessageText(text.slice(last), mentions)}
      </Fragment>,
    );
  }
  return out;
}

/** Render a message body with the safe markdown subset + @mention highlighting.
 *  Fast-paths to plain text when there is nothing to format. */
export function renderMessageBody(
  text: string,
  mentions?: ChannelMention[],
): React.ReactNode {
  const segs = splitFencedCode(text);
  if (segs.length === 0) return text;
  // No code fences → if there's also no inline markdown, defer entirely to the
  // mention renderer (preserves the plain-string fast path). Otherwise render
  // the inline subset.
  if (segs.length === 1 && segs[0].type === 'text') {
    const seg = segs[0].content;
    if (!/(`[^`\n]+`)|(\*\*[^*\n]+\*\*)/.test(seg)) {
      return renderMessageText(seg, mentions);
    }
    return renderInline(seg, mentions, 'b0');
  }
  return segs.map((s, idx) =>
    s.type === 'code' ? (
      <pre
        key={`blk${idx}`}
        data-channel-code-block
        className="my-1 px-2 py-1 rounded bg-[var(--bg-surface)] overflow-x-auto text-[11px] whitespace-pre"
        {...tokenAttrs('bgSurface', 'bg')}
      >
        <code>{s.content}</code>
      </pre>
    ) : (
      <Fragment key={`blk${idx}`}>{renderInline(s.content, mentions, `b${idx}`)}</Fragment>
    ),
  );
}

// ─── Pure view ──────────────────────────────────────────────────────────

export interface ChannelViewContentProps {
  channel: Channel;
  messages: ChannelMessage[];
  viewer: ChannelMember | null;
  /** Close the conversation VIEW only — deselect the active channel. The channel
   *  stays in the dock and you remain a member. */
  onClose: () => void;
  /** Leave the channel (X button) — removes your membership, then closes the
   *  view. Absent → no leave affordance (e.g. archived channels). */
  onLeave?: () => void;
  /** Archive the channel (one-way). Provided only when the viewer may archive
   *  it (the creator). Absent → no archive affordance is rendered. */
  onArchive?: () => void;
  /** Page older persisted messages in from the daemon. Called with the earliest
   *  currently-loaded seq; resolves to the number of messages fetched (0 ⇒ the
   *  persisted floor is reached). Absent → local-window paging only (tests). */
  onLoadEarlier?: (beforeSeq: number) => Promise<number>;
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
  onLeave,
  onArchive,
  onLoadEarlier,
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
  // P3b: render only the most recent `shownCount`; "load earlier" grows it.
  const [shownCount, setShownCount] = useState(SCROLLBACK_PAGE);
  // Daemon-paging floor: set once onLoadEarlier returns nothing new, so the
  // "load earlier" affordance stops offering a fetch that can't progress.
  const [reachedHistoryStart, setReachedHistoryStart] = useState(false);
  const windowed = useMemo(
    () => (visible.length > shownCount ? visible.slice(visible.length - shownCount) : visible),
    [visible, shownCount],
  );
  const hiddenEarlier = visible.length - windowed.length;
  // "Load earlier": grow the local window, and when it reaches the start of the
  // hydrated set, page the previous window in from the daemon (Codex review). seq
  // starts at 1, so the persisted floor is max(viewer.historyFromSeq, 1).
  const earliestSeq = visible.length > 0 ? visible[0].seq : 0;
  const floorSeq = Math.max(viewer?.historyFromSeq ?? 0, 1);
  const moreOnDaemon = !!onLoadEarlier && !reachedHistoryStart && earliestSeq > floorSeq;
  const canLoadEarlier = hiddenEarlier > 0 || moreOnDaemon;
  const handleLoadEarlier = useCallback(() => {
    setShownCount((c) => c + SCROLLBACK_PAGE);
    if (!onLoadEarlier || reachedHistoryStart) return;
    const earliest = visible.length > 0 ? visible[0].seq : 0;
    const floor = Math.max(viewer?.historyFromSeq ?? 0, 1);
    if (earliest <= floor) return; // already at the persisted floor
    void onLoadEarlier(earliest).then((loaded) => {
      if (loaded === 0) setReachedHistoryStart(true);
    });
  }, [visible, viewer, onLoadEarlier, reachedHistoryStart]);
  // P3c: in-channel message search. Searches ALL viewer-visible messages (not
  // just the scrollback window) so old context is findable; an active query
  // bypasses the window and shows every match.
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Reset channel-local view state on channel switch — ChannelViewContent is
  // reused across switches, so without this the scrollback window, the search
  // query/visibility, and the archive-arm/daemon-paging flags would leak into
  // the next channel (CodeRabbit review).
  useEffect(() => {
    setShownCount(SCROLLBACK_PAGE);
    setSearchOpen(false);
    setQuery('');
    setArchiveArmed(false);
    setReachedHistoryStart(false);
  }, [channel.id]);
  const trimmedQuery = query.trim().toLowerCase();
  const matched = useMemo(
    () => (trimmedQuery ? visible.filter((m) => m.text.toLowerCase().includes(trimmedQuery)) : null),
    [visible, trimmedQuery],
  );
  const rendered = matched ?? windowed;

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
          <button
            type="button"
            aria-label={t('channels.searchTooltip') || 'Search messages'}
            title={t('channels.searchTooltip') || 'Search messages'}
            aria-expanded={searchOpen}
            onClick={() => {
              const next = !searchOpen;
              setSearchOpen(next);
              if (!next) setQuery('');
            }}
            className={`flex items-center justify-center w-5 h-5 rounded transition-colors duration-150 ${FOCUS_RING} ${
              searchOpen
                ? 'text-[var(--accent-blue)] bg-[rgba(var(--bg-surface-rgb),0.6)]'
                : 'text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)]'
            }`}
            data-channel-search-toggle
            {...tokenAttrs('textSub', 'text')}
          >
            <span aria-hidden="true" className="text-[11px]">🔍</span>
          </button>
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
          {/* Close the conversation VIEW only — the channel stays in the dock and
                you remain a member. Distinct from the X (leave) below. */}
          <button
            type="button"
            aria-label={t('channels.closeViewTooltip') || 'Close conversation (channel stays)'}
            title={t('channels.closeViewTooltip') || 'Close conversation (channel stays)'}
            onClick={onClose}
            className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
            data-channel-view-close
            {...tokenAttrs('textSub', 'text')}
          >
            <span className="rotate-90" aria-hidden="true">
              <IconChevron size={11} />
            </span>
          </button>
          {/* X = LEAVE the channel (removes your membership, then closes the
                view). Destructive but recoverable for public channels (rejoin
                from Discover). */}
          {onLeave && (
            <button
              type="button"
              aria-label={t('channels.leaveChannel') || 'Leave channel'}
              title={t('channels.leaveChannel') || 'Leave channel'}
              onClick={onLeave}
              className={`flex items-center justify-center w-5 h-5 rounded text-[var(--text-subtle)] hover:text-[var(--accent-red)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors duration-150 ${FOCUS_RING}`}
              data-channel-view-leave
              {...tokenAttrs('textSub', 'text')}
            >
              <IconX size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Search bar (P3c) — revealed by the header search toggle. Filters the
            whole visible history, not just the scrollback window. */}
      {searchOpen && (
        <div
          className="px-4 py-1 border-b border-[var(--bg-surface)] shrink-0"
          style={{ borderColor: 'var(--border-soft)' }}
          {...tokenAttrs('bgSurface', 'border')}
        >
          <input
            type="text"
            autoFocus
            data-channel-search
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('channels.searchPlaceholder') || 'Search messages…'}
            aria-label={t('channels.searchPlaceholder') || 'Search messages'}
            className={`w-full bg-[var(--bg-base)] text-[var(--text-main)] text-[11px] font-mono px-2 py-1 rounded border border-[var(--bg-surface)] outline-none ${FOCUS_RING}`}
            {...tokenAttrs('bgBase', 'bg')}
          />
        </div>
      )}

      {/* Message list — scrollable. Empty-state copy when the channel
            has nothing visible to the viewer yet. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-2"
        data-channel-view-messages
      >
        {rendered.length === 0 ? (
          matched !== null ? (
            <div
              data-channel-search-empty
              className="text-[11px] font-mono text-[var(--text-muted)] text-center py-8"
              {...tokenAttrs('textMuted', 'text')}
            >
              {t('channels.searchEmpty') || 'No messages match your search.'}
            </div>
          ) : (
            <div
              data-channel-view-empty
              className="text-[11px] font-mono text-[var(--text-muted)] text-center py-8"
              {...tokenAttrs('textMuted', 'text')}
            >
              {t('channels.emptyMessages') || 'No messages yet — be the first to post.'}
            </div>
          )
        ) : (
          <>
            {matched === null && canLoadEarlier && (
              <button
                type="button"
                data-channels-load-earlier
                onClick={handleLoadEarlier}
                className={`w-full py-1 text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--text-sub)] transition-colors ${FOCUS_RING}`}
                {...tokenAttrs('textMuted', 'text')}
              >
                {t('channels.loadEarlier') || 'Load earlier'}
                {hiddenEarlier > 0 ? ` (${hiddenEarlier})` : ''}
              </button>
            )}
            {rendered.map((m) => {
            const myStatus = viewerDeliveryStatus(m, viewer?.memberId ?? null);
            const mentionsMe =
              !!viewer && !!m.mentions?.some((mn) => mn.workspaceId === viewer.workspaceId);
            return (
              <div
                key={`${channel.id}:${m.seq}`}
                data-channel-message
                data-seq={m.seq}
                data-member-id={m.memberId}
                data-delivery={myStatus ?? 'unknown'}
                data-mentions-me={mentionsMe ? 'true' : undefined}
                className={`flex flex-col gap-0.5 ${
                  mentionsMe ? 'border-l-2 border-[var(--accent-blue)] pl-1.5' : ''
                }`}
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
                  {renderMessageBody(m.text, m.mentions)}
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
            })}
          </>
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
  const leaveChannelDaemon = useStore((s) => s.leaveChannelDaemon);

  // Close the conversation view only (deselect) — the channel stays + you stay a member.
  const handleClose = useCallback(() => setActiveChannel(null), [setActiveChannel]);

  // The renderer's "self" workspace — same expression as `viewer` below (the
  // company CEO when set, else the active workspace).
  const selfWs = company?.ceoWorkspaceId ?? activeWorkspaceId ?? '';
  // The X = LEAVE the channel (removes this workspace's UI membership), then
  // close the view. Gate on the ACTUAL (selfWs, 'local-ui') GUI member row, not
  // just any member of this workspace: handleLeave always removes memberId
  // 'local-ui', so a workspace present only via an agent member (e.g. 'lead')
  // would show the X and then always fail with NOT_A_MEMBER (Codex review).
  // Agent-only membership — and a public channel you're only previewing — show
  // no leave affordance.
  const selfIsMember =
    !!selfWs && members.some((m) => m.workspaceId === selfWs && m.memberId === 'local-ui');
  const handleLeave = useCallback(() => {
    if (!activeChannelId || !selfWs) return;
    // memberId 'local-ui' is the human/GUI member id (one per workspace).
    void leaveChannelDaemon(activeChannelId, 'local-ui', selfWs).then((res) => {
      if (res.ok) {
        setActiveChannel(null);
        pushToast({
          level: 'info',
          message: t('channels.leftToast', { channel: channel?.name ?? activeChannelId }),
        });
      } else {
        pushToast({ level: 'error', message: t('channels.leaveFailedToast') || res.error.message });
      }
    });
  }, [activeChannelId, selfWs, leaveChannelDaemon, setActiveChannel, pushToast, t, channel?.name]);
  // Archive is a member action (the daemon gates on membership, mirroring kick —
  // there is no privileged "creator"). Offer the affordance only when this
  // workspace is a member, so a non-member preview never shows a button that would
  // just toast NOT_AUTHORIZED.
  const canArchive = !!channel && selfIsMember;
  const handleArchive = useCallback(() => {
    if (!activeChannelId || !selfWs) return;
    void archiveChannelDaemon(activeChannelId, selfWs).then((res) => {
      if (!res.ok) pushToast({ message: res.error.message, level: 'error' });
    });
  }, [activeChannelId, selfWs, archiveChannelDaemon, pushToast]);
  // P3b+: page OLDER persisted history in from the daemon. Channel-open hydration
  // only fetches the most recent SCROLLBACK_PAGE messages, so a channel with more
  // than that could never reach its older messages via the local window alone
  // (Codex review). Called with the earliest currently-loaded seq; the helper
  // fetches the SCROLLBACK_PAGE window just before it and merges by seq (dedup).
  // Resolves to the number fetched (0 ⇒ persisted floor reached → stop offering).
  const handleLoadEarlier = useCallback(
    (beforeSeq: number): Promise<number> => {
      const bridge = useStore.getState().channelsRpc();
      if (!bridge || !selfWs || !activeChannelId) return Promise.resolve(0);
      return loadChannelHistory({
        rpc: bridge.rpc,
        channelId: activeChannelId,
        nextSeq: beforeSeq, // helper computes sinceSeq = beforeSeq - limit
        workspaceId: selfWs,
        apply: useStore.getState().hydrateChannelMessages,
        limit: SCROLLBACK_PAGE,
      });
    },
    [selfWs, activeChannelId],
  );

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
    }).then((loaded) => {
      // A1: opening the channel = receiving its messages. Ack up to the latest
      // seq so the SENDER's deliveryStatus flips 'pending' → 'delivered'. Routed
      // through the renderer-trusted local path (pinned, pipe-unreachable) — a
      // no-PTY renderer can't pass the pipe's senderPtyId pin. Best-effort: a
      // failed ack must not affect the view; the next open re-acks (no-op repeat).
      // Skip when nothing actually loaded (review A1 P3) so a blank/failed fetch
      // doesn't mark messages received. NOTE: the flip is persisted on the daemon
      // and visible to the sender's NEXT poll/reopen (agents poll getMessages, so
      // they see it); live push to an already-open sender view is a follow-up.
      if (disposed || !loaded) return;
      // Compute uptoSeq from the messages ACTUALLY in the store, not the catalog
      // row's nextSeq: appendMessageFromEvent/hydrateChannelMessages never advance
      // channels[].nextSeq, so a catalog hydrated before later messages arrived
      // leaves it stale (== 1). The old `nextSeq - 1` guard then skipped the ack
      // for live messages, stranding the sender's deliveryStatus at 'pending' (Codex).
      const stored = useStore.getState().channelMessages[activeChannelId] ?? [];
      let uptoSeq = 0;
      for (const m of stored) if (m.seq > uptoSeq) uptoSeq = m.seq;
      if (uptoSeq < 1) return;
      void bridge
        .mutateLocal('a2a.channel.ack', {
          channelId: activeChannelId,
          workspaceId: selfWs,
          verifiedWorkspaceId: selfWs,
          uptoSeq,
        })
        .catch(() => undefined);
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
        onLeave={selfIsMember ? handleLeave : undefined}
        onArchive={canArchive ? handleArchive : undefined}
        onLoadEarlier={handleLoadEarlier}
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
