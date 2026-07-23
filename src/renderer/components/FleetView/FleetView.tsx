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
 * S-C1 Fleet View — the cockpit. An always-on chrome panel (Ctrl+Shift+A
 * toggles it) that shows every agent across every workspace, with the blocked
 * ones floated to the top. Click a card → jump straight to that pane. The
 * "Approvals" tab is a v2 stub (the unified A2A + MCP approval inbox).
 *
 * NB2 wave 2 cycle A: fullscreen modal → persistent chrome. Placed in AppLayout as a flex
 * sibling like ChannelDock so panes reflow (no longer a fixed overlay — a fixed-width side
 * panel opposite the workspace sidebar). Backdrop and modal focus trap removed; keyboard
 * interaction is captured only when the panel has focus — Tab can move freely to other panes.
 *
 * Mount-gated by AppLayout on `fleetViewVisible`, so this component (and its
 * store subscriptions / selector) only exists while the cockpit is open.
 */
export default function FleetView() {
  const t = useT();
  const setVisible = useStore((s) => s.setFleetViewVisible);
  // Persistent chrome edge mirroring: workspace sidebar follows sidebarPosition; this panel
  // sits on the opposite side (same rule as ChannelDock). Sidebar left (default) → panel
  // right and content border faces left (border-l).
  const sidebarPosition = useStore((s) => s.sidebarPosition);
  const dockOnRight = sidebarPosition !== 'right';
  const workspaces = useStore((s) => s.workspaces);
  const surfaceAgentStatus = useStore((s) => s.surfaceAgentStatus);
  // Hook-driven per-pane activity line (fleet-activity-line-hook). Subscribed
  // here so the selector re-runs when an agent's PostToolUse activity changes.
  const surfaceActivity = useStore((s) => s.surfaceActivity);
  const paneLabel = useStore((s) => s.paneLabel);
  // X8 supervision mirror — subscribed here so the selector re-runs when a
  // supervised pane arms/stops or its restart count changes.
  const supervisionByPtyId = useStore((s) => s.supervisionByPtyId);

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
  // TASK-6 — per-pane agent RAM. {ptyId: {rss bytes, image?}}. Filled by ONE
  // shared 4s poll below that only runs while this (mount-gated) cockpit is open.
  const [resources, setResources] = useState<Record<string, { rss: number; image?: string }>>({});
  const panelRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Derive + sort outside the hot render path. Re-runs only when the workspace
  // trees or the per-pty attention map change (the two inputs the selector
  // reads), not on every unrelated store mutation.
  const panes = useMemo(
    () => sortFleetPanes(selectFleetPanes({ workspaces, surfaceAgentStatus, surfaceActivity, paneLabel, supervisionByPtyId }), fleetSortMode),
    [workspaces, surfaceAgentStatus, surfaceActivity, paneLabel, supervisionByPtyId, fleetSortMode],
  );
  const needsCount = useMemo(() => countNeedsAttention(panes), [panes]);
  // Stable identity key of the terminal ptyIds to poll for RAM. `panes`
  // recomputes on every streaming activity tick (surfaceActivity/agentStatus
  // are memo deps), so keying the resource-poll effect on `panes` directly
  // would tear down + re-fire the poll (a fresh CIM spawn) each tick while
  // Fleet View is open and any agent streams. This string only changes when the
  // set of polled ptyIds changes, so the effect's interval stays stable.
  const resourcePtyIdsKey = useMemo(
    () => panes.filter((p) => p.surfaceType === 'terminal' && p.ptyId).map((p) => p.ptyId).sort().join(','),
    [panes],
  );

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

  // TASK-6 — per-pane agent resource attribution. The whole component is
  // mount-gated on `fleetViewVisible`, so this interval exists ONLY while the
  // cockpit is open: a closed Fleet View issues ZERO Win32_Process snapshots
  // (the plan's polling-gate acceptance criterion). Each 4s tick sends the
  // currently-shown terminal ptyIds to main, which takes ONE CIM snapshot, walks
  // each pane shell's descendant tree, and returns summed RAM + heaviest child
  // image. Non-Windows / local mode / snapshot failure → empty map → no chips.
  useEffect(() => {
    if (typeof window.electronAPI?.pty?.resources !== 'function') return;
    let cancelled = false;
    const ptyIds = resourcePtyIdsKey ? resourcePtyIdsKey.split(',') : [];
    if (ptyIds.length === 0) {
      setResources((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    // In-flight guard: a CIM snapshot can take up to ~8s (slow machines), longer
    // than the 4s tick — without this the interval would stack concurrent
    // whole-machine powershell spawns. Skip a tick while one is still running.
    let inFlight = false;
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await window.electronAPI.pty.resources(ptyIds);
        if (!cancelled) setResources(next ?? {});
      } catch {
        // Fail-soft: keep the last-known values, drop no chips mid-glance.
      } finally {
        inFlight = false;
      }
    };
    void poll(); // paint immediately; don't wait 4s for the first sample.
    const id = window.setInterval(poll, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [resourcePtyIdsKey]);

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

  // Focus real DOM on the card/row for the current tab and focus index. Returns true on success.
  // Must target the item element, not panelRef, so (1) assistive tech announces initial selection
  // and (2) with a single card in the tab, roving index is not stuck in clamp. Shared focus
  // path for mount and roving effects.
  const focusActiveItem = useCallback(() => {
    if (tab === 'fleet' && panes.length > 0) {
      const cards = gridRef.current?.querySelectorAll<HTMLElement>('[data-fleet-card]');
      const el = cards && cards[focusedIdx];
      if (el) { el.focus(); return true; }
    } else if (tab === 'approvals' && inbox.length > 0) {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[role=option]');
      const el = rows && rows[inboxIdx];
      if (el) { el.focus(); return true; }
    } else if (tab === 'remote' && remoteInbox.length > 0) {
      const rows = bodyRef.current?.querySelectorAll<HTMLElement>('[role=option]');
      const el = rows && rows[remoteIdx];
      if (el) { el.focus(); return true; }
    }
    return false;
  }, [tab, focusedIdx, inboxIdx, remoteIdx, panes.length, inbox.length, remoteInbox.length]);

  // Keep latest focusActiveItem closure in a ref so mount effect ([] deps) reads current state
  // without re-running on every focus change.
  const focusActiveItemRef = useRef(focusActiveItem);
  focusActiveItemRef.current = focusActiveItem;

  // Ref holding activeElement at open trigger time — focus restore target on close.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Persistent chrome: on open (mount), pull focus to current item once. Previously only
  // panelRef was focused; the roving effect's "focus already inside panel" guard ran
  // synchronously before the rAF callback → false → immediate return → no card got real DOM
  // focus; with one card, arrow clamp prevented index change and roving never woke up. Now
  // focus the actual card/row directly, fall back to panel container only when no items.
  // Unlike modal, never steal focus afterward (roving moves only when "already inside panel").
  //
  // On close (Esc/close button/Ctrl+Shift+A), focused elements disappear and browser drops
  // focus to body. Save activeElement at mount (before rAF steals focus = just after open
  // trigger) and restore on unmount.
  useEffect(() => {
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const raf = requestAnimationFrame(() => {
      if (!focusActiveItemRef.current()) panelRef.current?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      // Restore focus if opener element is still in document (e.g. pane xterm textarea mid-typing).
      // If it disappeared, do not force-move — leave browser default (body).
      const el = restoreFocusRef.current;
      if (el && el.isConnected) el.focus();
    };
  }, []);

  // Roving focus: DOM focus follows cards/rows on arrow moves so assistive tech reads selection.
  // Persistent chrome — move only when focus is "already inside panel"; must not steal focus
  // while user types in another pane (decisive difference from modal trap). Do nothing when
  // focus is outside.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || !panel.contains(document.activeElement)) return;
    const raf = requestAnimationFrame(() => { focusActiveItem(); });
    return () => cancelAnimationFrame(raf);
  }, [focusActiveItem]);

  // Keyboard (persistent chrome redesign): removed modal-era global window capture + Tab trap.
  // Handler attaches via onKeyDownCapture on panel DOM and runs only when focus is inside —
  // no keys intercepted when another pane's xterm has focus, so the screen is not caged.
  // Tab is no longer held: native Tab follows role=listbox convention (roving tabindex,
  // arrows=internal move, Tab=widget enter/exit) and can move focus to other panes. Esc closes
  // chrome when focus is inside. Ctrl+Shift+A toggle is useKeyboard global handler.
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setVisible(false);
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
      // Row shortcuts (Enter=approve, Backspace/Delete=deny/dismiss) fire only when the
      // role=option row itself has focus. Previously only <button> was exempt; removing Tab
      // trap let A2A row auto-approve checkbox (input) receive keyboard focus. Enter/Backspace/
      // Delete while checkbox focused must not misfire as row approve/deny (trust boundary) —
      // so any interactive control other than the row itself is not intercepted; native
      // activation (checkbox toggle, button click) owns the keys.
      const onOptionRow =
        active instanceof HTMLElement && active.getAttribute('role') === 'option' &&
        !!panelRef.current?.contains(active);
      if (tab === 'approvals' && inbox.length > 0 && onOptionRow) {
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
      // focused card (mirrors approvals' deny-key path; same onOptionRow guard so a
      // Tab-focused dismiss <button> / checkbox keeps native activation).
      if (tab === 'remote' && remoteInbox.length > 0 && onOptionRow) {
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
    }, [tab, panes.length, inbox, inboxIdx, remoteInbox, remoteIdx, dismissRemoteItem, setVisible]);

  return (
    // Persistent chrome panel: flex sibling in AppLayout tree (no fixed overlay/backdrop),
    // takes width and reflows panes. role=region (not modal), docked on edge opposite sidebar.
    // Keyboard captured via onKeyDownCapture only when focus is inside this panel.
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label={t('fleet.title')}
      data-fleet-view
      onKeyDownCapture={handleKeyDown}
      className={`flex flex-col h-full overflow-hidden outline-none ${dockOnRight ? 'border-l' : 'border-r'}`}
      style={{
        width: 'clamp(300px, 30vw, 460px)',
        backgroundColor: 'var(--bg-base)',
        borderColor: 'var(--bg-surface)',
      }}
    >
        {/* Header: title + "N need you" chip */}
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{ borderBottom: '1px solid var(--bg-surface)' }}
        >
          <span className="text-title text-[var(--text-main)]">{t('fleet.title')}</span>
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
          {/* Persistent chrome: backdrop click-to-close is gone, so explicit close button is required.
              Provides close path alongside Ctrl+Shift+A / Esc (when focus inside). */}
          <button
            type="button"
            onClick={() => setVisible(false)}
            className="text-sm leading-none text-[var(--text-muted)] px-1.5 py-0.5 rounded transition-colors hover:text-[var(--text-main)]"
            style={{ border: '1px solid var(--bg-overlay)' }}
            title={t('fleet.close')}
            aria-label={t('fleet.close')}
          >
            ✕
          </button>
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
              // Shrink card min-width for persistent chrome (narrower than modal 92vw/960px) so
              // grid does not overflow in a narrow panel. Card internals are all truncate so
              // layout holds at 200px (behavior unchanged, visuals naturally differ).
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}
            >
              {panes.map((card, idx) => (
                <FleetCard
                  key={`${card.workspaceId}:${card.paneId}:${card.surfaceId}`}
                  card={card}
                  focused={idx === focusedIdx}
                  onJump={jump}
                  tail={card.ptyId ? tails[card.ptyId] : undefined}
                  resource={card.ptyId ? resources[card.ptyId] : undefined}
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
  );
}
