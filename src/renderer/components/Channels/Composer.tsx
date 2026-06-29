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
import { findLeafPanes } from '../../hooks/a2aAddressing';
import { generateId, type Workspace } from '../../../shared/types';
import type { AgentSlug } from '../../../shared/events';
import type { ChannelMember, ChannelMention, ChannelMessage } from '../../../shared/channels';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { computePaneAutoName, paneDisplayName } from '../../utils/paneNaming';

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

/** A live agent pane the composer can @-mention (agent-pane redesign). Each
 *  candidate is one detected agent in a member workspace — addressed by its
 *  stable `paneId` + a `ptyId` snapshot the receiving renderer re-checks
 *  (fail-closed) before pinning the a2a task. P2: the @token is the pane's
 *  stable unique auto name (`insertToken`); the dropdown shows the human
 *  `displayName` (rename ?? auto name). The unique token is what disambiguates
 *  two same-agent panes in one workspace. */
export interface MentionCandidate {
  workspaceId: string;
  paneId: string;
  ptyId: string;
  /** Stable, UNIQUE @-token inserted into the body and matched on submit — the
   *  pane's auto name (e.g. "w1-2(claude)"). Routing still uses paneId. */
  insertToken: string;
  /** Human-facing label shown in the dropdown: pane rename when set, else the
   *  auto name. May collide (harmless — paneId routes). */
  displayName: string;
}

/**
 * P2 — build the composer's @-mention candidates: one per LIVE AGENT pane in a
 * member workspace (excluding our own). Each candidate carries a stable, unique
 * `insertToken` (the pane auto name `w<ws>-<pane>(<agent>)`), so two same-agent
 * panes in ONE workspace — the case the old agentName + wsName hint could not
 * disambiguate — get distinct tokens. `displayName` (rename ?? auto name) is the
 * dropdown label. Pure + exported so the disambiguation invariant is unit-tested
 * directly (the packaged Electron UI can't be driven by automation).
 */
export function buildMentionCandidates(args: {
  workspaces: Workspace[];
  surfaceAgent: Record<string, { name: string; slug?: AgentSlug } | undefined>;
  paneLabel: Record<string, string>;
  memberWorkspaceIds: ReadonlySet<string>;
  selfWorkspaceId: string | null;
}): MentionCandidate[] {
  const { workspaces, surfaceAgent, paneLabel, memberWorkspaceIds, selfWorkspaceId } = args;
  const out: MentionCandidate[] = [];
  for (const w of workspaces) {
    if (w.id === selfWorkspaceId) continue; // can't ping yourself
    if (!memberWorkspaceIds.has(w.id)) continue; // channel members only
    const wsOrdinal = w.wsOrdinal ?? 0;
    for (const leaf of findLeafPanes(w.rootPane)) {
      // One candidate per PANE — mentions route by paneId, and the auto name is a
      // pane coordinate. Emitting per-surface would make a multi-tab pane whose
      // tabs run the same agent produce duplicate candidates with a COLLIDING
      // insertToken. Pick the pane's representative agent surface: the active
      // surface when it runs a live agent, else the first that does.
      const agentSurfaces = leaf.surfaces.filter(
        (s) => s.surfaceType !== 'browser' && !!s.ptyId && !!surfaceAgent[s.ptyId]?.name,
      );
      const repr = agentSurfaces.find((s) => s.id === leaf.activeSurfaceId) ?? agentSurfaces[0];
      if (!repr) continue; // no live agent in this pane — excludes plain terminals
      const autoName = computePaneAutoName(wsOrdinal, leaf.ordinal ?? 0, surfaceAgent[repr.ptyId]?.slug);
      out.push({
        workspaceId: w.id,
        paneId: leaf.id,
        ptyId: repr.ptyId,
        insertToken: autoName,
        displayName: paneDisplayName(paneLabel[leaf.id], autoName),
      });
    }
  }
  return out;
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
    // Match the typed query against either the human label or the stable token,
    // so "claude", "w1", or a rename like "backend" all surface the pane.
    return candidates.filter(
      (c) => c.displayName.toLowerCase().includes(q) || c.insertToken.toLowerCase().includes(q),
    );
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
      const insert = `@${c.insertToken} `;
      const caret = before.length + insert.length;
      setText(before + insert + after);
      setPicked((prev) =>
        prev.some((p) => p.paneId === c.paneId && p.workspaceId === c.workspaceId)
          ? prev
          : [...prev, { workspaceId: c.workspaceId, paneId: c.paneId, ptyId: c.ptyId, name: c.insertToken }],
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
          e.stopPropagation();
          setActiveIdx((i) => (i + 1) % matches.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
          return;
        }
        // Enter (without Shift) or Tab commits the highlighted mention. Shift+Enter
        // falls through to insert a newline. Skip during IME composition (that Enter
        // commits the Hangul/IME composition, not the mention).
        if (((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.stopPropagation();
          applyMention(matches[activeIdx] ?? matches[0]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          setToken(null);
          return;
        }
      }
      // Enter submits; Shift+Enter inserts a newline. Skip during IME composition
      // (Enter that commits a Hangul/IME composition must not send), and
      // stopPropagation so the keystroke does not leak to the focused terminal.
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        e.stopPropagation();
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
                key={`${c.workspaceId}:${c.paneId}`}
                data-channel-mention-option
                data-workspace-id={c.workspaceId}
                data-pane-id={c.paneId}
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
                <span className="truncate">{c.displayName}</span>
                {c.displayName !== c.insertToken && (
                  <span className="ml-auto pl-2 text-[9px] opacity-60 truncate">{c.insertToken}</span>
                )}
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
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const paneLabel = useStore((s) => s.paneLabel);
  const postMessageDaemon = useStore((s) => s.postMessageDaemon);

  // Sender identity: the CEO workspace when Company mode is active, else the
  // active workspace. The daemon's post path requires
  // sender.workspaceId === verifiedWorkspaceId AND membership.
  const selfWorkspaceId = company?.ceoWorkspaceId ?? activeWorkspaceId ?? null;

  // @-mention candidates (agent-pane redesign): every LIVE AGENT pane in a member
  // workspace except our own. We walk each member workspace's live pane tree and
  // keep only panes whose terminal surface has a detected agent (agentName !=
  // null) — plain terminals and non-member workspaces are excluded, which is how
  // non-agents drop out of the mention targets. The @token label is the agent
  // name; when the same agent name appears more than once (e.g. a "claude" in two
  // workspaces) we attach the workspace name as a dropdown disambiguator.
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () => buildMentionCandidates({
      workspaces,
      surfaceAgent,
      paneLabel,
      memberWorkspaceIds: new Set(members.map((m) => m.workspaceId)),
      selfWorkspaceId,
    }),
    [members, workspaces, surfaceAgent, paneLabel, selfWorkspaceId],
  );

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
      // A6: the post succeeded, but the daemon may have DROPPED some @mentions
      // whose target workspace is not a channel member. Surface that to the
      // sender as a warning — previously the renderer discarded it, so a ping
      // that never reached anyone looked like a clean send (the silent-failure
      // A2 set out to kill).
      if (result.droppedMentions && result.droppedMentions.length > 0) {
        const names = result.droppedMentions.map((d) => d.name ?? d.workspaceId).join(', ');
        onError({
          level: 'warn',
          message: (
            t('channels.mentionDropped') ||
            'These @mentions did not land (not a channel member): {names}'
          ).replace('{names}', names),
        });
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
