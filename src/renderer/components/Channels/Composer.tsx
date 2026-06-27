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

import {
  useState,
  useRef,
  useCallback,
  useMemo,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { useStore } from '../../stores';
import { generateId } from '../../../shared/types';
import type { ChannelMember, ChannelMention, ChannelMessage } from '../../../shared/channels';
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
  mentions?: ChannelMention[];
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
    // The daemon re-validates + overwrites this; carried so the optimistic
    // local insert renders @tokens before the authoritative row lands.
    ...(params.mentions && params.mentions.length > 0
      ? { mentions: params.mentions }
      : {}),
  };
}

// ─── @-mention token detection ──────────────────────────────────────────

/** A member the composer can @-mention. The human UI participates as one
 *  member per workspace (memberId `local-ui`), so the display label is the
 *  workspace name. */
export interface MentionCandidate {
  workspaceId: string;
  memberId: string;
  name: string;
}

/**
 * Detect an in-progress `@` mention token immediately left of the caret.
 * Returns the `start` index of the `@` and the `query` typed after it, or
 * `null` when the caret is not inside a mention token.
 *
 * Rules: the `@` must sit at a word boundary (string start or after
 * whitespace) so emails like `a@b` don't trigger it, and the token does not
 * cross a newline. The query MAY contain spaces (workspace names can), so a
 * trailing-space query that no longer matches any candidate simply collapses
 * the dropdown via the empty filter — there's no hard space terminator.
 */
export function detectMentionToken(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = value[i];
    if (ch === '\n' || ch === '\r') return null;
    if (ch === '@') {
      const prev = i > 0 ? value[i - 1] : '';
      if (prev === '' || /\s/.test(prev)) {
        return { start: i, query: value.slice(i + 1, caret) };
      }
      return null;
    }
  }
  return null;
}

// ─── Pure view (props-driven) ───────────────────────────────────────────

const EMPTY_CANDIDATES: MentionCandidate[] = [];

export interface ComposerContentProps {
  channelId: string;
  onSubmit: (
    text: string,
    mentions: ChannelMention[],
  ) => Promise<{ ok: boolean; errorCode?: string; errorMessage?: string }>;
  /** Members this composer can @-mention. The sender is excluded upstream
   *  (you can't ping yourself). Defaults to none (no dropdown). */
  mentionCandidates?: MentionCandidate[];
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
  mentionCandidates,
  placeholder,
  disabled,
  t: tProp,
}: ComposerContentProps): React.ReactElement {
  const t = tProp ?? ((key: string) => key);
  const candidates = mentionCandidates ?? EMPTY_CANDIDATES;
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  // The in-progress `@` token under the caret (null = dropdown closed) and
  // the highlighted option within it.
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  // Mentions the user picked from the dropdown, keyed by workspace. Sent on
  // submit only if the @name token still survives in the text (so deleting
  // the token drops the ping).
  const [picked, setPicked] = useState<ChannelMention[]>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const trimmed = text.trim();
  const canSend = trimmed.length > 0 && !inFlight && !disabled;

  // Candidates matching the active query (case-insensitive substring).
  const matches = useMemo(() => {
    if (!token) return EMPTY_CANDIDATES;
    const q = token.query.toLowerCase();
    return candidates.filter((c) => c.name.toLowerCase().includes(q));
  }, [token, candidates]);

  const dropdownOpen = token !== null && matches.length > 0 && !inFlight && !disabled;

  const resetAfterSend = useCallback(() => {
    setText('');
    setPicked([]);
    setToken(null);
    setActiveIdx(0);
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (!canSend) return;
      setInFlight(true);
      setError(null);
      try {
        // Attach only mentions whose @name token still survives in the body;
        // the daemon re-validates against live membership.
        const mentions = picked.filter((m) => text.includes(`@${m.name}`));
        const result = await onSubmit(trimmed, mentions);
        if (result.ok) {
          resetAfterSend();
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
    [canSend, onSubmit, trimmed, text, picked, resetAfterSend, t],
  );

  const applyMention = useCallback(
    (c: MentionCandidate) => {
      if (!token) return;
      const before = text.slice(0, token.start);
      const after = text.slice(token.start + 1 + token.query.length);
      const insert = `@${c.name} `;
      const caret = before.length + insert.length;
      setText(before + insert + after);
      setPicked((prev) =>
        prev.some((p) => p.workspaceId === c.workspaceId)
          ? prev
          : [...prev, { workspaceId: c.workspaceId, memberId: c.memberId, name: c.name }],
      );
      setToken(null);
      setActiveIdx(0);
      // Restore focus + caret immediately after the inserted mention.
      requestAnimationFrame(() => {
        const el = inputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(caret, caret);
        }
      });
    },
    [token, text],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (dropdownOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setActiveIdx((i) => (i + 1) % matches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
          return;
        }
        // Enter or Tab commits the highlighted mention instead of submitting.
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyMention(matches[activeIdx] ?? matches[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setToken(null);
          return;
        }
      }
      // Enter submits; Shift+Enter inserts a newline.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (canSend) {
          void handleSubmit(e as unknown as FormEvent);
        }
      }
    },
    [dropdownOpen, matches, activeIdx, applyMention, canSend, handleSubmit],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      if (error) setError(null);
      setToken(detectMentionToken(value, e.target.selectionStart ?? value.length));
      setActiveIdx(0);
    },
    [error],
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
      <div className="relative flex items-end gap-2">
        {dropdownOpen && (
          <div
            data-channel-mention-dropdown
            role="listbox"
            className="absolute bottom-full left-0 mb-1 z-20 w-56 max-h-[40vh] overflow-y-auto rounded-md shadow-xl py-1 bg-[var(--bg-surface)]"
            style={{ border: '1px solid var(--border-soft)' }}
            {...tokenAttrs('bgSurface', 'bg')}
          >
            {matches.map((c, idx) => (
              <button
                type="button"
                key={`${c.workspaceId}:${c.memberId}`}
                data-channel-mention-option
                data-workspace-id={c.workspaceId}
                data-active={idx === activeIdx ? 'true' : undefined}
                role="option"
                aria-selected={idx === activeIdx}
                // preventDefault on mousedown so the textarea doesn't blur
                // (and tear down the dropdown) before the click lands.
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => applyMention(c)}
                className={`w-full flex items-center gap-1.5 px-3 py-1 text-left text-[11px] font-mono transition-colors ${FOCUS_RING} ${
                  idx === activeIdx
                    ? 'bg-[var(--bg-overlay)] text-[var(--text-main)]'
                    : 'text-[var(--text-sub)] hover:bg-[var(--bg-overlay)]'
                }`}
                {...tokenAttrs('textSub', 'text')}
              >
                <span className="text-[var(--accent-blue)]" aria-hidden="true">@</span>
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={2}
          data-channel-composer-input
          value={text}
          placeholder={placeholder ?? t('channels.composerPlaceholder') ?? 'Type a message…'}
          disabled={disabled || inFlight}
          onChange={handleChange}
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

const EMPTY_MEMBERS: ChannelMember[] = [];

export function Composer({ channelId, onError }: ComposerProps): React.ReactElement {
  const t = useT();
  const company = useStore((s) => s.company);
  // Channels are decoupled from in-app Company mode: the active workspace
  // stands in as the sender identity when no company is set (mirrors
  // ChannelsPanel / ChannelView / useChannelsHydration).
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const channel = useStore((s) => s.channels[channelId]);
  const members = useStore((s) => s.channelMembers[channelId] ?? EMPTY_MEMBERS);
  const workspaces = useStore((s) => s.workspaces);
  const postMessageDaemon = useStore((s) => s.postMessageDaemon);

  // Sender identity: the CEO workspace when Company mode is active, else the
  // active workspace. The daemon's post path requires
  // sender.workspaceId === verifiedWorkspaceId AND membership.
  const selfWorkspaceId = company?.ceoWorkspaceId ?? activeWorkspaceId ?? null;

  // @-mention candidates: every member workspace except the sender's own (you
  // can't ping yourself), deduped by workspace and labeled with the workspace
  // name — members are workspace-level in the human UI (memberId `local-ui`).
  const mentionCandidates = useMemo<MentionCandidate[]>(() => {
    const seen = new Set<string>();
    const out: MentionCandidate[] = [];
    for (const m of members) {
      if (m.workspaceId === selfWorkspaceId) continue;
      if (seen.has(m.workspaceId)) continue;
      seen.add(m.workspaceId);
      out.push({
        workspaceId: m.workspaceId,
        memberId: m.memberId,
        name: workspaces.find((w) => w.id === m.workspaceId)?.name ?? m.workspaceId,
      });
    }
    return out;
  }, [members, workspaces, selfWorkspaceId]);

  const handlePost = useCallback(
    async (text: string, mentions: ChannelMention[]) => {
      // A channel created by another client requires a join first — that is
      // the daemon's membership rule (NOT_A_MEMBER), not a company gate.
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
      // The daemon re-validates mentions against live membership and drops any
      // non-member / forged entry; we send our best-effort set and carry it on
      // the optimistic row so @tokens render immediately.
      const mentionsArg = mentions.length > 0 ? mentions : undefined;
      const message = synthesizeChannelMessage({
        channelId,
        seq: nextSeq,
        text,
        senderWorkspaceId: selfWorkspaceId,
        senderMemberId: 'local-ui',
        senderMemberName: 'local-ui',
        clientMsgId,
        mentions: mentionsArg,
      });
      const result = await postMessageDaemon(channelId, {
        text,
        sender: {
          workspaceId: selfWorkspaceId,
          memberId: 'local-ui',
          memberName: 'local-ui',
        },
        clientMsgId,
        mentions: mentionsArg,
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
    [channelId, channel, selfWorkspaceId, postMessageDaemon, onError, t],
  );

  // The composer is bound to a single channel; an archived channel is
  // gated at the ChannelView level (the composer slot is replaced
  // with a read-only banner), so the active state here is just
  // "channel present + non-archived".
  return (
    <ComposerContent
      channelId={channelId}
      onSubmit={handlePost}
      mentionCandidates={mentionCandidates}
      disabled={!channel || channel.status === 'archived'}
      t={t}
    />
  );
}

export default Composer;
