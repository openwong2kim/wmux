import { useComposeShortcut } from '../../hooks/useComposeShortcut';
import { useStore } from '../../stores';
import ComposePopover from './ComposePopover';
import FanOutDialog from './FanOutDialog';
import { placePopover } from './placePopover';
import { createPortal } from 'react-dom';

/**
 * Layout-level host. Always mounted so ⌘G / Ctrl+G survives inject-chrome
 * being hidden, and so FanOutDialog never lives inside the sidebar scroller.
 */
export default function ComposeHost() {
  useComposeShortcut();
  const popover = useStore((s) => s.toolbarPopover);
  const ctx = useStore((s) => s.composeContext);
  const fanOutWorkspaceId = useStore((s) => s.fanOutWorkspaceId);
  const fanOutAnchor = useStore((s) => s.fanOutAnchor);
  const closeFanOut = useStore((s) => s.closeFanOut);

  // Height must match what the dialog can actually take (`max-h-[70vh]`), not a
  // fixed 560: guessing short let placePopover keep a top that the taller
  // dialog then overflowed, clipping its repo field and Launch button.
  const fanOutHeight = typeof window === 'undefined'
    ? 560
    : Math.round(window.innerHeight * 0.7);
  const fanOutPos = fanOutWorkspaceId
    ? placePopover(fanOutAnchor, { width: 420, height: fanOutHeight })
    : null;

  return (
    <>
      {popover === 'rich' && ctx && (
        <ComposePopover paneId={ctx.paneId} ptyId={ctx.ptyId} />
      )}
      {fanOutWorkspaceId && fanOutPos && createPortal(
        <div
          data-testid="fanout-host"
          className="fixed"
          style={{ top: fanOutPos.top, left: fanOutPos.left, zIndex: 'var(--z-popover-top)' }}
        >
          <FanOutDialog workspaceId={fanOutWorkspaceId} onClose={closeFanOut} />
        </div>,
        document.body,
      )}
    </>
  );
}
