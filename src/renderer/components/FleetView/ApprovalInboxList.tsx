import { useEffect, useState } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { groupCapabilities } from '../Approval/PermissionApprovalDialog';
import type { RiskClassCopy } from '../../../main/mcp/methodCapabilityMap';
import type { InboxItem } from '../../stores/selectors/approvalInbox';

// ─── S-C2 Approval Inbox list ─────────────────────────────────────────────────
//
// A role="listbox" of pending-approval rows. Mirrors FleetCard's roving-focus
// pattern (role="option" + tabIndex 0/-1 + aria-selected) so the cockpit's
// capture-phase keyboard model can drive selection without leaking to the
// background xterm. The two sources render structurally distinct rows; the
// resolve dispatch is owned by the caller (resolveInboxItem) and reached via
// onResolve so this component never re-implements resolve logic (guard #3).
//
// Empty state is the caller's (FleetView) responsibility — when items is empty
// this renders nothing.

interface ApprovalInboxListProps {
  items: InboxItem[];
  focusedIdx: number;
  onResolve: (item: InboxItem, approved: boolean) => void;
}

function severityAccent(severity: RiskClassCopy['severity']): string {
  switch (severity) {
    case 'critical':
      return 'var(--accent-red)';
    case 'caution':
      return 'var(--accent-yellow)';
    case 'neutral':
      return 'var(--text-subtle)';
  }
}

export default function ApprovalInboxList({ items, focusedIdx, onResolve }: ApprovalInboxListProps) {
  const t = useT();

  // Resolve A2A sender/receiver workspace IDs to display names (mirrors
  // ExecuteApprovalDialog) so the row tells the user WHICH workspace wants
  // bypassPermissions — security context, not just a title.
  const workspaces = useStore((s) => s.workspaces);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;

  // Live countdown tick for any A2A row, mirroring ExecuteApprovalDialog's
  // now-tick. Gated on the inbox actually containing an A2A row so an inbox of
  // only MCP prompts never spins a 250ms interval.
  const hasA2a = items.some((it) => it.source === 'a2a');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasA2a) return;
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [hasA2a]);

  if (items.length === 0) return null;

  return (
    <div role="listbox" aria-label={t('fleet.tab.approvals')} className="flex flex-col gap-2">
      {items.map((item, idx) => {
        const focused = idx === focusedIdx;
        const optionProps = {
          role: 'option' as const,
          'aria-selected': focused,
          tabIndex: focused ? 0 : (-1 as const),
          'data-inbox-row': true,
          'data-source': item.source,
        };

        // Clicking a button must resolve WITHOUT disturbing the row's option
        // semantics (no focus-jump / roving-index confusion).
        const stop = (e: React.MouseEvent) => e.stopPropagation();

        const denyButton = (
          <button
            type="button"
            onClick={(e) => { stop(e); onResolve(item, false); }}
            className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
            style={{ backgroundColor: 'var(--bg-surface)', color: 'var(--text-subtle)' }}
          >
            {t('fleet.approvals.deny')}
          </button>
        );

        if (item.source === 'a2a') {
          const remainingSec = Math.ceil(Math.max(0, item.expiresAt - now) / 1000);
          return (
            <div
              key={item.key}
              {...optionProps}
              className="flex flex-col gap-2 p-3 rounded-lg outline-none"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: `1px solid ${focused ? 'var(--accent-blue)' : 'var(--accent-red)'}`,
                boxShadow: focused ? '0 0 0 1px var(--accent-blue)' : undefined,
              }}
            >
              <div className="flex items-center gap-2">
                <span style={{ color: 'var(--accent-red)', fontSize: 14 }}>⚠</span>
                <span className="text-sm font-semibold font-mono" style={{ color: 'var(--text-main)' }}>
                  {t('fleet.approvals.a2aTitle')}
                </span>
                <div className="flex-1" />
                <span className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                  {t('fleet.approvals.autoDenyIn', { seconds: remainingSec })}
                </span>
              </div>
              {/* Who is asking + what they want — security context (subordinate,
                  muted, mono). Uses the previously-dead from/to/a2aDesc keys. */}
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                {t('fleet.approvals.from')} {wsName(item.senderWorkspaceId)}
                {' → '}
                {t('fleet.approvals.to')} {wsName(item.receiverWorkspaceId)}
              </div>
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                {t('fleet.approvals.a2aDesc')}
              </div>
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
                {item.messagePreview || '<empty message>'}
              </p>
              <div className="flex items-center justify-end gap-2">
                {denyButton}
                <button
                  type="button"
                  onClick={(e) => { stop(e); onResolve(item, true); }}
                  className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                  style={{ backgroundColor: 'var(--accent-red)', color: 'var(--bg-base)' }}
                >
                  {t('fleet.approvals.approve')}
                </button>
              </div>
            </div>
          );
        }

        // MCP row. Highest-severity group is groups[0] — groupCapabilities
        // returns them in critical-first GROUP_RENDER_ORDER.
        const groups = groupCapabilities(item.declaredCapabilities);
        const top = groups[0];
        const accent = top ? severityAccent(top.copy.severity) : 'var(--text-subtle)';
        return (
          <div
            key={item.key}
            {...optionProps}
            className="flex flex-col gap-2 p-3 rounded-lg outline-none"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: `1px solid ${
                focused ? 'var(--accent-blue)' : item.isCritical ? 'var(--accent-red)' : 'var(--bg-overlay)'
              }`,
              boxShadow: focused ? '0 0 0 1px var(--accent-blue)' : undefined,
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-mono truncate" style={{ color: 'var(--text-main)' }}>
                <span style={{ color: 'var(--text-subtle)' }}>{t('fleet.approvals.plugin')}: </span>
                {item.clientName}
              </span>
              <div className="flex-1" />
              {item.isCritical && (
                <span
                  className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--accent-red) 22%, transparent)',
                    color: 'var(--accent-red)',
                  }}
                >
                  {t('fleet.approvals.critical')}
                </span>
              )}
            </div>

            {top && (
              <div className="text-xs font-medium" style={{ color: accent }}>
                {top.copy.summary}
              </div>
            )}

            {item.declaredCapabilities.length > 0 && (
              <ul className="text-[11px] font-mono" style={{ color: 'var(--text-sub2)' }}>
                {item.declaredCapabilities.map((cap, capIdx) => (
                  <li key={`${cap}-${capIdx}`}>· {cap}</li>
                ))}
              </ul>
            )}

            <div className="flex items-center justify-end gap-2">
              {denyButton}
              <button
                type="button"
                onClick={(e) => { stop(e); onResolve(item, true); }}
                className="px-4 py-1.5 rounded-lg text-xs font-medium transition-colors"
                style={{
                  backgroundColor: item.isCritical ? 'var(--accent-red)' : 'var(--accent-yellow)',
                  color: 'var(--bg-base)',
                }}
              >
                {t('fleet.approvals.approve')}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
