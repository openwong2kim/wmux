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
//   2. Fetching is not viewing, and mounting is not seeing. The "while you were
//      away" delta is acknowledged (DECK_BRIEFING_SEEN) only once the card is
//      expanded AND actually on screen (it lives at the top of a scroll
//      container that pins to the bottom, so an auto-expanded card can be
//      entirely off-view) AND the document is visible (leaving the deck open and
//      walking away is the single most likely way to be "away" — the exact
//      scenario this card exists for). The shown delta then STAYS on screen
//      until the operator collapses or leaves, so it can't blink out from under
//      them on the next refresh.
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
 *  push waits for the pane gate, so a deck opened during startup can beat it —
 *  and on a heavy fleet that wait is a COLD RECOVERY: issue #537 recorded 35
 *  sessions taking ~23s, which is why the launcher's 15s budget became a 90s
 *  ceiling. A flat 750ms × 20 gave up after 15s, so the cold-start briefing was
 *  silently skipped on exactly the fleets that need it. Backs off to a calm
 *  cadence instead of hammering, with a ceiling (~3.5 min) that clears a heavy
 *  recovery by a wide margin while still bounded, so a renderer that never
 *  pushes doesn't poll forever. */
const MIRROR_RETRY_BASE_MS = 750;
const MIRROR_RETRY_MAX_MS = 5000;
const MIRROR_MAX_RETRIES = 45;

/** Delay before retry #n (0-based). */
export function mirrorRetryDelayMs(attempt: number): number {
  return Math.min(MIRROR_RETRY_BASE_MS * 1.5 ** attempt, MIRROR_RETRY_MAX_MS);
}

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
  fleetSignature,
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
  /** A string that changes when the active workspace's status-relevant fleet
   *  state changes (CommanderView derives it from the store). The card also
   *  refetches on it, because `onStream` only fires on BRAIN output: in autonomy
   *  mode `off` no turns run at all, so a pane that finished or blocked reached
   *  the mirror but never reached this card, which then sat stale forever —
   *  despite the briefing deliberately rendering in every mode. Compared, not
   *  counted: an unchanged signature costs nothing. */
  fleetSignature?: string;
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
  // Fleet-signature refetch debounce (declared here so the workspace-switch
  // reset below can cancel it).
  const fleetDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ack visibility gate — the card element (for the intersection observer) and
  // the document's own visibility.
  const [cardEl, setCardEl] = useState<HTMLElement | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  const [docVisible, setDocVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState === 'visible',
  );

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
          const delay = mirrorRetryDelayMs(retriesRef.current);
          retriesRef.current += 1;
          if (retryRef.current) clearTimeout(retryRef.current);
          retryRef.current = setTimeout(() => refreshRef.current(), delay);
        }
        return;
      }
      // The mirror answered — a later cold recovery (a workspace switch, a
      // daemon restart) gets the full retry budget again rather than the tail
      // of the one this startup already spent.
      retriesRef.current = 0;
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
  const lastFleetSigRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    reqSeq.current++;
    hydratedRef.current = false;
    userToggledRef.current = false;
    signalRef.current = null;
    retriesRef.current = 0;
    lastFleetSigRef.current = undefined;
    if (retryRef.current) {
      clearTimeout(retryRef.current);
      retryRef.current = null;
    }
    if (fleetDebounceRef.current) {
      clearTimeout(fleetDebounceRef.current);
      fleetDebounceRef.current = null;
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

  // Refetch (debounced, same shape) when the renderer's own fleet state moves.
  // This is the mode-'off' path: no brain turns run, so `onStream` never fires
  // and the stream subscription above can't see a pane finishing or blocking.
  useEffect(() => {
    if (fleetSignature === undefined) return;
    // First observation for this workspace — the mount fetch already covers it.
    if (lastFleetSigRef.current === undefined) {
      lastFleetSigRef.current = fleetSignature;
      return;
    }
    if (lastFleetSigRef.current === fleetSignature) return;
    lastFleetSigRef.current = fleetSignature;
    if (fleetDebounceRef.current) clearTimeout(fleetDebounceRef.current);
    fleetDebounceRef.current = setTimeout(() => void refresh(), 200);
  }, [fleetSignature, refresh]);
  useEffect(() => {
    return () => {
      if (fleetDebounceRef.current) clearTimeout(fleetDebounceRef.current);
    };
  }, []);

  // Settings toggled the briefing on/off in MAIN — re-read the authoritative
  // config (a disabled briefing comes back null and the card unmounts itself).
  useEffect(() => onBriefingConfigChanged(() => void refresh()), [refresh]);

  // ── the ack visibility gate ───────────────────────────────────────────────
  // Is the card itself in the viewport? It sits at the TOP of the commander
  // thread, which pins to the bottom as soon as there is history, so "mounted
  // and expanded" says nothing about whether the operator ever saw it.
  useEffect(() => {
    if (!cardEl) {
      setOnScreen(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      // No observer (older embedder / test env): fall back to "visible" rather
      // than never acknowledging — a delta stuck forever is the worse failure.
      setOnScreen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setOnScreen(e.isIntersecting);
      },
      { threshold: 0.01 },
    );
    io.observe(cardEl);
    return () => io.disconnect();
  }, [cardEl]);

  // Is the WINDOW visible? A minimized/backgrounded deck must not consume the
  // very delta it exists to hold for the operator's return.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = (): void => setDocVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    onVis();
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // ACKNOWLEDGE — this build was genuinely SEEN: expanded, on screen, in a
  // visible window. Fires on every such build, delta or not: the baseline is
  // what "you last saw", so a refresh showing a pane back to `running` has to
  // advance it too, or a pane that goes blocked → running → blocked diffs
  // against the stale blocked baseline and the second block reads as old news.
  // The "don't hammer the disk" property lives in main instead, which skips the
  // write when the snapshot matches the stored one (deckBriefingStore.ts).
  // Re-runs whenever any gate flips, so a card scrolled into view — or a window
  // brought back to the front — acknowledges then rather than never.
  const seen = resolvedApi?.seen;
  useEffect(() => {
    if (!expanded || !briefing || !workspaceId || !seen) return;
    if (!onScreen || !docVisible) return;
    void seen(workspaceId, briefing.builtAt).catch(() => undefined);
  }, [expanded, briefing, workspaceId, seen, onScreen, docVisible]);

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
      ref={setCardEl}
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
          // Read the current value and call both setters sequentially — a React
          // state updater must be pure, so it cannot drive the second setState.
          const wasExpanded = expanded;
          setExpanded(!wasExpanded);
          // Collapsing dismisses the while-away line — it has been read.
          if (wasExpanded) setShownChange(null);
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
