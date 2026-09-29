import { useEffect, useRef, useCallback, useState, type CSSProperties } from 'react';
import { LAYOUT_PRESETS } from '../../../shared/layoutPresets';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import { createWorkspaceWithRemotePane } from '../../utils/remotePaneWorkspace';
import { destroyRemoteSessions } from '../../utils/remoteSessionTeardown';
import AttachRemoteModal from './AttachRemoteModal';
import AddRemotePaneModal from '../Remote/AddRemotePaneModal';

interface PresetPickerProps {
  onClose: () => void;
  /** Viewport-fixed anchor (left/top px). The default `absolute right-2
   *  top-10` placement predates the Bridge titlebar (#409) and only works
   *  inside the sidebar's positioning context — rendered from the titlebar
   *  it resolved against the full-width header and the menu opened at the
   *  far RIGHT edge of the window (owner-reported). The titlebar measures
   *  its + button and passes the anchor instead. */
  anchorStyle?: CSSProperties;
}

export default function PresetPicker({ onClose, anchorStyle }: PresetPickerProps) {
  const t = useT();
  const addWorkspace = useStore((s) => s.addWorkspace);
  const addWorkspaceWithPreset = useStore((s) => s.addWorkspaceWithPreset);
  const ref = useRef<HTMLDivElement>(null);
  // Selecting "Attach remote workspace…" swaps this dropdown for the modal
  // rather than closing it — AttachRemoteModal owns its own full-screen
  // backdrop dismissal, and the whole thing closes via the same onClose the
  // picker itself uses once the modal is done.
  const [attachRemoteOpen, setAttachRemoteOpen] = useState(false);
  // A "Pair again" opens AppLayout's own copy of the attach dialog; two
  // stacked copies would fight over focus and Escape, so this one yields.
  const remoteRepairHostId = useStore((s) => s.remoteRepairHostId);
  // The sidebar's Remote hub owns "Other computers"; this entry opens it
  // there. Only when no hub is mounted (the sidebar nav is not rendered) does
  // the attach dialog open here instead, so the entry never goes dead.
  const remoteHubMounted = useStore((s) => s.remoteHubMounted > 0);
  const openRemoteHub = useStore((s) => s.openRemoteHub);
  const handleAttachRemote = useCallback(() => {
    if (remoteHubMounted) {
      openRemoteHub();
      onClose();
    } else {
      setAttachRemoteOpen(true);
    }
  }, [remoteHubMounted, openRemoteHub, onClose]);
  useEffect(() => {
    if (remoteRepairHostId) onClose();
  }, [remoteRepairHostId, onClose]);

  // #1323 — "Empty — remote" is offered only while at least one host is
  // paired; with none, this menu renders exactly the rows it always did.
  // Pairing is app-wide, so the question is asked of the host list, not of a
  // workspace. A rejected read leaves the row out rather than surfacing here.
  const [hasPairedHost, setHasPairedHost] = useState(false);
  useEffect(() => {
    let cancelled = false;
    window.electronAPI?.remote?.hostsList?.()
      .then((list) => { if (!cancelled) setHasPairedHost(list.length > 0); })
      .catch(() => { /* no row */ });
    return () => { cancelled = true; };
  }, []);
  // Same swap as attachRemoteOpen: the dropdown gives way to the host picker
  // the ⋮ menu's remote entries open (AddRemotePaneModal).
  const [remotePaneOpen, setRemotePaneOpen] = useState(false);
  // The modal calls onCreated after its host round-trip (up to the request
  // timeout) with no check that it is still on screen, and every way out of it
  // (Escape, backdrop, a repair) unmounts this picker. A mint that lands after
  // that was cancelled: creating the workspace then would switch the user's
  // screen to something they backed out of, and a retry would leave two. The
  // session exists on the host by then, so it is destroyed rather than left
  // running (#1129). The happy path never sees the flag — the modal calls
  // onCreated before onClose. Reset on mount so a StrictMode re-mount counts
  // as mounted.
  const dismissedRef = useRef(false);
  useEffect(() => {
    dismissedRef.current = false;
    return () => { dismissedRef.current = true; };
  }, []);
  const handleRemotePaneCreated = useCallback((hostId: string, sessionId: string, remoteWorkspaceId: string) => {
    if (dismissedRef.current) {
      destroyRemoteSessions([{ hostId, sessionId }]);
      return;
    }
    createWorkspaceWithRemotePane(useStore.getState, destroyRemoteSessions, { hostId, sessionId, remoteWorkspaceId });
  }, []);

  const handleSelect = useCallback((presetId: string | null) => {
    if (presetId === null) {
      // Empty workspace (single leaf, same as before)
      addWorkspace();
    } else {
      addWorkspaceWithPreset(presetId);
    }
    onClose();
  }, [addWorkspace, addWorkspaceWithPreset, onClose]);

  const handleBrowseFolder = useCallback(async () => {
    const folders = await window.electronAPI?.dialog?.pickFolder();
    if (folders && folders.length > 0) {
      const folderPath = folders[0];
      const folderName = folderPath.split(/[/\\]/).filter(Boolean).pop() || 'Workspace';
      addWorkspace(folderName, { startupCwd: folderPath });
      onClose();
    }
  }, [addWorkspace, onClose]);

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid the click that opened the picker from immediately closing it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handler);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handler);
    };
  }, [onClose]);

  // Close on ESC
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (attachRemoteOpen) {
    return <AttachRemoteModal onClose={onClose} />;
  }
  if (remotePaneOpen) {
    // The heading is the row's own label (#1148: the dialog names the entry
    // that opened it).
    return (
      <AddRemotePaneModal
        title={t('sidebar.emptyRemote')}
        onClose={onClose}
        onCreated={handleRemotePaneCreated}
      />
    );
  }

  return (
    <div
      ref={ref}
      style={{ ...anchorStyle, '--wmux-menu-top': typeof anchorStyle?.top === 'number' ? `${anchorStyle.top}px` : anchorStyle?.top } as CSSProperties}
      className={`wmux-workspace-menu ${anchorStyle ? 'fixed' : 'absolute right-2 top-10'} z-50 w-52 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-1 text-[13px]`}
    >
      {/* Browse folder option */}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
        onClick={handleBrowseFolder}
      >
        {/* Every other row in this menu is label + description, so dropping this
            one's sub-line entirely left it reading as a section header. It says
            something now instead of restating the label: the old line was "Pick
            a folder as workspace" in a menu whose only job is making one. */}
        <div className="font-semibold">{t('sidebar.browseFolder')}</div>
        <div className="text-[var(--text-sub)] text-[11px]">{t('sidebar.browseFolderDesc')}</div>
      </button>

      <div className="border-t border-[var(--bg-surface)] my-0.5" />

      {/* Empty workspace option */}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
        onClick={() => handleSelect(null)}
      >
        <div className="font-semibold">{t('sidebar.emptyWorkspace')}</div>
        <div className="text-[var(--text-sub)] text-[11px]">{t('sidebar.blankSinglePane')}</div>
      </button>

      <div className="border-t border-[var(--bg-surface)] my-0.5" />

      {/* Preset options */}
      {LAYOUT_PRESETS.filter((p) => p.id !== 'single').map((preset) => (
        <button
          key={preset.id}
          className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
          onClick={() => handleSelect(preset.id)}
        >
          <div className="font-semibold">{t(`preset.${preset.id}.name`)}</div>
          <div className="text-[var(--text-sub)] text-[11px]">{t(`preset.${preset.id}.description`)}</div>
        </button>
      ))}

      <div className="border-t border-[var(--bg-surface)] my-0.5" />

      {/* Remote Workspace Attach entry — opens the Remote hub on "Other
          computers" (or, with no hub mounted, AttachRemoteModal in place of
          this dropdown; see attachRemoteOpen above). */}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
        onClick={handleAttachRemote}
      >
        <div className="font-semibold">{t('remote.attachTitle')}…</div>
        <div className="text-[var(--text-sub)] text-[11px]">{t('remote.mirrorDescription')}</div>
      </button>

      {/* #1323 — a blank single pane that runs on a paired computer: the
          remote twin of "Empty" above. Last, so arriving after the host list
          resolves moves no row already on screen; beside "Attach", so
          watching (mirror) and working (a real pane) read as the two remote
          choices they are. */}
      {hasPairedHost && (
        <button
          className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
          onClick={() => setRemotePaneOpen(true)}
          data-preset-remote-pane
        >
          <div className="font-semibold">{t('sidebar.emptyRemote')}…</div>
          <div className="text-[var(--text-sub)] text-[11px]">{t('sidebar.blankSingleRemotePane')}</div>
        </button>
      )}
    </div>
  );
}
