import { memo } from 'react';
import type { FleetPane } from '../../stores/selectors/fleet';
import { selectLatestCompletionEvidenceTask } from '../../stores/selectors/fleet';
import type { WorkTask } from '../../../shared/workTask';
import type { Task } from '../../../shared/types';
import { isVerifiedItem } from '../../../shared/completionEvidence';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';

// Compact, scan-friendly cwd: keep the last two path segments. Mirrors the
// sidebar's shortenPath so the cockpit reads the same as the workspace rows.
function shortenPath(path: string, maxLen = 34): string {
  if (!path || path.length <= maxLen) return path;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `…/${parts.slice(-2).join('/')}`;
}

interface FleetCardProps {
  card: FleetPane;
  focused: boolean;
  /** A2: card를 인자로 받는다 — 부모가 안정적인 단일 콜백(useCallback)을 그대로
   *  내릴 수 있어 memo(FleetCard)가 실효한다(카드마다 새 화살표 생성 회피). */
  onJump: (card: FleetPane) => void;
  /** S-C2 live output tail — last ~3 plaintext lines of this pane's buffer.
   *  Only meaningful for terminal cards with a ptyId; already plaintext. */
  tail?: string[];
  /** TASK-6 — per-pane agent resource attribution: summed RAM (bytes) of this
   *  pane's shell + descendant tree, and the heaviest child's image name. Only
   *  present on Windows with a live agent; undefined ⇒ no chip. */
  resource?: { rss: number; image?: string };
}

// TASK-6 — a bare process image ("claude.exe", "node.exe") shortened to a human
// agent label for the chip. Falls back to the raw name minus a trailing .exe.
function agentLabel(image: string | undefined): string {
  if (!image) return 'agent';
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
      className="flex items-center gap-1.5 min-w-0 text-caption font-mono"
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
    <div
      className="flex items-center gap-1 min-w-0 text-caption font-mono"
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
      >
        ✓
      </span>
      <span className="truncate text-[var(--text-muted)]">
        evidence {verified}/{total}
      </span>
    </div>
  );
}

/**
 * One agent in the Fleet View grid. Status badge reuses AGENT_STATUS_ICON so the
 * cockpit stays in lockstep with the sidebar dots. awaiting_input — the
 * unattended-loop money state — gets a yellow border + "needs your input"
 * affordance so a blocked agent is unmissable. Click jumps to its pane.
 */
function FleetCard({ card, focused, onJump, tail, resource }: FleetCardProps) {
  const t = useT();
  const icon = AGENT_STATUS_ICON[card.agentStatus];
  // 사이클 C — 이 카드의 워크스페이스가 fan-out 태스크의 전용 워크스페이스
  // (paneGroupId)면 미션 title·status를 부가 표시한다. 좁은 셀렉터(자기
  // paneGroupId 항목만)라 다른 미션 변경엔 리렌더되지 않고, 매칭이 없으면
  // undefined(신규 UI 표면 없음 — 기존 카드 확장).
  const mission = useStore((s) => s.missionByPaneGroup[card.workspaceId]);
  // NB3 trust surface — the most recent completed A2A task with evidence
  // addressed to this pane (narrow, reference-stable read: the selector returns
  // the store's own Task object, so an unchanged winner is Object.is-equal and
  // never re-renders this memoized card). Undefined ⇒ no badge.
  const evidenceTask = useStore((s) =>
    selectLatestCompletionEvidenceTask(s.a2aTasks, card.workspaceId, card.paneId, card.isActivePane),
  );
  const isAwaitingInput = card.agentStatus === 'awaiting_input';
  const isIdle = card.agentStatus === 'idle';
  // P2: a user rename wins so the cockpit reflects the same name as the composer
  // / pane header; otherwise the existing agent name or surface title.
  const displayName = card.paneLabel || card.agentName || card.title || t('surface.terminal');
  // Hook-driven activity line (fleet-activity-line-hook). When present it is the
  // card's primary status text — a meaningful one-liner ("✎ fleet.ts") instead
  // of raw scrollback. The raw tail is the FALLBACK, shown only for terminals
  // that have NO activity (Codex / Gemini / plain shells, or a Claude pane
  // before its first PostToolUse). awaiting_input still wins the third row.
  const activity = card.activity?.trim() || undefined;
  const showTail =
    !activity && card.surfaceType === 'terminal' && !!tail && tail.length > 0;
  // X8 supervision chip: a declared/unattended agent shows it's armed (⟳, plus
  // the restart count once it has restarted) or that the runaway guard tripped
  // (⟳! red — the supervisor gave up, a human is needed). Mirrors the pane badge
  // so the cockpit reads the same as the pane header. Absent → no chip.
  const supervision = card.supervision;
  const supervisionStopped = supervision?.status === 'stopped';
  const supervisionLabel = supervision
    ? `${supervisionStopped ? 'supervision stopped' : 'supervised'}, ${supervision.restartCount} restart${
        supervision.restartCount === 1 ? '' : 's'
      }`
    : '';

  return (
    <button
      type="button"
      role="option"
      aria-selected={focused}
      aria-label={`${displayName}, ${t(icon.labelKey)}, ${card.workspaceName}${supervision ? `, ${supervisionLabel}` : ''}`}
      tabIndex={focused ? 0 : -1}
      onClick={() => onJump(card)}
      data-fleet-card
      data-status={card.agentStatus}
      data-pty-id={card.ptyId}
      data-workspace-id={card.workspaceId}
      data-workspace-name={card.workspaceName}
      className="group text-left flex flex-col gap-1.5 rounded-lg p-3 transition-[transform,box-shadow,border-color,background-color] duration-150 cursor-pointer outline-none hover:-translate-y-px hover:shadow-[0_2px_8px_rgba(0,0,0,0.25)] motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: `1px solid ${
          focused ? 'var(--accent-blue)' : isAwaitingInput ? 'var(--accent-yellow)' : 'var(--bg-overlay)'
        }`,
        boxShadow: focused ? '0 0 0 1px var(--accent-blue)' : undefined,
        opacity: isIdle ? 0.62 : 1,
      }}
      title={card.cwd ? `${card.workspaceName} · ${card.cwd}` : card.workspaceName}
    >
      {/* Header: status dot + name + status label */}
      <div className="flex items-center gap-2 min-w-0">
        <span
          className={`w-2 h-2 rounded-full flex-shrink-0 ${icon.glowClass}`}
          style={{ backgroundColor: icon.dotVar }}
        />
        <span className="flex-1 min-w-0 truncate text-body font-medium text-[var(--text-main)]">
          {displayName}
        </span>
        {supervision && (
          <span
            data-fleet-supervision
            data-supervision-status={supervision.status}
            className="flex-shrink-0 text-[10px] font-mono"
            style={{ color: supervisionStopped ? 'var(--accent-red)' : 'var(--text-subtle)' }}
            title={supervisionLabel}
          >
            {`${supervisionStopped ? '⟳!' : '⟳'}${supervision.restartCount > 0 ? ` ${supervision.restartCount}` : ''}`}
          </span>
        )}
        <span className="flex-shrink-0 text-[10px] font-mono" style={{ color: icon.dotVar }}>
          {t(icon.labelKey)}
        </span>
      </div>

      {/* Context line: workspace · cwd */}
      <div className="flex items-center gap-1.5 min-w-0 text-caption font-mono text-[var(--text-muted)]">
        <span className="truncate max-w-[48%]" title={card.workspaceName}>{card.workspaceName}</span>
        {card.cwd && (
          <>
            <span className="opacity-50">·</span>
            <span className="truncate flex-1" title={card.cwd}>{shortenPath(card.cwd)}</span>
          </>
        )}
      </div>

      {/* TASK-6 — per-pane agent resource chip. Quiet mono token (no new accent —
          DESIGN.md restraint): "Claude · 370 MB". Present only on Windows with a
          live descendant agent (resource.rss > 0); undefined / zero ⇒ no row. */}
      {resource && resource.rss > 0 && (
        <div
          data-fleet-resource
          data-rss-bytes={resource.rss}
          className="flex items-center gap-1 min-w-0 text-caption font-mono text-[var(--text-muted)]"
          title={`${agentLabel(resource.image)} — ${formatRss(resource.rss)} resident (shell + descendants)`}
        >
          <span className="truncate">
            {agentLabel(resource.image)} · {formatRss(resource.rss)}
          </span>
        </div>
      )}

      {/* 사이클 C — 미션 라인(순수 prop-구동 서브컴포넌트). 이 카드가 fan-out
          태스크의 워크스페이스면 title + status를 부가 표시(매칭 없으면 null). */}
      <FleetCardMissionLine mission={mission} />

      {/* NB3 trust surface — completion-evidence badge for the pane's most
          recent completed A2A task (null when none). Sits under the mission line
          because both describe delegated work; subordinate to the header. */}
      <FleetCardEvidenceBadge task={evidenceTask} />

      {/* Affordance row — only when there is something worth a third line. */}
      {isAwaitingInput ? (
        <div className="text-caption font-medium" style={{ color: 'var(--accent-yellow)' }}>
          ⏸ {t('fleet.needsYourInput')}
        </div>
      ) : card.surfaceType !== 'terminal' ? (
        <div className="text-caption font-mono text-[var(--text-subtle)] capitalize">
          {card.surfaceType}
        </div>
      ) : null}

      {/* Hook-driven activity line — the deterministic "what is it doing" string
          (PostToolUse → summarizeActivity in main). Single truncated row so a
          long path/command can never widen the card. Shown for any non-awaiting
          card that has activity (the affordance owns the row when awaiting
          input); it REPLACES the raw tail (showTail is false whenever activity
          is present). data-fleet-activity exposes it for dogfood/tests. */}
      {!isAwaitingInput && activity && (
        <div
          data-fleet-activity
          className="block truncate font-mono text-caption leading-tight"
          style={{ color: 'var(--text-subtle)' }}
          title={activity}
        >
          {activity}
        </div>
      )}

      {/* S-C2 live output tail — last ~3 lines of the pane's buffer. Already
          plaintext (no xterm renderer needed); subordinate to the header. Each
          line is its own truncated row so a long line can never widen / break
          the card. Hidden entirely when there is no terminal output to show, OR
          when the hook-driven activity line above is present (its fallback). */}
      {showTail && (
        <div
          className="mt-0.5 flex flex-col font-mono text-[10px] leading-tight overflow-hidden"
          style={{ color: 'var(--text-subtle)' }}
          aria-hidden="true"
        >
          {tail.map((line, i) => (
            <span key={i} className="block truncate whitespace-pre">
              {line || ' '}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

// A2: 그리드 자식 memo 방벽. 부모(FleetView)가 함대 갱신마다 리렌더돼도 이 카드의
// props(card·focused·onJump·tail)가 참조상 같으면 리렌더를 건너뛴다. card/tail은
// fleet 셀렉터가 값이 바뀐 pane에 대해서만 새 참조를 만들므로 얕은 비교로 실효.
export default memo(FleetCard);
