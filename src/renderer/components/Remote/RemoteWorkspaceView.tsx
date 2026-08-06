import { useEffect, useState, type CSSProperties } from 'react';
import { useT } from '../../hooks/useT';
import type { AttachedRemoteWorkspace } from '../../stores/slices/remoteWorkspacesSlice';
import type { RemotePaneSummary } from '../../../shared/remoteHosts';
import RemoteMirrorTerminal from './RemoteMirrorTerminal';

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

/** One pane cell: owns the paneAttach call (and its resulting attachId), the
 *  shell/cwd caption, and the mirror terminal itself. Attach is idempotent in
 *  main, so a StrictMode double-effect here is harmless. */
function PaneCell({ hostId, pane, readOnly }: { hostId: string; pane: RemotePaneSummary; readOnly: boolean }) {
  const [attachId, setAttachId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    remote.paneAttach(hostId, pane.sessionId).then((res) => {
      if (cancelled) return;
      if (res.ok) setAttachId(res.attachId);
      else setError(res.error);
    }).catch((err: unknown) => {
      // Unexpected IPC rejection (not the {ok:false} result path) — surface
      // it the same way a rejected attach result does, rather than leaving
      // this cell silently stuck with attachId: null forever.
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [hostId, pane.sessionId]);

  return (
    <div className="flex flex-col min-h-0 min-w-0" style={{ background: 'var(--bg-base)' }}>
      <div
        className="h-6 flex items-center px-2 text-[10px] font-mono truncate flex-shrink-0"
        style={{ color: 'var(--text-subtle)', borderBottom: '1px solid var(--bg-overlay)' }}
      >
        {pane.shell ?? pane.sessionId.slice(0, 8)}
        {pane.cwd ? ` — ${pane.cwd}` : ''}
      </div>
      <div className="flex-1 min-h-0">
        <RemoteMirrorTerminal attachId={attachId} error={error} readOnly={readOnly} />
      </div>
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
 */
export default function RemoteWorkspaceView({ workspace }: { workspace: AttachedRemoteWorkspace }) {
  const t = useT();
  // RemoteHostPublic.allowInput may be stale/undefined right after app
  // restart until a probe runs. This view's own hostsList() call (fired once,
  // at mount — the view stays mounted for the app session per the
  // hidden-but-alive rule above) is that probe.
  const [allowInput, setAllowInput] = useState<boolean | undefined>(undefined);

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
          <PaneCell key={pane.sessionId} hostId={workspace.hostId} pane={pane} readOnly={allowInput === false} />
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
