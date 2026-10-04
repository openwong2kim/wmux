// One channel message as a transcript row. Shared by the channel view and by
// Fleet's task conversation, so a mission report reads the same wherever it
// is shown: the operator-join marker, the author with its workspace badge and
// pane chip, the time, the body (safe markdown subset, long reports folded)
// and, on the viewer's own posts, the delivery outcome.

import type { ChannelMember, ChannelMessage } from '../../../shared/channels';
import { tokenAttrs } from '../../themes';
import { formatChannelAuthor } from '../../channels/authorDisplay';
import { ownMessageDeliveryState, DELIVERY_LABEL_KEY, DELIVERY_LABEL_FALLBACK } from './deliveryStatus';
import { renderMessageBody } from './ChannelView';

export interface ChannelMessageRowProps {
  message: ChannelMessage;
  viewer: ChannelMember | null;
  now: number;
  t: (key: string) => string;
  workspaceName: (workspaceId: string) => string | undefined;
  nudgeExhaustedAtByMember?: Readonly<Record<string, number>>;
  paneNameFor?: (workspaceId: string, memberId: string) => string | undefined;
}

export function ChannelMessageRow({
  message: m,
  viewer,
  now,
  t,
  workspaceName,
  nudgeExhaustedAtByMember,
  paneNameFor,
}: ChannelMessageRowProps): React.ReactElement {
  // operator-join (§2.1.1/§3): a server-published system marker renders as
  // a centered muted line, not an attributed chat message. The durable
  // append is the audit trail; the copy is viewpoint-neutral because
  // every member's view renders this same marker.
  if (m.systemKind === 'operator-join') {
    return (
      <div
        data-channel-message
        data-channel-system-message="operator-join"
        data-seq={m.seq}
        className="flex items-center justify-center py-0.5 text-[10px] font-mono italic text-[var(--text-muted)]"
        {...tokenAttrs('textMuted', 'text')}
      >
        {t('channels.systemOperatorJoin') || 'Operator joined this channel'}
      </div>
    );
  }
  const myStatus = ownMessageDeliveryState({
    message: m,
    viewerMemberId: viewer?.memberId ?? null,
    now,
    ...(nudgeExhaustedAtByMember
      ? { exhaustedAtByMember: nudgeExhaustedAtByMember }
      : {}),
  });
  const mentionsMe =
    !!viewer && !!m.mentions?.some((mn) => mn.workspaceId === viewer.workspaceId);
  const author = formatChannelAuthor(m, workspaceName);
  // C-5: an agent's identity chip names its PANE the way the rest of
  // the app names it. A pane that joined over MCP/CLI carries an
  // opaque spawn-stamped memberId, which the chip used to print raw;
  // the roster's principal resolves it back to "w26-1(claude)". The
  // chip is dropped when the primary label already says it.
  const paneName =
    author.kind === 'agent' ? paneNameFor?.(m.workspaceId, m.memberId) : undefined;
  const identityChip =
    paneName && !author.primary.includes(paneName) ? paneName : author.chip;
  return (
    <div
      data-channel-message
      data-seq={m.seq}
      data-member-id={m.memberId}
      data-author-kind={author.kind}
      data-delivery={myStatus ?? 'unknown'}
      data-mentions-me={mentionsMe ? 'true' : undefined}
      className={`flex flex-col gap-0.5 ${
        mentionsMe ? 'border-l-2 border-[var(--accent-blue)] pl-1.5' : ''
      }`}
    >
      <div className="flex items-baseline gap-2">
        {/* Identity audit 1a: per-workspace color badge — round for a
              human seat, square for an agent pane — so same-named
              senders from different workspaces stay tellable. */}
        <span
          aria-hidden="true"
          data-channel-author-badge={author.kind}
          className={`self-center inline-block w-2 h-2 shrink-0 ${
            author.kind === 'human' ? 'rounded-full' : 'rounded-[1px]'
          }`}
          style={{
            backgroundColor: `hsl(${author.hue} 55% 62%)`,
            // The hue is dynamic so it can't be a theme token; the
            // border keeps the badge visible on light themes where
            // L=62% alone would wash out (ship design review).
            border: '1px solid var(--border-soft)',
          }}
        />
        <span
          className="text-caption font-mono font-bold text-[var(--text-main)]"
          data-channel-message-author
          {...tokenAttrs('textMain', 'text')}
        >
          {/* Human/GUI senders read as "Me" (never the internal
                local-ui token); agent senders read as their display
                name with the pane memberId chip alongside — the fix
                for every agent collapsing into "Claude Code". */}
          {author.kind === 'human' ? (t('channels.me') || 'Me') : author.primary}
        </span>
        {identityChip && (
          <span
            data-channel-author-chip
            className="text-[10px] font-mono text-[var(--text-sub)]"
            title={author.kind === 'human' ? m.workspaceId : m.memberId}
            {...tokenAttrs('textSub', 'text')}
          >
            {identityChip}
          </span>
        )}
        <span
          className="text-[10px] font-mono text-[var(--text-muted)]"
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
        {m.text.length > 600 ? (
          <details className="wmux-record-long-message">
            <summary><span>{m.text.slice(0, 160)}…</span><span className="wmux-record-expand-label">{t('channels.readFullUpdate')}</span></summary>
            {renderMessageBody(m.text, m.mentions)}
          </details>
        ) : renderMessageBody(m.text, m.mentions)}
      </div>
      {myStatus && (
        <div
          className={`text-[10px] font-mono self-end ${
            myStatus === 'nudge_exhausted'
              ? 'text-[var(--accent-yellow)]'
              : 'text-[var(--text-muted)]'
          }`}
          data-channel-message-delivery
          data-delivery-status={myStatus}
          {...tokenAttrs(myStatus === 'nudge_exhausted' ? 'warning' : 'textMuted', 'text')}
        >
          {t(DELIVERY_LABEL_KEY[myStatus]) || DELIVERY_LABEL_FALLBACK[myStatus]}
        </div>
      )}
    </div>
  );
}
