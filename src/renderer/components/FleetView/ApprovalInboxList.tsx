import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../stores';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { useT } from '../../hooks/useT';
import { groupCapabilities } from '../Approval/PermissionApprovalDialog';
import type { RiskClassCopy } from '../../../main/mcp/methodCapabilityMap';
import type { InboxItem } from '../../stores/selectors/approvalInbox';
import { deadlineForItem, remainingSeconds } from './approvalCountdown';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { beginApprovalCountdown, pauseApprovalCountdown } from '../../utils/executeApprovalGate';
import { IconWarning } from '../icons';

// gpui button recipes (theme-safe). Approve = primary warm CTA; deny = danger
// tinted. The row still carries the critical/attention border + countdown, so
// warm-approve does not drop the "this is a sensitive grant" signal.
const BTN_PRIMARY_WARM =
  'rounded-[5px] font-semibold bg-[var(--accent)] text-[var(--bg-base)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--surface-highlight)_22%,transparent),0_1px_2px_rgba(0,0,0,0.3)] hover:bg-[color-mix(in_srgb,var(--accent)_88%,var(--text-main))] transition-colors';
const BTN_DANGER_TINTED =
  'rounded-[5px] border transition-colors bg-[color-mix(in_srgb,var(--accent-red)_15%,transparent)] border-[color-mix(in_srgb,var(--accent-red)_32%,transparent)] text-[color-mix(in_srgb,var(--accent-red)_70%,var(--text-main))] hover:bg-[color-mix(in_srgb,var(--accent-red)_22%,transparent)]';
// Raised neutral — DESIGN.md "Secondary = raised neutral". Cancelling a help
// request abandons one step, not the flow, so it is NOT the destructive
// treatment the approval rows' Deny wears.
const BTN_SECONDARY_RAISED =
  'rounded-[5px] border transition-colors bg-[color-mix(in_srgb,var(--text-main)_6%,transparent)] border-[color-mix(in_srgb,var(--text-main)_10%,transparent)] text-[var(--text-sub)] shadow-[inset_0_1px_0_color-mix(in_srgb,var(--text-main)_6%,transparent)] hover:bg-[color-mix(in_srgb,var(--text-main)_10%,transparent)]';

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
  onNavigate?: () => void;
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

export default function ApprovalInboxList({ items, focusedIdx, onResolve, onNavigate }: ApprovalInboxListProps) {
  const t = useT();

  // Resolve A2A sender/receiver workspace IDs to display names (mirrors
  // ExecuteApprovalDialog) so the row tells the user WHICH workspace wants
  // bypassPermissions — security context, not just a title.
  // A1: id→name 해석만 필요 — {id,name} 투영만 구독.
  const workspaces = useStore(useShallow(selectWorkspaceIdName));
  const a2aAutoApproveExecute = useStore((s) => s.a2aAutoApproveExecute);
  const setA2aAutoApproveExecute = useStore((s) => s.setA2aAutoApproveExecute);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? id;

  // C-3: an MCP prompt gets a countdown once the approval record carries a
  // deadline. Read structurally off the store record so the badge appears the
  // moment the field lands and renders nothing until then.
  const mcpPrompts = useStore((s) => s.mcpPrompts);
  const mcpDeadlineAt = useMemo(
    () => (promptId: string) =>
      (mcpPrompts[promptId] as { deadlineAt?: number } | undefined)?.deadlineAt,
    [mcpPrompts],
  );

  // While this tab is open AppLayout unmounts the execute dialog, which is the
  // only other thing that starts an A2A prompt's auto-deny clock — so without
  // this the row sat at "0s" and never expired. Every row is on screen at once
  // here, so each one's 30 s is time a person can actually use. Idempotent, so
  // a row that is already counting keeps its deadline when another one lands.
  const a2aRows = items.filter((it): it is Extract<InboxItem, { source: 'a2a' }> => it.source === 'a2a');
  const a2aApprovalIds = a2aRows.map((it) => it.approvalId).join(',');
  // Rows on screen whose clock is not running: new ones, and any another
  // surface paused. Keyed on those alone, so a row that is already counting
  // keeps its deadline when another one lands or settles.
  const stoppedA2aIds = a2aRows.filter((it) => it.expiresAt <= 0).map((it) => it.approvalId).join(',');
  useEffect(() => {
    if (!stoppedA2aIds) return;
    for (const id of stoppedA2aIds.split(',')) beginApprovalCountdown(id);
  }, [stoppedA2aIds]);
  // When the inbox goes away, the dialog takes over and shows ONE prompt at a
  // time; the rest must not keep counting down unseen. Pause every row this
  // list was showing — the dialog restarts the one it shows. Unmount only: a
  // row that leaves the list while it stays open has settled.
  const shownA2aIds = useRef<string[]>([]);
  useEffect(() => {
    shownA2aIds.current = a2aApprovalIds ? a2aApprovalIds.split(',') : [];
  }, [a2aApprovalIds]);
  useEffect(() => () => {
    for (const id of shownA2aIds.current) pauseApprovalCountdown(id);
  }, []);

  // Live countdown tick for any row that HAS a deadline (A2A always, an MCP
  // prompt once stamped), mirroring ExecuteApprovalDialog's now-tick. Gated so
  // an inbox of deadline-less prompts never spins a 250ms interval.
  const hasDeadline = items.some((it) => deadlineForItem(it, mcpDeadlineAt) !== undefined);
  const [now, setNow] = useState(() => Date.now());
  // Layout effect, and `now` refreshed on start: while no row had a deadline
  // the tick was off and `now` kept its mount time, so the first countdown
  // would paint against a stale clock ("auto-deny in 330s").
  useLayoutEffect(() => {
    if (!hasDeadline) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(tick);
  }, [hasDeadline]);

  // Jump to the browser pane a help request is about, then step out of the way.
  // Reuses focusNotificationTarget — the existing, race-tested jump (workspace
  // switch, pane + surface activation, zoom coherence) FleetView's own rows go
  // through — rather than a second focus path. Closing the cockpit matches what
  // FleetView's card jump does: the operator asked to be taken to the pane.
  const jumpToHelpSurface = (surfaceId: string) => {
    onNavigate?.();
    focusNotificationTarget(() => useStore.getState(), { surfaceId });
    useStore.getState().setFleetViewVisible(false);
  };

  // C-3 (review fix): the log is the STORE's, written at the removal point.
  // Inferring it here from "row vanished, deadline past" mislabelled rows a
  // human answered after a throttled timer, and recorded nothing at all while
  // this tab was closed — which is precisely when you need it.
  const autoRejected = useStore((s) => s.approvalAutoRejected);

  if (items.length === 0 && autoRejected.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      {/* An empty listbox is a control with nothing to choose — announced, and
          unusable. When there are no rows the log below stands alone. */}
      {items.length > 0 && (
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
            className={`px-4 py-1.5 text-xs font-medium ${BTN_DANGER_TINTED}`}
          >
            {t('fleet.approvals.deny')}
          </button>
        );

        if (item.source === 'a2a') {
          const deadline = deadlineForItem(item);
          const sameWs = !!item.senderWorkspaceId && item.senderWorkspaceId === item.receiverWorkspaceId;
          return (
            <div
              key={item.key}
              {...optionProps}
              className="flex flex-col gap-2 p-3 rounded-[7px] outline-none"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: `1px solid ${focused ? 'var(--accent-blue)' : 'var(--accent-red)'}`,
                boxShadow: focused ? '0 0 0 1px var(--accent-blue)' : undefined,
              }}
            >
              <div className="flex items-center gap-2">
                <span aria-hidden="true" className="inline-flex" style={{ color: 'var(--accent-red)' }}><IconWarning size={14} /></span>
                <span className="text-sm font-semibold font-mono" style={{ color: 'var(--text-main)' }}>
                  {t('fleet.approvals.a2aTitle')}
                </span>
                <div className="flex-1" />
                {deadline !== undefined && (
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                    {t('fleet.approvals.autoDenyIn', { seconds: remainingSeconds(deadline, now) })}
                  </span>
                )}
              </div>
              {/* Who is asking + what they want — security context (subordinate,
                  muted, mono). Uses the from/to/a2aDescRemote/a2aDescSameWorkspace keys. */}
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                {t('fleet.approvals.from')} {wsName(item.senderWorkspaceId)}
                {' → '}
                {t('fleet.approvals.to')} {wsName(item.receiverWorkspaceId)}
              </div>
              <div className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                {t(sameWs ? 'fleet.approvals.a2aDescSameWorkspace' : 'fleet.approvals.a2aDescRemote')}
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
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={a2aAutoApproveExecute}
                    onChange={(e) => setA2aAutoApproveExecute(e.currentTarget.checked)}
                  />
                  <span className="truncate">{t('fleet.approvals.a2aAutoApprove')}</span>
                </label>
                <div className="flex shrink-0 items-center justify-end gap-2">
                  {denyButton}
                  <button
                    type="button"
                    onClick={(e) => { stop(e); onResolve(item, true); }}
                    className={`px-4 py-1.5 text-xs ${BTN_PRIMARY_WARM}`}
                  >
                    {t('fleet.approvals.approve')}
                  </button>
                </div>
              </div>
            </div>
          );
        }

        if (item.source === 'browserHelp') {
          // Second rendition of ONE event (DESIGN.md attention grammar, max
          // two): the in-pane bar is the first, this row is the second, and
          // there is deliberately no titlebar chip and no modal. Red dot =
          // needs input, the one vocabulary the dots share.
          const deadline = deadlineForItem(item);
          return (
            <div
              key={item.key}
              {...optionProps}
              className="flex flex-col gap-2 p-3 rounded-[7px] outline-none"
              style={{
                backgroundColor: 'var(--bg-surface)',
                border: `1px solid ${focused ? 'var(--accent-blue)' : 'var(--accent-red)'}`,
                boxShadow: focused ? '0 0 0 1px var(--accent-blue)' : undefined,
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  aria-hidden="true"
                  className="shrink-0 rounded-full"
                  style={{ width: 6, height: 6, backgroundColor: 'var(--accent-red)' }}
                />
                <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-main)' }}>
                  {t('fleet.help.title')}
                </span>
                <div className="flex-1" />
                {deadline !== undefined && (
                  <span className="text-[10px] font-mono" style={{ color: 'var(--text-subtle)' }}>
                    {t('fleet.help.timesOutIn', { seconds: remainingSeconds(deadline, now) })}
                  </span>
                )}
              </div>
              {/* Sans, not mono: this is the agent talking to the operator, not
                  machine evidence (DESIGN.md typography rule). Rendered as a
                  text child, so an agent-authored prompt can never be markup. */}
              <p
                className="text-xs whitespace-pre-wrap break-words"
                style={{ color: 'var(--text-sub)' }}
                data-browser-help-prompt
              >
                {item.prompt}
              </p>
              <div className="flex items-center justify-end gap-2">
                {/* Every claim one click from its evidence: the page the human
                    has to act on is one jump away. */}
                {item.surfaceId !== undefined && (
                  <button
                    type="button"
                    onClick={(e) => { stop(e); jumpToHelpSurface(item.surfaceId as string); }}
                    title={t('fleet.help.jump')}
                    aria-label={t('fleet.help.jump')}
                    className="px-2 py-1.5 text-xs rounded-[5px] transition-colors"
                    style={{ color: 'var(--accent-blue)', minWidth: 24, minHeight: 24 }}
                  >
                    →
                  </button>
                )}
                <button
                  type="button"
                  onClick={(e) => { stop(e); onResolve(item, false); }}
                  className={`px-4 py-1.5 text-xs font-medium ${BTN_SECONDARY_RAISED}`}
                >
                  {t('browser.help.cancel')}
                </button>
                <button
                  type="button"
                  onClick={(e) => { stop(e); onResolve(item, true); }}
                  className={`px-4 py-1.5 text-xs ${BTN_PRIMARY_WARM}`}
                >
                  {t('browser.help.done')}
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
            className="flex flex-col gap-2 p-3 rounded-[7px] outline-none"
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
                {/* A tab-borrow prompt comes from a workspace's agent, not from a
                    plugin; labelling it one would misattribute the request. */}
                <span style={{ color: 'var(--text-subtle)' }}>
                  {t(item.kind === 'browser-borrow' ? 'fleet.approvals.workspace' : 'fleet.approvals.plugin')}:{' '}
                </span>
                {item.clientName}
              </span>
              <div className="flex-1" />
              {/* C-3: only rendered once the approval record carries a deadline —
                  a countdown with no auto-reject behind it would be a lie. */}
              {(() => {
                const deadlineAt = mcpDeadlineAt(item.promptId);
                if (deadlineAt === undefined) return null;
                return (
                  <span
                    data-approval-countdown
                    className="text-[10px] font-mono"
                    style={{ color: 'var(--text-subtle)' }}
                  >
                    {t('fleet.approvals.autoDenyIn', { seconds: remainingSeconds(deadlineAt, now) })}
                  </span>
                );
              })()}
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

            {/* The question itself, for a prompt that carries one. A borrow
                declares no capabilities, so without this the row would say who
                is asking and never what for. */}
            {item.title && (
              <div className="text-xs font-medium" style={{ color: 'var(--text-main)' }}>
                {item.title}
              </div>
            )}

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
                className={`px-4 py-1.5 text-xs ${BTN_PRIMARY_WARM}`}
              >
                {t('fleet.approvals.approve')}
              </button>
            </div>
          </div>
        );
      })}
      </div>
      )}
      {autoRejected.length > 0 && (
        <ul
          data-approval-auto-rejected-log
          className="flex flex-col gap-0.5 px-1"
          aria-label={t('fleet.approvals.autoRejectedLog')}
        >
          {autoRejected.map((entry) => (
            <li
              key={entry.key}
              data-approval-auto-rejected
              className="text-[10px] font-mono truncate"
              style={{ color: 'var(--text-subtle)' }}
              title={entry.label}
            >
              {t('fleet.approvals.autoRejected', { name: entry.label })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
