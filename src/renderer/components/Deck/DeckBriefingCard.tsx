// ─── Command Deck — "welcome home" briefing card (D1) ────────────────────────
//
// Presents the deterministic briefing (deckBriefing.ts) at the top of the deck
// thread: a headline, an optional "changed while away" line, and pointers into
// the decision card / channels. It is a PRESENTER of existing judgment — never a
// second resolve control (the DeckDecisionCard owns the amber "blocked on you"
// element below it).
//
// It deliberately does NOT render a pane roster (owner decision 2026-07-24).
// DeckFleet is mounted directly above this card with a near-identical row
// anatomy — status dot, agent name, mono detail line, jump arrow — in
// effectively the same order, so one blocked pane was being rendered three times
// down the screen (Fleet row + briefing row + titlebar vitals chip) where
// DESIGN.md permits at most two: "Never three." What survives is the ladder's
// CONCLUSION: the single highest-priority pane, named next to the headline and
// one click from its terminal, so "every claim one click from its evidence"
// holds without rebuilding the roster.
//
// Self-contained (the DeckDecisionCard pattern): all IPC goes through the
// injected `api` / `onStream` props (defaulting to window.electronAPI.deck.*),
// so it unit-tests under jsdom with fakes and zero store wiring.
//
// THREE rules this card learned the hard way:
//   1. It must not fight the operator. `refresh()` runs on every deck stream
//      event for the workspace, so automatic expansion applies ONLY on the first
//      briefing for a workspace and on a genuine rising edge of newly-actionable
//      state; a background refresh updates DATA and never touches `expanded`.
//   2. Fetching is not viewing. The "while you were away" delta is acknowledged
//      (DECK_BRIEFING_SEEN) only once it is actually rendered expanded — and the
//      shown delta then STAYS on screen until the operator collapses or leaves,
//      so it can't blink out from under them on the next refresh.
//   3. Nothing to say ⇒ render nothing. DESIGN.md: no dead gauges, no extra
//      chrome row (the always-on instrument strip was removed the day it landed).
//
// The headline is composed HERE from structured counts, not shipped as prose
// from main: main has no locale, and English pluralization must not be baked
// into the payload.
//
// DESIGN.md: NEUTRAL chrome — amber stays reserved for the DecisionCard + the
// running dots (the 5±2 budget). Jump affordances are steel-blue navigation.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { onBriefingConfigChanged } from './deckBriefingConfigBus';
import {
  briefingHasContent,
  briefingSignal,
  hasBriefingDelta,
  isNewlyActionable,
  shouldAutoExpandBriefing,
  type BriefingSignal,
  type WorkspaceBriefing,
  type BriefingChange,
} from '../../../main/deck/deckBriefing';

export interface DeckBriefingApi {
  get: (workspaceId: string) => Promise<{
    briefing: WorkspaceBriefing | null;
    autoShow?: boolean;
    /** false ⇒ the main-process workspace mirror has not been populated yet, so
     *  the briefing would be built on an empty fleet. Nothing was consumed;
     *  retry shortly. */
    mirrorReady?: boolean;
  }>;
  /** Acknowledge that THIS build was actually seen — advances the last-viewed
   *  baseline in main. Optional so fakes/preloads without it degrade to "the
   *  delta is shown but never consumed" rather than throwing. */
  seen?: (workspaceId: string, builtAt: number) => Promise<{ ok: boolean }>;
}

/** The deck event stream — subscribed only to trigger a refetch when the brain's
 *  activity changes fleet state (event payload is not inspected). */
export type DeckBriefingStream = (
  cb: (env: { workspaceId: string; event: unknown }) => void,
) => () => void;

/** Retry cadence while the workspace mirror is still unpopulated. The mirror
 *  push waits for the pane gate, so a deck opened during startup can beat it;
 *  bounded so a renderer that never pushes doesn't poll forever. */
const MIRROR_RETRY_MS = 750;
const MIRROR_MAX_RETRIES = 20;

type T = (key: string) => string;

function tf(t: T, key: string, fallback: string): string {
  return t(key) || fallback;
}

/** A whole-sentence key with a {count} placeholder, plural-selected by the
 *  locale's own one/other keys — never by pluralization logic in JS. */
function tc(t: T, key: string, fallback: string, count: number): string {
  return tf(t, key, fallback).replace('{count}', String(count));
}

function tp(
  t: T,
  base: string,
  fallbackOne: string,
  fallbackOther: string,
  count: number,
): string {
  return count === 1
    ? tc(t, `${base}.one`, fallbackOne, count)
    : tc(t, `${base}.other`, fallbackOther, count);
}

/** The headline, composed from the builder's structured counts. */
export function briefingHeadline(b: WorkspaceBriefing, t: T): string {
  const c = b.counts;
  let body: string;
  if (c.total === 0) {
    body = b.pendingDecision
      ? tf(t, 'deck.briefing.headline.decisionOnly', 'One decision is waiting on you.')
      : tf(t, 'deck.briefing.headline.empty', 'Nothing running here yet.');
  } else {
    const clauses: string[] = [];
    if (c.blocked > 0) {
      clauses.push(
        tp(t, 'deck.briefing.clause.blocked', '{count} needs you', '{count} need you', c.blocked),
      );
    }
    if (c.errored > 0) {
      clauses.push(
        tp(t, 'deck.briefing.clause.errored', '{count} in error', '{count} in error', c.errored),
      );
    }
    if (c.running > 0) {
      clauses.push(
        tp(t, 'deck.briefing.clause.running', '{count} running', '{count} running', c.running),
      );
    }
    if (c.done > 0) {
      clauses.push(
        tp(t, 'deck.briefing.clause.done', '{count} finished', '{count} finished', c.done),
      );
    }
    body =
      clauses.length === 0
        ? tp(
            t,
            'deck.briefing.headline.allIdle',
            'The agent is idle.',
            'All {count} agents are idle.',
            c.total,
          )
        : tf(t, 'deck.briefing.headline.sentence', '{clauses}.').replace(
            '{clauses}',
            clauses.join(tf(t, 'deck.briefing.headline.join', ', ')),
          );
  }
  if (!b.coldStart) return body;
  return `${tf(t, 'deck.briefing.welcomeBack', 'Welcome back.')} ${body}`;
}

/** The "changed while away" line. Each fragment is a whole translatable sentence
 *  with a {count} placeholder, and the surrounding sentence is a key too — word
 *  order is the locale's business, not this function's. */
export function briefingDeltaLine(changed: BriefingChange, t: T): string {
  const parts: string[] = [];
  if (changed.finished.length > 0) {
    parts.push(
      tp(
        t,
        'deck.briefing.delta.finished',
        '{count} finished',
        '{count} finished',
        changed.finished.length,
      ),
    );
  }
  if (changed.newlyBlocked.length > 0) {
    parts.push(
      tp(
        t,
        'deck.briefing.delta.nowBlocked',
        '{count} is now blocked on you',
        '{count} are now blocked on you',
        changed.newlyBlocked.length,
      ),
    );
  }
  if (changed.errored.length > 0) {
    parts.push(
      tp(
        t,
        'deck.briefing.delta.errored',
        '{count} hit an error',
        '{count} hit an error',
        changed.errored.length,
      ),
    );
  }
  if (changed.newDecision) {
    parts.push(tf(t, 'deck.briefing.delta.newDecision', 'a new decision'));
  }
  return tf(t, 'deck.briefing.whileAway', 'While you were away: {items}').replace(
    '{items}',
    parts.join(tf(t, 'deck.briefing.delta.join', ' · ')),
  );
}

export function DeckBriefingCard({
  api,
  onStream,
  workspaceId,
  t: tProp,
  onJumpToPane,
  resolvePtyPane,
  channelsUnread = 0,
  onJumpToChannels,
}: {
  api?: DeckBriefingApi;
  onStream?: DeckBriefingStream;
  workspaceId?: string;
  t?: (key: string) => string;
  onJumpToPane?: (workspaceId: string, paneId: string) => void;
  resolvePtyPane?: (ptyId: string) => { workspaceId: string; paneId: string } | null;
  /** Renderer-only overlay: unread count in the active workspace's channels. */
  channelsUnread?: number;
  /** Jump to the Channels tab (the unread-line affordance). */
  onJumpToChannels?: () => void;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  const resolvedApi =
    api ??
    (window.electronAPI as unknown as { deck?: { briefing?: DeckBriefingApi } } | undefined)?.deck
      ?.briefing;
  const resolvedStream =
    onStream ??
    (window.electronAPI as unknown as { deck?: { onStream?: DeckBriefingStream } } | undefined)
      ?.deck?.onStream;

  const [briefing, setBriefing] = useState<WorkspaceBriefing | null>(null);
  const [expanded, setExpanded] = useState(false);
  // The delta STAYS once shown. Acknowledging it clears the delta in main, so
  // without this the "2 finished, 1 now blocked" line the operator is reading
  // would vanish on the very next stream tick.
  const [shownChange, setShownChange] = useState<BriefingChange | null>(null);
  // Monotonic request id: ignore a slow get() whose response lands after the
  // workspace changed (or after a newer get), so a stale response can't overwrite
  // the active workspace's card (workspace-switch race — DeckDecisionCard pattern).
  const reqSeq = useRef(0);
  // Per-workspace expansion state machine (see rule 1 in the header).
  const hydratedRef = useRef(false);
  const userToggledRef = useRef(false);
  const signalRef = useRef<BriefingSignal | null>(null);
  // Mirror-not-ready retry.
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const refreshRef = useRef<() => void>(() => undefined);

  const refresh = useCallback(async () => {
    if (!resolvedApi || !workspaceId) return;
    const seq = ++reqSeq.current;
    try {
      const r = await resolvedApi.get(workspaceId);
      if (seq !== reqSeq.current) return; // superseded by a newer request / ws switch
      if (r.mirrorReady === false) {
        // Nothing was built and nothing was consumed — leave the current view
        // alone and try again once the renderer has pushed its tree.
        if (retriesRef.current < MIRROR_MAX_RETRIES) {
          retriesRef.current += 1;
          if (retryRef.current) clearTimeout(retryRef.current);
          retryRef.current = setTimeout(() => refreshRef.current(), MIRROR_RETRY_MS);
        }
        return;
      }
      setBriefing(r.briefing);
      if (!r.briefing) {
        signalRef.current = null;
        return;
      }
      if (hasBriefingDelta(r.briefing.changed)) setShownChange(r.briefing.changed);
      const next = briefingSignal(r.briefing);
      const prev = signalRef.current;
      signalRef.current = next;
      if (r.autoShow === false) {
        hydratedRef.current = true;
        return;
      }
      if (!hydratedRef.current) {
        // First briefing for this workspace — the one moment the card is allowed
        // to open itself without a new event to justify it.
        hydratedRef.current = true;
        if (!userToggledRef.current && shouldAutoExpandBriefing(r.briefing)) setExpanded(true);
        return;
      }
      // Background refresh: expand ONLY on a genuine rising edge (a decision that
      // just appeared, a pane that just became blocked). Never collapse — the
      // operator owns that.
      if (isNewlyActionable(prev, next)) setExpanded(true);
    } catch {
      /* main gone — leave the stale view */
    }
  }, [resolvedApi, workspaceId]);

  useEffect(() => {
    refreshRef.current = () => void refresh();
  }, [refresh]);

  // Clear immediately on a workspace switch so the previous workspace's briefing
  // never lingers while the new fetch is in flight, bump reqSeq so any in-flight
  // get for the old workspace is ignored, and reset the whole expansion state
  // machine (hydration + manual control + rising-edge baseline are per-workspace).
  useEffect(() => {
    reqSeq.current++;
    hydratedRef.current = false;
    userToggledRef.current = false;
    signalRef.current = null;
    retriesRef.current = 0;
    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    setBriefing(null);
    setExpanded(false);
    setShownChange(null);
  }, [workspaceId]);

  // Hydrate on mount + whenever the deck rebinds to another workspace.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Cancel a pending mirror retry on unmount.
  useEffect(() => {
    return () => {
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  // Refetch (debounced) on any brain activity for THIS workspace so a pane that
  // finished/blocked mid-session reflects promptly without polling.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!resolvedStream || !workspaceId) return;
    const off = resolvedStream((env) => {
      if (env.workspaceId !== workspaceId) return;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void refresh(), 200);
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      off();
    };
  }, [resolvedStream, workspaceId, refresh]);

  // Settings toggled the briefing on/off in MAIN — re-read the authoritative
  // config (a disabled briefing comes back null and the card unmounts itself).
  useEffect(() => onBriefingConfigChanged(() => void refresh()), [refresh]);

  // ACKNOWLEDGE — only what was actually rendered expanded. `changed === null` is
  // the first-ever view (no baseline stored yet) and must seed one; otherwise
  // there has to be a real delta to consume, which keeps this off the disk on the
  // common no-news refresh.
  const seen = resolvedApi?.seen;
  useEffect(() => {
    if (!expanded || !briefing || !workspaceId || !seen) return;
    if (briefing.changed !== null && !hasBriefingDelta(briefing.changed)) return;
    void seen(workspaceId, briefing.builtAt).catch(() => undefined);
  }, [expanded, briefing, workspaceId, seen]);

  if (!resolvedApi || !briefing) return null;
  // Nothing to say ⇒ no card at all (DESIGN.md: no dead gauges). The sticky delta
  // counts as content so an acknowledged "2 finished" doesn't yank the card away
  // mid-read on an otherwise-empty workspace.
  if (!briefingHasContent(briefing) && !hasBriefingDelta(shownChange)) return null;

  const jumpTo = (ptyId: string): void => {
    const coord = resolvePtyPane?.(ptyId);
    if (coord) onJumpToPane?.(coord.workspaceId, coord.paneId);
  };

  const delta = hasBriefingDelta(shownChange) ? shownChange : briefing.changed;
  const showDelta = hasBriefingDelta(delta);
  // The ladder's conclusion, and the card's ONLY jump: the single pane to look at
  // first. Rendered only when it actually resolves to a live pane, so the card
  // never offers a click that goes nowhere.
  const top = briefing.topPane;
  const topName = top ? top.agentName || t('deck.briefing.unnamedPane') || 'shell' : '';
  const showTopJump = !!top && !!resolvePtyPane?.(top.ptyId);

  return (
    <div
      data-deck-briefing
      className="rounded-[7px] px-4 py-2.5 bg-[rgba(var(--bg-surface-rgb),0.55)]"
      {...tokenAttrs('bgSurface', 'bg')}
    >
      {/* Header row — the collapsed one-line affordance; click toggles expand.
          The jump sits OUTSIDE the toggle button (a button cannot nest a
          button) and stays neutral steel-blue navigation: no status dot, no
          danger tint — the attention rendition for that pane already belongs to
          the Fleet row and the titlebar chip. */}
      <div className="flex items-center gap-2">
      <button
        type="button"
        data-briefing-toggle
        aria-expanded={expanded}
        onClick={() => {
          userToggledRef.current = true;
          setExpanded((v) => {
            // Collapsing dismisses the while-away line — it has been read.
            if (v) setShownChange(null);
            return !v;
          });
        }}
        className={`group flex-1 min-w-0 flex items-center gap-2 text-left ${FOCUS_RING}`}
      >
        <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)] shrink-0">
          {t('deck.briefing.eyebrow') || 'Briefing'}
        </span>
        <span
          className="text-[12.5px] text-[var(--text-main)] leading-relaxed truncate flex-1 min-w-0"
          {...tokenAttrs('textMain', 'text')}
        >
          {briefingHeadline(briefing, t)}
        </span>
        <span
          aria-hidden="true"
          className="text-[9px] font-mono opacity-70 text-[var(--text-muted)] shrink-0 group-hover:text-[var(--accent-blue)] transition-colors"
        >
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {showTopJump && top && (
        <button
          type="button"
          data-briefing-jump
          onClick={() => jumpTo(top.ptyId)}
          aria-label={tf(t, 'deck.briefing.jumpTo', 'Jump to {name}').replace('{name}', topName)}
          className={`shrink-0 flex items-center gap-1 font-mono text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
        >
          <span className="truncate max-w-[120px]">{topName}</span>
          <span aria-hidden="true">→</span>
        </button>
      )}
      </div>

      {expanded && (
        <div data-briefing-body className="mt-2 space-y-2">
          {/* Pending decision pointer FIRST — when one is open it is the primary
              affordance of this card; it names the decision and points at the
              DecisionCard below. NEVER a second resolve control. */}
          {briefing.pendingDecision && (
            <div
              data-briefing-decision
              className="text-[12px] text-[var(--text-main)] leading-relaxed"
              {...tokenAttrs('textMain', 'text')}
            >
              {t('deck.briefing.decisionPointer') || 'A decision is waiting on you below.'}
            </div>
          )}

          {showDelta && delta && (
            <div
              data-briefing-delta
              className="text-[11px] font-mono text-[var(--text-sub)] leading-relaxed"
              {...tokenAttrs('textSub', 'text')}
            >
              {briefingDeltaLine(delta, t)}
            </div>
          )}

          {briefing.loop && (
            <div
              data-briefing-loop
              className="text-[11px] font-mono text-[var(--text-sub)] leading-relaxed truncate"
              {...tokenAttrs('textSub', 'text')}
            >
              {t('deck.briefing.loopLabel') || 'Loop:'} {briefing.loop.objective}
              {briefing.loop.taskCount > 0
                ? ` (${briefing.loop.passes}/${briefing.loop.taskCount})`
                : ''}
            </div>
          )}

          {channelsUnread > 0 && (
            <button
              type="button"
              data-briefing-channels
              onClick={onJumpToChannels}
              className={`block text-left text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
            >
              {tc(t, 'deck.briefing.channelsUnread', '{count} unread in channels', channelsUnread)}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
