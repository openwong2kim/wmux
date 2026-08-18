import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../stores';
import AgentToolbar, { AGENT_TOOLBAR_HEIGHT } from './AgentToolbar';
import { useHoverReveal, HOVER_TRIGGER_ZONE_PX } from './useHoverReveal';

/**
 * Owns the reveal state for AgentToolbar and the element the trigger band is
 * measured against.
 *
 * The wrapper is `absolute inset-0 pointer-events-none`, so it spans the
 * workspace column (which must be `relative`) without intercepting anything:
 * the pane grid keeps every click and drag. Only the bar itself re-enables
 * pointer events, and only while revealed. Nothing here takes layout space —
 * a bar that took a row would resize every PTY on each reveal.
 */
export default function ToolbarHost() {
  const enabled = useStore((s) => s.agentToolbarEnabled);
  const pinned = useStore((s) => s.agentToolbarPinned);
  const [hold, setHold] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  // Keep-alive band = the bar plus a small margin, derived from the bar's own
  // height so the two can never drift apart.
  const { revealed, barHandlers } = useHoverReveal({
    pinned,
    hold,
    hostRef,
    keepAlivePx: AGENT_TOOLBAR_HEIGHT + 8,
  });
  const onHoldChange = useCallback((next: boolean) => setHold(next), []);

  if (!enabled) return null;

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
      <AgentToolbar barHandlers={barHandlers} revealed={revealed} onHoldChange={onHoldChange} />
    </div>
  );
}

export { AGENT_TOOLBAR_HEIGHT, HOVER_TRIGGER_ZONE_PX };
