import { useEffect, useRef, useState } from 'react';
import RemoteMirrorTerminal from './RemoteMirrorTerminal';

export interface RemotePaneSurfaceProps {
  hostId: string;
  sessionId: string;
  surfaceId: string;
  shell?: string;
  cwd?: string;
  /** Stacked/tab case (one surface visible at a time in the pane) — same
   *  isActive→display:none pattern TerminalComponent/BrowserPanel use, so an
   *  inactive remote tab stays mounted (no SSE re-attach on tab switch) but
   *  invisible instead of overlapping the active one. */
  isActive?: boolean;
  onTitleChange: (surfaceId: string, title: string) => void;
}

/**
 * #1086/#1091 — one remote-terminal surface living as an ordinary tab inside
 * a LOCAL workspace's own pane tree, instead of a whole separate
 * "attached remote workspace" (RemoteWorkspaceView's fixed mirror grid).
 *
 * Attach/detach lifecycle is the same shape as RemoteWorkspaceView's
 * `PaneCell` (teardown-then-attach ordering, chained onto the previous
 * detach so a fast remount can't race main's idempotency key) — that
 * component is left untouched (still used by the older mirror-grid view for
 * an ATTACHED remote workspace); this is its single-surface twin for a pane
 * that lives in a normal workspace.
 */
export default function RemotePaneSurface({ hostId, sessionId, surfaceId, shell, cwd, isActive = true, onTitleChange }: RemotePaneSurfaceProps) {
  const [attachId, setAttachId] = useState<string | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [allowInput, setAllowInput] = useState<boolean | undefined>(undefined);
  const teardown = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    let cancelled = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    remote.hostsList().then((hosts) => {
      if (cancelled) return;
      const host = hosts.find((h) => h.id === hostId);
      setAllowInput(host?.allowInput);
    });
    return () => { cancelled = true; };
  }, [hostId]);

  useEffect(() => {
    let cancelled = false;
    const remote = window.electronAPI?.remote;
    if (!remote) return;
    setAttachId(null);
    setError(undefined);
    let openedId: string | null = null;

    const attaching = teardown.current
      .then(() => remote.paneAttach(hostId, sessionId))
      .then((res) => {
        if (res.ok) {
          openedId = res.attachId;
          if (!cancelled) setAttachId(res.attachId);
        } else if (!cancelled) {
          setError(res.error);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      teardown.current = attaching
        .then(() => (openedId ? remote.paneDetach(openedId) : undefined))
        .catch(() => { /* teardown is best effort — main drops it on reload anyway */ });
    };
  }, [hostId, sessionId]);

  return (
    <div className="flex flex-col h-full w-full" style={{ background: 'var(--bg-base)', display: isActive ? 'flex' : 'none' }}>
      {(shell || cwd) && (
        <div
          className="h-6 flex items-center px-2 text-[10px] font-mono truncate flex-shrink-0"
          style={{ color: 'var(--text-subtle)', borderBottom: '1px solid var(--bg-overlay)' }}
        >
          {shell ?? sessionId.slice(0, 8)}
          {cwd ? ` — ${cwd}` : ''}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <RemoteMirrorTerminal
          attachId={attachId}
          error={error}
          readOnly={allowInput === false}
          onTitleChange={(title) => onTitleChange(surfaceId, title)}
        />
      </div>
    </div>
  );
}
