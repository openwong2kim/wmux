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
  memo,
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
import { HUMAN_WORKSPACE_ID, HUMAN_MEMBER_ID } from '../../../shared/channels';
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
  /** Absent on a badge-only candidate: a roster member whose workspace has no
   *  live agent pane, so there is nothing to pin and nobody to wake. */
  paneId?: string;
  ptyId?: string;
  /** Roster row this candidate addresses. Set on member candidates only; pane
   *  candidates address a pane, which the daemon resolves on its own. */
  memberId?: string;
  /** Stable, UNIQUE @-token inserted into the body and matched on submit — the
   *  pane's auto name (e.g. "w1-2(claude)"). Routing still uses paneId. */
  insertToken: string;
  /** Human-facing label shown in the dropdown: pane rename when set, else the
   *  auto name. May collide (harmless — paneId routes). */
  displayName: string;
  /** Display name of the pane this candidate pins, when the pin is not the
   *  candidate itself (a member candidate resolved to its most recently active
   *  agent pane). Drives the composer's "will reach …" hint. */
  pinnedPaneName?: string;
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
  /** Channel roster. Members whose own token is not already a pane candidate get
   *  one badge-only-or-pinned candidate each (C-1) — without them a member with
   *  no live agent pane could not be @-mentioned at all. */
  members?: readonly ChannelMember[];
  /** ptyId → last activity epoch ms (`surfaceActivityAt`). Picks WHICH agent pane
   *  a member candidate pins when its workspace runs several. */
  surfaceActivityAt?: Record<string, number | undefined>;
}): MentionCandidate[] {
  const { workspaces, surfaceAgent, paneLabel, memberWorkspaceIds } = args;
  const out: MentionCandidate[] = [];
  for (const w of workspaces) {
    // R1: same-workspace agent panes ARE valid @-mention targets now — a human
    // can ping their own workspace's agents, and (via the MCP post path) an agent
    // can ping a sibling pane. The old "exclude the whole self workspace" rule hid
    // those. Self-loop protection is NOT a candidate-UX concern; it lives in the
    // RECEIVING renderer's mention router (channelMentionInbox), which drops a
    // mention that targets the SENDER's own pane. `selfWorkspaceId` stays in the
    // signature for call-site compatibility and a future pane-scoped composer.
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
  // C-1 — one candidate per ROSTER MEMBER whose own name is not already a pane
  // token. A mention only wakes an idle agent when it carries a pane pin, so a
  // member candidate resolves to that workspace's most recently active agent
  // pane; a member with no live agent pane stays badge-only (no paneId) and the
  // composer says so instead of pretending the ping will land.
  const paneTokens = new Set(out.map((c) => c.insertToken));
  const paneCandidates = out.slice();
  const activity = args.surfaceActivityAt ?? {};
  for (const member of args.members ?? []) {
    if (member.workspaceId === HUMAN_WORKSPACE_ID) continue; // the human seat runs no agent
    const token = member.memberName ?? member.memberId;
    // The submit-time scan matches a single whitespace-free run, so a roster
    // name with a space can never be typed back as a token.
    if (!token || /\s/.test(token) || paneTokens.has(token)) continue;
    if (!memberWorkspaceIds.has(member.workspaceId)) continue;
    const pin = pickMostRecentlyActivePane(
      paneCandidates.filter((c) => c.workspaceId === member.workspaceId),
      activity,
    );
    out.push({
      workspaceId: member.workspaceId,
      memberId: member.memberId,
      insertToken: token,
      displayName: token,
      ...(pin ? { paneId: pin.paneId, ptyId: pin.ptyId, pinnedPaneName: pin.displayName } : {}),
    });
    paneTokens.add(token);
  }
  return out;
}

/**
 * C-1 (rev 2) — when a mentioned member's workspace runs SEVERAL live agent
 * panes, pin the most recently active one; `surfaceActivityAt` is the renderer's
 * per-pty activity clock. Ties (and a workspace with no activity samples at all)
 * fall back to the first candidate, which is the pane tree's own order — stable,
 * so the same member always resolves to the same pane until activity moves.
 * Returns `undefined` when the workspace has no live agent pane (badge-only).
 */
export function pickMostRecentlyActivePane(
  candidates: readonly MentionCandidate[],
  surfaceActivityAt: Record<string, number | undefined>,
): MentionCandidate | undefined {
  let best: MentionCandidate | undefined;
  let bestAt = -1;
  for (const c of candidates) {
    if (!c.paneId || !c.ptyId) continue;
    const at = surfaceActivityAt[c.ptyId] ?? 0;
    if (best === undefined || at > bestAt) {
      best = c;
      bestAt = at;
    }
  }
  return best;
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

// ─── Typed @-token promotion (submit-time) ──────────────────────────────

/** The mention row a candidate contributes — identical in shape to the row
 *  `applyMention` pushes into `picked`, so an auto-promoted (never-clicked)
 *  token and a dropdown-selected one are indistinguishable downstream. */
function candidateMention(c: MentionCandidate): ChannelMention {
  return {
    workspaceId: c.workspaceId,
    // A badge-only member candidate carries no pane pin: the mention lands at
    // workspace level, which is exactly what the daemon does with a pin it
    // cannot prove. Omit the keys rather than sending `undefined`.
    ...(c.paneId ? { paneId: c.paneId } : {}),
    ...(c.ptyId ? { ptyId: c.ptyId } : {}),
    ...(c.memberId ? { memberId: c.memberId } : {}),
    name: c.insertToken,
  };
}

/** Dedup identity for a mention row: a pane is addressed by (workspaceId,
 *  paneId) — the same key `applyMention` dedups on. */
function mentionKey(m: { workspaceId: string; paneId?: string }): string {
  return `${m.workspaceId}\u0000${m.paneId ?? ''}`;
}

/** True when `idx` sits at a token boundary: end-of-string, or a char that
 *  cannot be part of an insert token. Auto names are `w<n>-<n>(<slug>)` —
 *  letters, digits, `-`, `(`, `)` (underscore folded in defensively). A
 *  trailing token char means the typed run is LONGER than the candidate token
 *  (`@w1-2(claude)x`), so it is not an exact-token match. */
function isTokenBoundary(text: string, idx: number): boolean {
  if (idx >= text.length) return true;
  return !/[A-Za-z0-9()_-]/.test(text[idx]);
}

/**
 * P2e — submit-time promotion of hand-typed @tokens (audit C-C1/C-C2). Scans
 * `text` for `@<insertToken>` runs that EXACTLY match a candidate's insert token
 * (the same token the dropdown inserts, `@${insertToken} `) and promotes them
 * into the mentions payload even when the user never opened the dropdown — the
 * silent-drop bug where a typed @token shipped as plain text (no mention fired,
 * no warning). Matching is longest-token-first so a token that is a prefix of
 * another (`w1-2` vs `w1-2(claude)`) never shadows the longer one. `picked`
 * (dropdown selections) is folded into the same token table and deduped against,
 * so a token that was both clicked and typed appears once, and a picked mention
 * whose @token was deleted from the body is dropped (it no longer scans).
 * `unmatched` collects `@runs` (with the leading `@`) that match no candidate so
 * the caller can warn "did not match anyone — not delivered".
 *
 * PURE + exported for unit tests (the packaged Electron UI can't be automated).
 *
 * v1 scope: @tokens inside fenced code blocks / inline code are NOT
 * distinguished — a `@w1-2(claude)` written inside `code` still promotes. The
 * only structural filter is the `@` word boundary (start-of-line or after
 * whitespace, never mid-word, so `a@b` emails are skipped) — mirroring
 * detectMentionToken.
 */
export function promoteTypedMentions(
  text: string,
  candidates: MentionCandidate[],
  picked: ChannelMention[],
): { mentions: ChannelMention[]; unmatched: string[] } {
  // token → row to emit. Candidates auto-promote; picked overwrite so a dropdown
  // selection's exact row wins on a token collision (identical shape anyway).
  const byToken = new Map<string, ChannelMention>();
  for (const c of candidates) {
    if (!byToken.has(c.insertToken)) byToken.set(c.insertToken, candidateMention(c));
  }
  for (const m of picked) byToken.set(m.name, m);
  // Longest first so `w1-2(claude)` is tried before the prefix `w1-2`.
  const tokens = [...byToken.keys()].sort((a, b) => b.length - a.length);

  const mentions: ChannelMention[] = [];
  const seenMention = new Set<string>();
  const unmatched: string[] = [];
  const seenRun = new Set<string>();

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '@') continue;
    // Email guard only: skip when the preceding char could be an email
    // local-part ([A-Za-z0-9._%+-]) — `a@b` never triggers. Everything else
    // (start, whitespace, punctuation, CJK) scans: requiring whitespace
    // silently dropped mentions typed flush against Korean text or "cc:@…"
    // — including dropdown-PICKED ones (adversarial review F10).
    const prev = i > 0 ? text[i - 1] : '';
    if (prev !== '' && /[A-Za-z0-9._%+-]/.test(prev)) continue;

    let hit: string | null = null;
    for (const tok of tokens) {
      if (text.startsWith(`@${tok}`, i) && isTokenBoundary(text, i + 1 + tok.length)) {
        hit = tok;
        break;
      }
    }
    if (hit) {
      const row = byToken.get(hit)!;
      const k = mentionKey(row);
      if (!seenMention.has(k)) {
        seenMention.add(k);
        mentions.push(row);
      }
      i += hit.length; // skip past the matched token
      continue;
    }
    // No candidate matched — capture the typed run (`@` + non-whitespace) for the
    // "did not match anyone" warning. A bare `@` (nothing after it) is ignored.
    let j = i + 1;
    while (j < text.length && !/\s/.test(text[j])) j++;
    const run = text.slice(i, j);
    if (run.length > 1 && !seenRun.has(run)) {
      seenRun.add(run);
      unmatched.push(run);
    }
    i = j - 1;
  }

  // Explicit dropdown selections survive by the lenient legacy rule: if the
  // @token still appears ANYWHERE in the body, keep the mention — the user
  // clicked it on purpose; only deleting the token from the body drops it
  // (adversarial review F10: the boundary scan alone regressed this).
  for (const m of picked) {
    const k = mentionKey(m);
    if (!seenMention.has(k) && text.includes(`@${m.name}`)) {
      seenMention.add(k);
      mentions.push(m);
    }
  }

  return { mentions, unmatched };
}

// ─── Mention target hint (C-1) ──────────────────────────────────────────

/** One line of the composer's "who will this reach" hint. */
export interface MentionTargetHint {
  /** The @token as it appears in the body. */
  name: string;
  /** Display name of the pane the mention pins, when it pins one. */
  paneName?: string;
  /** True when the mention carries no pane pin: it shows as a badge in the
   *  recipient's channel list and wakes nobody. */
  badgeOnly: boolean;
}

/**
 * C-1 — describe where the draft's mentions would actually land. A mention with
 * a pane pin reaches that pane (the only shape that reaches an IDLE agent); one
 * without is badge-only. Pure + exported: the packaged Electron UI can't be
 * driven by automation, so the invariant is tested here.
 */
export function describeMentionTargets(
  mentions: readonly ChannelMention[],
  candidates: readonly MentionCandidate[],
): MentionTargetHint[] {
  const byKey = new Map<string, MentionCandidate>();
  for (const c of candidates) byKey.set(mentionKey({ workspaceId: c.workspaceId, paneId: c.paneId }), c);
  return mentions.map((m) => {
    const c = byKey.get(mentionKey(m));
    const paneName = m.paneId ? c?.pinnedPaneName ?? c?.displayName ?? m.name : undefined;
    return {
      name: m.name,
      ...(paneName ? { paneName } : {}),
      badgeOnly: !m.paneId,
    };
  });
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
  // Inline one-line warning for typed @tokens that matched no one on the last
  // send (post still went out — mirrors the droppedMentions warn path). Outlives
  // resetAfterSend so the sender sees which pings were lost.
  const [warning, setWarning] = useState<string | null>(null);
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

  // C-1 — live "will reach …" hint for the draft's mentions. Promotion is the
  // same pure scan the submit path runs, so the hint can never disagree with
  // what actually ships.
  const targetHints = useMemo(
    () => describeMentionTargets(promoteTypedMentions(text, candidates, picked).mentions, candidates),
    [text, candidates, picked],
  );

  const dropdownOpen = token !== null && matches.length > 0 && !inFlight && !disabled;
  // Open-intent but nothing matches (typing `@zzz`, or a channel with no live
  // agent panes): show a "no agents to mention" hint instead of rendering
  // nothing, so the user knows the @token won't resolve to anyone. A query
  // containing whitespace can never become an insert token (auto names are
  // single-word), so the hint collapses then — without that gate, any sentence
  // with a word-initial '@' ("meet @ noon tomorrow…") pinned the hint open for
  // the rest of the line (ship design review).
  const dropdownEmpty =
    token !== null && !/\s/.test(token.query) && matches.length === 0 && !inFlight && !disabled;

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
      setWarning(null);
      try {
        // Promote hand-typed @tokens (matching a candidate's insert token) into
        // the payload even if never dropdown-selected, and keep the picked
        // mentions whose @token still survives in the body. The daemon
        // re-validates against live membership. `unmatched` = typed @tokens that
        // resolved to no candidate.
        const { mentions, unmatched } = promoteTypedMentions(text, candidates, picked);
        const result = await onSubmit(trimmed, mentions);
        if (result.ok) {
          resetAfterSend();
          // The post shipped; if some typed @tokens matched no one, warn inline
          // (one line, warn style) — the message still sent, but those pings
          // never landed. Set AFTER the reset so it outlives the cleared body.
          if (unmatched.length > 0) {
            setWarning(
              (
                t('channels.mentionUnmatched') ||
                'These @mentions matched no one — not delivered: {names}'
              ).replace('{names}', unmatched.join(', ')),
            );
          }
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
    [canSend, onSubmit, trimmed, text, picked, candidates, resetAfterSend, t],
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
      // Escape must dismiss the empty-state hint too, not just a populated
      // dropdown (ship design review: the hint had no dismiss path).
      if (dropdownEmpty && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setToken(null);
        return;
      }
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
    [dropdownOpen, dropdownEmpty, matches, activeIdx, applyMention, canSend, handleSubmit],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setText(value);
      if (error) setError(null);
      if (warning) setWarning(null);
      setToken(detectMentionToken(value, e.target.selectionStart ?? value.length));
      setActiveIdx(0);
    },
    [error, warning],
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
      {warning && (
        <div
          role="status"
          data-channel-composer-warning
          className="text-[10px] font-mono text-[var(--accent-yellow)]"
          {...tokenAttrs('warning', 'text')}
        >
          {warning}
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
        {dropdownEmpty && (
          <div
            data-channel-mention-empty
            role="status"
            className="absolute bottom-full left-0 mb-1 z-20 w-56 rounded-md shadow-xl py-1.5 px-3 text-[11px] font-mono bg-[var(--bg-surface)] text-[var(--text-sub)]"
            style={{ border: '1px solid var(--border-soft)' }}
            {...tokenAttrs('bgSurface', 'bg')}
            {...tokenAttrs('textSub', 'text')}
          >
            {t('channels.mentionNoMatch') || 'No agents to mention'}
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
      {targetHints.length > 0 && (
        <div
          data-channel-mention-hint
          role="status"
          className="flex flex-col gap-0.5 text-[9px] font-mono text-[var(--text-muted)]"
          {...tokenAttrs('textMuted', 'text')}
        >
          {targetHints.map((h) => (
            <span
              key={h.name}
              data-channel-mention-hint-row
              data-badge-only={h.badgeOnly ? 'true' : undefined}
              className={h.badgeOnly ? 'text-[var(--accent-yellow)]' : undefined}
            >
              {h.badgeOnly
                ? (t('channels.mentionBadgeOnly') || '@{name} has no live pane — badge only, nobody is woken')
                    .replace('{name}', h.name)
                : (t('channels.mentionWillReach') || 'will reach {pane}').replace('{pane}', h.paneName ?? h.name)}
            </span>
          ))}
        </div>
      )}
    </form>
  );
}

// ─── Container ──────────────────────────────────────────────────────────

/** Resolves the unified human (ws-human) identity from the store and
 *  wires the composer to `postMessageOptimistic`. The `onError` is the
 *  toast slot from the parent (`useStore((s) => s.pushToast)`). */
export interface ComposerProps {
  channelId: string;
  onError: (toast: { message: string; level: 'info' | 'warn' | 'error' }) => void;
}

const EMPTY_MEMBERS: ChannelMember[] = [];

function ComposerImpl({ channelId, onError }: ComposerProps): React.ReactElement {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const members = useStore((s) => s.channelMembers[channelId] ?? EMPTY_MEMBERS);
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgent = useStore((s) => s.surfaceAgent);
  const paneLabel = useStore((s) => s.paneLabel);
  const postMessageDaemon = useStore((s) => s.postMessageDaemon);

  // P5 (unified human identity): the composer posts as the reserved human
  // workspace — the daemon's post path requires sender.workspaceId ===
  // verifiedWorkspaceId AND membership, both of which are the ws-human row now.
  const selfWorkspaceId: string | null = HUMAN_WORKSPACE_ID;

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
      // C-1: roster rows become candidates too (pinned to the workspace's most
      // recently active agent pane, or badge-only when it has none). The activity
      // clock is READ, not subscribed to: it is stamped on every tool event of
      // every pane, so a subscription would re-render the always-mounted composer
      // continuously (the A2 memo barrier below exists for exactly this). Re-read
      // whenever the roster or the pane tree changes, which is often enough — a
      // slightly older pin is still a live agent pane in the right workspace.
      members,
      surfaceActivityAt: useStore.getState().surfaceActivityAt,
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
        senderMemberId: HUMAN_MEMBER_ID,
        senderMemberName: HUMAN_MEMBER_ID,
        clientMsgId,
        mentions: mentionsArg,
      });
      const result = await postMessageDaemon(channelId, {
        text,
        sender: {
          workspaceId: selfWorkspaceId,
          memberId: HUMAN_MEMBER_ID,
          memberName: HUMAN_MEMBER_ID,
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

// A2: 상시 마운트 대형 컴포넌트 memo 방벽. ChannelView가 리렌더돼도 props
// (channelId·onError=pushToast 모두 안정)가 그대로면 Composer 재렌더를 건너뛴다.
// 내부 자체 구독(멤버/멘션 등) 변경은 memo와 무관하게 반영된다.
// 리뷰 반영: 실사용처(ChannelView)가 named import를 쓰므로 named export 자체가
// memo 래핑이어야 방벽이 실제로 적용된다(초판은 default만 memo — 무효였음).
export const Composer = memo(ComposerImpl);
export default Composer;
