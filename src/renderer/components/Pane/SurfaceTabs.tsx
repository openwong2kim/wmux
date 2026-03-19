import type { Surface } from '../../../shared/types';

interface SurfaceTabsProps {
  surfaces: Surface[];
  activeSurfaceId: string;
  onSelect: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
  onAdd: () => void;
}

export default function SurfaceTabs({ surfaces, activeSurfaceId, onSelect, onClose }: SurfaceTabsProps) {
  // Hide the tab bar entirely when there is only one surface — no tabs needed.
  // The X close button on a single tab would close the pane itself (handled by Pane.tsx),
  // so it is more intuitive to simply not show the tab strip in the single-tab case.
  if (surfaces.length <= 1) {
    return null;
  }

  return (
    <div className="flex items-center bg-[#181825] border-b border-[#313244] h-7 overflow-x-auto">
      {surfaces.map((s) => (
        <div
          key={s.id}
          className={`group flex items-center gap-1 px-3 h-full cursor-pointer text-xs border-r border-[#313244] transition-colors ${
            s.id === activeSurfaceId
              ? 'bg-[#1e1e2e] text-[#cdd6f4]'
              : 'text-[#6c7086] hover:text-[#bac2de] hover:bg-[#1e1e2e]/50'
          }`}
          onClick={() => onSelect(s.id)}
        >
          <span className="truncate max-w-[120px]">{s.title || 'Terminal'}</span>
          {/* X close button — always visible, not just on hover */}
          <button
            className="text-[#6c7086] hover:text-[#f38ba8] transition-colors ml-1 leading-none"
            onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
            title="Close tab"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
