import { useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import {
  selectFleetPanes,
  sortFleetPanes,
  type FleetPane,
} from '../../stores/selectors/fleet';
import type { AgentStatus } from '../../../shared/types';
import { shellDisplayName } from '../../utils/ptyCreateOptions';

/**
 * Bridge P2① — the Fleet roster inside the deck's Orchestrator tab.
 *
 * Mission-control unification (DESIGN.md "Layout Contract"): the agents, the
 * brain that commands them, and their channels are ONE system, so the roster
 * lives directly above the orchestrator thread instead of on the opposite
 * window edge. Each row: status dot + agent/pane name + the hook-driven mono
 * activity line + a jump affordance (every claim one click from its pane).
 *
 * Data is the existing S-C1 fleet derivation — no new plumbing. The roster
 * shows only panes with a live PTY (an unspawned pane is not an agent),
 * attention-sorted so "needs you" floats to the top. No silent cap: the
 * section scrolls past ~5 rows.
 */

/** DESIGN.md status-dot vocabulary: amber=running, green=ok, gray=idle, red=needs input. */
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

function rowLabel(p: FleetPane): string {
  if (p.paneLabel) return p.paneLabel;
  if (p.agentName) return p.agentName;
  // Plain shells carry the full exe path as their title — humanize it
  // ("C:\...\powershell.exe" → "PowerShell") like the pane tabs do.
  if (p.title) return p.title.includes('\\') || p.title.includes('/') ? shellDisplayName(p.title) : p.title;
  return 'shell';
}

/** Cheap fallback when the pane's agent emits no PostToolUse hooks. */
function activityLine(p: FleetPane, t: (k: string) => string): string {
  if (p.activity) return p.activity;
  if (p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting') {
    return t('deck.fleetNeedsInput') || 'needs your input';
  }
  return p.agentStatus;
}

export default function DeckFleet({
  onJumpToPane,
}: {
  onJumpToPane: (workspaceId: string, paneId: string) => void;
}) {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  const surfaceActivity = useStore((s) => s.surfaceActivity);
  const paneLabel = useStore((s) => s.paneLabel);

  const panes = useMemo(() => {
    const all = selectFleetPanes({ workspaces, surfaceAgentStatus, surfaceActivity, paneLabel });
    // Roster = live terminal panes only (browser/editor/diff surfaces and
    // not-yet-spawned panes are not agents).
    return sortFleetPanes(
      all.filter((p) => p.ptyId !== '' && p.surfaceType === 'terminal'),
      'attention',
    );
  }, [workspaces, surfaceAgentStatus, surfaceActivity, paneLabel]);

  if (panes.length === 0) return null;

  return (
    <div
      data-deck-fleet
      className="shrink-0 px-3 pt-2.5 pb-1.5 border-b border-[var(--bg-surface)]"
      style={{ borderColor: 'var(--border-soft)' }}
      {...tokenAttrs('bgSurface', 'border')}
    >
      <div className="flex items-baseline px-1 pb-1">
        <span
          className="text-[10px] font-semibold uppercase tracking-[0.09em] text-[var(--text-muted)]"
          {...tokenAttrs('textMuted', 'text')}
        >
          {(t('deck.fleetLabel') || 'Fleet')} · {panes.length}
        </span>
        {/* Needs-attention summary lives on the titlebar vitals chip; here the
            row wash is the rendition (attention = max 2 per DESIGN.md). */}
      </div>
      <div className="max-h-44 overflow-y-auto">
        {panes.map((p) => {
          const attention = p.agentStatus === 'awaiting_input' || p.agentStatus === 'waiting';
          return (
            <button
              key={`${p.workspaceId}:${p.paneId}`}
              type="button"
              data-deck-fleet-row
              onClick={() => onJumpToPane(p.workspaceId, p.paneId)}
              title={`${rowLabel(p)} — ${p.workspaceName}`}
              className="group w-full flex items-center gap-2 h-[26px] px-1 rounded-[4px] text-left transition-colors hover:bg-[rgba(var(--bg-surface-rgb),0.6)]"
              // The needs-input wash is the ONE permitted area wash (DESIGN.md
              // attention grammar). color-mix so every theme's danger hue works.
              style={attention ? { backgroundColor: 'color-mix(in srgb, var(--accent-red) 9%, transparent)' } : undefined}
            >
              <span
                aria-hidden="true"
                className="w-[7px] h-[7px] rounded-full shrink-0"
                style={{ backgroundColor: dotColor(p.agentStatus) }}
              />
              <span
                className="text-[12px] font-medium text-[var(--text-main)] shrink-0 max-w-[45%] truncate"
                {...tokenAttrs('textMain', 'text')}
              >
                {rowLabel(p)}
              </span>
              <span
                className={`flex-1 min-w-0 truncate font-mono text-[10px] ${
                  attention ? 'text-[var(--accent-red)]' : 'text-[var(--text-muted)]'
                }`}
                {...tokenAttrs('textMuted', 'text')}
              >
                {activityLine(p, t)}
              </span>
              {/* Jump affordance — muted at rest, accent on hover (DESIGN.md). */}
              <span
                aria-hidden="true"
                className="shrink-0 font-mono text-[11px] text-[var(--text-muted)] group-hover:text-[var(--accent-blue)]"
              >
                →
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
