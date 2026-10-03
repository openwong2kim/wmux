// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/app/shell/Sidebar.tsx), MIT License, Copyright (c) 2026 Nick
import type { AgentStatus } from '../../../shared/types';

export type StatusMark = 'dot' | 'ring' | 'cross' | 'check' | 'none';

// Shared mapping from agent status → visual indicator. Used by WorkspaceItem
// (full sidebar) and MiniSidebar so they stay in lockstep when statuses change.
// `dotVar` paints the row's main status dot and `glowClass` adds the animated
// glow channel (globals.css sidebar polish section).
// `shape` separates error from the other statuses by FORM, not only hue, so
// the ✕ still reads where colour does not (forced-colors, colour-blindness).
export const AGENT_STATUS_ICON: Record<AgentStatus, {
  dot: string;
  className: string;
  labelKey: string;
  dotVar: string;
  glowClass: string;
  shape: 'dot' | 'cross';
  /**
   * #1481 — the sidebar row's mark: status told by SHAPE first and colour
   * second, so it survives colour-blindness and forced-colors. running = filled
   * muted dot · needs input = accent ring · error = cross · complete = muted
   * check · idle = nothing. (Unconfirmed keeps its own hollow accent ring, drawn
   * by the caller from the unverifiable signal, not from this table.)
   */
  mark: StatusMark;
}> = {
  // Mono status vocabulary (DESIGN.md Colour grammar): one accent, for "needs you"; running
  // and complete are muted (--text-sub), red is for errors only, idle draws
  // nothing. DeckFleet.dotColor keeps its own copy of this mapping.
  running:        { dot: '●', className: 'text-[var(--text-sub)]',      labelKey: 'workspace.agentRunning',       dotVar: 'var(--text-sub)',        glowClass: 'sidebar-dot-running', shape: 'dot', mark: 'dot' },
  complete:       { dot: '●', className: 'text-[var(--text-sub)]',      labelKey: 'workspace.agentComplete',      dotVar: 'var(--text-sub)',  glowClass: '',                    shape: 'dot', mark: 'check' },
  error:          { dot: '●', className: 'text-[var(--accent-red)]',    labelKey: 'workspace.agentError',         dotVar: 'var(--accent-red)',    glowClass: 'sidebar-dot-error',   shape: 'cross', mark: 'cross' },
  waiting:        { dot: '●', className: 'text-[var(--accent)]',        labelKey: 'workspace.agentWaiting',       dotVar: 'var(--accent)', glowClass: 'sidebar-dot-waiting', shape: 'dot', mark: 'ring' },
  awaiting_input: { dot: '●', className: 'text-[var(--accent)]',        labelKey: 'workspace.agentAwaitingInput', dotVar: 'var(--accent)', glowClass: 'sidebar-dot-waiting', shape: 'dot', mark: 'ring' },
  idle:           { dot: '●', className: 'text-[var(--text-muted)]',    labelKey: 'workspace.agentIdle',          dotVar: 'var(--text-muted)',    glowClass: '',                    shape: 'dot', mark: 'none' },
};
