import React from 'react';
import { useT } from '../../hooks/useT';

export type PaletteCategory = 'workspace' | 'surface' | 'command';

export interface PaletteItemData {
  id: string;
  label: string;
  category: PaletteCategory;
  icon: React.ReactNode;
  action: () => void;
}

interface PaletteItemProps {
  item: PaletteItemData;
  isActive: boolean;
  onClick: () => void;
}

const categoryColor: Record<PaletteCategory, string> = {
  workspace: 'text-[var(--accent-blue)]',
  surface: 'text-[var(--accent-green)]',
  command: 'text-[var(--accent-purple)]',
};

export default function PaletteItem({ item, isActive, onClick }: PaletteItemProps) {
  const t = useT();

  const categoryLabel: Record<PaletteCategory, string> = {
    workspace: t('palette.catWorkspace'),
    surface: t('palette.catSurface'),
    command: t('palette.catCommand'),
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
        isActive
          ? 'bg-[var(--bg-surface)] text-[var(--text-main)]'
          : 'text-[var(--text-sub)] hover:bg-[#2a2a3d] hover:text-[var(--text-main)]',
      ].join(' ')}
    >
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-[var(--text-subtle)]">
        {item.icon}
      </span>
      <span className="flex-1 truncate text-sm">{item.label}</span>
      <span className={`shrink-0 text-xs font-medium ${categoryColor[item.category]}`}>
        {categoryLabel[item.category]}
      </span>
    </button>
  );
}
