import React, { memo } from 'react';
import { useT } from '../../hooks/useT';

export type PaletteCategory = 'workspace' | 'surface' | 'command' | 'recent';

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

function PaletteItem({ item, isActive, onClick }: PaletteItemProps) {
  const t = useT();

  const categoryLabel: Record<PaletteCategory, string> = {
    workspace: t('palette.catWorkspace'),
    surface: t('palette.catSurface'),
    command: t('palette.catCommand'),
    recent: t('palette.catRecent'),
  };

  return (
    <button
      type="button"
      onClick={onClick}
      // Quiet list row (DESIGN.md "Dialogs & forms"): an 8px chip inside the
      // panel inset, a faint neutral fill for the active row only (pointer
      // movement sets the active row, so hover needs no look of its own), and
      // a muted category label — no per-category colours.
      className={[
        'mx-1.5 flex w-[calc(100%-12px)] items-center gap-3 rounded-[8px] px-3 py-2 text-left transition-colors',
        isActive
          ? 'bg-[var(--surface-fill-hover)] text-[var(--text-main)]'
          : 'text-[var(--text-main)]',
      ].join(' ')}
    >
      <span className="shrink-0 w-4 h-4 flex items-center justify-center text-[var(--text-sub)]">
        {item.icon}
      </span>
      <span className="flex-1 truncate text-[13px] leading-5">{item.label}</span>
      <span className="shrink-0 text-[11px] leading-4 text-[var(--text-sub)]">
        {categoryLabel[item.category]}
      </span>
    </button>
  );
}

// A2: 리스트 자식 memo 방벽. 팔레트에서 activeIdx만 바뀔 때, 활성/비활성 경계의
// 두 항목 외 나머지 행은 리렌더를 건너뛴다(item.action은 buildItems 안에서
// 안정적으로 생성되므로 onClick 참조가 안정적).
export default memo(PaletteItem);
