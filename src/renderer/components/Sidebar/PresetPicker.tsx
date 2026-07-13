import { useEffect, useRef, useCallback, type CSSProperties } from 'react';
import { LAYOUT_PRESETS } from '../../../shared/layoutPresets';
import { useStore } from '../../stores';

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
  const addWorkspace = useStore((s) => s.addWorkspace);
  const addWorkspaceWithPreset = useStore((s) => s.addWorkspaceWithPreset);
  const ref = useRef<HTMLDivElement>(null);

  const handleSelect = useCallback((presetId: string | null) => {
    if (presetId === null) {
      // Empty workspace (single leaf, same as before)
      addWorkspace();
    } else {
      addWorkspaceWithPreset(presetId);
    }
    onClose();
  }, [addWorkspace, addWorkspaceWithPreset, onClose]);

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

  return (
    <div
      ref={ref}
      style={anchorStyle}
      className={`${anchorStyle ? 'fixed' : 'absolute right-2 top-10'} z-50 w-52 bg-[var(--bg-overlay)] border border-[var(--bg-surface)] rounded-md shadow-lg py-1 text-xs font-mono`}
    >
      {/* Empty workspace option */}
      <button
        className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
        onClick={() => handleSelect(null)}
      >
        <div className="font-semibold">Empty</div>
        <div className="text-[var(--text-muted)] text-[10px]">Blank single pane</div>
      </button>

      <div className="border-t border-[var(--bg-surface)] my-0.5" />

      {/* Preset options */}
      {LAYOUT_PRESETS.filter((p) => p.id !== 'single').map((preset) => (
        <button
          key={preset.id}
          className="w-full text-left px-3 py-1.5 hover:bg-[var(--bg-surface)] text-[var(--text-main)] transition-colors"
          onClick={() => handleSelect(preset.id)}
        >
          <div className="font-semibold">{preset.name}</div>
          <div className="text-[var(--text-muted)] text-[10px]">{preset.description}</div>
        </button>
      ))}
    </div>
  );
}
