import React from 'react';

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

const categoryLabel: Record<PaletteCategory, string> = {
  workspace: 'Workspace',
  surface: 'Surface',
  command: 'Command',
};

const categoryColor: Record<PaletteCategory, string> = {
  workspace: 'text-[#89b4fa]',
  surface: 'text-[#a6e3a1]',
  command: 'text-[#cba6f7]',
};

export default function PaletteItem({ item, isActive, onClick }: PaletteItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors',
        isActive
          ? 'bg-[#313244] text-[#cdd6f4]'
          : 'text-[#bac2de] hover:bg-[#2a2a3d] hover:text-[#cdd6f4]',
      ].join(' ')}
    >
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-[#6c7086]">
        {item.icon}
      </span>
      <span className="flex-1 truncate text-sm">{item.label}</span>
      <span className={`shrink-0 text-xs font-medium ${categoryColor[item.category]}`}>
        {categoryLabel[item.category]}
      </span>
    </button>
  );
}
