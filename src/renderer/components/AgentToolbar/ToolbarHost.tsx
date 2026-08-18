import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import AgentToolbar, { AGENT_TOOLBAR_HEIGHT } from './AgentToolbar';
import { useComposeShortcut } from './useComposeShortcut';
import { useHoverReveal, HOVER_TRIGGER_ZONE_PX } from './useHoverReveal';

/**
 * Owns the reveal state for AgentToolbar and the element the trigger band is
 * measured against.
 *
 * The wrapper is `absolute inset-0 pointer-events-none`, so it spans the
 * workspace column (which must be `relative`) without intercepting anything:
 * the pane grid keeps every click and drag. Only the bar's own controls
 * re-enable pointer events, and only while revealed. Nothing here takes layout
 * space — a bar that took a row would resize every PTY on each reveal.
 */
export default function ToolbarHost() {
  // ⌘G lives at this level, not inside the bar: the bar unmounts when the
  // inject-chrome setting is off, and the shortcut is documented to survive
  // that ("Ctrl+G stays bound either way"). Mounting the listener here keeps
  // the contract the deleted ComposeHost used to hold.
  useComposeShortcut();
  const enabled = useStore((s) => s.agentToolbarEnabled);
  // A remote workspace view covers this same column (WorkspaceCenter stacks
  // them), but every toolbar verb targets the LOCAL active workspace's pty. A
  // bar floating over a remote screen would inject into a terminal that is not
  // on screen and spawn worktrees in the wrong repo.
  const remoteActive = useStore((s) => s.activeRemoteKey != null);

  if (!enabled || remoteActive) return null;
  return <RevealHost />;
}

/**
 * Split from ToolbarHost so the pointer/keyboard listeners in useHoverReveal
 * only exist while the bar can actually show. Hooks cannot sit behind the
 * early return above, and a disabled toolbar has no business watching every
 * pointermove in the app.
 */
function RevealHost() {
  const pinned = useStore((s) => s.agentToolbarPinned);
  const [hold, setHold] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep-alive band = the bar plus a small margin, derived from the bar's own
  // height so the two can never drift apart.
  const { revealed, barHandlers, revealForFocus } = useHoverReveal({
    pinned,
    hold,
    hostRef,
    keepAlivePx: AGENT_TOOLBAR_HEIGHT + 8,
  });
  const onHoldChange = useCallback((next: boolean) => setHold(next), []);

  return (
    <div
      ref={hostRef}
      className="absolute inset-0 z-20 pointer-events-none"
      data-testid="toolbar-host"
    >
      {/* The lip: the only always-visible trace of the bar. Without it a hidden
          bar is undiscoverable, which is worse than a badly placed one. */}
      {!revealed && (
        <div
          className="absolute inset-x-0 bottom-0"
          style={{ height: 2, background: 'var(--bg-surface)' }}
          aria-hidden
          data-testid="toolbar-lip"
        />
      )}
      <AgentToolbar
        barHandlers={barHandlers}
        revealed={revealed}
        onHoldChange={onHoldChange}
        onFocusEnter={revealForFocus}
      />
    </div>
  );
}

export { AGENT_TOOLBAR_HEIGHT, HOVER_TRIGGER_ZONE_PX };
