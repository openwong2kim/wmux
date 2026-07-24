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
import { ORCH_ROLES, bindingEnforcesModel } from '../../../shared/orchestratorRole';

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
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  const surfaceActivity = useStore((s) => s.surfaceActivity);
  const paneLabel = useStore((s) => s.paneLabel);
  const paneRole = useStore((s) => s.paneRole);
  const roleBindings = useStore((s) => s.orchestratorRoleBindings);

  const panes = useMemo(() => {
    const all = selectFleetPanes({ workspaces, surfaceAgentStatus, surfaceActivity, paneLabel });
    // Roster = live terminal panes of the ACTIVE workspace only (M1.5: the
    // deck is this workspace's orchestrator, so its roster is this
    // workspace's agents — the fleet-wide view lives in the titlebar vitals).
    // Browser/editor/diff surfaces and not-yet-spawned panes are not agents.
    return sortFleetPanes(
      all.filter(
        (p) =>
          p.ptyId !== '' && p.surfaceType === 'terminal' && p.workspaceId === activeWorkspaceId,
      ),
      'attention',
    );
  }, [workspaces, activeWorkspaceId, surfaceAgentStatus, surfaceActivity, paneLabel]);

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
          // Operator-assigned role (soft). A value set via MCP may be outside the
          // built-in vocabulary; surface it as an extra option so the <select>
          // never renders blank for a known-but-custom role.
          const role = paneRole[p.paneId] ?? '';
          const roleOptions = role && !(ORCH_ROLES as readonly string[]).includes(role)
            ? [role, ...ORCH_ROLES]
            : [...ORCH_ROLES];
          // D2 — the enforced agent/model for this role, shown as a muted
          // sub-label so the operator sees what a worker will actually launch as.
          // Gated on the binding REALLY injecting the model (bindingEnforcesModel),
          // the same gate the pane badge uses: a stored-but-inert binding gets no
          // chip here, because a chip reading "gemini · flash" is indistinguishable
          // from an enforced one while the launch is untouched. Settings is where
          // an inert row explains itself; this roster only states facts about the
          // launch. Consequence: an args-only binding shows no chip either.
          const binding = role ? roleBindings[role] : undefined;
          const bindingLabel = bindingEnforcesModel(binding)
            ? [binding?.agent, binding?.model].filter(Boolean).join(' · ')
            : '';
          return (
            // Row = flex container so the jump button and the role <select> are
            // SIBLINGS (a <select> cannot nest inside a <button>). No parent click
            // handler, so no stopPropagation needed — the select handles its own.
            <div
              key={`${p.workspaceId}:${p.paneId}`}
              data-deck-fleet-row
              className="group flex items-center gap-1 h-[26px] px-1 rounded-[4px]"
              // The needs-input wash is the ONE permitted area wash (DESIGN.md
              // attention grammar). color-mix so every theme's danger hue works.
              style={attention ? { backgroundColor: 'color-mix(in srgb, var(--accent-red) 9%, transparent)' } : undefined}
            >
              <button
                type="button"
                onClick={() => onJumpToPane(p.workspaceId, p.paneId)}
                title={`${rowLabel(p)} — ${p.workspaceName}`}
                className="flex-1 min-w-0 flex items-center gap-2 h-full text-left rounded-[4px] transition-colors hover:bg-[rgba(var(--bg-surface-rgb),0.6)]"
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
              {/* Operator-assigned role — soft routing hint the orchestrator reads.
                  Writes through MetadataStore (setRole) so it relays to the brain.
                  D2: when the role is bound, a muted agent·model chip sits INLINE
                  beside the select (not stacked — the row keeps its 26px density
                  contract) showing what an agent launched here will run as. Amber
                  stays reserved for alive+focus per DESIGN.md. */}
              {bindingLabel && (
                <span
                  className="shrink-0 font-mono text-[10px] leading-none text-[var(--text-muted)] max-w-[92px] truncate"
                  {...tokenAttrs('textMuted', 'text')}
                  title={t('deck.fleet.enforcedLaunch', { binding: bindingLabel })}
                >
                  {bindingLabel}
                </span>
              )}
              <select
                aria-label={`${rowLabel(p)} role`}
                value={role}
                onChange={(e) => {
                  void window.electronAPI?.metadata?.setRole?.(p.paneId, p.workspaceId, e.target.value);
                }}
                className="shrink-0 h-[18px] max-w-[84px] bg-transparent text-[10px] text-[var(--text-muted)] hover:text-[var(--text-main)] focus:text-[var(--text-main)] rounded-[3px] outline-none cursor-pointer"
                {...tokenAttrs('textMuted', 'text')}
                title="Preferred role — the orchestrator routes matching work here"
              >
                <option value="">role…</option>
                {roleOptions.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}
