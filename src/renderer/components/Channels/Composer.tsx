// ─── Channel post composer (U8) ─────────────────────────────────────────
//
// Post input that ships a typed message into the channels slice and (on
// success) clears itself. The composer is a thin shell over the slice's
// `postMessageDaemon` thunk (U4, R4 + R11), which round-trips to the
// daemon via the `a2a.channel.post` RPC and applies the authoritative
// row through `postMessageOptimistic` on success. The synthesized
// `ChannelMessage` we construct here is the input shape — it is
// overwritten by the daemon's authoritative row in the slice.
//
// Failure surfacing: PERSIST_FAILED → push toast + show inline error.
// The slice never throws on failure; we branch on the structured
// `result.error.code` per R7 / the U2 maintainer directive.
//
// Plan ref: U4 (wire-path entry), U8 (UI surface), R7, R22, R26.

import { useState, useRef, useCallback, type FormEvent, type KeyboardEvent } from 'react';
import { useStore } from '../../stores';
import { generateId } from '../../../shared/types';
import type { ChannelMessage } from '../../../shared/channels';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';

// ─── Synthesized message row for the optimistic local insert ───────────

/** Synthesize a `ChannelMessage` for the optimistic local insert. The
 *  daemon will overwrite this with the authoritative row (authoritative
 *  `seq`, `recipientSnapshot`, etc.) once the `channel.message` event
 *  fans in. The synthesis exists so the UI shows the user's post
 *  immediately on click, without waiting for the round-trip. */
export function synthesizeChannelMessage(params: {
  channelId: string;
  seq: number;
  text: string;
  senderWorkspaceId: string;
  senderMemberId: string;
  senderMemberName: string;
  clientMsgId?: string;
}): ChannelMessage {
  return {
    channelId: params.channelId,
    seq: params.seq,
    workspaceId: params.senderWorkspaceId,
    memberId: params.senderMemberId,
    memberName: params.senderMemberName,
    text: params.text,
    postedAt: Date.now(),
    deliveryStatus: 'pending',
    clientMsgId: params.clientMsgId,
  };
}

// ─── Pure view (props-driven) ───────────────────────────────────────────

export interface ComposerContentProps {
  channelId: string;
  onSubmit: (text: string) => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>;
  /** Translator — defaults to identity. Tests pass a stub. */
  t?: (key: string) => string;
  /** Override the placeholder when running in a test. */
  placeholder?: string;
  /** Disable the input + send button. */
  disabled?: boolean;
}

/** Side-effect-free presentational surface. The test can call
 *  `onSubmit` directly to drive the success/failure paths without
 *  mounting the real `useStore` round-trip. The `t` prop is the
 *  translator — defaults to identity so tests can omit it; the
 *  container passes the real `useT()` translator in production. */
export function ComposerContent({
  channelId,
  onSubmit,
  placeholder,
  disabled,
  t: tProp,
}: ComposerContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !inFlight && !disabled;

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSend) return;
      setInFlight(true);
      setError(null);
      try {
        const result = await onSubmit(trimmed);
        if (result.ok) {
          setText('');
          inputRef.current?.focus();
        } else {
          setError(result.errorMessage ?? t('channels.postFailed') ?? 'Post failed');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setInFlight(false);
      }
    },
    [canSend, onSubmit, trimmed, t],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter submits; Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend) {
          void handleSubmit(e as unknown as FormEvent);
        }
      }
    },
    [canSend, handleSubmit],
  );

  return (
    <form
      onSubmit={handleSubmit}
      data-channel-composer
      data-channel-id={channelId}
      data-in-flight={inFlight ? 'true' : 'false'}
      className="flex flex-col gap-1.5 px-4 py-2"
    >
      {error && (
        <div
          role="alert"
          data-channel-composer-error
          className="text-[10px] font-mono text-[var(--accent-red)]"
          {...tokenAttrs('danger', 'text')}
        >
          {error}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          rows={2}
          data-channel-composer-input
          value={text}
          placeholder={placeholder ?? t('channels.composerPlaceholder') ?? 'Type a message…'}
          disabled={disabled || inFlight}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={handleKeyDown}
          className={`flex-1 min-w-0 resize-none bg-[var(--bg-base)] text-[var(--text-main)] text-[12px] font-mono px-2 py-1.5 rounded border border-[var(--bg-surface)] outline-none ${FOCUS_RING}`}
          aria-label={t('channels.composerAriaLabel') || 'Compose channel message'}
          {...tokenAttrs('bgBase', 'bg')}
          {...tokenAttrs('textMain', 'text')}
          {...tokenAttrs('bgSurface', 'border')}
        />
        <button
          type="submit"
          data-channel-composer-send
          disabled={!canSend}
          aria-label={t('channels.sendTooltip') || 'Send'}
          title={t('channels.sendTooltip') || 'Send'}
          className={`flex items-center justify-center w-7 h-7 rounded text-[var(--bg-base)] transition-opacity ${FOCUS_RING} ${
            canSend
              ? 'bg-[var(--accent-green)] hover:opacity-90'
              : 'bg-[var(--bg-surface)] opacity-50 cursor-not-allowed'
          }`}
          {...tokenAttrs('success', 'bg')}
          {...tokenAttrs('bgBase', 'text')}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="7" y1="11" x2="7" y2="3" />
            <polyline points="3.5,6.5 7,3 10.5,6.5" />
          </svg>
        </button>
      </div>
    </form>
  );
}

// ─── Container ──────────────────────────────────────────────────────────

/** Resolves the active company + member identity from the store and
 *  wires the composer to `postMessageOptimistic`. The `onError` is the
 *  toast slot from the parent (`useStore((s) => s.pushToast)`). */
export interface ComposerProps {
  channelId: string;
  onError: (toast: { message: string; level: 'info' | 'warn' | 'error' }) => void;
}

export function Composer({ channelId, onError }: ComposerProps): React.ReactElement {
  const t = useT();
  const company = useStore((s) => s.company);
  // Channels are decoupled from in-app Company mode: the active workspace
  // stands in as the sender identity when no company is set (mirrors
  // ChannelsPanel / ChannelView / useChannelsHydration).
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const channel = useStore((s) => s.channels[channelId]);
  const postMessageDaemon = useStore((s) => s.postMessageDaemon);

  const handlePost = useCallback(
    async (text: string) => {
      // Sender identity: the CEO workspace when Company mode is active, else
      // the active workspace. The daemon's post path requires
      // sender.workspaceId === verifiedWorkspaceId AND membership; posting
      // succeeds on channels this identity is a member of (e.g. ones it
      // created here). A channel created by another client requires a join
      // first — that is the daemon's membership rule (NOT_A_MEMBER), not a
      // company gate.
      const selfWorkspaceId = company?.ceoWorkspaceId ?? activeWorkspaceId;
      if (!channel || !selfWorkspaceId) {
        return { ok: false, errorCode: 'UNKNOWN', errorMessage: 'No channel or workspace identity' };
      }
      // R11 idempotency: `clientMsgId` is the per-post idempotency
      // key. The daemon returns the original `seq` on a repeat hit
      // instead of appending a duplicate; we generate the key here
      // so a network-retry from the user (same composer session)
      // dedupes against the prior in-flight post.
      const clientMsgId = generateId('cmid');
      const nextSeq = channel.nextSeq;
      const message = synthesizeChannelMessage({
        channelId,
        seq: nextSeq,
        text,
        senderWorkspaceId: selfWorkspaceId,
        senderMemberId: 'local-ui',
        senderMemberName: 'local-ui',
        clientMsgId,
      });
      const result = await postMessageDaemon(channelId, {
        text,
        sender: {
          workspaceId: selfWorkspaceId,
          memberId: 'local-ui',
          memberName: 'local-ui',
        },
        clientMsgId,
        message,
      });
      if (!result.ok) {
        // Plan R7: PERSIST_FAILED is surfaced verbatim, not swallowed.
        if (result.error.code === 'PERSIST_FAILED') {
          onError({ level: 'error', message: t('channels.postFailed') || 'Post failed' });
        } else {
          onError({ level: 'error', message: result.error.message });
        }
        return {
          ok: false,
          errorCode: result.error.code,
          errorMessage: result.error.message,
        };
      }
      return { ok: true };
    },
    [channelId, channel, company, postMessageDaemon, onError, t],
  );

  // The composer is bound to a single channel; an archived channel is
  // gated at the ChannelView level (the composer slot is replaced
  // with a read-only banner), so the active state here is just
  // "channel present + non-archived".
  return (
    <ComposerContent
      channelId={channelId}
      onSubmit={handlePost}
      disabled={!channel || channel.status === 'archived'}
      t={t}
    />
  );
}

export default Composer;
