// Trust seam (plan PR-7, PRD §4.2 / G6).
//
// The persistent declaration that Chat View is a PROJECTION and the terminal is
// the ground truth, plus the jump back. 11px mono footer: quiet at rest, warm
// (`--accent`) when the projection is known to lag the PTY. The arrow is a
// navigation affordance, so it is steel-blue — never amber.

import React from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';

export interface TrustSeamProps {
  /** Transcript file basename from TranscriptStatus; absent → generic wording. */
  transcriptBasename?: string;
  /** Projection freshness lags the PTY (fed by the integration wave). */
  stale?: boolean;
  onJumpToTerminal: () => void;
}

export function TrustSeam({
  transcriptBasename,
  stale,
  onJumpToTerminal,
}: TrustSeamProps): React.ReactElement {
  const t = useT();
  const text = stale
    ? t('chat.trustSeamStale')
    : transcriptBasename
      ? t('chat.trustSeam', { basename: transcriptBasename })
      : t('chat.trustSeamNoFile');

  return (
    <div
      className="flex items-baseline gap-2 px-3 py-1 text-[11px] font-mono"
      data-chat-trust-seam
      data-chat-trust-stale={stale ? '1' : undefined}
      style={{ boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-main) 6%, transparent)' }}
    >
      <span
        className="truncate"
        style={{ color: stale ? 'var(--accent)' : 'var(--text-muted)' }}
      >
        {text}
      </span>
      <button
        type="button"
        data-chat-jump-terminal
        onClick={onJumpToTerminal}
        title={t('chat.jumpToTerminal')}
        aria-label={t('chat.jumpToTerminal')}
        className={`text-[var(--accent-blue)] hover:opacity-80 transition-opacity ${FOCUS_RING}`}
      >
        →
      </button>
    </div>
  );
}

export default TrustSeam;
