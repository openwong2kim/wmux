import { memo } from 'react';
import type { FleetPane, FleetRow } from '../../stores/selectors/fleet';
import { fleetRow, selectLatestCompletionEvidenceTask } from '../../stores/selectors/fleet';
import type { WorkTask } from '../../../shared/workTask';
import type { Task } from '../../../shared/types';
import { isVerifiedItem } from '../../../shared/completionEvidence';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import { useT } from '../../hooks/useT';
import { t } from '../../i18n';
import { useStore } from '../../stores';
import { IconCheck, IconChevronDir, IconExternalLink } from '../icons';
import { fleetTitle } from './fleetPresentation';
import { formatIdle, IDLE_SHOW_AFTER_MS } from '../../utils/idleTime';

interface FleetCardProps {
  card: FleetPane;
  focused: boolean;
  /** A2: card를 인자로 받는다 — 부모가 안정적인 단일 콜백(useCallback)을 그대로
   *  내릴 수 있어 memo(FleetCard)가 실효한다(카드마다 새 화살표 생성 회피). */
  onJump: (card: FleetPane) => void;
  /** S-C2 live output tail — last ~3 plaintext lines of this pane's buffer.
   *  Only meaningful for terminal cards with a ptyId; already plaintext. */
  tail?: string[];
  /** Section, detail and elapsed time from `groupFleetPanes`. Absent (tests,
   *  stand-alone renders) → derived from the card alone. */
  row?: FleetRow;
  /** Status differs from what Fleet showed when it was last closed. */
  changed?: boolean;
  onFocus?: () => void;
  /** TASK-6 — per-pane agent resource attribution: summed RAM (bytes) of this
   *  pane's shell + descendant tree, and the heaviest child's image name. Only
   *  present on Windows with a live agent; undefined ⇒ no chip. */
  resource?: { rss: number; image?: string };
}

// TASK-6 — a bare process image ("claude.exe", "node.exe") shortened to a human
// agent label for the chip. Falls back to the raw name minus a trailing .exe.
function agentLabel(image: string | undefined): string {
  if (!image) return t('fleet.agent');
  const base = image.replace(/\.exe$/i, '').toLowerCase();
  if (base === 'claude') return 'Claude';
  if (base === 'node') return 'Node';
  if (base === 'codex') return 'Codex';
  if (base === 'python' || base === 'python3') return 'Python';
  return image.replace(/\.exe$/i, '');
}

// TASK-6 — bytes → compact "370 MB" / "1.2 GB". Working-set is reported in
// bytes; the chip shows whole MB (or one decimal GB) so it reads at a glance.
function formatRss(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

/**
 * 사이클 C — fan-out 미션 라인(순수 prop-구동, 테스트 가능). 매칭 미션이 없으면
 * null(기존 카드 확장 — 신규 UI 표면 아님). status로 색·취소선을 인코딩한다.
 */
export function FleetCardMissionLine({ mission }: { mission: WorkTask | undefined }): React.ReactElement | null {
  if (!mission) return null;
  const isOpen = mission.status === 'open';
  return (
    <div
      className="flex items-center gap-1.5 min-w-0 text-[12px] font-mono"
      data-fleet-mission
      data-mission-status={mission.status}
      title={`Mission: ${mission.title} (${mission.status})`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ backgroundColor: isOpen ? 'var(--accent-green)' : 'var(--text-muted)' }}
      />
      <span className={`truncate ${isOpen ? 'text-[var(--text-sub)]' : 'text-[var(--text-muted)] line-through'}`}>
        {mission.title}
      </span>
    </div>
  );
}

/**
 * NB3 trust surface — completion-evidence badge (pure, prop-driven, testable).
 * Given the most recent COMPLETED A2A task addressed to this pane (resolved by
 * selectLatestCompletionEvidenceTask), it shows `✓ evidence n/m` where n is the
 * verified-item count (verifiedItemCount) and m the total evidence items — the
 * durable proof the agent left when it finished, made legible on the card. The
 * tooltip carries the detail (task title + evidence summary) so the on-card text
 * stays a single compact token. Renders null when the pane has no such task or
 * the task carries no evidence items (additive — never a new empty row).
 */
export function FleetCardEvidenceBadge({ task }: { task: Task | undefined }): React.ReactElement | null {
  if (!task) return null;
  const evidence = task.status.evidence;
  if (!evidence || evidence.items.length === 0) return null;
  const total = evidence.items.length;
  const verified = evidence.items.filter(isVerifiedItem).length;
  return (
    <span
      className="flex items-center gap-1 min-w-0 text-[12px] font-mono"
      data-fleet-evidence
      data-evidence-verified={verified}
      data-evidence-total={total}
      title={`Completion evidence — ${task.metadata.title}: ${evidence.summary} (${verified}/${total} verified)`}
    >
      {/* The check is green only when at least one item is actually verified —
          verified is a GRADE, not a gate (completionEvidence E9), so an all-
          unverified proof reads muted, not falsely reassuring. */}
      <span
        className="flex-shrink-0"
        style={{ color: verified > 0 ? 'var(--accent-green)' : 'var(--text-muted)' }}
        aria-hidden="true"
      >
        <IconCheck size={12} />
      </span>
      <span className="truncate text-[var(--text-muted)]">
        evidence {verified}/{total}
      </span>
    </span>
  );
}

/** Compact task row. Output belongs in the opt-in preview, not in every row. */
function FleetCard({ card, focused, onJump, resource, row: rowProp, changed, onFocus }: FleetCardProps) {
  const t = useT();
  const icon = AGENT_STATUS_ICON[card.agentStatus];
  const mission = useStore((s) => s.missionByPaneGroup[card.workspaceId]);
  const evidenceTask = useStore((s) =>
    selectLatestCompletionEvidenceTask(s.a2aTasks, card.workspaceId, card.paneId, card.isActivePane),
  );
  const displayName = fleetTitle(card, mission);
  const agentName = card.agentName || (card.surfaceType === 'terminal' ? card.title : card.surfaceType);
  const supervision = card.supervision;
  const supervisionStopped = supervision?.status === 'stopped';
  const supervisionLabel = supervision
    ? `${supervisionStopped ? 'supervision stopped' : 'supervised'}, ${supervision.restartCount} restart${
        supervision.restartCount === 1 ? '' : 's'
      }`
    : '';
  const row = rowProp ?? fleetRow(card);
  // A waiting pane with no question is idle, not a request for input.
  const isAwaitingInput = card.agentStatus === 'awaiting_input' || row.detailSource === 'question';
  // A waiting pane with no question sits in Idle; label and colour it as idle
  // so no red needs-you dot appears inside the Idle section.
  const quietWaiting = card.agentStatus === 'waiting' && row.section === 'idle';
  const statusLabel = card.unverifiable ? t('fleet.status.unconfirmed')
    : card.agentStatus === 'complete' ? t('fleet.status.turnComplete')
    : quietWaiting ? t('workspace.agentIdle') : t(icon.labelKey);
  // Unconfirmed reuses the sidebar's hollow amber ring (.sidebar-dot-unverifiable):
  // the pane still claims to be working, nothing backs the claim.
  const statusColor = card.unverifiable ? 'var(--accent-cursor)'
    : card.agentStatus === 'idle' || quietWaiting ? 'var(--text-sub)' : icon.dotVar;
  const detail = row.detail ?? t(row.detailKey);
  const elapsed = row.idleForMs !== undefined && row.idleForMs >= IDLE_SHOW_AFTER_MS
    ? formatIdle(row.idleForMs) : undefined;
  const action = isAwaitingInput ? t('fleet.action.respond')
    : card.agentStatus === 'complete' ? t('fleet.action.result')
    : card.agentStatus === 'error' || card.unverifiable || supervisionStopped ? t('fleet.action.inspect')
    : t('fleet.action.open');
  const showActivity = row.detailSource === 'activity';

  return (
    <button
      type="button"
      role="option"
      aria-selected={focused}
      aria-label={`${displayName}, ${statusLabel}, ${card.workspaceName}${card.remote ? `, ${card.remote.hostLabel}` : ''}${supervision ? `, ${supervisionLabel}` : ''}${changed ? `, ${t('fleet.changedSinceSeen')}` : ''}, ${detail}, ${action}`}
      tabIndex={focused ? 0 : -1}
      onFocus={onFocus}
      onClick={() => onJump(card)}
      data-fleet-card
      data-status={card.agentStatus}
      data-unverifiable={card.unverifiable || undefined}
      data-pty-id={card.ptyId}
      data-workspace-id={card.workspaceId}
      data-workspace-name={card.workspaceName}
      className="wmux-fleet-card"
    >
      <span className="wmux-fleet-status" style={{ color: statusColor }}>
        <span
          aria-hidden="true"
          className={`wmux-fleet-dot ${card.unverifiable ? 'is-unconfirmed' : icon.glowClass}`}
          data-shape={icon.shape}
          style={{ color: statusColor }}
        >{icon.shape === 'cross' ? '×' : null}</span>
        <span>{statusLabel}</span>
      </span>
      <span className="wmux-fleet-identity">
        <span className="wmux-fleet-name" title={displayName}>
          {card.remote && (
            // #1343 — origin glyph: this agent runs on another host. Identical
            // rendition to the sidebar roster's badge (#1163) so the same agent
            // reads the same in both rosters: steel, not accent (DESIGN.md — a
            // provenance marker must never spend an amber point), shape carries
            // the meaning, host name lives in the label and the tooltip.
            <span
              data-fleet-remote
              className="inline-flex mr-1 align-middle text-[var(--text-muted)]"
              title={`@${card.remote.hostLabel}`}
              aria-hidden="true"
            >
              <IconExternalLink size={10} />
            </span>
          )}
          {displayName}
          {changed && <span data-fleet-changed className="wmux-fleet-changed" aria-hidden="true" />}
        </span>
        <span className="wmux-fleet-context" title={card.cwd || card.workspaceName}>
          {displayName !== card.workspaceName && <span>{card.workspaceName}</span>}
          {agentName && agentName !== displayName && <span>{agentName}</span>}
          {card.stashed && <span>{t('fleet.stashed')}</span>}
          {resource && resource.rss > 0 && (
            <span data-fleet-resource data-rss-bytes={resource.rss} title={`${agentLabel(resource.image)}: ${formatRss(resource.rss)}`}>
              {formatRss(resource.rss)}
            </span>
          )}
          {supervision && (
            <span data-fleet-supervision data-supervision-status={supervision.status}
              style={{ color: supervisionStopped ? 'var(--accent-red)' : undefined }} title={supervisionLabel}>
              {`${supervisionStopped ? '⟳!' : '⟳'}${supervision.restartCount > 0 ? ` ${supervision.restartCount}` : ''}`}
            </span>
          )}
        </span>
      </span>
      <span className="wmux-fleet-progress">
        <span className={`wmux-fleet-detail${showActivity ? ' is-activity' : ''}`}
          data-fleet-activity={showActivity || undefined} title={detail}>{detail}</span>
        <span className="wmux-fleet-meta">
          {card.agentStatus === 'complete' && <FleetCardEvidenceBadge task={evidenceTask} />}
          {elapsed && <span data-fleet-elapsed>{elapsed}</span>}
        </span>
      </span>
      <span className="wmux-fleet-action" aria-hidden="true">
        <span>{action}</span><IconChevronDir dir="right" size={12} />
      </span>
    </button>
  );
}

export default memo(FleetCard);
