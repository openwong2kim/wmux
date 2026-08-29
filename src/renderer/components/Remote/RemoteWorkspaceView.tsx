import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import type { AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';
import type { RemotePaneSummary } from '../../../shared/remoteHosts';
import RemoteMirrorTerminal from './RemoteMirrorTerminal';
import RemotePaneContainer from './RemotePaneContainer';
import {
  type RemotePaneNode,
  applySizes,
  leafIds,
  reconcile,
  removeLeaf,
  splitLeaf,
} from './remotePaneTree';

/**
 * A bare leaf render (no Group/Panel) at the SAME position a branch would
 * render (Group -> Panel -> leaf) is a different React element TYPE — React
 * unmounts and remounts the whole subtree on that transition, tearing down
 * and re-attaching a survivor's live SSE mirror for no reason (a live
 * regression: collapsing a 2-pane split down to 1 pane by closing the other
 * one detached AND re-attached the survivor). Wrapping every render in a
 * trivial single-child "branch" keeps the outer element type constant across
 * the 1-pane <-> N-pane transition, at the render boundary only — the STORED
 * tree still uses a bare leaf for 1 pane, which keeps splitLeaf/removeLeaf's
 * own invariants (and their tests) simple.
 */
function wrapForRender(node: RemotePaneNode): RemotePaneNode {
  if (node.type === 'branch') return node;
  return { id: `${node.id}-solo`, type: 'branch', direction: 'horizontal', children: [node] };
}

/** Bounded reads rule: never open more than this many concurrent SSE mirrors
 *  for one workspace — a "+N more panes" note covers the rest. Applied by
 *  capping which session ids ever enter the split tree (`reconcile` below),
 *  not by capping the tree's own rendering. */
const MAX_MIRRORS = 6;

/** One pane cell: owns the paneAttach call (and its resulting attachId), the
 *  shell/cwd caption, and the mirror terminal itself. Attach is idempotent in
 *  main, so a StrictMode double-effect here is harmless.
 *
 *  `attachEpoch` re-runs the attach without changing the cell's React key. A
 *  host that slept past RemoteHostClient's reconnect budget comes back with
 *  the SAME remote sessionIds, so nothing in the pane list changes and this
 *  effect would never fire again — the mirror would sit blank forever with no
 *  visible error. The epoch is bumped by the store whenever `stale` clears. */
function PaneCell({ hostId, pane, readOnly, attachEpoch, onClose, closeLabel }: {
  hostId: string;
  pane: RemotePaneSummary;
  readOnly: boolean;
  attachEpoch: number | undefined;
  /** Undefined when this pane can't be closed from here — read-only hosts
   *  (#1091, #1067's parity ask): closing panes is spawn's mirror image, so
   *  it goes through `mayInput` too, same as add. */
  onClose?: (sessionId: string) => void;
  closeLabel: string;
}) {
  const [attachId, setAttachId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  /** The previous run's detach. Main keys attach idempotency on
   *  (sender, host, session), so the old and the new attach are the SAME
   *  record: if the re-attach reached main first it would be handed the dying
   *  attachId, and the detach behind it would then kill the stream we had just
   *  asked for. Waiting on this makes the order teardown-then-attach. */
  const teardown = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    setAttachId(null);
    setError(undefined);
    let openedId: string | null = null;

    const attaching = teardown.current
      .then(() => remote.paneAttach(hostId, pane.sessionId))
      .then((res) => {
        if (res.ok) {
          openedId = res.attachId;
          if (!cancelled) setAttachId(res.attachId);
        } else if (!cancelled) {
          setError(res.error);
        }
      })
      .catch((err: unknown) => {
        // Unexpected IPC rejection (not the {ok:false} result path) — surface
        // it the same way a rejected attach result does, rather than leaving
        // this cell silently stuck with attachId: null forever.
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      // Panes now come and go with the poll, so a cell can unmount while its
      // attach is still in flight. Chaining the detach onto the attach is what
      // stops that from leaving a live SSE stream behind in main.
      teardown.current = attaching
        .then(() => (openedId ? remote.paneDetach(openedId) : undefined))
        .catch(() => { /* teardown is best effort — main drops it on reload anyway */ });
    };
  }, [hostId, pane.sessionId, attachEpoch]);

  return (
    <div className="flex flex-col min-h-0 min-w-0" style={{ background: 'var(--bg-base)' }}>
      <div
        className="h-6 flex items-center gap-1 px-2 text-[10px] font-mono flex-shrink-0"
        style={{ color: 'var(--text-subtle)', borderBottom: '1px solid var(--bg-overlay)' }}
      >
        <span className="truncate flex-1 min-w-0">
          {pane.shell ?? pane.sessionId.slice(0, 8)}
          {pane.cwd ? ` — ${pane.cwd}` : ''}
        </span>
        {onClose && (
          <button
            type="button"
            title={closeLabel}
            aria-label={closeLabel}
            onClick={() => onClose(pane.sessionId)}
            className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded hover:bg-[var(--bg-overlay)]"
            style={{ color: 'var(--text-subtle)' }}
          >
            ×
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <RemoteMirrorTerminal attachId={attachId} error={error} readOnly={readOnly} />
      </div>
    </div>
  );
}

/**
 * Resizable split view of one attached remote workspace's panes (#1091 —
 * replaced the earlier fixed mirror grid with a real, user-controlled split
 * tree, parity with a local workspace). Mount lifecycle is
 * hidden-but-alive — WorkspaceCenter renders one of these per attached
 * remote workspace and toggles display:none by activeRemoteKey, the same
 * technique WorkspaceViewport uses for local workspaces. Unmounting on every
 * sidebar switch would re-attach every SSE stream and repaint the full
 * snapshot each time.
 *
 * Known cost of that rule now that attachments are restored on boot: launching
 * the app alone opens up to MAX_MIRRORS authenticated streams per restored
 * workspace, before the user has selected any of them. Attaching lazily on
 * first selection would fix it, but it is a change to the mount contract this
 * view shares with WorkspaceCenter, not a tweak here — deliberately left out
 * of the lifecycle fix.
 */
export default function RemoteWorkspaceView({ workspace }: { workspace: AttachedRemoteWorkspace }) {
  const t = useT();
  // RemoteHostPublic.allowInput may be stale/undefined right after app
  // restart until a probe runs. This view's own hostsList() call (fired once,
  // at mount — the view stays mounted for the app session per the
  // hidden-but-alive rule above) is that probe.
  const [allowInput, setAllowInput] = useState<boolean | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  // The split tree (#1091). Local-only, rebuilt from `workspace.panes` by the
  // reconcile effect below — see remotePaneTree.ts's header comment for why
  // this is a separate structure from both the server pane list and the
  // local-workspace pane tree.
  const [layout, setLayout] = useState<RemotePaneNode | null>(null);
  // Which leaf a split targets. Falls back to the tree's first leaf when
  // nothing has been clicked yet (e.g. right after the very first pane
  // attaches) so "Split" always has somewhere to act on.
  const [activeLeafId, setActiveLeafId] = useState<string | null>(null);

  const visibleSessionIds = useMemo(
    () => workspace.panes.slice(0, MAX_MIRRORS).map((p) => p.sessionId),
    [workspace.panes],
  );
  const visibleSessionIdsKey = visibleSessionIds.join(',');

  // Keyed on visibleSessionIdsKey, not visibleSessionIds: the array is
  // recreated every render, the key is stable unless the actual ids change —
  // same discipline PaneContainer's childIdKey uses.
  useEffect(() => {
    setLayout((prev) => reconcile(prev, visibleSessionIds));
  }, [visibleSessionIdsKey]);

  useEffect(() => {
    if (activeLeafId && layout && leafIds(layout).includes(activeLeafId)) return;
    setActiveLeafId(layout ? leafIds(layout)[0] ?? null : null);
  }, [layout, activeLeafId]);

  useEffect(() => {
    let cancelled = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    remote.hostsList().then((hosts) => {
      if (cancelled) return;
      const host = hosts.find((h) => h.id === workspace.hostId);
      setAllowInput(host?.allowInput);
    });
    return () => { cancelled = true; };
  }, [workspace.hostId]);

  // Grow/shrink the SAME workspace on the remote host (#1091 — parity with a
  // local workspace's add/close pane). Both apply the result straight to
  // `remoteWorkspaces` via `setRemoteWorkspacePanes`'s merge — an add appends
  // the new sessionId (mergePaneSets keeps anything present in the next list),
  // a close is a filter of the current list — rather than waiting up to
  // POLL_INTERVAL_MS for `useRemoteAttachmentsLifecycle`'s own refetch to
  // notice, so the workspace visibly grows/shrinks the moment the request
  // that did it succeeds.
  const handleAddPane = useCallback(async (direction: 'horizontal' | 'vertical') => {
    const remote = window.electronAPI?.remote;
    if (!remote || pending) return;
    setPending(true);
    setActionError(undefined);
    try {
      const res = await remote.workspacePaneAdd(workspace.hostId, workspace.workspaceId);
      if (!res.ok) {
        setActionError(t('remote.addPaneFailed'));
        return;
      }
      const nextPanes: RemotePaneSummary[] = [...workspace.panes, { sessionId: res.sessionId }];
      useStore.getState().setRemoteWorkspacePanes(workspace.key, nextPanes);
      setLayout((prev) => {
        if (!prev) return { id: res.sessionId, type: 'leaf' };
        const target = activeLeafId && leafIds(prev).includes(activeLeafId) ? activeLeafId : leafIds(prev)[0];
        return target ? splitLeaf(prev, target, res.sessionId, direction) : prev;
      });
      setActiveLeafId(res.sessionId);
    } catch {
      setActionError(t('remote.addPaneFailed'));
    } finally {
      setPending(false);
    }
  }, [workspace.hostId, workspace.workspaceId, workspace.key, workspace.panes, pending, activeLeafId, t]);

  const handleClosePane = useCallback(async (sessionId: string) => {
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    setActionError(undefined);
    try {
      const res = await remote.sessionClose(workspace.hostId, sessionId);
      if (!res.ok) {
        setActionError(t('remote.closePaneFailed'));
        return;
      }
      const nextPanes = workspace.panes.filter((p) => p.sessionId !== sessionId);
      useStore.getState().setRemoteWorkspacePanes(workspace.key, nextPanes);
      setLayout((prev) => (prev ? removeLeaf(prev, sessionId) : prev));
    } catch {
      setActionError(t('remote.closePaneFailed'));
    }
  }, [workspace.hostId, workspace.key, workspace.panes, t]);

  const handleResize = useCallback((branchId: string, sizes: number[]) => {
    setLayout((prev) => (prev ? applySizes(prev, branchId, sizes) : prev));
  }, []);

  const readOnly = allowInput === false;
  const hiddenCount = Math.max(0, workspace.panes.length - MAX_MIRRORS);
  // A read-only host has no mayInput grant server-side either — add/close
  // would just 403, so don't offer them (same gate handleSessionCreate and
  // handleSessionDelete apply on WebTerminalServer).
  const canManagePanes = !readOnly;

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {readOnly && (
        <div
          className="px-3 py-1.5 text-[11px] font-mono flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
        >
          {t('remote.readOnly')}
        </div>
      )}
      {actionError && (
        <div
          className="px-3 py-1.5 text-[11px] font-mono flex-shrink-0 cursor-pointer"
          style={{ background: 'color-mix(in srgb, var(--accent-red, red) 12%, transparent)', color: 'var(--accent-red, red)' }}
          onClick={() => setActionError(undefined)}
        >
          {actionError}
        </div>
      )}
      <div
        className="flex-1 min-h-0"
        style={{ background: 'var(--bg-surface)' }}
      >
        {layout && (
          <RemotePaneContainer
            node={wrapForRender(layout)}
            onResize={handleResize}
            renderLeaf={(leaf) => {
              const pane = workspace.panes.find((p) => p.sessionId === leaf.id);
              if (!pane) return null;
              return (
                <div
                  className="h-full w-full"
                  onMouseDown={() => setActiveLeafId(leaf.id)}
                  style={leaf.id === activeLeafId ? { outline: '1px solid var(--accent-blue)', outlineOffset: '-1px' } : undefined}
                >
                  <PaneCell
                    hostId={workspace.hostId}
                    pane={pane}
                    readOnly={readOnly}
                    attachEpoch={workspace.attachEpoch}
                    onClose={canManagePanes ? handleClosePane : undefined}
                    closeLabel={t('remote.closePane')}
                  />
                </div>
              );
            }}
          />
        )}
      </div>
      {hiddenCount > 0 && (
        <div className="px-3 py-1 text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
          {t('remote.morePanes', { count: hiddenCount })}
        </div>
      )}
      {canManagePanes && (
        <div className="px-2 py-1 flex-shrink-0 border-t flex items-center gap-1" style={{ borderColor: 'var(--bg-overlay)' }}>
          <button
            type="button"
            disabled={pending}
            onClick={() => { void handleAddPane('horizontal'); }}
            className="text-[11px] font-mono px-2 py-1 rounded hover:bg-[var(--bg-overlay)] disabled:opacity-50"
            style={{ color: 'var(--text-subtle)' }}
          >
            {t('remote.splitRight')}
          </button>
          <button
            type="button"
            title={t('remote.splitDown')}
            disabled={pending}
            onClick={() => { void handleAddPane('vertical'); }}
            className="text-[11px] font-mono px-2 py-1 rounded hover:bg-[var(--bg-overlay)] disabled:opacity-50"
            style={{ color: 'var(--text-subtle)' }}
          >
            {t('remote.splitDown')}
          </button>
        </div>
      )}
    </div>
  );
}
