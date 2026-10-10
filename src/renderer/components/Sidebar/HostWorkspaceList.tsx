import { useCallback, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import { selectPcRailFeedStale, selectPcRailRowAlias, selectPcRailRows } from '../../stores/selectors/pcRail';
import { remoteWorkspaceAttentionClass } from '../../stores/selectors/fleet';
import { formatShadowWorkspaceId, pcRailHostState, type PcRailWorkspaceRow } from '../../../shared/pcRail';
import { normalizeWorkspaceColor, workspaceColorHex } from '../../../shared/workspaceColors';
import { nextRowIndex } from './sidebarRowKeys';

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * PC rail: the Workspaces page scoped to one web-paired computer. Its rows
 * come from the host's own list (pcRailFeeds), in the host's order; opening
 * one builds or activates its shadow workspace. Nothing here creates,
 * closes or renames anything on that computer.
 */
export default function HostWorkspaceList({ hostId }: { hostId: string }) {
  const t = useT();
  const host = useStore((s) => s.pcRailHosts.find((h) => h.id === hostId));
  const status = useStore((s) => s.pcRailHostStatus[hostId] ?? 'reachable');
  const rows = useStore((s) => selectPcRailRows(s, hostId));
  const fetchedAt = useStore((s) => s.pcRailFeeds[hostId]?.fetchedAt ?? null);
  const stale = useStore((s) => selectPcRailFeedStale(s, hostId));
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const [keyRowId, setKeyRowId] = useState<string | null>(null);
  const name = host?.label || hostId;
  const state = pcRailHostState(status);
  const offline = state === 'offline' || state === 'insecure' || stale;

  const open = useCallback((row: PcRailWorkspaceRow) => {
    if (offline || row.empty) return;
    useStore.getState().openShadowWorkspace(hostId, row.id);
  }, [hostId, offline]);

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

  const activeRowId = rows.find((r) => formatShadowWorkspaceId(hostId, r.id) === activeWorkspaceId)?.id;
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
        <div role="tree" aria-label={name} className="space-y-0.5" onKeyDown={onKeyDown}
          onFocus={(e) => setKeyRowId((e.target as HTMLElement).getAttribute('data-sidebar-row'))}
          onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyRowId(null); }}
        >
          {rows.map((row) => (
            <HostWorkspaceRow
              key={row.id}
              hostId={hostId}
              row={row}
              isActive={row.id === activeRowId}
              disabled={offline || !!row.empty}
              tabStop={row.id === tabStopId}
              onOpen={open}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HostWorkspaceRow({ hostId, row, isActive, disabled, tabStop, onOpen }: {
  hostId: string;
  row: PcRailWorkspaceRow;
  isActive: boolean;
  disabled: boolean;
  tabStop: boolean;
  onOpen: (row: PcRailWorkspaceRow) => void;
}) {
  const t = useT();
  const alias = useStore((s) => selectPcRailRowAlias(s, hostId, row.id));
  // The host's own name; a host that sends none (locked desktop, old build) is named by id.
  const displayName = alias?.label || row.name || row.id;
  const tagHex = workspaceColorHex(normalizeWorkspaceColor(alias?.color ?? row.color));
  const attention = remoteWorkspaceAttentionClass({ panes: row.panes, stale: disabled && !row.empty });
  const needsYou = attention === 'needsYou';
  const errored = attention === 'error';
  return (
    <div className="relative mx-2">
      <div
        role="treeitem"
        aria-level={1}
        tabIndex={tabStop ? 0 : -1}
        aria-selected={isActive}
        aria-disabled={disabled || undefined}
        data-sidebar-row={row.id}
        data-host-row={row.id}
        className={`group sidebar-row px-2.5 py-2 rounded-md select-none ${disabled ? 'cursor-default' : 'cursor-pointer'} ${needsYou ? 'sidebar-row-needs' : ''} ${isActive ? 'sidebar-row-active' : ''}`}
        onClick={() => onOpen(row)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(row);
          }
        }}
      >
        <div className={`flex min-w-0 items-center gap-2 ${disabled ? 'opacity-60' : ''}`}>
          <div
            className="w-1.5 h-1.5 rounded-full flex-shrink-0"
            style={{ backgroundColor: tagHex ?? (needsYou ? 'var(--attention)' : isActive ? 'var(--accent)' : 'var(--text-muted)') }}
          />
          <div className="flex-1 min-w-0">
            <div className="text-caption font-mono truncate">{displayName}</div>
            {row.gitBranch && (
              <div className="mt-0.5 text-[11px] font-mono truncate" style={{ color: 'color-mix(in srgb, var(--text-main) 45%, transparent)' }}>
                {row.gitBranch}
              </div>
            )}
          </div>
          {needsYou && (
            <span className="font-sans text-[11px] font-medium text-[var(--attention-text)] flex-shrink-0">{t('workspace.needsYou')}</span>
          )}
          {errored && (
            <span className="font-sans text-[11px] font-medium text-[var(--accent-red)] flex-shrink-0">{t('workspace.agentError')}</span>
          )}
        </div>
      </div>
    </div>
  );
}
