import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { useT } from '../../hooks/useT';

export interface RemoteMirrorTerminalProps {
  /** null while the pane attach is still in flight. */
  attachId: string | null;
  /** Set when the attach itself failed (e.g. a rejected paneAttach). */
  error?: string;
}

/** Decode a base64 payload into raw bytes and hand it to xterm as-is — the
 *  same pattern useTerminal.ts uses for its dead-snapshot repaint
 *  (`Uint8Array.from(atob(b64), c => c.charCodeAt(0))`), so multi-byte UTF-8
 *  sequences split across the wire boundary decode correctly via xterm's own
 *  parser instead of a lossy JS string round-trip. */
function decodeBase64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * One @xterm/xterm mirror of a single remote pane. Read-mostly: the remote's
 * meta event (cols/rows) is the ONLY thing that drives `term.resize()` — this
 * component never calls a resize API back toward the remote (geometry has a
 * single owner, the remote daemon). A container/remote aspect mismatch is
 * letterboxed by the parent's CSS, not by resizing the terminal.
 */
export default function RemoteMirrorTerminal({ attachId, error }: RemoteMirrorTerminalProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exited, setExited] = useState(false);

  // Mount the xterm instance once, for the lifetime of this component.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({ convertEol: false, scrollback: 2000, disableStdin: false });
    term.open(containerRef.current);
    termRef.current = term;
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Subscribe/attach lifecycle keyed on attachId. Geometry arrives once per
  // connection — every onPaneMeta (fresh attach OR reconnect) means "reset
  // terminal, resize, repaint", never a delta.
  useEffect(() => {
    if (!attachId) return;
    setExited(false);
    const remote = window.electronAPI?.remote;
    if (!remote) return;

    const offMeta = remote.onPaneMeta((e) => {
      if (e.attachId !== attachId) return;
      const term = termRef.current;
      if (!term) return;
      term.reset();
      term.resize(e.cols, e.rows);
      term.write(decodeBase64Bytes(e.snapshotB64));
    });
    const offData = remote.onPaneData((e) => {
      if (e.attachId !== attachId) return;
      const term = termRef.current;
      if (!term) return;
      term.write(decodeBase64Bytes(e.dataB64));
    });
    const offExit = remote.onPaneExit((e) => {
      if (e.attachId !== attachId) return;
      setExited(true);
    });
    const dataDisposable = termRef.current?.onData((data) => {
      remote.paneWrite(attachId, data);
    });

    return () => {
      offMeta();
      offData();
      offExit();
      dataDisposable?.dispose();
      remote.paneDetach(attachId);
    };
  }, [attachId]);

  return (
    <div className="relative w-full h-full min-h-0 min-w-0">
      <div ref={containerRef} className="absolute inset-0" />
      {error && (
        <div
          className="absolute inset-0 flex items-center justify-center text-[11px] font-mono px-2 text-center"
          style={{ color: 'var(--accent-red)', background: 'var(--bg-base)' }}
        >
          {error}
        </div>
      )}
      {exited && (
        <div
          className="absolute bottom-0 left-0 right-0 px-2 py-1 text-[10px] font-mono"
          style={{ color: 'var(--text-muted)', background: 'rgba(0,0,0,0.55)' }}
        >
          {t('remote.exited')}
        </div>
      )}
    </div>
  );
}
