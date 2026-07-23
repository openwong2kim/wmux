// ─── Command Deck — "welcome home" briefing card (D1) ────────────────────────
//
// Presents the deterministic briefing (deckBriefing.ts) at the top of the deck
// thread: a greeting, an optional "changed while away" line, the suggested-order
// pane list, and pointers into the decision card / channels. It is a PRESENTER
// of existing judgment — never a second resolve control (the DeckDecisionCard
// owns the amber "blocked on you" element below it).
//
// Self-contained (the DeckDecisionCard pattern): all IPC goes through the
// injected `api` / `onStream` props (defaulting to window.electronAPI.deck.*),
// so it unit-tests under jsdom with fakes and zero store wiring. Renders nothing
// when the briefing is null (config disabled / preload absent).
//
// DESIGN.md: NEUTRAL chrome — amber stays reserved for the DecisionCard + the
// running dots (the 5±2 budget). Jump affordances are steel-blue navigation.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import type { AgentStatus } from '../../../shared/types';
import {
  hasBriefingDelta,
  shouldAutoExpandBriefing,
  type WorkspaceBriefing,
  type BriefingChange,
} from '../../../main/deck/deckBriefing';

export interface DeckBriefingApi {
  get: (
    workspaceId: string,
  ) => Promise<{ briefing: WorkspaceBriefing | null; autoShow?: boolean }>;
}

/** The deck event stream — subscribed only to trigger a refetch when the brain's
 *  activity changes fleet state (event payload is not inspected). */
export type DeckBriefingStream = (
  cb: (env: { workspaceId: string; event: unknown }) => void,
) => () => void;

/** Cap the rendered pane rows — a 30-session fleet must not paint 30 rows in the
 *  chat dock (DESIGN.md "does this shrink the hero?"). Priority sort ensures the
 *  capped list shows the ones that matter; the rest collapse into "+N more". */
const MAX_PANE_ROWS = 8;

/** DESIGN.md status-dot vocabulary: amber=running, green=ok/idle-complete,
 *  gray=idle, red=needs input/error. Local copy of the Fleet row's vocabulary
 *  (DeckFleet's is module-private) so the two stay visually identical. */
function dotColor(status: AgentStatus): string {
  switch (status) {
    case 'running':
      return 'var(--accent-cursor)';
    case 'complete':
      return 'var(--accent-green)';
    case 'awaiting_input':
    case 'waiting':
    case 'error':
      return 'var(--accent-red)';
    default:
      return 'var(--text-muted)';
  }
}

/** The "changed while away" line, composed from the delta counts. Empty when
 *  there is nothing to say (the caller guards with hasBriefingDelta). */
function deltaLine(changed: BriefingChange, t: (key: string) => string): string {
  const parts: string[] = [];
  if (changed.finished.length > 0) {
    parts.push(`${changed.finished.length} ${t('deck.briefing.finished') || 'finished'}`);
  }
  if (changed.newlyBlocked.length > 0) {
    parts.push(
      `${changed.newlyBlocked.length} ${t('deck.briefing.nowBlocked') || 'now blocked on you'}`,
    );
  }
  if (changed.errored.length > 0) {
    parts.push(`${changed.errored.length} ${t('deck.briefing.errored') || 'hit an error'}`);
  }
  if (changed.newDecision) parts.push(t('deck.briefing.newDecision') || 'a new decision');
  return parts.join(' · ');
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
  // Monotonic request id: ignore a slow get() whose response lands after the
  // workspace changed (or after a newer get), so a stale response can't overwrite
  // the active workspace's card (workspace-switch race — DeckDecisionCard pattern).
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!resolvedApi || !workspaceId) return;
    const seq = ++reqSeq.current;
    try {
      const r = await resolvedApi.get(workspaceId);
      if (seq !== reqSeq.current) return; // superseded by a newer request / ws switch
      setBriefing(r.briefing);
      // Auto-expand only when the config allows AND there is something worth
      // showing (cold start / new decision / newly-blocked). Otherwise sit as a
      // collapsed one-line affordance so the card never nags on every switch.
      setExpanded(
        !!r.briefing && r.autoShow !== false && shouldAutoExpandBriefing(r.briefing),
      );
    } catch {
      /* main gone — leave the stale view */
    }
  }, [resolvedApi, workspaceId]);

  // Clear immediately on a workspace switch so the previous workspace's briefing
  // never lingers while the new fetch is in flight, and bump reqSeq so any
  // in-flight get for the old workspace is ignored when it resolves.
  useEffect(() => {
    reqSeq.current++;
    setBriefing(null);
    setExpanded(false);
  }, [workspaceId]);

  // Hydrate on mount + whenever the deck rebinds to another workspace.
  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  if (!resolvedApi || !briefing) return null;

  const jumpTo = (ptyId: string): void => {
    const coord = resolvePtyPane?.(ptyId);
    if (coord) onJumpToPane?.(coord.workspaceId, coord.paneId);
  };

  const shownPanes = briefing.panes.slice(0, MAX_PANE_ROWS);
  const overflow = briefing.panes.length - shownPanes.length;
  const showDelta = hasBriefingDelta(briefing.changed);

  return (
    <div
      data-deck-briefing
      className="rounded-[7px] px-4 py-2.5 bg-[rgba(var(--bg-surface-rgb),0.55)]"
      {...tokenAttrs('bgSurface', 'bg')}
    >
      {/* Header row — the collapsed one-line affordance; click toggles expand. */}
      <button
        type="button"
        data-briefing-toggle
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className={`w-full flex items-center gap-2 text-left ${FOCUS_RING}`}
      >
        <span className="text-[11px] font-mono uppercase tracking-wider text-[var(--text-muted)] shrink-0">
          {t('deck.briefing.eyebrow') || 'Briefing'}
        </span>
        <span
          className="text-[12.5px] text-[var(--text-main)] leading-relaxed truncate flex-1 min-w-0"
          {...tokenAttrs('textMain', 'text')}
        >
          {briefing.greeting}
        </span>
        <span
          aria-hidden="true"
          className="text-[11px] font-mono text-[var(--text-muted)] shrink-0 hover:text-[var(--accent-blue)] transition-colors"
        >
          {expanded ? '−' : (t('deck.briefing.expand') || 'Brief me')}
        </span>
      </button>

      {expanded && (
        <div data-briefing-body className="mt-2 space-y-2">
          {showDelta && briefing.changed && (
            <div
              data-briefing-delta
              className="text-[11px] font-mono text-[var(--text-sub)] leading-relaxed"
              {...tokenAttrs('textSub', 'text')}
            >
              {t('deck.briefing.whileAway') || 'While you were away:'} {deltaLine(briefing.changed, t)}
            </div>
          )}

          {/* Pending decision pointer — names it, points at the DecisionCard
              below. NEVER a second resolve control. */}
          {briefing.pendingDecision && (
            <div
              data-briefing-decision
              className="text-[12px] text-[var(--text-main)] leading-relaxed"
              {...tokenAttrs('textMain', 'text')}
            >
              {t('deck.briefing.decisionPointer') || 'A decision is waiting on you below.'}
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

          {shownPanes.length > 0 && (
            <div data-briefing-panes className="space-y-0.5">
              {shownPanes.map((p) => {
                const canJump = !!resolvePtyPane?.(p.ptyId);
                return (
                  <div
                    key={p.ptyId}
                    data-briefing-pane
                    className="group flex items-center gap-2 text-[12px] leading-relaxed"
                  >
                    <span
                      aria-hidden="true"
                      className="w-[7px] h-[7px] rounded-full shrink-0"
                      style={{ backgroundColor: dotColor(p.agentStatus) }}
                    />
                    <span
                      className="shrink-0 text-[var(--text-main)] truncate max-w-[40%]"
                      {...tokenAttrs('textMain', 'text')}
                    >
                      {p.agentName || t('deck.briefing.unnamedPane') || 'shell'}
                    </span>
                    <span
                      className="flex-1 min-w-0 truncate font-mono text-[11px] text-[var(--text-muted)]"
                      {...tokenAttrs('textMuted', 'text')}
                    >
                      {t(`deck.briefing.reason.${p.reason}`) || p.reason}
                      {p.cwd ? ` · ${p.cwd}` : ''}
                    </span>
                    {canJump && (
                      <button
                        type="button"
                        data-briefing-jump
                        onClick={() => jumpTo(p.ptyId)}
                        aria-label={t('deck.briefing.jump') || 'Jump to pane'}
                        className={`shrink-0 font-mono text-[11px] text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
                      >
                        →
                      </button>
                    )}
                  </div>
                );
              })}
              {overflow > 0 && (
                <div
                  data-briefing-more
                  className="text-[11px] font-mono text-[var(--text-muted)]"
                  {...tokenAttrs('textMuted', 'text')}
                >
                  {(t('deck.briefing.more') || '+{count} more').replace('{count}', String(overflow))}
                </div>
              )}
            </div>
          )}

          {channelsUnread > 0 && (
            <button
              type="button"
              data-briefing-channels
              onClick={onJumpToChannels}
              className={`block text-left text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
            >
              {(t('deck.briefing.channelsUnread') || '{count} unread in channels').replace(
                '{count}',
                String(channelsUnread),
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
