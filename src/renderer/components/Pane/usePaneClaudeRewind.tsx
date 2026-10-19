// Pane actions menu → "Rewind…" for a terminal pane running Claude Code.
//
// Opens Claude's own Rewind picker (its double ESC) through the daemon, which
// refuses unless Claude is idle with an empty composer (openClaudeRewind.ts).
// The picker itself is Claude's: the user picks a point and confirms there.

import { useCallback, useMemo } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useDaemonModeActive } from '../../hooks/useDaemonMode';
import { IconClock } from '../icons';
import type { PaneActionItem } from './PaneActionsMenu';
import { terminalRegistry } from '../../hooks/useTerminal';
import { xtermKittyFlags } from '../../terminal/kittyKeyboard';
import type { ClaudeRewindResult } from '../../../shared/transcript/turnEvents';
import { agentRow } from '../../../shared/agentIdentity';

export const PANE_CLAUDE_REWIND_KEY = 'claude-rewind';

/** Daemon refusal → message key. */
const REFUSAL_KEYS: Record<Exclude<ClaudeRewindResult, 'opened'>, string> = {
  busy: 'pane.rewindBusy',
  draft: 'pane.rewindDraft',
  blocked: 'pane.rewindBlocked',
  retry: 'pane.rewindRetry',
  unavailable: 'pane.rewindUnavailable',
  error: 'pane.rewindUnavailable',
};

export function usePaneClaudeRewind(opts: {
  ptyId: string | undefined;
  /** False for a read-only mirror, whose ptyIds are not this main's panes. */
  allowed: boolean;
}): PaneActionItem[] {
  const { ptyId, allowed } = opts;
  const t = useT();
  const daemon = useDaemonModeActive();
  const isClaude = useStore((s) => (ptyId ? !!agentRow(s.surfaceAgent[ptyId]?.slug)?.rewindPicker : false));
  const ready = allowed && daemon && isClaude && !!ptyId && !!window.electronAPI?.chat?.rewind;

  const rewind = useCallback(async () => {
    const api = window.electronAPI?.chat;
    if (!api?.rewind || !ptyId) return;
    let result: ClaudeRewindResult;
    // Escape as this pane's keys are encoded now (useTerminal's Escape path): CSI-u once its app pushed kitty flags.
    const term = terminalRegistry.get(ptyId);
    const kitty = !!term && term.options.vtExtensions?.kittyKeyboard === true && (xtermKittyFlags(term) ?? 0) > 0;
    try { result = (await api.rewind({ ptyId, kitty })).result; } catch { result = 'error'; }
    if (result === 'opened') {
      // The picker takes arrow keys and Enter: hand the keyboard to the terminal.
      requestAnimationFrame(() => { terminalRegistry.get(ptyId)?.focus(); });
      return;
    }
    useStore.getState().pushToast({ level: result === 'error' ? 'error' : 'warn', message: t(REFUSAL_KEYS[result] ?? 'pane.rewindUnavailable') });
  }, [ptyId, t]);

  return useMemo(() => (ready ? [{
    key: PANE_CLAUDE_REWIND_KEY,
    label: t('pane.rewind'),
    title: t('pane.rewindHint'),
    icon: <IconClock size={14} />,
    onSelect: () => { void rewind(); },
  }] : []), [ready, rewind, t]);
}
