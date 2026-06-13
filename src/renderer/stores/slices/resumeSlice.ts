// Resume-hint state slice (X6 Feature ②) — renderer-side mirror of the daemon's
// per-boot "this interactive pane was an agent before recovery" hint, keyed by
// ptyId. Drives the one-click "Resume Claude" pill on a recovered shell pane.
//
// All fields are TRANSIENT (never enter buildSessionData). Hydrated from
// `pty.list` on mount/reconnect (the daemon only sets `resumeAgent` for sessions
// RECOVERED this boot — never live reconnects, so the pill can't paste into a
// running agent). Cleared the moment the offer goes stale: the pill is clicked
// or dismissed, the user types into the pane, or the agent is detected live
// again (it relaunched).

import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { AgentSlug } from '../../../shared/events';

export interface ResumeSlice {
  /** Per-ptyId resume hint (agent slug). Absent key = no pill for this pane. */
  resumeHintByPtyId: Record<string, AgentSlug>;

  /** Ptys that have emitted their first data (shell prompt drawn) since mount.
   *  The resume pill is only clickable once its pane is here — guards against
   *  pasting `claude --continue` before the recovered pipe is writable (EI6). */
  ptyReadyByPtyId: Record<string, true>;

  /** Mark a pty interactive (first PTY data received). */
  markPtyReady: (ptyId: string) => void;

  /** Offer a resume for a recovered agent pane. */
  setResumeHint: (ptyId: string, agent: AgentSlug) => void;

  /** Drop one pane's hint — clicked, dismissed, typed-into, or agent relaunched. */
  clearResumeHint: (ptyId: string) => void;

  /**
   * Replace the whole map from a `pty.list` snapshot. The daemon only reports
   * `resumeAgent` for sessions recovered-this-boot whose agent has NOT been
   * re-detected, so replacing on every hydrate drops a hint the moment the
   * agent relaunches. Known v1 edge: an explicitly-dismissed pill can reappear
   * on a later daemon:connected re-hydrate (the daemon isn't told about a
   * dismiss); clicking Resume self-clears it because the relaunched agent is
   * then detected live.
   */
  hydrateResume: (snapshot: Record<string, AgentSlug>) => void;
}

export const createResumeSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ResumeSlice
> = (set) => ({
  resumeHintByPtyId: {},
  ptyReadyByPtyId: {},

  markPtyReady: (ptyId) => set((draft: StoreState) => {
    if (!draft.ptyReadyByPtyId[ptyId]) draft.ptyReadyByPtyId[ptyId] = true;
  }),

  setResumeHint: (ptyId, agent) => set((draft: StoreState) => {
    draft.resumeHintByPtyId[ptyId] = agent;
  }),

  clearResumeHint: (ptyId) => set((draft: StoreState) => {
    if (draft.resumeHintByPtyId[ptyId]) delete draft.resumeHintByPtyId[ptyId];
  }),

  hydrateResume: (snapshot) => set((draft: StoreState) => {
    draft.resumeHintByPtyId = { ...snapshot };
  }),
});
