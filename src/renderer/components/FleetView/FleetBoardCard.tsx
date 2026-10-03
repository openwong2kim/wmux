import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { FleetPane, FleetRow } from '../../stores/selectors/fleet';
import { fleetTargetPtyId } from '../../stores/selectors/fleet';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { getLocale } from '../../i18n';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import { IconExternalLink } from '../icons';
import { fleetTitle } from './fleetPresentation';
import { fleetRequesterText } from '../../utils/fanoutProvenance';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';
import type { BoardColumn } from './fleetBoardModel';
import { useUsageLimitNow } from '../Pane/UsageLimitChip';
import { usageLimitFleetDetail, usageLimitView } from '../Pane/usageLimitPresentation';

/** bytes → "370 MB" / "1.2 GB" (Windows agent RAM). */
function formatRss(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

/** Compact line counts: 2100 → "2.1k". */
function formatCount(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

export interface FleetBoardCardProps {
  card: FleetPane;
  row: FleetRow;
  column: BoardColumn;
  focused: boolean;
  /** 20 or more agents: two lines per card. */
  dense: boolean;
  now: number;
  changed?: boolean;
  /** Work-task ledger status of this pane's task, when it has one. */
  ledgerStatus?: string;
  /** An A2A request addressed to this workspace waits for approval. */
  approvalPending?: boolean;
  resource?: { rss: number; image?: string };
  onJump: (card: FleetPane) => void;
  onFocus: () => void;
}

/**
 * One agent on the Fleet board. Line 1: status dot, name, agent, elapsed (a
 * running turn counts from its start, anything else from its last sign of
 * life). Line 2: workspace, branch, ahead/behind — and the diff on Ready to
 * review cards. Then the one detail line (question → last message → last
 * activity, the activity in mono), chips, and who asked for it. Only data
 * wmux already has.
 */
function FleetBoardCard({
  card, row, column, focused, dense, now, changed, ledgerStatus, approvalPending, resource, onJump, onFocus,
}: FleetBoardCardProps) {
  const t = useT();
  const icon = AGENT_STATUS_ICON[card.agentStatus];
  const mission = useStore((s) => s.missionByPaneGroup[card.workspaceId]);
  const meta = useStore(useShallow((s) => {
    const m = s.workspaces.find((w) => w.id === card.workspaceId)?.metadata;
    return { branch: m?.gitBranch, sync: m?.gitSync ?? null, pr: m?.pr ?? null };
  }));
  const turnOpenAt = useStore((s) => (card.ptyId ? s.surfaceTurnOpenAt[card.ptyId] : undefined));
  const requester = useStore(useShallow((s) => fleetRequesterText(s, card.workspaceId, t)));

  const title = fleetTitle(card, mission);
  const agentName = card.agentName || (card.surfaceType === 'terminal' ? card.title : card.surfaceType);
  const quietWaiting = card.agentStatus === 'waiting' && row.section === 'idle';
  // Waiting out a usage limit: a muted clock — not an error, not a request.
  const usageWaiting = !!card.usageLimitWaiting && !card.unverifiable
    && card.agentStatus !== 'running' && card.agentStatus !== 'awaiting_input';
  const statusLabel = card.unverifiable ? t('fleet.status.unconfirmed')
    : usageWaiting ? t('usageLimit.waiting')
    : card.agentStatus === 'complete' ? t('fleet.status.turnComplete')
    : quietWaiting ? t('workspace.agentIdle') : t(icon.labelKey);
  // The board's dot grammar is its columns': amber waits on you (red for an
  // error), accent runs, green is ready to review, idle is muted.
  const statusColor = usageWaiting ? 'var(--text-muted)'
    : card.agentStatus === 'error' ? 'var(--accent-red)'
    : column === 'needsYou' ? 'var(--accent-yellow)'
    : column === 'running' ? 'var(--accent)'
    : column === 'review' ? 'var(--accent-green)'
    : 'var(--text-muted)';
  const elapsedMs = card.agentStatus === 'running' && turnOpenAt ? now - turnOpenAt : row.idleForMs;
  const elapsed = elapsedMs !== undefined && elapsedMs >= IDLE_SHOW_AFTER_MS ? formatIdle(elapsedMs) : '';
  // A pane held at its usage limit says when it resets instead of a generic detail.
  const usageLimit = useStore((s) => s.usageLimits[fleetTargetPtyId(card)] ?? (card.ptyId ? s.usageLimits[card.ptyId] : undefined));
  const limitNow = useUsageLimitNow(!!usageLimit);
  const detail = usageLimit
    ? usageLimitFleetDetail(usageLimitView(usageLimit, limitNow, getLocale()), t)
    : row.detail ?? t(row.detailKey);
  const sync = meta.sync;
  const showDiff = column === 'review' && sync && ((sync.added ?? 0) > 0 || (sync.removed ?? 0) > 0);
  const supervisionStopped = card.supervision?.status === 'stopped';
  const pr = meta.pr;

  return (
    <button
      type="button"
      role="option"
      aria-selected={focused}
      aria-label={[title, statusLabel, card.workspaceName, requester?.text, card.remote?.hostLabel, changed ? t('fleet.changedSinceSeen') : '', detail]
        .filter(Boolean).join(', ')}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onClick={() => onJump(card)}
      className="wmux-board-card"
      data-fleet-card
      data-board-key={card.paneId}
      data-status={card.agentStatus}
      data-usage-waiting={usageWaiting || undefined}
      data-column={column}
      data-dense={dense ? 'true' : undefined}
      data-unverifiable={card.unverifiable || undefined}
      data-pty-id={card.ptyId}
      data-workspace-id={card.workspaceId}
      data-workspace-name={card.workspaceName}
    >
      <span className="wmux-board-card-r1">
        {usageWaiting ? (
          <svg className="flex-none" width="10" height="10" viewBox="0 0 9 9" fill="none" stroke={statusColor} strokeWidth="1.2" strokeLinecap="round" aria-hidden="true" data-shape="clock">
            <circle cx="4.5" cy="4.5" r="3.6" />
            <polyline points="4.5,2.5 4.5,4.6 5.9,5.5" />
          </svg>
        ) : (
          <span
            className={`wmux-board-dot${card.unverifiable ? ' is-hollow' : ''}`}
            data-shape={icon.shape}
            style={{ color: statusColor }}
            aria-hidden="true"
          >{icon.shape === 'cross' ? '×' : null}</span>
        )}
        {card.remote && <span className="wmux-board-remote" data-fleet-remote title={`@${card.remote.hostLabel}`} aria-hidden="true"><IconExternalLink size={10} /></span>}
        <span className="wmux-board-title" title={title}>{title}</span>
        {changed && <span className="wmux-fleet-changed" data-fleet-changed aria-hidden="true" />}
        {agentName && agentName !== title && <span className="wmux-board-agent">{agentName}</span>}
        <span className="wmux-board-elapsed" data-fleet-elapsed={elapsed || undefined}>{usageWaiting ? statusLabel : elapsed || statusLabel}</span>
      </span>
      {!dense && (
        <span className="wmux-board-card-r2">
          <span className="truncate">{card.workspaceName}</span>
          {meta.branch && <span className="truncate">⎇ {meta.branch}</span>}
          {sync && sync.ahead > 0 && <span>↑{sync.ahead}</span>}
          {sync && sync.behind > 0 && <span>↓{sync.behind}</span>}
          {showDiff && <span className="wmux-board-add">+{formatCount(sync.added ?? 0)}</span>}
          {showDiff && <span className="wmux-board-del">−{formatCount(sync.removed ?? 0)}</span>}
        </span>
      )}
      <span
        className={`wmux-board-detail${row.detailSource === 'activity' ? ' is-activity' : ''}`}
        data-fleet-activity={row.detailSource === 'activity' || undefined}
        title={detail}
      >
        {row.detailSource === 'question' ? `“${detail}”` : detail}
      </span>
      {!dense && (
        <span className="wmux-board-chips">
          {approvalPending && <span className="wmux-board-chip is-warn" data-fleet-chip="approval">{t('fleetBoard.chip.approval')}</span>}
          {ledgerStatus && <span className="wmux-board-chip" data-fleet-chip="ledger">{t('fleetBoard.chip.ledger', { status: ledgerStatus })}</span>}
          {pr && (
            <span className="wmux-board-chip" data-fleet-chip="pr">
              {`PR #${pr.number}`}{pr.checks ? ` · ${t(`fleetBoard.ci.${pr.checks}`)}` : ''}
            </span>
          )}
          {resource && resource.rss > 0 && <span className="wmux-board-chip" data-fleet-resource data-rss-bytes={resource.rss}>{formatRss(resource.rss)}</span>}
          {card.supervision && (
            <span className="wmux-board-chip" data-fleet-supervision data-supervision-status={card.supervision.status}>
              {`${supervisionStopped ? '⟳!' : '⟳'}${card.supervision.restartCount > 0 ? ` ${card.supervision.restartCount}` : ''}`}
            </span>
          )}
          {card.stashed && <span className="wmux-board-chip">{t('fleet.stashed')}</span>}
        </span>
      )}
      {!dense && requester && <span className="wmux-board-lineage" data-fleet-requester title={requester.text}>{requester.text}</span>}
    </button>
  );
}

export default memo(FleetBoardCard);
