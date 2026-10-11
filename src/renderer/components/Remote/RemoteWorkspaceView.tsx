import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useT } from '../../hooks/useT';
import { useStore } from '../../stores';
import RemoteRepairNotice from './RemoteRepairNotice';
import type { AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';
import type { RemotePaneSummary } from '../../../shared/remoteHosts';
import type { Workspace } from '../../../shared/types';
import RemoteMirrorTerminal from './RemoteMirrorTerminal';
import Button from '../ui/Button';
import Dialog, { DialogBody, DialogHeader } from '../ui/Dialog';
import { FOCUS_RING } from '../focusRing';
import { IconGrid } from '../icons';
import { listedWorkspaces, moaHqId } from '../Moa/moaHqGuard';
import { selectWorkspaceIdName } from '../../stores/selectors/workspaceProjections';
import { getWorkspaceLeafPanes } from '../../../shared/paneUtils';
import { focusNotificationTarget } from '../../hooks/useNotificationListener';
import { openRemoteSessionAsTab } from '../../utils/remotePaneWorkspace';

/** Bounded reads rule: never open more than this many concurrent SSE mirrors
 *  for one workspace — a "+N more panes" note covers the rest. */
const MAX_MIRRORS = 6;

/** 1 → full, 2 → columns, 3-4 → 2×2, 5-6 → 3×2 (brief-specified layout). */
function gridStyle(count: number): CSSProperties {
  if (count <= 1) return { gridTemplateColumns: '1fr', gridTemplateRows: '1fr' };
  if (count === 2) return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr' };
  if (count <= 4) return { gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr' };
  return { gridTemplateColumns: '1fr 1fr 1fr', gridTemplateRows: '1fr 1fr' };
}

/** #1323 — the tabs that already show one of `hostId`'s sessions, as
 *  sessionId → surfaceId. Same rule as addRemoteSurface's one-viewer guard
 *  (findRemoteSurface: any workspace, another computer's shadow and stashed
 *  panes included), so a session the store would refuse to open again is
 *  offered as "Go to tab", never as a dead "Open as tab". One walk per store
 *  change for the whole grid. */
function selectHostTabs(s: { workspaces: readonly Workspace[] }, hostId: string): Record<string, string> {
  const tabs: Record<string, string> = {};
  for (const ws of s.workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const sf of leaf.surfaces) {
        if (sf.surfaceType === 'remote-terminal' && sf.remoteHostId === hostId && sf.remoteSessionId
          && !(sf.remoteSessionId in tabs)) {
          tabs[sf.remoteSessionId] = sf.id;
        }
      }
    }
  }
  return tabs;
}

/** #1323 — "Open as tab": which of the operator's own workspaces receives
 *  the session. The HQ and other computers' (shadow) workspaces are not
 *  offered, the same set the sidebar lists. */
function OpenAsTabDialog({ session, hostLabel, onPick, onClose }: {
  session: string;
  hostLabel: string;
  onPick: (workspaceId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const workspaces = useStore(useShallow((s) => listedWorkspaces(selectWorkspaceIdName(s), moaHqId(s))));
  return (
    <Dialog onClose={onClose} closeOnBackdrop width={380} zIndexClassName="z-[var(--z-modal)]">
      <DialogHeader
        title={t('remote.openAsTab')}
        description={t('remote.openAsTabDescription', { session, host: hostLabel })}
      />
      <DialogBody className="!gap-3">
        <div className="ui-group">
          {workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`ui-row w-full text-left hover:bg-[var(--surface-fill-hover)] ${FOCUS_RING}`}
              onClick={() => onPick(w.id)}
              data-open-as-tab-target={w.id}
            >
              <span className="ui-row-icon" aria-hidden="true"><IconGrid size={14} /></span>
              <span className="ui-row-text">
                <span className="ui-row-title truncate">{w.name}</span>
              </span>
            </button>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
}

/** One pane cell: owns the paneAttach call (and its resulting attachId), the
 *  shell/cwd caption, and the mirror terminal itself. Attach is idempotent in
 *  main, so a StrictMode double-effect here is harmless.
 *
 *  `attachEpoch` re-runs the attach without changing the cell's React key. A
 *  host that slept past RemoteHostClient's reconnect budget comes back with
 *  the SAME remote sessionIds, so nothing in the pane list changes and this
 *  effect would never fire again — the mirror would sit blank forever with no
 *  visible error. The epoch is bumped by the store whenever `stale` clears.
 *
 *  #1323 — the cell stays live while the same session is also open as a tab:
 *  main gives each view its own id on the shared stream and closes the
 *  stream only when the last one detaches. */
function PaneCell({ hostId, hostLabel, remoteWorkspaceId, pane, readOnly, attachEpoch, tabSurfaceId }: {
  hostId: string;
  hostLabel: string;
  /** The host-side workspace this grid mirrors. */
  remoteWorkspaceId: string;
  pane: RemotePaneSummary;
  readOnly: boolean;
  attachEpoch: number | undefined;
  /** The tab that already shows the session, if any (see selectHostTabs). */
  tabSurfaceId: string | null;
}) {
  const t = useT();
  const [picking, setPicking] = useState(false);
  const [attachId, setAttachId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [insecure, setInsecure] = useState(false);
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
    setInsecure(false);
    let openedId: string | null = null;

    const attaching = teardown.current
      .then(() => remote.paneAttach(hostId, pane.sessionId))
      .then((res) => {
        if (res.ok) {
          openedId = res.attachId;
          if (!cancelled) setAttachId(res.attachId);
        } else if (!cancelled) {
          setError(res.error);
          // Needs HTTPS is a standing state, not a transient failure: say so
          // on this pane and on the host's rows, and keep input shut.
          if (res.reason === 'insecure-transport') {
            setInsecure(true);
            useStore.getState().setRemoteHostInsecure(hostId, true);
          }
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

  const session = pane.shell ?? pane.sessionId.slice(0, 8);
  const openAsTab = (workspaceId: string): void => {
    setPicking(false);
    const surfaceId = openRemoteSessionAsTab(() => useStore.getState(), workspaceId, {
      hostId,
      sessionId: pane.sessionId,
      remoteWorkspaceId,
    });
    if (surfaceId) focusNotificationTarget(() => useStore.getState(), { surfaceId });
    else useStore.getState().pushToast({ message: t('remote.openAsTabFailed', { session }), level: 'warn' });
  };

  return (
    <div className="flex flex-col min-h-0 min-w-0" style={{ background: 'var(--bg-base)' }}>
      <div
        className="h-6 flex items-center pl-2 flex-shrink-0"
        style={{ color: 'var(--text-subtle)', borderBottom: '1px solid var(--bg-overlay)' }}
      >
        <span className="flex-1 min-w-0 text-[10px] font-mono truncate">
          {session}
          {pane.cwd ? ` — ${pane.cwd}` : ''}
        </span>
        {/* Offered only once the mirror is live: a host that refused the
            attach would refuse the tab's too. */}
        {(tabSurfaceId !== null || (attachId !== null && !error)) && (
          <Button
            variant="ghost"
            className="h-6 flex-shrink-0 !px-2 !py-0 !text-[11px]"
            aria-label={tabSurfaceId !== null ? undefined : t('remote.openAsTabLabel', { session })}
            onClick={() => (tabSurfaceId !== null
              ? focusNotificationTarget(() => useStore.getState(), { surfaceId: tabSurfaceId })
              : setPicking(true))}
            data-mirror-open-as-tab={tabSurfaceId !== null ? 'open' : 'offer'}
          >
            {tabSurfaceId !== null ? t('remote.goToTab') : `${t('remote.openAsTab')}…`}
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <RemoteMirrorTerminal
          attachId={attachId}
          error={error}
          insecureTransport={insecure}
          readOnly={readOnly}
          hostLabel={hostLabel}
          hostId={hostId}
        />
      </div>
      {picking && (
        <OpenAsTabDialog
          session={session}
          hostLabel={hostLabel || t('remote.hostFallback')}
          onPick={openAsTab}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/**
 * Grid of one attached remote workspace's panes. Mount lifecycle is
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
  const requestRemoteRepair = useStore((s) => s.requestRemoteRepair);
  const tabBySession = useStore(useShallow((s) => selectHostTabs(s, workspace.hostId)));

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

  const visiblePanes = workspace.panes.slice(0, MAX_MIRRORS);
  const hiddenCount = Math.max(0, workspace.panes.length - MAX_MIRRORS);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* The host refused this computer's credential: nothing here will
          reconnect on its own, so say so above the (now frozen) panes. The
          modal is mounted by AppLayout, not here — pairing again removes the
          host and with it this view. */}
      {workspace.insecureTransport && (
        <div className="px-3 py-2 flex-shrink-0">
          <RemoteRepairNotice insecure hostLabel={workspace.hostLabel || t('remote.hostFallback')} />
        </div>
      )}
      {workspace.authRejected && !workspace.insecureTransport && (
        <div className="px-3 py-2 flex-shrink-0">
          <RemoteRepairNotice
            hostLabel={workspace.hostLabel || t('remote.hostFallback')}
            onRepair={() => requestRemoteRepair(workspace.hostId)}
          />
        </div>
      )}
      {allowInput === false && (
        <div
          className="px-3 py-1.5 text-[11px] font-mono flex-shrink-0"
          style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)', color: 'var(--accent)' }}
        >
          {t('remote.readOnly')}
        </div>
      )}
      <div
        className="flex-1 min-h-0"
        style={{ display: 'grid', ...gridStyle(visiblePanes.length), gap: '2px', background: 'var(--bg-surface)' }}
      >
        {visiblePanes.map((pane) => (
          <PaneCell
            key={pane.sessionId}
            hostId={workspace.hostId}
            hostLabel={workspace.hostLabel}
            remoteWorkspaceId={workspace.workspaceId}
            tabSurfaceId={tabBySession[pane.sessionId] ?? null}
            pane={pane}
            readOnly={allowInput === false}
            attachEpoch={workspace.attachEpoch}
          />
        ))}
      </div>
      {hiddenCount > 0 && (
        <div className="px-3 py-1 text-[10px] font-mono flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
          {t('remote.morePanes', { count: hiddenCount })}
        </div>
      )}
    </div>
  );
}
