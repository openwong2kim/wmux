// ─── Command Deck — the pinned task-ledger status panel (orchestrator W2 B-1) ─
//
// "What is delegated right now?" answered from the LEDGER, not from pane
// screens. The ledger (src/shared/ledger.ts) is the one state the brain, the
// workers and the Stop gate already share, so a panel fed by it cannot
// disagree with the gate that holds the brain's turn open.
//
// Pinned above the deck's conversation and NOT part of its scroll: an open task
// must stay on screen while the operator reads history. Renders nothing when
// there are no open tasks — a zero-task deck should look exactly like it did
// before this panel existed.
//
// Refresh: main pushes a bare "your ledger moved" ping on every transition
// (deck:ledger:push) and the panel re-reads; a 10 s timer is the fallback for
// a push lost to a reload or a renderer that mounted mid-transition. The read
// is a main-side projection, so neither path can drift from the other.
//
// Self-contained like DeckLoopPanel: all IPC goes through the injected `api`
// prop (defaulting to window.electronAPI.deck.ledger), so the panel unit-tests
// under jsdom with a fake api and zero store wiring.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';
import { taskStatusDot } from '../shared/taskStatusDot';
import type { DeckLedgerRow, DeckLedgerSummary } from '../../../main/deck/deckLedgerSummary';

/** Fallback poll — a push that never arrived must not strand the panel. */
export const LEDGER_PANEL_POLL_MS = 10_000;

/** Rows shown before the `+N more` toggle. The panel is pinned chrome above the
 *  conversation, so an eight-task fan-out used to push the brain's own thread
 *  off the bottom of the deck. Five rows is the header line plus enough to see
 *  a fan-out is running. */
export const LEDGER_PANEL_VISIBLE_ROWS = 5;

/** Per-viewer convenience only — which way the operator last left the panel.
 *  Collapsed is the default, including when storage is unreadable. */
export const LEDGER_PANEL_EXPANDED_KEY = 'deck.ledgerPanel.expanded';

/** localStorage throws outright in some embeddings; a panel that cannot read a
 *  preference must still render. */
export function readLedgerPanelExpanded(): boolean {
  try {
    return window.localStorage.getItem(LEDGER_PANEL_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLedgerPanelExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(LEDGER_PANEL_EXPANDED_KEY, expanded ? '1' : '0');
  } catch {
    /* private window / storage blocked — the session keeps its own state */
  }
}

export interface DeckLedgerApi {
  summary: (workspaceId: string) => Promise<DeckLedgerSummary>;
  /** Main's transition ping. Returns the unsubscribe. */
  onChanged?: (callback: (envelope: { workspaceId: string }) => void) => () => void;
}

/** Compact age: seconds under a minute, then minutes, then hours. */
export function formatAge(ageMs: number): string {
  const s = Math.max(0, Math.floor(ageMs / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function DeckLedgerPanel({
  api,
  workspaceId,
  t: tProp,
  onOpenCountChange,
  channelByTaskId,
  onOpenChannel,
}: {
  api?: DeckLedgerApi;
  /** The workspace whose brain owns the tasks — the deck is per-workspace. */
  workspaceId?: string;
  t?: (key: string) => string;
  /** Reported on every change so the deck can open its report rail while work
   *  is outstanding. */
  onOpenCountChange?: (openCount: number) => void;
  /** `taskId → mission channel id`. A row whose task is not in the map draws
   *  no `#` — the affordance appears only where it goes somewhere. The ledger
   *  summary is built from the ledger alone and knows nothing about channels,
   *  so the mapping is the caller's (see stores/selectors/missions.ts). */
  channelByTaskId?: Readonly<Record<string, string>>;
  /** Opens one mission channel. Together with the map above this is the `#`
   *  jump the deleted sidebar task rows used to own. */
  onOpenChannel?: (channelId: string) => void;
}): React.ReactElement | null {
  const t = tProp ?? (() => '');
  // Optional-chain the whole path — window.electronAPI is absent under jsdom
  // and in dev shells without the preload.
  const resolvedApi =
    api ??
    (window.electronAPI as unknown as { deck?: { ledger?: DeckLedgerApi } } | undefined)?.deck
      ?.ledger;
  const [rows, setRows] = useState<DeckLedgerRow[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [unavailable, setUnavailable] = useState(false);
  // Collapsed by default; the operator's last choice is remembered per browser
  // profile. This is a per-viewer convenience, which is exactly what
  // localStorage is for — nothing here has to survive a reinstall.
  const [expanded, setExpanded] = useState(readLedgerPanelExpanded);
  const reportRef = useRef(onOpenCountChange);
  reportRef.current = onOpenCountChange;
  // Request sequence. Reads are fired by four things (mount, the fallback
  // timer, main's ping and a workspace change) and IPC replies are not ordered,
  // so without this an older workspace's slow reply can land after a newer
  // one's and render another deck's tasks into this one. Only the latest
  // request may write state; the effect cleanup bumps the counter, which
  // invalidates every read still in flight for the workspace being left.
  const reqSeq = useRef(0);

  const refresh = useCallback(async () => {
    if (!resolvedApi || !workspaceId) return;
    const seq = ++reqSeq.current;
    try {
      const summary = await resolvedApi.summary(workspaceId);
      if (reqSeq.current !== seq) return;
      setRows(summary.rows);
      setOpenCount(summary.openCount);
      setUnavailable(summary.error === true);
      reportRef.current?.(summary.openCount);
    } catch {
      /* main gone — leave the stale view rather than blanking the panel */
    }
  }, [resolvedApi, workspaceId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), LEDGER_PANEL_POLL_MS);
    const off = resolvedApi?.onChanged?.((envelope) => {
      // Another workspace's brain moving its own ledger is not this panel's
      // business — re-reading on it would be a wasted IPC per fan-out worker.
      if (!workspaceId || envelope.workspaceId === workspaceId) void refresh();
    });
    return () => {
      // Invalidate every read still in flight for the workspace being left.
      reqSeq.current += 1;
      clearInterval(timer);
      off?.();
    };
  }, [refresh, resolvedApi, workspaceId]);

  // "Nothing is delegated" collapses; "I cannot read the ledger" must NOT —
  // that is the state in which the Stop gate may be holding the brain's turn on
  // a ledger neither of us can see, and a collapsed panel would call it idle.
  if (!resolvedApi || (openCount === 0 && !unavailable)) return null;

  const hidden = Math.max(0, rows.length - LEDGER_PANEL_VISIBLE_ROWS);
  const visibleRows = expanded ? rows : rows.slice(0, LEDGER_PANEL_VISIBLE_ROWS);
  const toggle = (): void => {
    const next = !expanded;
    setExpanded(next);
    writeLedgerPanelExpanded(next);
  };

  return (
    <div
      data-deck-ledger-panel
      className="shrink-0 px-3 pt-2.5 pb-1.5 border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgSurface', 'border')}
    >
      <div className="flex items-baseline px-1 pb-1">
        {unavailable ? (
          // Stated, not coloured: this is an absence of information, not an
          // alarm, and the amber/red vocabulary is reserved for a worker that
          // actually needs somebody (DESIGN.md status-dot grammar).
          <span
            data-deck-ledger-unavailable
            className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--text-muted)]"
            {...tokenAttrs('textMuted', 'text')}
          >
            {t('deck.ledgerUnavailable') || 'Ledger unavailable'}
          </span>
        ) : (
          <span
            data-deck-ledger-count
            className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--text-muted)]"
            {...tokenAttrs('textMuted', 'text')}
          >
            {(t('deck.ledgerOpenTasks') || '{count} open tasks').replace(
              '{count}',
              String(openCount),
            )}
          </span>
        )}
      </div>
      {/* Collapsed the panel shows LEDGER_PANEL_VISIBLE_ROWS and nothing more:
          it is pinned chrome above the conversation, and a fan-out of eight
          used to push the brain's own thread off the bottom. Expanded it grows
          to a bounded, scrolling list — never past the deck. */}
      <div className={expanded ? 'max-h-44 overflow-y-auto' : undefined}>
        {visibleRows.map((row) => {
          // ONE vocabulary, shared with every other surface that draws a task
          // dot (components/shared/taskStatusDot.ts). The panel does not decide
          // what a colour means.
          const dot = taskStatusDot(row.status, row.workerStatus);
          const channelId = channelByTaskId?.[row.id];
          return (
          <div
            key={row.id}
            data-deck-ledger-row
            data-task-id={row.id}
            className="flex items-baseline gap-2 px-1 py-1 leading-relaxed"
          >
            <span
              aria-hidden="true"
              data-deck-ledger-dot
              data-tone={dot.tone}
              title={t(dot.labelKey)}
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0 self-center"
              style={{ backgroundColor: dot.color }}
            />
            <span
              data-deck-ledger-title
              className="text-[12px] text-[var(--text-main)] truncate max-w-[42%]"
              {...tokenAttrs('textMain', 'text')}
            >
              {row.title}
            </span>
            <span
              data-deck-ledger-status
              // eslint-disable-next-line no-restricted-syntax -- off-scale size owned by PR #1219; folded onto the ramp there to avoid a cross-PR conflict.
              className="text-[10.5px] font-mono shrink-0 text-[var(--text-sub)]"
              {...tokenAttrs('textSub', 'text')}
            >
              {row.status}
              {row.workerStatus ? ` · ${row.workerStatus}` : ''}
            </span>
            {/* Actor-written text (a worker, usually) — rendered as data. */}
            <span
              data-deck-ledger-line
              className="flex-1 min-w-0 text-[11px] font-mono truncate text-[var(--text-muted)]"
              {...tokenAttrs('textMuted', 'text')}
            >
              {row.lastLine ?? ''}
            </span>
            <span
              data-deck-ledger-age
              // eslint-disable-next-line no-restricted-syntax -- off-scale size owned by PR #1219; folded onto the ramp there to avoid a cross-PR conflict.
              className="text-[10.5px] font-mono shrink-0 text-[var(--text-muted)]"
              {...tokenAttrs('textMuted', 'text')}
            >
              {formatAge(row.ageMs)}
            </span>
            {/* The `#` jump the deleted sidebar task rows carried. Drawn only
                when the caller can actually resolve a channel for this task —
                DESIGN.md "every claim is one click from its evidence", never a
                link to nowhere. */}
            {channelId && onOpenChannel && (
              <button
                type="button"
                data-deck-ledger-channel
                data-channel-id={channelId}
                className="shrink-0 text-[10px] font-mono text-[var(--text-subtle)] hover:text-[var(--accent-blue)] transition-colors"
                onClick={() => onOpenChannel(channelId)}
                title={t('missions.openChannel') || 'Open task channel'}
                aria-label={(t('missions.openChannelFor') || 'Open task channel for {title}').replace(
                  '{title}',
                  row.title,
                )}
              >
                #
              </button>
            )}
          </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          data-deck-ledger-more
          aria-expanded={expanded}
          onClick={toggle}
          className={`w-full text-left px-1 py-1 text-[10px] font-mono text-[var(--text-muted)] hover:text-[var(--accent-blue)] transition-colors ${FOCUS_RING}`}
          {...tokenAttrs('textMuted', 'text')}
        >
          {expanded
            ? t('deck.ledgerShowLess') || 'Show less'
            : (t('deck.ledgerMore') || '+{count} more').replace('{count}', String(hidden))}
        </button>
      )}
    </div>
  );
}

export default DeckLedgerPanel;
