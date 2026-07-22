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
import type { ResumeBinding } from '../../../shared/agentResume';

export interface ResumeSlice {
  /** Per-ptyId resume hint (agent slug). Absent key = no pill for this pane. */
  resumeHintByPtyId: Record<string, AgentSlug>;

  /**
   * X6 ③: per-ptyId resume binding (origin session id + cwd + permission mode),
   * surfaced alongside the slug for panes recovered-this-boot whose captured cwd
   * still matches (the daemon enforces that guard). Present → the pill can build
   * `--resume <id>` for the EXACT conversation; absent → the pill falls back to
   * cwd-relative `--continue`.
   */
  resumeBindingByPtyId: Record<string, ResumeBinding>;

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

  /** Replace the binding map from a `pty.list` snapshot (parallel to hydrateResume). */
  hydrateResumeBindings: (snapshot: Record<string, ResumeBinding>) => void;

  /**
   * OSC 133 shell state per ptyId — true = a foreground command owns the PTY
   * (e.g. a live `claude`), false = at a shell prompt. Absent key = the daemon
   * sent no value (shell integration off) → the resume chip falls back to its
   * activity heuristic. The AUTHORITATIVE gate for the persistent resume chip.
   */
  commandRunningByPtyId: Record<string, boolean>;

  /** Replace the OSC 133 map from a `pty.list` snapshot. */
  hydrateCommandRunning: (snapshot: Record<string, boolean>) => void;

  /**
   * Process-truth agent liveness per ptyId (daemon AgentProcessTracker) —
   * true = the pane's agent process is observed alive, false = it was observed
   * and DIED (the alive→dead edge), absent = never attributed. Sits between
   * OSC 133 and the activity heuristic in the resume chip's busy gate, so a
   * quiet-but-alive agent on a no-integration pane no longer surfaces the chip
   * mid-session.
   */
  agentAliveByPtyId: Record<string, boolean>;

  /** Replace the agent-liveness map from a `pty.list` snapshot. */
  hydrateAgentAlive: (snapshot: Record<string, boolean>) => void;
}

export const createResumeSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  ResumeSlice
> = (set) => ({
  resumeHintByPtyId: {},
  resumeBindingByPtyId: {},
  commandRunningByPtyId: {},
  agentAliveByPtyId: {},
  ptyReadyByPtyId: {},

  markPtyReady: (ptyId) => set((draft: StoreState) => {
    if (!draft.ptyReadyByPtyId[ptyId]) draft.ptyReadyByPtyId[ptyId] = true;
  }),

  setResumeHint: (ptyId, agent) => set((draft: StoreState) => {
    draft.resumeHintByPtyId[ptyId] = agent;
  }),

  clearResumeHint: (ptyId) => set((draft: StoreState) => {
    // Clear the binding together with the hint — the pill goes away as a unit
    // (clicked, dismissed, typed-into, or agent relaunched).
    if (draft.resumeHintByPtyId[ptyId]) delete draft.resumeHintByPtyId[ptyId];
    if (draft.resumeBindingByPtyId[ptyId]) delete draft.resumeBindingByPtyId[ptyId];
  }),

  hydrateResume: (snapshot) => set((draft: StoreState) => {
    draft.resumeHintByPtyId = { ...snapshot };
  }),

  hydrateResumeBindings: (snapshot) => set((draft: StoreState) => {
    draft.resumeBindingByPtyId = { ...snapshot };
  }),

  hydrateCommandRunning: (snapshot) => set((draft: StoreState) => {
    draft.commandRunningByPtyId = { ...snapshot };
  }),

  hydrateAgentAlive: (snapshot) => set((draft: StoreState) => {
    draft.agentAliveByPtyId = { ...snapshot };
  }),
});
