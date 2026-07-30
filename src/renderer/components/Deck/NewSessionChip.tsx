// ─── Command Deck — "New session" chip ──────────────────────────────────────
//
// Replaces this workspace's orchestrator with a fresh one: the live brain is
// disposed (interrupting an in-flight turn) and its persisted session id is
// dropped, so the next turn starts a brand-new conversation instead of
// resuming. The whole main-process path already existed
// (DECK_CONVERSATION_CLEAR); this is the affordance that reaches it.
//
// Why the deck needs it at all: the commander session id is persisted
// precisely so a relaunch RESUMES the same conversation, so restarting wmux
// does NOT hand you a fresh orchestrator. Short of deleting the workspace —
// which takes its whole pane tree with it — there was no way to get one.
// Quitting the terminal brain's TUI does not do it either: the next turn
// respawns with `--resume`, giving a new process on the SAME conversation,
// which is easy to mistake for a reset.
//
// Named for what it produces, not for what it destroys. "Reset" has no object
// (the deck has a loop, schedules, a mode, a transcript, panes — all resettable
// in principle) and "restart" already means a PANE restart in wmux's vocabulary
// (pane.restarted / supervision armed|stopped), so either would invite "did it
// restart my panes?". Nothing outside the conversation is touched: panes,
// worktrees, the #commander transcript, durable memory, policy, mode, loops and
// schedules all survive.
//
// Self-contained like AgentModeChip / DeckLoopPanel: all IPC goes through the
// injected `api`, defaulting to window.electronAPI.deck in the container, and
// it renders nothing when the preload is absent so pure jsdom tests of the
// parent view are unaffected.

import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenAttrs } from '../../themes';
import { FOCUS_RING } from '../focusRing';

export interface NewSessionApi {
  /** Dispose the live brain and drop its persisted session id. */
  clear: (workspaceId: string) => Promise<{ ok: boolean; code?: string }>;
  /**
   * Take one turn now. Fired right after a successful clear so the operator
   * gets a fresh orchestrator that has ALREADY looked around (it re-reads
   * pane_list with no stale assumptions) instead of an empty dock.
   *
   * Load-bearing since the terminal brain became the default: clearing kills
   * its embedded pty, which retracts the terminal and drops the deck out of the
   * pty layout — where the composer does not exist. Without this the operator
   * is left staring at a dock with no brain and no obvious way to start one.
   */
  wake: (workspaceId: string) => Promise<{ ok: boolean; code?: string }>;
}

export interface NewSessionChipProps {
  workspaceId: string;
  api: NewSessionApi;
  /**
   * Whether a turn is streaming. Deliberately NOT used to disable the chip:
   * "the brain is stuck in a bad turn" is the single most common reason to want
   * a fresh one, and disabling it exactly then would be backwards. It only
   * changes the wording, so the operator knows the click interrupts.
   */
  busy?: boolean;
  t?: (key: string) => string;
}

/** How long the armed state waits for the second click before disarming. */
const ARM_TIMEOUT_MS = 4000;

export function NewSessionChip({
  workspaceId,
  api,
  busy = false,
  t,
}: NewSessionChipProps): React.ReactElement | null {
  const [armed, setArmed] = useState(false);
  const [running, setRunning] = useState(false);
  const disarmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const label = t?.('deck.newSession') || 'New session';
  const confirmLabel = busy
    ? t?.('deck.newSessionConfirmBusy') || 'Interrupt & start new session?'
    : t?.('deck.newSessionConfirm') || 'Start a new session?';

  const clearDisarm = useCallback(() => {
    if (disarmTimer.current) {
      clearTimeout(disarmTimer.current);
      disarmTimer.current = null;
    }
  }, []);

  // An armed control that stays armed forever is a trap for the next click that
  // lands anywhere near it. Time it out, and never leave a timer behind.
  useEffect(() => clearDisarm, [clearDisarm]);
  // Switching workspaces must not carry an arming intent to a DIFFERENT
  // orchestrator — that is precisely the misclick the two-step exists to stop.
  useEffect(() => {
    setArmed(false);
    clearDisarm();
  }, [workspaceId, clearDisarm]);

  const disarm = useCallback(() => {
    setArmed(false);
    clearDisarm();
  }, [clearDisarm]);

  const onClick = useCallback(() => {
    if (running) return;
    if (!armed) {
      setArmed(true);
      clearDisarm();
      disarmTimer.current = setTimeout(() => setArmed(false), ARM_TIMEOUT_MS);
      return;
    }
    disarm();
    setRunning(true);
    void (async () => {
      try {
        const res = await api.clear(workspaceId);
        // Only wake a clear that actually happened. Waking a failed clear would
        // spin the OLD conversation back up and read as "the button did
        // nothing, twice".
        if (res?.ok) {
          await api.wake(workspaceId).catch(() => {
            /* best-effort: a busy/rejected wake still leaves a fresh brain
               ready for the operator's next message */
          });
        }
      } catch {
        /* the deck surfaces brain errors on its own stream; a failed clear
           leaves the existing conversation untouched, which is the safe end */
      } finally {
        setRunning(false);
      }
    })();
  }, [armed, running, api, workspaceId, disarm, clearDisarm]);

  if (!workspaceId) return null;

  return (
    <button
      type="button"
      data-deck-new-session
      data-armed={armed ? 'true' : 'false'}
      disabled={running}
      onClick={onClick}
      onBlur={disarm}
      onMouseLeave={disarm}
      aria-label={armed ? confirmLabel : label}
      title={
        armed
          ? confirmLabel
          : t?.('deck.newSessionTooltip') ||
            'Replace this workspace’s orchestrator with a fresh session. Panes, worktrees and the conversation history stay; loops and schedules keep running.'
      }
      // Neutral at rest like the other AI-directed controls on this bar
      // (DESIGN.md: AI-directed actions stay neutral at rest) — nothing is
      // destroyed by arming. Red only once ARMED, which is the one click that
      // commits: DESIGN.md reserves solid red for the final confirm.
      className={
        armed
          ? `px-2.5 py-1 rounded-md text-[12px] font-semibold text-[var(--accent-red)] bg-[rgba(var(--bg-surface-rgb),0.6)] transition-colors disabled:opacity-40 ${FOCUS_RING}`
          : `px-2.5 py-1 rounded-md text-[12px] font-semibold text-[var(--text-sub)] bg-[rgba(var(--bg-surface-rgb),0.6)] hover:text-[var(--accent-amber)] transition-colors disabled:opacity-40 ${FOCUS_RING}`
      }
      {...(armed ? tokenAttrs('danger', 'text') : tokenAttrs('textSub', 'text'))}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/** Wires the real preload. Renders nothing without it (jsdom parent tests). */
export function NewSessionChipContainer({
  workspaceId,
  busy,
  t,
}: {
  workspaceId: string;
  busy?: boolean;
  t?: (key: string) => string;
}): React.ReactElement | null {
  const deck = window.electronAPI?.deck;
  const clear = deck?.conversation?.clear;
  const wake = deck?.wake;
  if (!clear || !wake) return null;
  return (
    <NewSessionChip
      workspaceId={workspaceId}
      busy={busy}
      t={t}
      api={{
        clear: (id) => clear(id),
        wake: (id) => wake(id),
      }}
    />
  );
}
