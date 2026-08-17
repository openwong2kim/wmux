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

  const fanOutPos = fanOutWorkspaceId
    ? placePopover(
      fanOutAnchor ? { top: fanOutAnchor.top, left: fanOutAnchor.left, right: fanOutAnchor.left, bottom: fanOutAnchor.top } : null,
      { width: 420, height: 560 },
    )
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
