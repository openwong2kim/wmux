// Chat View availability probe — the thing that lets the feature be ENTERED.
//
// `chatStatus[ptyId]` gates the Terminal|Chat toggle and the keyboard chord.
// It used to be written in exactly one place: `useChatProjection`, which mounts
// inside `ChatView`, which only renders once `Surface.chatMode` is true, which
// `setSurfaceChatMode` refuses to set unless `chatStatus[ptyId].available`.
// That is a closed loop: the status that enables the toggle could only be
// fetched by a component the toggle had to be used to mount. Chat View was
// unreachable from a cold start no matter what the daemon reported.
//
// So the probe lives out here, on the TERMINAL-mode surface, and runs before
// anything about Chat is mounted.
//
// Re-probing is deliberately narrow. A pane has no `transcriptPath` until its
// FIRST TURN ENDS (SessionStart fires before the `.jsonl` exists), so the first
// probe of a fresh agent pane legitimately answers `no-transcript-path` and the
// toggle must light up later, on its own. The pane's agent status changing is
// that "later" — a turn boundary moves it to 'complete' — but it is not the
// ONLY one, so a bounded retry runs alongside it while the answer is still
// negative (see the comment on the interval below). Once availability is
// positive both stop, so a busy pane does not pay one IPC per transition for an
// answer that will not change.

import { useEffect } from 'react';
import { useStore } from '../stores';
import { getChatBridge } from './useChatProjection';

/** Gap between re-probes while the answer is still "not yet", in ms. */
export const AVAILABILITY_RETRY_MS = 2_000;

/**
 * How many re-probes one pending window is worth. The window restarts on every
 * agent-status change and on `daemon:connected`, so this bounds the cost of a
 * pane that simply never becomes chattable — it does not bound convergence.
 */
export const AVAILABILITY_RETRY_LIMIT = 20;

/** Probe `daemon.transcript.status` for one pane and keep the store honest. */
export function useChatAvailability(ptyId: string): void {
  const available = useStore((s) => (ptyId ? s.chatStatus[ptyId]?.available === true : false));
  const agentStatus = useStore((s) => (ptyId ? s.surfaceAgent[ptyId]?.status : undefined));
  // While unavailable, every agent-status change is a reason to re-ask (a turn
  // may have just ended and minted the transcript path). Once available, the
  // key freezes and the effect stops re-running.
  const probeKey = available ? 'available' : `pending:${agentStatus ?? 'none'}`;

  useEffect(() => {
    if (!ptyId) return;
    const chat = getChatBridge();
    // Feature-detected: an older preload bundle has no `chat` surface at all,
    // and a missing probe must leave the toggle disabled, not throw at mount.
    if (!chat?.status) return;

    let live = true;
    const probe = (): void => {
      void chat
        .status?.(ptyId)
        .then((status) => {
          if (!live || !status) return;
          useStore.getState().setChatStatus(ptyId, status);
        })
        .catch(() => {
          // A failed probe leaves the toggle exactly as it was — disabled if it
          // was never available. Guessing "available" here would open a Chat
          // surface onto nothing.
        });
    };
    probe();

    // A daemon respawn re-mints the projector, and a pane's binding may have
    // been restored (or lost) across it.
    const daemon = (
      globalThis as {
        window?: { electronAPI?: { daemon?: { onConnected?: (cb: () => void) => () => void } } };
      }
    ).window?.electronAPI?.daemon;
    const offConnected = daemon?.onConnected?.(() => { if (live) probe(); });

    // The transcript path is minted by the daemon at a moment NOTHING in the
    // renderer observes. If it lands in the same tick the agent status settles,
    // `probeKey` is already frozen and the toggle stays dark until the NEXT
    // status change — observed live as 2–3 wasted operator turns before Chat
    // would open. Keying on some other value cannot fix that (there is no
    // renderer-side event for "the path now exists"), so while the answer is
    // still "not yet" we simply keep asking, briefly: the daemon knows, this is
    // only the UI catching up. Availability turning true re-runs this effect
    // (probeKey → 'available') and the cleanup below stops the timer.
    let attempts = 0;
    const retry = available
      ? undefined
      : setInterval(() => {
          const status = useStore.getState().chatStatus[ptyId];
          // 'not-claude' is a property of the agent, not a race — re-asking it
          // every 2s would be pure noise. Any real change to that answer comes
          // with an agent-status change, which restarts this effect.
          if (status?.available || status?.reason === 'not-claude') return;
          attempts += 1;
          if (attempts > AVAILABILITY_RETRY_LIMIT) {
            if (retry) clearInterval(retry);
            return;
          }
          probe();
        }, AVAILABILITY_RETRY_MS);

    return () => {
      live = false;
      if (retry) clearInterval(retry);
      offConnected?.();
    };
  }, [ptyId, probeKey]);
}
