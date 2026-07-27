// Diff-shaped tool output (plan PR-7, PRD §4.2).
//
// A diff NEVER renders inline in Chat View — it opens the existing
// workspace-diff surface. This keeps the "no IDE creep" non-goal intact and
// satisfies DESIGN.md's "every claim is one click from its evidence": the chip
// IS the jump affordance.

import React from 'react';
import type { ToolResultEvent } from '../../../shared/transcript/turnEvents';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';

export interface DiffChipProps {
  event: ToolResultEvent;
  /** Opens the workspace-diff surface for this result. Absent → inert chip. */
  onOpenDiff?: (eventId: string) => void;
}

export function DiffChip({ event, onOpenDiff }: DiffChipProps): React.ReactElement {
  const t = useT();
  return (
    <button
      type="button"
      data-chat-diff-chip={event.id}
      disabled={!onOpenDiff}
      onClick={() => onOpenDiff?.(event.id)}
      className={`self-start inline-flex items-baseline gap-1.5 rounded-[5px] px-1.5 py-0.5 text-[11px] font-mono text-[var(--text-muted)] hover:text-[var(--accent-blue)] disabled:hover:text-[var(--text-muted)] transition-colors ${FOCUS_RING}`}
      title={t('chat.openDiff')}
    >
      <span aria-hidden="true">⟨</span>
      <span>{t('chat.diffChip', { bytes: event.bytes })}</span>
      <span aria-hidden="true">⟩</span>
      <span className="text-[var(--accent-blue)]" aria-hidden="true">→</span>
    </button>
  );
}

export default DiffChip;
