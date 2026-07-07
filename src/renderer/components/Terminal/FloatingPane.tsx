import { useRef, useEffect, useCallback } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { useIpc } from '../../hooks/useIpc';
import { withDefaultShell } from '../../utils/ptyCreateOptions';
import '@xterm/xterm/css/xterm.css';

export default function FloatingPane() {
  const floatingPaneVisible = useStore((s) => s.floatingPaneVisible);
  const floatingPanePtyId = useStore((s) => s.floatingPanePtyId);
  const defaultShell = useStore((s) => s.defaultShell);
  const paneGate = useStore((s) => s.paneGate);
  const toggleFloatingPane = useStore((s) => s.toggleFloatingPane);
  const setFloatingPanePtyId = useStore((s) => s.setFloatingPanePtyId);
  const t = useT();
  const { invoke: ipcInvoke } = useIpc();

  const containerRef = useRef<HTMLDivElement>(null);
  const creatingRef = useRef(false);

  // Create PTY on first open. Routed through ipcInvoke so a RESOURCE_EXHAUSTED
  // rejection (daemon session cap reached) shows an actionable toast instead
  // of being silently swallowed by the previous .catch(() => {}) — that left
  // the floating pane shortcut looking unresponsive when the cap was hit.
  //
  // paneGate (S-A Step 1): this component mounts OUTSIDE the paneGate
  // placeholder subtree, so with the renderer loading in parallel with the
  // daemon bootstrap this effect can fire while the LOCAL→DAEMON handler
  // swap is still in flight — a create in that window mints a local-mode id
  // whose writes the daemon handler silently drops (dda4c0c). Defer the
  // create until the gate flips; paneGate is in the deps, so an early
  // Ctrl+` simply creates the PTY the moment startup reconcile completes.
  useEffect(() => {
    if (paneGate !== 'ready') return;
    if (!floatingPaneVisible) return;
    if (floatingPanePtyId) return;
    if (creatingRef.current) return;

    creatingRef.current = true;
    void ipcInvoke<{ id: string }>(() =>
      window.electronAPI.pty.create(withDefaultShell({ spawnKind: 'user-shell' }, defaultShell))
    ).then((result) => {
      if (result.ok) {
        setFloatingPanePtyId(result.data.id);
      }
      // On failure useIpc already surfaced a toast.
      creatingRef.current = false;
    });
  }, [defaultShell, floatingPaneVisible, floatingPanePtyId, setFloatingPanePtyId, ipcInvoke, paneGate]);

  useTerminal(containerRef, {
    ptyId: floatingPanePtyId,
    isVisible: floatingPaneVisible,
  });

  // Close on ESC while pane is focused
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      toggleFloatingPane();
    }
  }, [toggleFloatingPane]);

  // Close when clicking backdrop
  const handleBackdropClick = useCallback((e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      toggleFloatingPane();
    }
  }, [toggleFloatingPane]);

  if (!floatingPanePtyId && !floatingPaneVisible) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-label={t('floatingPane.title')}
      aria-modal="true"
      onKeyDown={handleKeyDown}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        display: floatingPaneVisible ? 'flex' : 'none',
        flexDirection: 'column',
        justifyContent: 'flex-end',
        backgroundColor: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={handleBackdropClick}
    >
      {/* Panel */}
      <div
        style={{
          position: 'relative',
          bottom: 0,
          left: 0,
          right: 0,
          height: '50vh',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-surface)',
          borderTop: '1px solid var(--bg-overlay)',
          boxShadow: '0 -8px 32px rgba(0, 0, 0, 0.5)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar / drag handle */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 32,
            paddingLeft: 12,
            paddingRight: 8,
            flexShrink: 0,
            backgroundColor: 'var(--bg-overlay)',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            userSelect: 'none',
          }}
        >
          {/* Drag handle indicator */}
          <div
            style={{
              width: 32,
              height: 3,
              borderRadius: 2,
              backgroundColor: 'var(--text-sub2)',
              opacity: 0.4,
              marginRight: 10,
              flexShrink: 0,
            }}
          />
          <span
            style={{
              flex: 1,
              fontSize: 11,
              fontFamily: 'ui-monospace, monospace',
              fontWeight: 600,
              color: 'var(--text-sub)',
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
            }}
          >
            {t('floatingPane.title')}
          </span>
          <button
            onClick={toggleFloatingPane}
            title={t('floatingPane.close')}
            aria-label={t('floatingPane.close')}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-sub2)',
              fontSize: 14,
              lineHeight: 1,
              padding: '4px 6px',
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              transition: 'color 0.15s, background 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-main)';
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.08)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-sub2)';
              (e.currentTarget as HTMLButtonElement).style.background = 'none';
            }}
          >
            ✕
          </button>
        </div>

        {/* Terminal container */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            padding: '4px 2px 2px 2px',
          }}
        />
      </div>
    </div>
  );
}
