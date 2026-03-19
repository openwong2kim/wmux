import type { Surface } from '../../../shared/types';

interface SurfaceTabsProps {
  surfaces: Surface[];
  activeSurfaceId: string;
  onSelect: (surfaceId: string) => void;
  onClose: (surfaceId: string) => void;
  onAdd: () => void;
}

export default function SurfaceTabs({ surfaces, activeSurfaceId, onSelect, onClose, onAdd }: SurfaceTabsProps) {
  // Surface가 1개 이하일 때는 탭 목록을 숨기되 + 버튼만 표시
  if (surfaces.length <= 1) {
    return (
      <div className="flex items-center justify-end h-7 bg-[#181825] border-b border-[#313244] px-1">
        <button
          className="px-2 h-full text-[#6c7086] hover:text-[#a6e3a1] text-xs transition-colors"
          onClick={onAdd}
          title="New tab (Ctrl+T)"
        >
          +
        </button>
      </div>
    );
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
          <button
            className="opacity-0 group-hover:opacity-100 text-[#6c7086] hover:text-[#f38ba8] transition-opacity ml-1"
            onClick={(e) => { e.stopPropagation(); onClose(s.id); }}
          >
            ✕
          </button>
        </div>
      ))}
      <button
        className="px-2 h-full text-[#6c7086] hover:text-[#a6e3a1] text-xs transition-colors"
        onClick={onAdd}
        title="New surface (Ctrl+T)"
      >
        +
      </button>
    </div>
  );
}
