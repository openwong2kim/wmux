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
  // Always render the strip — even for a single surface — so the X button is
  // reachable. Pane.tsx's handleCloseSurface cascades into closePane when the
  // last surface is removed, so this is also the only mouse path to dismantle
  // a split. Hiding it left users unable to close split panes (the keyboard
  // shortcut Ctrl+W now mirrors the same cascade, but the X must exist too).

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
