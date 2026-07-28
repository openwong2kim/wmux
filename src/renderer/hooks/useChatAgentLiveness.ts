// Chat View is a lens over a LIVE agent — this hook takes the lens away when
// the agent behind it is gone.
//
// The failure it closes: killing `claude` does not end the pane. The PTY keeps
// running with a bare shell, so the projection freezes on a dead conversation
// and the composer keeps writing into a shell that ignores it. From inside the
// lens there is no way back to an agent. The terminal is the ground truth
// (DESIGN.md 2026-07-27), and when the ground truth has lost its agent there is
// nothing left for the lens to project — so the surface flips back to the
// terminal, where the user can relaunch.
//
// What counts as "gone" is deliberately narrow: `agentProcessAlive === false`,
// the daemon AgentProcessTracker's process-truth edge. It is only ever `false`
// after the tracker attributed a live agent pid and the process monitor watched
// that exact pid die. Softer signals are rejected on purpose:
//   • PTY exit — a different event (the whole surface goes away), and node-pty
//     has been observed reporting a bogus exit (#646). A misfire there would
//     eject a perfectly healthy pane.
//   • agent status / activity heuristics — a long thinking gap looks exactly
//     like a dead agent.
//   • "no agent detected" — never-observed is not observed-dying. `undefined`
//     means the tracker could not attribute a process, and it must switch
//     nothing.
//
// The liveness map is refreshed by a 15 s poll (AppLayout), so it can lag a
// relaunch by up to one tick. Acting on that stale `false` would eject the user
// the instant they re-entered Chat on a just-relaunched agent, so entering chat
// mode takes one first-hand reading of the daemon's session list and only arms
// the switch afterwards.

import { useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { useT } from './useT';

/**
 * Flip `surfaceId` back to the terminal rendering when this pane's agent
 * process is observed dead. No-op while chat mode is off.
 */
export function useChatAgentLiveness(surfaceId: string, ptyId: string, chatMode: boolean): void {
  const t = useT();
  const alive = useStore((s) => (ptyId ? s.agentAliveByPtyId[ptyId] : undefined));
  // Armed only after a first-hand reading — see the stale-`false` note above.
  const [armed, setArmed] = useState(false);
  // One switch per chat session. Without this, a surfaceId the store cannot
  // find (the surface closed underneath us) would leave `chatMode` true and
  // re-push the toast on every render.
  const firedRef = useRef(false);

  useEffect(() => {
    firedRef.current = false;
    if (!chatMode || !ptyId) {
      setArmed(false);
      return;
    }
    let live = true;
    const pty = window.electronAPI?.pty;
    // No bridge (older preload, jsdom): nothing to re-read, so the map the
    // renderer already holds is the best answer available.
    if (!pty?.list) {
      setArmed(true);
      return;
    }
    void pty
      .list()
      .then((sessions) => {
        if (!live) return;
        // Same shape AppLayout's poll hydrates from — one authoritative list,
        // one writer contract.
        const snapshot: Record<string, boolean> = {};
        for (const s of sessions) {
          if (s.agentProcessAlive !== undefined) snapshot[s.id] = s.agentProcessAlive;
        }
        useStore.getState().hydrateAgentAlive(snapshot);
      })
      .catch(() => {
        // Transient list failure — the 15 s poll re-reads. Arming on a map we
        // could not refresh is still safe: it only ever holds daemon answers.
      })
      .finally(() => {
        if (live) setArmed(true);
      });
    return () => { live = false; };
  }, [chatMode, ptyId]);

  useEffect(() => {
    if (!armed || !chatMode || !ptyId) return;
    if (alive !== false) return;
    if (firedRef.current) return;
    firedRef.current = true;
    const state = useStore.getState();
    state.setSurfaceChatMode(surfaceId, false);
    // Announced, not silent: the view changing under the user is otherwise an
    // unexplained jump. Re-entering Chat is one right-click away once the agent
    // is back — the tracker re-arms on the relaunched process.
    state.pushToast({ level: 'info', message: t('chat.agentGone') });
  }, [armed, chatMode, ptyId, alive, surfaceId, t]);
}
