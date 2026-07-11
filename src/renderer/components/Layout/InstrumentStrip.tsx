import { useMemo, useCallback } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { tokenAttrs } from '../../themes';
import {
  selectFleetPanes,
  sortFleetPanes,
  countNeedsAttention,
} from '../../stores/selectors/fleet';

/**
 * Bridge P2② — the bottom instrument strip (Codex status-line pattern,
 * DESIGN.md "Layout Contract"). A full-width 24px mono rail that keeps the
 * fleet's vital signs visible regardless of which workspace/tab is focused:
 *
 *   orchestrator model · [busy spinner]        N running · N need you
 *
 * 24px (not the 36px chrome module) is the documented deviation: this is a
 * dense instrument rail, not an interactive chrome row — DESIGN.md pins the
 * footer at 24px. Only REAL signals render: no approval/ctx% until those
 * numbers actually exist in the renderer store (no fake gauges).
 *
 * Attention grammar: the red "N need you" chip here + the roster row wash in
 * DeckFleet are the two permitted renditions of needs-input. Clicking the
 * chip jumps to the most urgent pane.
 */
export default function InstrumentStrip() {
  const t = useT();
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  const surfaceActivity = useStore((s) => s.surfaceActivity);
  const brainStatus = useStore((s) => s.brainStatus);
  const deckBrainModel = useStore((s) => s.deckBrainModel);
  const setActiveWorkspace = useStore((s) => s.setActiveWorkspace);
  const setActivePane = useStore((s) => s.setActivePane);

  const panes = useMemo(
    () =>
      sortFleetPanes(
        selectFleetPanes({ workspaces, surfaceAgentStatus, surfaceActivity }).filter(
          (p) => p.ptyId !== '' && p.surfaceType === 'terminal',
        ),
        'attention',
      ),
    [workspaces, surfaceAgentStatus, surfaceActivity],
  );
  const running = panes.filter((p) => p.agentStatus === 'running').length;
  const needsYou = countNeedsAttention(panes);
  const brainBusy = brainStatus === 'busy';

  // Jump to the most urgent pane (roster is attention-sorted; index 0 is it).
  const jumpToUrgent = useCallback(() => {
    const target = panes[0];
    if (!target) return;
    setActiveWorkspace(target.workspaceId);
    setActivePane(target.paneId);
  }, [panes, setActiveWorkspace, setActivePane]);

  return (
    <div
      data-instrument-strip
      className="flex items-center h-6 shrink-0 font-mono text-[10.5px] text-[var(--text-muted)] select-none bg-[var(--bg-mantle)]"
      style={{ boxShadow: 'inset 0 1px 0 var(--border-soft)' }}
      {...tokenAttrs('bgMantle', 'bg')}
      {...tokenAttrs('textMuted', 'text')}
    >
      {/* Orchestrator model — the one amber instrument on this rail. */}
      <span className="flex items-center gap-1.5 px-3 h-full" style={{ boxShadow: 'inset -1px 0 0 var(--border-soft)' }}>
        <span {...tokenAttrs('textMuted', 'text')}>{t('deck.commander') || 'Orchestrator'}</span>
        <span className="text-[var(--accent-blue)]" {...tokenAttrs('accent', 'text')}>
          {deckBrainModel || 'default'}
        </span>
      </span>
      {brainBusy && (
        <span className="flex items-center gap-1.5 px-3 h-full" data-instrument-busy>
          <span
            aria-hidden="true"
            className="inline-block w-2 h-2 rounded-full border-[1.5px] border-[var(--accent-blue)] border-t-transparent animate-spin"
          />
          {t('deck.commanderThinking') || 'Orchestrator is working…'}
        </span>
      )}
      <span className="flex-1" />
      {/* Fleet vitals — right-aligned, evidence one click away. */}
      <span className="flex items-center gap-1.5 px-3 h-full" data-instrument-running>
        <span
          aria-hidden="true"
          className="w-[6px] h-[6px] rounded-full"
          style={{ backgroundColor: running > 0 ? 'var(--accent-cursor)' : 'var(--text-muted)' }}
        />
        {(t('strip.running') || '{count} running').replace('{count}', String(running))}
      </span>
      {needsYou > 0 && (
        <button
          type="button"
          data-instrument-needs
          onClick={jumpToUrgent}
          className="flex items-center gap-1.5 px-3 h-full font-semibold text-[var(--accent-red)] hover:bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors"
          style={{ boxShadow: 'inset 1px 0 0 var(--border-soft)' }}
          title={t('strip.needsYouTooltip') || 'Jump to the pane that needs you'}
          {...tokenAttrs('danger', 'text')}
        >
          <span aria-hidden="true" className="w-[6px] h-[6px] rounded-full bg-[var(--accent-red)]" />
          {(t('strip.needsYou') || '{count} need you').replace('{count}', String(needsYou))}
        </button>
      )}
    </div>
  );
}
