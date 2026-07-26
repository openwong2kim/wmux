// ─── Brain terminal embed — the `claude-pty` orchestrator's own TUI ─────────
//
// The `claude-pty` brain runs the user's real Claude Code binary as an
// interactive terminal program (see main/deck/ClaudePtyBrainAdapter). Its TUI
// already renders the conversation — thinking, tool calls, diffs, the lot — far
// better than a re-synthesised bubble stream could, so the deck EMBEDS that
// terminal in place of the bubble list instead of parsing its screen.
//
// Deliberately thin: the same `useTerminal(ref, { ptyId, isVisible })` wiring
// FloatingPane uses, in a container the deck sizes. Input still flows through
// the composer (deck:send → the adapter types into this pty), so this surface
// is a VIEW — the human's typing target stays the one composer.

import { useRef } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import '@xterm/xterm/css/xterm.css';

export interface BrainTerminalEmbedProps {
  /** Daemon session id of the brain's TUI. */
  ptyId: string;
  /** False while the deck tab / workspace is hidden — keeps xterm from
   *  fitting into a zero-size container. */
  isVisible?: boolean;
}

export function BrainTerminalEmbed({
  ptyId,
  isVisible = true,
}: BrainTerminalEmbedProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  useTerminal(containerRef, { ptyId, isVisible });
  return (
    <div
      data-commander-brain-terminal
      data-pty-id={ptyId}
      ref={containerRef}
      className="flex-1 min-h-0 w-full overflow-hidden rounded-[6px]"
    />
  );
}

export default BrainTerminalEmbed;
