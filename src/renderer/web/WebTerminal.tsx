/**
 * Browser-build stand-in (vite.web.config.ts) for components/Terminal/Terminal:
 * it mounts the desktop's REAL TerminalComponent for a pane that is shown and
 * holds one of the page's live stream slots (webPty.ts), and a static body for
 * every other case.
 *
 *  - No ptyId → never mount TerminalComponent (its self-create path would call
 *    `pty.create`, which the browser must never reach).
 *  - Not shown (inactive tab, hidden workspace, off the phone's zoomed pane)
 *    → nothing mounted and no slot held, so no stream is open for it.
 *  - Shown without a slot → a placeholder with a button that takes a slot from
 *    the least recently activated live pane.
 *  - The grid is the desktop's (`fixedGeometry` from /api/sessions and the
 *    stream's `meta`); scrollback restore and the PTY-created callback are
 *    desktop-only and are not passed on.
 */
import { useEffect, useSyncExternalStore } from 'react';
import TerminalComponent from '../components/Terminal/Terminal';
import { useStore } from '../stores';
import { useT } from '../hooks/useT';
import { findLeaf, findLeafBySurfaceId, getLeafPanes } from '../../shared/paneUtils';
import { FOCUS_RING } from '../components/focusRing';
import { WEB_LIVE_STREAM_CAP, type WebPtyHub } from './webPty';

let hub: WebPtyHub | null = null;

/** main.tsx installs the page's hub before the first render. */
export function setWebPtyHub(next: WebPtyHub | null): void {
  hub = next;
}

const noopSubscribe = () => () => undefined;
const zero = () => 0;

interface WebTerminalProps {
  chatView?: boolean;
  ptyId?: string;
  shell?: string;
  cwd?: string;
  onPtyCreated?: (ptyId: string) => void;
  isActive?: boolean;
  visible?: boolean;
  isWorkspaceVisible?: boolean;
  scrollbackFile?: string;
  workspaceId?: string;
  surfaceId?: string;
}

function Body({ surfaceId, children }: { surfaceId: string; children: React.ReactNode }) {
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[var(--bg-base)] text-sm"
      style={{ color: 'var(--text-sub2)' }}
      data-surface-id={surfaceId}
      data-web-terminal-waiting
    >
      {children}
    </div>
  );
}

export default function WebTerminal({
  ptyId, cwd, isActive = true, visible, isWorkspaceVisible = true, workspaceId, surfaceId = '',
}: WebTerminalProps) {
  const t = useT();
  const h = hub;
  useSyncExternalStore(h ? h.subscribe : noopSubscribe, h ? h.version : zero);

  // The phone shows one pane through the app's zoom; PaneContainer hides the
  // others with CSS but still tells them they are visible.
  const zoomHidden = useStore((s) => {
    const zoomed = s.zoomedPaneId;
    if (!zoomed || !surfaceId) return false;
    const ws = s.workspaces.find((w) => w.id === (workspaceId ?? s.activeWorkspaceId));
    if (!ws || !findLeaf(ws.rootPane, zoomed)) return false;
    const leaf = findLeafBySurfaceId(ws.rootPane, surfaceId);
    return !!leaf && leaf.id !== zoomed;
  });
  const title = useStore((s) => {
    for (const ws of s.workspaces) {
      for (const leaf of getLeafPanes(ws.rootPane)) {
        const hit = leaf.surfaces.find((x) => x.id === surfaceId);
        if (hit) return hit.title;
      }
    }
    return '';
  });

  const shown = isWorkspaceVisible && (visible ?? isActive) && !zoomHidden;
  const id = ptyId ?? '';

  useEffect(() => {
    if (!h || !shown || !id) return;
    h.request(id);
    return () => h.release(id);
  }, [h, shown, id]);

  if (!shown || !id || !h) return null;
  const geometry = h.geometryOf(id);
  if (!h.isLive(id)) {
    return (
      <Body surfaceId={surfaceId}>
        <span className="truncate max-w-[80%]" style={{ color: 'var(--text-sub)' }}>{title}</span>
        <span className="text-xs">{t('web.streamWaiting', { count: WEB_LIVE_STREAM_CAP })}</span>
        <button
          type="button"
          className={`rounded border px-3 py-1 text-xs ${FOCUS_RING}`}
          style={{ borderColor: 'var(--border)', color: 'var(--text-main)' }}
          onClick={() => h.activate(id)}
          data-web-terminal-activate
        >
          {t('web.streamShow')}
        </button>
      </Body>
    );
  }
  if (!geometry) {
    return (
      <Body surfaceId={surfaceId}>
        <span className="text-xs">{t('web.streamConnecting')}</span>
      </Body>
    );
  }
  return (
    <TerminalComponent
      ptyId={id}
      cwd={cwd}
      isActive={isActive}
      visible={visible}
      isWorkspaceVisible={isWorkspaceVisible}
      workspaceId={workspaceId}
      surfaceId={surfaceId}
      fixedGeometry={geometry}
    />
  );
}
