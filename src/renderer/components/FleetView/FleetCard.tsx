import type { FleetPane } from '../../stores/selectors/fleet';
import { AGENT_STATUS_ICON } from '../Sidebar/agentStatusIcon';
import { useT } from '../../hooks/useT';

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
  onJump: () => void;
  /** S-C2 live output tail — last ~3 plaintext lines of this pane's buffer.
   *  Only meaningful for terminal cards with a ptyId; already plaintext. */
  tail?: string[];
}

/**
 * One agent in the Fleet View grid. Status badge reuses AGENT_STATUS_ICON so the
 * cockpit stays in lockstep with the sidebar dots. awaiting_input — the
 * unattended-loop money state — gets a yellow border + "needs your input"
 * affordance so a blocked agent is unmissable. Click jumps to its pane.
 */
export default function FleetCard({ card, focused, onJump, tail }: FleetCardProps) {
  const t = useT();
  const icon = AGENT_STATUS_ICON[card.agentStatus];
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
      onClick={onJump}
      data-fleet-card
      data-status={card.agentStatus}
      data-pty-id={card.ptyId}
      data-workspace-id={card.workspaceId}
      data-workspace-name={card.workspaceName}
      className="group text-left flex flex-col gap-1.5 rounded-lg p-3 transition-colors cursor-pointer outline-none hover:border-[var(--accent-blue)]"
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
        <span className="flex-1 min-w-0 truncate text-[13px] font-medium text-[var(--text-main)]">
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
      <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-mono text-[var(--text-muted)]">
        <span className="truncate max-w-[48%]" title={card.workspaceName}>{card.workspaceName}</span>
        {card.cwd && (
          <>
            <span className="opacity-50">·</span>
            <span className="truncate flex-1" title={card.cwd}>{shortenPath(card.cwd)}</span>
          </>
        )}
      </div>

      {/* Affordance row — only when there is something worth a third line. */}
      {isAwaitingInput ? (
        <div className="text-[11px] font-medium" style={{ color: 'var(--accent-yellow)' }}>
          ⏸ {t('fleet.needsYourInput')}
        </div>
      ) : card.surfaceType !== 'terminal' ? (
        <div className="text-[11px] font-mono text-[var(--text-subtle)] capitalize">
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
          className="block truncate font-mono text-[11px] leading-tight"
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
