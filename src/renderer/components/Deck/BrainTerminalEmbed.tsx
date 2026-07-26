// ─── Brain terminal embed — the `claude-pty` orchestrator's own TUI ─────────
//
// The `claude-pty` brain runs the user's real Claude Code binary as an
// interactive terminal program (see main/deck/ClaudePtyBrainAdapter). Its TUI
// already renders the conversation — thinking, tool calls, diffs, the lot — far
// better than a re-synthesised bubble stream could, so the deck EMBEDS that
// terminal in place of the bubble list instead of parsing its screen.
//
// Deliberately thin: the same `useTerminal(ref, { ptyId, isVisible })` wiring
// FloatingPane uses, in a container the deck sizes. That hook owns the whole
// input path already — `terminal.onData → pty.write(ptyId, …)`, the paste
// chunker, IME guards — and the ResizeObserver that keeps `pty.resize` in step
// with the container, so the embed adds only what a pane gets from its own
// chrome: DOM focus.
//
// Focus is NOT cosmetic here. The composer below is the normal typing target
// (deck:send → the adapter types into this pty), but it disables while a turn
// runs — and Claude Code's own blocking dialogs (folder trust, a permission
// prompt, /login) appear DURING a turn, before any Stop hook. With no way to
// reach the TUI the deck deadlocks: the brain waits on a dialog nobody can
// answer, and the composer waits on the brain. Clicking the terminal (or the
// autofocus below on first mount) puts the keyboard on the pty, so arrow keys
// and Enter reach the dialog.
import { useCallback, useEffect, useRef } from 'react';
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
  const { terminal } = useTerminal(containerRef, { ptyId, isVisible });

  // Click anywhere in the embed → keyboard focus on the pty. xterm focuses its
  // own hidden textarea when the click lands on the rendered grid, but the
  // container is taller than the grid whenever the TUI is short, so a click in
  // the padding below it would otherwise leave focus on <body>.
  const focusTerminal = useCallback(() => {
    try {
      terminal.current?.focus();
    } catch {
      /* disposed mid-click — the next mount takes focus instead */
    }
  }, [terminal]);

  // Take focus once the terminal exists, so a freshly spawned brain is typable
  // without a click — the deck only mounts this when the operator is looking at
  // the Orchestrator tab. Deliberately NOT re-run on visibility or data: it must
  // never yank focus back from the composer while the user is typing there.
  useEffect(() => {
    if (!isVisible) return;
    const raf = requestAnimationFrame(focusTerminal);
    return () => cancelAnimationFrame(raf);
    // ptyId ONLY, on purpose: `isVisible` and `focusTerminal` are read, not
    // depended on. Adding them would re-run the effect on every deck reveal and
    // steal focus back from the composer mid-sentence.
  }, [ptyId]);

  return (
    <div
      data-commander-brain-terminal
      data-pty-id={ptyId}
      ref={containerRef}
      onMouseDown={focusTerminal}
      // Firm height (not flex-1): the bubble log now renders BELOW the embed in
      // the same scroll column, and a flex-fill terminal would squeeze it out.
      className="h-[42vh] min-h-[260px] shrink-0 w-full overflow-hidden rounded-[6px]"
    />
  );
}

export default BrainTerminalEmbed;
