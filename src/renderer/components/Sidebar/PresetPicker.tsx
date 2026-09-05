import { useEffect, useRef, useCallback, useState, type CSSProperties } from 'react';
import { LAYOUT_PRESETS } from '../../../shared/layoutPresets';
import { useStore } from '../../stores';
import { useT } from '../../hooks/useT';
import AttachRemoteModal from './AttachRemoteModal';

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

  return (
    <div
      ref={ref}
      style={anchorStyle}
      className={`${anchorStyle ? 'fixed' : 'absolute right-2 top-10'} z-50 w-52 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-1 text-xs font-mono`}
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
        <div className="text-[var(--text-muted)] text-[10px]">{t('sidebar.browseFolderDesc')}</div>
      </button>

      <div className="border-t border-[var(--bg-surface)] my-0.5" />

      {/* Empty workspace option */}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
        onClick={() => handleSelect(null)}
      >
        <div className="font-semibold">{t('sidebar.emptyWorkspace')}</div>
        <div className="text-[var(--text-muted)] text-[10px]">{t('sidebar.blankSinglePane')}</div>
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
          <div className="text-[var(--text-muted)] text-[10px]">{t(`preset.${preset.id}.description`)}</div>
        </button>
      ))}

      <div className="border-t border-[var(--bg-surface)] my-0.5" />

      {/* Remote Workspace Attach entry — opens AttachRemoteModal in place of
          this dropdown (see attachRemoteOpen above). */}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
        onClick={() => setAttachRemoteOpen(true)}
      >
        <div className="font-semibold">{t('remote.attachTitle')}…</div>
        <div className="text-[var(--text-muted)] text-[10px]">{t('remote.mirrorDescription')}</div>
      </button>
    </div>
  );
}
