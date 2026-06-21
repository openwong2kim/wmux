import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import {
  selectFleetPanes,
  sortFleetPanes,
  countNeedsAttention,
  type FleetPane,
} from '../../stores/selectors/fleet';
import { selectApprovalInbox } from '../../stores/selectors/approvalInbox';
import { selectRemoteInbox } from '../../stores/selectors/remoteInbox';
import { resolveInboxItem } from '../../utils/resolveInboxItem';
import {
  focusPaneByPtyId,
  activatePaneTarget,
  focusNotificationTarget,
} from '../../hooks/useNotificationListener';
import type { FleetTab } from '../../stores/slices/uiSlice';
import { tailForPty } from '../../utils/terminalTail';
import { onTerminalRegistered } from '../../hooks/useTerminal';
import FleetCard from './FleetCard';
import ApprovalInboxList from './ApprovalInboxList';
import RemoteInboxList from './RemoteInboxList';

/**
 * S-C1 Fleet View — the cockpit. A full-screen overlay (Ctrl+Shift+A) that
 * shows every agent across every workspace on one screen, with the blocked
 * ones floated to the top. Click a card → jump straight to that pane. The
 * "Approvals" tab is a v2 stub (the unified A2A + MCP approval inbox).
 *
 * Mount-gated by AppLayout on `fleetViewVisible`, so this component (and its
 * store subscriptions / selector) only exists while the cockpit is open.
 */
export default function FleetView() {
  const t = useT();
  const setVisible = useStore((s) => s.setFleetViewVisible);
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  // Hook-driven per-pane activity line (fleet-activity-line-hook). Subscribed
  // here so the selector re-runs when an agent's PostToolUse activity changes.
  const surfaceActivity = useStore((s) => s.surfaceActivity);

  // S-C2: tab lives in uiSlice (not FleetView-local) so the A2A / MCP approval
  // modals can suppress themselves while the inbox tab is open (AppLayout delta
  // 5). Reset to 'fleet' on unmount (mount-gated = close) so reopening the
  // cockpit always lands on the agent grid.
  const tab = useStore((s) => s.fleetActiveTab);
  const setTab = useStore((s) => s.setFleetActiveTab);
  useEffect(() => () => setTab('fleet'), [setTab]);

  // S-C1 follow-up — situational sort: 'attention' (awaiting_input floats up,
  // then sidebar order) ↔ 'workspace' (pure sidebar order). Persists across
  // cockpit open/close within a session (not reset on unmount, unlike the tab).
  const fleetSortMode = useStore((s) => s.fleetSortMode);
  const setFleetSortMode = useStore((s) => s.setFleetSortMode);

  const [focusedIdx, setFocusedIdx] = useState(0);
  const [inboxIdx, setInboxIdx] = useState(0);
  const [remoteIdx, setRemoteIdx] = useState(0);
  // S-C2 Phase 2 — live output tail. {ptyId: last-3-lines}. Filled by ONE
  // shared coarse poll below; passed down to terminal cards only.
  const [tails, setTails] = useState<Record<string, string[]>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Derive + sort outside the hot render path. Re-runs only when the workspace
  // trees or the per-pty attention map change (the two inputs the selector
  // reads), not on every unrelated store mutation.
  const panes = useMemo(
    () => sortFleetPanes(selectFleetPanes({ workspaces, surfaceAgentStatus, surfaceActivity }), fleetSortMode),
    [workspaces, surfaceAgentStatus, surfaceActivity, fleetSortMode],
  );
  const needsCount = useMemo(() => countNeedsAttention(panes), [panes]);

  // S-C2 approval inbox — pure derivation of the two pending-approval sources
  // (A2A-first, then MCP). Mirrors the fleet selector's narrow subscription.
  const mcpPrompts = useStore((s) => s.mcpPrompts);
  const mcpPromptOrder = useStore((s) => s.mcpPromptOrder);
  const pendingExecuteApprovals = useStore((s) => s.pendingExecuteApprovals);
  const pendingExecuteApprovalOrder = useStore((s) => s.pendingExecuteApprovalOrder);
  const inbox = useMemo(
    () => selectApprovalInbox({ mcpPrompts, mcpPromptOrder, pendingExecuteApprovals, pendingExecuteApprovalOrder }),
    [mcpPrompts, mcpPromptOrder, pendingExecuteApprovals, pendingExecuteApprovalOrder],
  );

  // LanLink PR-5 remote inbox — pure derivation of off-machine peer messages
  // (PR-2 built the slice + selector; this is the first consumer). dismissRemoteItem
  // is a view action (per-card X / Delete key); it never touches peer trust state.
  const remoteItems = useStore((s) => s.remoteItems);
  const remoteItemOrder = useStore((s) => s.remoteItemOrder);
  const dismissRemoteItem = useStore((s) => s.dismissRemoteItem);
  const remoteInbox = useMemo(
    () => selectRemoteInbox({ remoteItems, remoteItemOrder }),
    [remoteItems, remoteItemOrder],
  );

  // S-C2 Phase 2 — live output tail. ONE shared coarse interval (the whole
  // component is mount-gated on cockpit-open, so the poll only runs while the
  // overlay is visible). Each tick reads the last 3 plaintext lines of every
  // terminal pane that has a ptyId via the shared `tailForPty` (same buffer-read
  // path as `input.readScreen`) — read-only, no daemon round-trip. We rebuild a
  // next map and shallow-compare it against the previous one so an unchanged
  // tail does NOT mint a new object identity / re-render every 750ms.
  //
  // Bounds: terminals-with-a-ptyId only, last-3-rows window only, one timer for
  // the whole fleet (never per-pane). An `onTerminalRegistered` subscription
  // refreshes when a pane mounts late (e.g. a restored terminal finishing its
  // async scrollback load after the first tick). NO offsetWidth guard — see
  // terminalTail.ts; background panes are display:none yet must still show a tail.
  useEffect(() => {
    const terminalPtyIds = panes
      .filter((p) => p.surfaceType === 'terminal' && p.ptyId)
      .map((p) => p.ptyId);

    const refresh = () => {
      setTails((prev) => {
        const next: Record<string, string[]> = {};
        let changed = false;
        for (const ptyId of terminalPtyIds) {
          const tail = tailForPty(ptyId, 3);
          next[ptyId] = tail;
          const before = prev[ptyId];
          if (
            !before ||
            before.length !== tail.length ||
            tail.some((line, i) => line !== before[i])
          ) {
            changed = true;
          }
        }
        // A pty dropping out of the fleet (closed pane) is also a change.
        if (!changed && Object.keys(prev).length !== terminalPtyIds.length) {
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    refresh(); // paint immediately; don't wait 750ms for the first tail.
    const id = window.setInterval(refresh, 750);
    const unsub = onTerminalRegistered(() => refresh());
    return () => {
      window.clearInterval(id);
      unsub();
    };
  }, [panes]);

  // Jump to a pane's workspace + pane + surface, then close the overlay.
  // Terminal panes resolve by their active-surface ptyId via the full
  // notification jump — which also marks that surface's notifications read and
  // clears its attention ring. That side effect is intentional here: jumping to
  // a pane from the cockpit acknowledges it, exactly like the toast-click and
  // pane-click paths. It does NOT touch the agentStatus, so the card keeps
  // showing awaiting_input until the agent actually resumes. Browser/editor/
  // unspawned surfaces have no ptyId (and no ring), so they activate the
  // workspace+pane+surface directly via the shared activation core.
  const jump = useCallback((card: FleetPane) => {
    const getState = () => useStore.getState();
    if (card.ptyId) {
      focusPaneByPtyId(getState, card.ptyId);
    } else if (card.surfaceId) {
      activatePaneTarget(getState, {
        workspaceId: card.workspaceId,
        paneId: card.paneId,
        surfaceId: card.surfaceId,
      });
    } else {
      focusNotificationTarget(getState, { workspaceId: card.workspaceId });
    }
    setVisible(false);
  }, [setVisible]);

  // Keep focus index in range when the pane set shrinks / the tab changes.
  useEffect(() => {
    setFocusedIdx((i) => Math.min(i, Math.max(panes.length - 1, 0)));
  }, [panes.length]);

  // Same clamp for the inbox: a row resolving (or the A2A 30s auto-deny)
  // shrinks the list, so the focused index must never dangle past the end.
  useEffect(() => {
    setInboxIdx((i) => Math.min(i, Math.max(inbox.length - 1, 0)));
  }, [inbox.length]);

  // Same clamp for the remote inbox: dismissing a card shrinks the list.
  useEffect(() => {
    setRemoteIdx((i) => Math.min(i, Math.max(remoteInbox.length - 1, 0)));
  }, [remoteInbox.length]);

  // Pull DOM focus INTO the overlay (the focused card, else the panel) so no
  // keystroke — arrows, Enter, or typed text — can leak to the background
  // pane's xterm textarea underneath the backdrop, and so the keyboard
  // selection is announced by assistive tech (roving focus on role=option).
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      if (tab === 'fleet' && panes.length > 0) {
        const cards = gridRef.current?.querySelectorAll<HTMLElement>('[data-fleet-card]');
        (cards && cards[focusedIdx])?.focus();
      } else if (tab === 'approvals' && inbox.length > 0) {
        // Mirror the fleet-tab branch for the inbox listbox so arrows / Enter /
        // deny-keys land on the focused row and can't leak to the background
        // xterm underneath the backdrop.
        const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[role=option]');
        (rows && rows[inboxIdx])?.focus();
      } else if (tab === 'remote' && remoteInbox.length > 0) {
        // Same roving-focus pull for the remote-peer listbox.
        const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[role=option]');
        (rows && rows[remoteIdx])?.focus();
      } else {
        panelRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [tab, focusedIdx, inboxIdx, remoteIdx, panes.length, inbox.length, remoteInbox.length]);

  // Keyboard: Esc closes; unmodified arrows move card focus and are ALWAYS
  // swallowed (capture-phase) so they never reach the background xterm or
  // scroll the page, even on the Approvals tab / empty fleet. Enter/Space are
  // left to native <button> activation on the focused card (one code path, no
  // double-fire). The global useKeyboard handler ignores unmodified
  // Esc/Arrow, and Ctrl+Shift+A still toggles closed through it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setVisible(false);
        return;
      }
      if (e.key === 'Tab') {
        // Modal focus trap: never let Tab escape the overlay. On the Fleet tab
        // it drives roving card navigation (wrapping); otherwise it cycles the
        // dialog's own controls (the tab buttons) so a keyboard user can still
        // switch tabs instead of dead-ending on the empty / Approvals state.
        e.preventDefault();
        e.stopPropagation();
        if (tab === 'fleet' && panes.length > 0) {
          setFocusedIdx((i) =>
            e.shiftKey ? (i - 1 + panes.length) % panes.length : (i + 1) % panes.length);
          return;
        }
        const focusables = Array.from(
          panelRef.current?.querySelectorAll<HTMLElement>('button:not([tabindex="-1"])') ?? [],
        );
        if (focusables.length === 0) { panelRef.current?.focus(); return; }
        const cur = focusables.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey
          ? (cur - 1 + focusables.length) % focusables.length
          : (cur + 1) % focusables.length;
        focusables[next]?.focus();
        return;
      }
      // Approvals tab: Enter approves the focused row (guard #5 — non-critical
      // only), Backspace/Delete denies it (always safe). Both swallowed so the
      // keystroke never leaks to the background xterm. A critical MCP row's
      // Enter is a deliberate no-op: granting a critical capability requires an
      // explicit click / Tab-to-Approve, never a blind keyboard grant.
      //
      // The roving shortcuts fire ONLY when the inbox ROW itself (role=option)
      // holds focus. If the user has Tab-focused a dialog <button> (a row's
      // Deny / Approve, or a tab button), we must NOT intercept: native button
      // activation owns Enter/Space there. Otherwise the capture-phase Enter
      // would approve the focused ROW even when the user pressed Enter on the
      // Deny button (opposite of intent — codex P1), and a critical row's
      // explicit keyboard Approve (the sanctioned path per guard #5) would be
      // unreachable because the critical-row no-op swallows Enter first.
      const active = document.activeElement;
      const onDialogButton =
        active instanceof HTMLElement && active.tagName === 'BUTTON' &&
        !!panelRef.current?.contains(active);
      if (tab === 'approvals' && inbox.length > 0 && !onDialogButton) {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          const it = inbox[inboxIdx];
          if (it && !(it.source === 'mcp' && it.isCritical)) {
            resolveInboxItem(it, true);
          }
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          const it = inbox[inboxIdx];
          if (it) resolveInboxItem(it, false);
          return;
        }
      }
      // Remote tab: read-only, so no Enter action — Backspace/Delete dismisses the
      // focused card (mirrors approvals' deny-key path; same onDialogButton guard so
      // a Tab-focused dismiss <button> keeps native activation).
      if (tab === 'remote' && remoteInbox.length > 0 && !onDialogButton) {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          e.stopPropagation();
          const it = remoteInbox[remoteIdx];
          if (it) dismissRemoteItem(it.recordId);
          return;
        }
      }

      const isArrow =
        e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
        e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      if (!isArrow || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      if (tab === 'fleet' && panes.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          setFocusedIdx((i) => Math.min(i + 1, panes.length - 1));
        } else {
          setFocusedIdx((i) => Math.max(i - 1, 0));
        }
        return;
      }
      if (tab === 'approvals' && inbox.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          setInboxIdx((i) => Math.min(i + 1, inbox.length - 1));
        } else {
          setInboxIdx((i) => Math.max(i - 1, 0));
        }
        return;
      }
      if (tab === 'remote' && remoteInbox.length > 0) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          setRemoteIdx((i) => Math.min(i + 1, remoteInbox.length - 1));
        } else {
          setRemoteIdx((i) => Math.max(i - 1, 0));
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tab, panes.length, inbox, inboxIdx, remoteInbox, remoteIdx, dismissRemoteItem, setVisible]);

  return (
    <div
      className="fixed inset-0 z-[55] flex items-start justify-center pt-[8vh]"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) setVisible(false); }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={t('fleet.title')}
        className="w-[min(960px,92vw)] max-h-[82vh] flex flex-col rounded-xl overflow-hidden shadow-2xl outline-none"
        style={{
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--bg-surface)',
          boxShadow: '0 25px 60px rgba(0,0,0,0.7)',
        }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header: title + "N need you" chip */}
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid var(--bg-surface)' }}
        >
          <span className="text-sm font-semibold text-[var(--text-main)]">{t('fleet.title')}</span>
          {needsCount > 0 && (
            <span
              className="text-[11px] font-medium px-2 py-0.5 rounded-full"
              style={{
                backgroundColor: 'color-mix(in srgb, var(--accent-yellow) 22%, transparent)',
                color: 'var(--accent-yellow)',
              }}
            >
              {t('fleet.needsAttention', { count: needsCount })}
            </span>
          )}
          <div className="flex-1" />
          {/* Situational sort toggle (fleet tab only). Cycles attention-first
              ↔ pure workspace (sidebar) order. */}
          {tab === 'fleet' && (
            <button
              type="button"
              onClick={() => setFleetSortMode(fleetSortMode === 'attention' ? 'workspace' : 'attention')}
              className="text-[11px] px-2 py-0.5 rounded transition-colors hover:text-[var(--text-main)]"
              style={{ border: '1px solid var(--bg-overlay)', color: 'var(--text-muted)' }}
              title={t('fleet.sort.tooltip')}
              aria-label={t('fleet.sort.tooltip')}
            >
              {t('fleet.sort.label')}: {t(fleetSortMode === 'attention' ? 'fleet.sort.attention' : 'fleet.sort.workspace')}
            </button>
          )}
          <kbd
            className="text-xs text-[var(--text-muted)] px-1.5 py-0.5 rounded"
            style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
          >
            ESC
          </kbd>
        </div>

        {/* Tabs: Fleet (v1) + Approvals (v2 stub) */}
        <div
          className="flex items-center gap-1 px-3 pt-1.5"
          role="tablist"
          style={{ borderBottom: '1px solid var(--bg-surface)' }}
        >
          {(['fleet', 'approvals', 'remote'] as FleetTab[]).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className="px-3 py-1.5 text-xs rounded-t-md transition-colors"
              style={{
                color: tab === id ? 'var(--text-main)' : 'var(--text-muted)',
                borderBottom: tab === id ? '2px solid var(--accent-blue)' : '2px solid transparent',
              }}
            >
              {/* Explicit per-tab key (NOT a `fleet.tab.${id}` template) so a missing
                  key is a tsc error, not a raw-string render to the user. */}
              {t(id === 'fleet' ? 'fleet.tab.fleet' : id === 'approvals' ? 'fleet.tab.approvals' : 'fleet.tab.remote')}
            </button>
          ))}
        </div>

        {/* Body */}
        <div ref={bodyRef} className="overflow-y-auto flex-1 p-4">
          {tab === 'approvals' ? (
            inbox.length > 0 ? (
              <ApprovalInboxList items={inbox} focusedIdx={inboxIdx} onResolve={resolveInboxItem} />
            ) : (
              <div className="flex items-center justify-center h-[200px] text-sm text-[var(--text-muted)]">
                {t('fleet.approvals.empty')}
              </div>
            )
          ) : tab === 'remote' ? (
            remoteInbox.length > 0 ? (
              <RemoteInboxList items={remoteInbox} focusedIdx={remoteIdx} onDismiss={dismissRemoteItem} />
            ) : (
              <div className="flex items-center justify-center h-[200px] text-sm text-[var(--text-muted)]">
                {t('fleet.remote.empty')}
              </div>
            )
          ) : panes.length === 0 ? (
            <div className="flex items-center justify-center h-[200px] text-sm text-[var(--text-muted)]">
              {t('fleet.empty')}
            </div>
          ) : (
            <div
              ref={gridRef}
              role="listbox"
              aria-label={t('fleet.title')}
              className="grid gap-3"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}
            >
              {panes.map((card, idx) => (
                <FleetCard
                  key={`${card.workspaceId}:${card.paneId}:${card.surfaceId}`}
                  card={card}
                  focused={idx === focusedIdx}
                  onJump={() => jump(card)}
                  tail={card.ptyId ? tails[card.ptyId] : undefined}
                />
              ))}
            </div>
          )}
        </div>

        {/* Footer hint — approve/deny on the Approvals tab, jump on Fleet. */}
        <div
          className="flex items-center gap-3 px-4 py-2"
          style={{ borderTop: '1px solid var(--bg-surface)', backgroundColor: 'var(--bg-mantle)' }}
        >
          <span className="text-xs text-[var(--text-muted)]">
            <kbd
              className="px-1 py-0.5 rounded mr-0.5"
              style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
            >
              ↑↓
            </kbd>{' '}
            {t('palette.navigate')}
          </span>
          {tab === 'approvals' ? (
            <>
              <span className="text-xs text-[var(--text-muted)]">
                <kbd
                  className="px-1 py-0.5 rounded mr-0.5"
                  style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
                >
                  Enter
                </kbd>{' '}
                {t('fleet.approvals.enterApprove')}
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                <kbd
                  className="px-1 py-0.5 rounded mr-0.5"
                  style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
                >
                  Del
                </kbd>{' '}
                {t('fleet.approvals.delDeny')}
              </span>
            </>
          ) : tab === 'remote' ? (
            <span className="text-xs text-[var(--text-muted)]">
              <kbd
                className="px-1 py-0.5 rounded mr-0.5"
                style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
              >
                Del
              </kbd>{' '}
              {t('fleet.remote.delDismiss')}
            </span>
          ) : (
            <span className="text-xs text-[var(--text-muted)]">
              <kbd
                className="px-1 py-0.5 rounded mr-0.5"
                style={{ border: '1px solid var(--bg-overlay)', fontFamily: 'monospace' }}
              >
                Enter
              </kbd>{' '}
              {t('fleet.jumpHint')}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
