import { useStore } from '../../stores';
import FanOutDialog from './FanOutDialog';
import { placePopover } from './placePopover';
import { createPortal } from 'react-dom';

/**
 * Layout-level portal host for FanOutDialog, so the dialog never lives inside
 * the toolbar's stacking context (or, before that, the sidebar scroller).
 *
 * It no longer hosts a compose popover: with the agent toolbar restored
 * (2026-08-18) ⌘G belongs to the toolbar's Rich Input again. Keeping both
 * meant one keypress opened two popovers — the toolbar's own and this host's —
 * since both watched `toolbarPopover === 'rich'`.
 */
export default function ComposeHost() {
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

  if (!fanOutWorkspaceId || !fanOutPos) return null;

  return createPortal(
    <div
      data-testid="fanout-host"
      className="fixed"
      style={{ top: fanOutPos.top, left: fanOutPos.left, zIndex: 'var(--z-popover-top)' }}
    >
      <FanOutDialog workspaceId={fanOutWorkspaceId} onClose={closeFanOut} />
    </div>,
    document.body,
  );
}
