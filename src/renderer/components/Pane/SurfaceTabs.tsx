import type { Surface } from '../../../shared/types';
import { useT } from '../../hooks/useT';

interface SurfaceTabsProps {
  surfaces: Surface[];
  activeSurfaceId: string;
  onSelect: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
  onAdd: () => void;
}

export default function SurfaceTabs({ surfaces, activeSurfaceId, onSelect, onClose }: SurfaceTabsProps) {
  const t = useT();
  // Hide the tab bar entirely when there is only one surface — no tabs needed.
  // The X close button on a single tab would close the pane itself (handled by Pane.tsx),
  // so it is more intuitive to simply not show the tab strip in the single-tab case.
  if (surfaces.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center bg-[var(--bg-mantle)] border-b border-[var(--bg-surface)] h-7 overflow-x-auto">
      {surfaces.map((s) => (
        <div
          key={s.id}
          className={`group flex items-center gap-1 px-3 h-full cursor-pointer text-xs border-r border-[var(--bg-surface)] transition-colors ${
            s.id === activeSurfaceId
              ? 'bg-[var(--bg-base)] text-[var(--text-main)]'
              : 'text-[var(--text-subtle)] hover:text-[var(--text-sub)] hover:bg-[rgba(var(--bg-base-rgb),0.5)]'
          }`}
          onClick={() => onSelect(s.id)}
        >
          <span className="truncate max-w-[120px]">{s.title || t('surface.terminal')}</span>
          {/* X close button — always visible, not just on hover */}
          <button
            className="text-[var(--text-subtle)] hover:text-[var(--accent-red)] transition-colors ml-1 leading-none"
            onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
            title={t('surface.closeTab')}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
