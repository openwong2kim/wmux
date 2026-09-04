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
import type { AgentStatus } from '../../../shared/types';
import type { DeckLedgerRow, DeckLedgerSummary } from '../../../main/deck/deckLedgerSummary';

/** Fallback poll — a push that never arrived must not strand the panel. */
export const LEDGER_PANEL_POLL_MS = 10_000;

export interface DeckLedgerApi {
  summary: (workspaceId: string) => Promise<DeckLedgerSummary>;
  /** Main's transition ping. Returns the unsubscribe. */
  onChanged?: (callback: (envelope: { workspaceId: string }) => void) => () => void;
}

/** DESIGN.md status-dot vocabulary: amber=running, green=ok, gray=idle,
 *  red=needs input. Same mapping DeckFleet uses — a worker row and a fleet row
 *  must not disagree about what a colour means. */
function workerDotColor(status: AgentStatus | null): string {
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
}: {
  api?: DeckLedgerApi;
  /** The workspace whose brain owns the tasks — the deck is per-workspace. */
  workspaceId?: string;
  t?: (key: string) => string;
  /** Reported on every change so the deck can open its report rail while work
   *  is outstanding. */
  onOpenCountChange?: (openCount: number) => void;
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
      {/* Scrolls past a handful of rows — the panel is pinned chrome, so it
          must not grow until it owns the deck. */}
      <div className="max-h-44 overflow-y-auto">
        {rows.map((row) => (
          <div
            key={row.id}
            data-deck-ledger-row
            data-task-id={row.id}
            className="flex items-baseline gap-2 px-1 py-1 leading-relaxed"
          >
            <span
              aria-hidden="true"
              data-deck-ledger-dot
              className="inline-block w-1.5 h-1.5 rounded-full shrink-0 self-center"
              style={{ backgroundColor: workerDotColor(row.workerStatus) }}
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
              className="text-[10.5px] font-mono shrink-0 text-[var(--text-muted)]"
              {...tokenAttrs('textMuted', 'text')}
            >
              {formatAge(row.ageMs)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default DeckLedgerPanel;
