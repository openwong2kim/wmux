import { useId } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import type { WorkspaceSettleGroupKind } from '../../stores/slices/workspaceSettleSlice';

/**
 * One of the two groups at the foot of the workspace list — Snoozed, then
 * Settled. Collapsed by default, like the Archived section whose header it
 * copies; the open state lasts for the session. A group holding the active
 * workspace opens until the user folds it, or settling the row you are in
 * would make it vanish. Neutral on purpose: settled is not a state that wants
 * attention, so it wears no colour. Empty → nothing is drawn.
 */
export default function WorkspaceSettleGroup({ kind, count, containsActive, children }: {
  kind: WorkspaceSettleGroupKind;
  /** Top-level rows in the group (nested tasks ride with their owner). */
  count: number;
  containsActive: boolean;
  children: React.ReactNode;
}) {
  const t = useT();
  const remembered = useStore((s) => s.workspaceSettleGroupsOpen[kind]);
  const setOpen = useStore((s) => s.setWorkspaceSettleGroupOpen);
  const listId = useId();
  if (count === 0) return null;
  const open = remembered ?? containsActive;
  return (
    <div className="pt-2 mt-1 border-t" style={{ borderColor: 'var(--stroke)' }} data-workspace-settle-group={kind}>
      <button
        type="button"
        className={`flex w-full min-h-[24px] items-center gap-1.5 px-1 py-0.5 text-left text-[12px] font-medium text-[color-mix(in_srgb,var(--text-main)_70%,transparent)] hover:text-[var(--text-main)] ${FOCUS_RING}`}
        // Group-label case and tracking come from the look (DESIGN.md).
        style={{ textTransform: 'var(--group-case)' as React.CSSProperties['textTransform'], letterSpacing: 'var(--group-track)' }}
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen(kind, !open)}
      >
        <span
          aria-hidden="true"
          className="w-3 h-3 flex-none inline-flex items-center justify-center transition-transform"
          style={{ transform: open ? 'rotate(90deg)' : 'none' }}
        >
          <IconChevron size={12} />
        </span>
        {t(kind === 'settled' ? 'workspaceSettle.groupSettled' : 'workspaceSettle.groupSnoozed', { count })}
      </button>
      <div id={listId} className="mt-0.5 space-y-0.5" hidden={!open}>
        {open && children}
      </div>
    </div>
  );
}
