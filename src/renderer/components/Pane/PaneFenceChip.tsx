// Pane-header chip for a tab opted into the worker fence (utils/paneFence.ts).
// Lives in the tab strip's flow beside the usage-limit and stuck chips, never
// a new row. A label, not a control: the switch is in the pane menu.
//   - on:       a muted lock and "Fenced";
//   - pending:  the switch moved under a running agent, which keeps the state
//               it started with: muted "Fence: next launch";
//   - refused:  main did not start a fenced launch: "Fence refused" in
//               --accent-red, the reason in the tooltip.
// Colour carries the refusal only; nothing else is coloured, no wash.
import { useEffect } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { IconLock } from '../icons';
import type { Surface } from '../../../shared/types';
import { assertTabWorkerFence } from '../../utils/paneFence';

export type PaneFenceChipState =
  | { kind: 'none' }
  | { kind: 'on' }
  | { kind: 'pending'; on: boolean }
  | { kind: 'refused'; reason: string };

/** What the chip shows for a tab. Pure. */
export function paneFenceChipState(on: boolean, notice: { kind: 'pending' } | { kind: 'refused'; reason: string } | undefined): PaneFenceChipState {
  if (notice?.kind === 'refused') return { kind: 'refused', reason: notice.reason };
  if (notice?.kind === 'pending') return { kind: 'pending', on };
  return on ? { kind: 'on' } : { kind: 'none' };
}

export default function PaneFenceChip({ surface }: { surface: Pick<Surface, 'ptyId' | 'workerFence' | 'surfaceType'> | undefined }) {
  const t = useT();
  const ptyId = surface?.ptyId || '';
  const terminal = !!surface && (!surface.surfaceType || surface.surfaceType === 'terminal');
  const on = terminal && surface?.workerFence === true;
  const notice = useStore((s) => (ptyId ? s.paneFenceNotice[ptyId] : undefined));
  const agentRunning = useStore((s) => (ptyId ? s.surfaceAgent[ptyId] !== undefined : false));
  // main's record follows the tab's switch (once per app run).
  useEffect(() => { if (on && ptyId) assertTabWorkerFence(ptyId); }, [on, ptyId]);
  // The running agent that kept the old state is gone: the switch is in force.
  useEffect(() => {
    if (notice?.kind === 'pending' && !agentRunning && ptyId) useStore.getState().setPaneFenceNotice(ptyId, null);
  }, [notice, agentRunning, ptyId]);
  if (!terminal) return null;
  const state = paneFenceChipState(on, notice);
  if (state.kind === 'none') return null;
  const title = state.kind === 'refused'
    ? t('paneFence.refusedTitle', { reason: state.reason })
    : state.kind === 'pending'
      ? t(state.on ? 'paneFence.pendingOnTitle' : 'paneFence.pendingOffTitle')
      : t('paneFence.chipTitle');
  const word = state.kind === 'refused' ? t('paneFence.refused') : state.kind === 'pending' ? t('paneFence.pending') : t('paneFence.chip');
  return (
    <span
      data-pane-fence={state.kind}
      className="shrink min-w-0 overflow-hidden flex items-center gap-1 px-1 h-6 text-[11px] text-[var(--text-muted)] select-none"
      role="img"
      title={title}
      aria-label={title}
    >
      {state.kind !== 'refused' && <span className="shrink-0 flex items-center" aria-hidden="true"><IconLock size={11} /></span>}
      <span className={`truncate ${state.kind === 'refused' ? 'text-[var(--accent-red)]' : ''}`} aria-hidden="true">{word}</span>
    </span>
  );
}
