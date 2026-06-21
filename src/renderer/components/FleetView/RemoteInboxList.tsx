import { useT } from '../../hooks/useT';
import type { RemoteInboxItem } from '../../../shared/lanlink';

// ─── LanLink PR-5 Remote Inbox list ───────────────────────────────────────────
//
// A role="listbox" of read-only remote-PEER messages (off-machine, origin:'remote').
// The message body is UNTRUSTED input and is rendered as a React TEXT CHILD ONLY
// ({item.text}) — never dangerouslySetInnerHTML, never written to a PTY, never fed
// to the a2a execute funnel. React escapes control characters to inert text, so an
// ESC / CSI sequence in a remote message cannot drive the terminal.
//
// Mirrors ApprovalInboxList's roving-focus pattern (role="option" + tabIndex 0/-1 +
// aria-selected) so the cockpit's capture-phase keyboard model can drive focus
// without leaking to the background xterm. The dismiss dispatch is owned by the
// caller (FleetView, via onDismiss(recordId)); this component never mutates the
// store directly. Empty state is the caller's responsibility — when items is empty
// this renders nothing.

interface RemoteInboxListProps {
  items: RemoteInboxItem[];
  focusedIdx: number;
  onDismiss: (recordId: string) => void;
}

export default function RemoteInboxList({ items, focusedIdx, onDismiss }: RemoteInboxListProps) {
  const t = useT();
  if (items.length === 0) return null;

  return (
    <div role="listbox" aria-label={t('fleet.tab.remote')} className="flex flex-col gap-2">
      {items.map((item, idx) => {
        const focused = idx === focusedIdx;
        return (
          <div
            key={item.recordId}
            role="option"
            aria-selected={focused}
            tabIndex={focused ? 0 : -1}
            data-inbox-row
            data-source="remote"
            className="flex flex-col gap-2 p-3 rounded-lg outline-none"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: `1px solid ${focused ? 'var(--accent-blue)' : 'var(--bg-overlay)'}`,
              boxShadow: focused ? '0 0 0 1px var(--accent-blue)' : undefined,
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              {/* "remote peer" badge — marks the message as off-machine / untrusted. */}
              <span
                className="text-[10px] font-mono px-2 py-0.5 rounded shrink-0"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  color: 'var(--accent-blue)',
                  border: '1px solid var(--bg-overlay)',
                }}
              >
                {t('fleet.remote.peerBadge')}
              </span>
              <span
                className="text-sm font-semibold font-mono truncate"
                style={{ color: 'var(--text-main)' }}
              >
                {item.peerName}
              </span>
              <div className="flex-1" />
              <span className="text-[10px] font-mono shrink-0" style={{ color: 'var(--text-subtle)' }}>
                {new Date(item.receivedAt).toLocaleTimeString()}
              </span>
              {/* Per-card dismiss. stopPropagation keeps the row's option semantics
                  (no focus-jump / roving-index confusion); the focused row can also
                  be dismissed via Delete/Backspace (FleetView keyboard branch). */}
              <button
                type="button"
                aria-label={t('fleet.remote.dismiss')}
                tabIndex={focused ? 0 : -1}
                onClick={(e) => { e.stopPropagation(); onDismiss(item.recordId); }}
                className="px-2 py-0.5 rounded text-xs shrink-0 transition-colors"
                style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
              >
                ✕
              </button>
            </div>
            {/* UNTRUSTED off-machine text — React text child ONLY. */}
            <p
              className="text-xs font-mono whitespace-pre-wrap break-words"
              style={{
                color: 'var(--text-sub)',
                maxHeight: 96,
                overflowY: 'auto',
                backgroundColor: 'var(--bg-mantle)',
                borderRadius: 6,
                padding: '6px 8px',
              }}
            >
              {item.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}
