import { useCallback, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { selectPcRailFeedStale, selectPcRailRowAlias, selectPcRailRows } from '../../stores/selectors/pcRail';
import { remoteWorkspaceAttentionClass, type FleetAttentionClass } from '../../stores/selectors/fleet';
import type { AgentStatus } from '../../../shared/types';
import { StatusMarkView } from './AgentMarks';
import { AGENT_STATUS_ICON } from './agentStatusIcon';
import { normalizeWorkspaceColor, workspaceColorHex } from '../../../shared/workspaceColors';
import { RowOpenSurfaceContext, RowStoreContext } from '../../stores/rowStore';
import { useHostRowStore } from '../../stores/hostRowStore';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { useStore as useZustandStore } from 'zustand';
import WorkspaceItem from './WorkspaceItem';
import { formatShadowWorkspaceId, parseShadowWorkspaceId, pcRailHostState, type PcRailWorkspaceRow } from '../../../shared/pcRail';
import { workspaceShortcutNumber } from '../../../shared/keymap';
import { nextRowIndex } from './sidebarRowKeys';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { findRemoteSurface } from '../../stores/shadowWorkspace';

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

const noop = () => { /* another computer's row offers no local action */ };

/**
 * PC rail: the Workspaces page scoped to one web-paired computer. Its rows
 * are this computer's own row component (WorkspaceItem, with its pane rows)
 * reading a read-only projection of that computer (hostRowStore.ts), in the
 * host's order and numbered as the host numbers them. Opening one builds or
 * activates its shadow workspace; nothing here creates, closes or renames
 * anything on that computer.
 */
export default function HostWorkspaceList({ hostId }: { hostId: string }) {
  const t = useT();
  const host = useStore((s) => s.pcRailHosts.find((h) => h.id === hostId));
  const status = useStore((s) => s.pcRailHostStatus[hostId] ?? 'reachable');
  const fetchedAt = useStore((s) => s.pcRailFeeds[hostId]?.fetchedAt ?? null);
  const stale = useStore((s) => selectPcRailFeedStale(s, hostId));
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const rowStore = useHostRowStore(hostId);
  const rows = useZustandStore(rowStore, (s) => s.workspaces);
  const [keyRowId, setKeyRowId] = useState<string | null>(null);
  const name = host?.label || hostId;
  const state = pcRailHostState(status);
  const offline = state === 'offline' || state === 'insecure' || stale;

  // A row with no terminal (`empty`) has no pane to show: nothing opens.
  const open = useCallback((id: string): boolean => {
    const ref = parseShadowWorkspaceId(id);
    if (offline || !ref || ref.hostId !== hostId) return false;
    return useStore.getState().openShadowWorkspace(hostId, ref.remoteId) !== null;
  }, [hostId, offline]);

  // A pane row: open the workspace, then that tab (the shadow's ids are the
  // ones the row was drawn with).
  const openSurface = useCallback((surfaceId: string) => {
    const ws = rowStore.getState().workspaces.find((w) => getWorkspaceLeafPanes(w).some((l) => l.surfaces.some((s) => s.id === surfaceId)));
    const sessionId = ws && getWorkspaceLeafPanes(ws).flatMap((l) => l.surfaces).find((s) => s.id === surfaceId)?.remoteSessionId;
    if (!ws || !sessionId || !open(ws.id)) return;
    // The shadow may hold that session as an "Open in …" placeholder (it is a
    // tab elsewhere already): go to the tab that shows it.
    const hit = findRemoteSurface(useStore.getState(), hostId, sessionId);
    focusNotificationTarget(() => useStore.getState(), { ptyId: null, surfaceId: hit?.surfaceId ?? surfaceId });
  }, [hostId, open, rowStore]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (!target.hasAttribute('data-sidebar-row')) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const list = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-sidebar-row]')];
    const next = nextRowIndex(e.key, list.indexOf(target), list.length);
    if (next === null) return;
    e.preventDefault();
    list[next].focus();
  }, []);

  let notice: { text: string; action?: { label: string; run: () => void } } | null = null;
  if (state === 'needs-repair') {
    notice = { text: t('pcRail.needsRepair', { name }), action: { label: t('pcRail.pairAgain'), run: () => useStore.getState().requestRemoteRepair(hostId) } };
  } else if (state === 'insecure') {
    notice = { text: t('pcRail.insecure') };
  } else if (state === 'offline') {
    notice = { text: fetchedAt !== null ? t('pcRail.offlineLastSeen', { time: clockTime(fetchedAt) }) : t('pcRail.offline') };
  } else if (stale && fetchedAt !== null) {
    notice = { text: t('pcRail.updatedAgo', { time: clockTime(fetchedAt) }) };
  }

  const activeRowId = rows.some((w) => w.id === activeWorkspaceId) ? activeWorkspaceId : undefined;
  const tabStopId = keyRowId ?? activeRowId ?? rows[0]?.id;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-0 pb-2" data-host-workspaces={hostId}>
      {notice && (
        <p className="mx-4 mb-1 text-[11px] text-[var(--text-muted)]" role="status" data-host-notice={state}>
          {notice.text}
          {notice.action && (
            <>
              {' · '}
              <button type="button" className="underline" onClick={notice.action.run}>{notice.action.label}</button>
            </>
          )}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="mx-4 mt-2 text-[12px] text-[var(--text-muted)]" data-host-empty>
          {t('pcRail.noWorkspaces', { name })}
        </p>
      ) : (
        <RowStoreContext.Provider value={rowStore}>
          <RowOpenSurfaceContext.Provider value={openSurface}>
            <div role="tree" aria-label={name} className={`space-y-0.5 ${offline ? 'opacity-60' : ''}`} onKeyDown={onKeyDown} data-sidebar-tree
              onFocus={(e) => setKeyRowId((e.target as HTMLElement).getAttribute('data-sidebar-row'))}
              onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyRowId(null); }}
            >
              {rows.map((ws, i) => (
                <WorkspaceItem
                  key={ws.id}
                  workspaceId={ws.id}
                  isActive={ws.id === activeRowId}
                  isMultiview={false}
                  index={i}
                  shortcutNumber={workspaceShortcutNumber(i, rows.length)}
                  onSelect={open}
                  onCtrlSelect={open}
                  onRename={noop}
                  onClose={noop}
                  onArchive={noop}
                  onCopyInfo={noop}
                  onDuplicate={noop}
                  onReorder={noop}
                  tabStop={ws.id === tabStopId}
                />
              ))}
            </div>
          </RowOpenSurfaceContext.Provider>
        </RowStoreContext.Provider>
      )}
    </div>
  );
}


/** The row's mark: the status of its loudest agent pane, by the same class rule. */
const MARK_STATUS: Record<FleetAttentionClass, AgentStatus> = {
  needsYou: 'awaiting_input',
  error: 'error',
  finished: 'complete',
  running: 'running',
  unconfirmed: 'running',
  idle: 'idle',
};


/**
 * The collapsed rail's workspace avatars while a paired computer is selected:
 * the same rows as the expanded list, drawn as the local avatars are (initial
 * plus position, colour rail, status mark in the corner). Opening one is the
 * list's open; nothing local is offered (no drag, no unread, no new workspace).
 */
export function HostRailAvatars({ hostId }: { hostId: string }) {
  const status = useStore((s) => s.pcRailHostStatus[hostId] ?? 'reachable');
  const rows = useStore((s) => selectPcRailRows(s, hostId));
  const stale = useStore((s) => selectPcRailFeedStale(s, hostId));
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const state = pcRailHostState(status);
  const offline = state === 'offline' || state === 'insecure' || stale;
  const open = useCallback((row: PcRailWorkspaceRow) => {
    if (offline || row.empty) return;
    useStore.getState().openShadowWorkspace(hostId, row.id);
    useStore.getState().setAppRoute('workspaces');
  }, [hostId, offline]);
  return (
    <div className="flex-1 overflow-y-auto py-2 flex flex-col items-center gap-1" data-host-rail={hostId}>
      {rows.map((row, i) => (
        <HostRailAvatar
          key={row.id}
          hostId={hostId}
          row={row}
          position={i + 1}
          isActive={formatShadowWorkspaceId(hostId, row.id) === activeWorkspaceId}
          disabled={offline || !!row.empty}
          onOpen={open}
        />
      ))}
    </div>
  );
}

function HostRailAvatar({ hostId, row, position, isActive, disabled, onOpen }: {
  hostId: string;
  row: PcRailWorkspaceRow;
  position: number;
  isActive: boolean;
  disabled: boolean;
  onOpen: (row: PcRailWorkspaceRow) => void;
}) {
  const t = useT();
  const aliasLabel = useStore((s) => selectPcRailRowAlias(s, hostId, row.id)?.label);
  const aliasColor = useStore((s) => selectPcRailRowAlias(s, hostId, row.id)?.color);
  const displayName = aliasLabel || row.name || row.id;
  const tagHex = workspaceColorHex(normalizeWorkspaceColor(aliasColor ?? row.color));
  const attention = remoteWorkspaceAttentionClass({ panes: row.panes, stale: disabled && !row.empty });
  const markStatus = MARK_STATUS[attention];
  const statusText = attention === 'needsYou' ? t('workspace.needsYou')
    : markStatus !== 'idle' ? t(AGENT_STATUS_ICON[markStatus].labelKey) : undefined;
  const name = [displayName, statusText].filter(Boolean).join(', ');
  return (
    <div className="relative w-8">
      {tagHex && (
        <div className="absolute top-1 bottom-1 w-[3px] rounded-full z-[1] pointer-events-none" style={{ left: 0, background: tagHex }} aria-hidden="true" />
      )}
      <button
        type="button"
        className={`relative w-8 h-8 rounded-md flex items-center justify-center text-[10px] font-bold font-mono select-none transition-colors ${
          isActive
            ? 'bg-[var(--selection)] text-[var(--text-main)]'
            : 'text-[color-mix(in_srgb,var(--text-main)_50%,transparent)] hover:bg-[var(--hover-fill)] hover:text-[var(--text-main)]'
        } ${disabled ? 'opacity-60' : ''}`}
        aria-disabled={disabled || undefined}
        onClick={() => onOpen(row)}
        title={name}
        aria-label={name}
        aria-current={isActive ? 'true' : undefined}
        data-host-rail-workspace={row.id}
      >
        {`${Array.from(displayName)[0]?.toUpperCase() ?? '?'}${position}`}
        {statusText && (
          <span className="absolute -bottom-0.5 -right-0.5 flex items-center justify-center rounded-full bg-[var(--bg-mantle)]" data-rail-status>
            <StatusMarkView status={markStatus} />
          </span>
        )}
      </button>
    </div>
  );
}
