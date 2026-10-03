import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import { useT } from '../../hooks/useT';
import Popover from '../ui/Popover';
import { IconCheck } from '../icons';
import type { FilterChip, WorkspaceFilter } from './workspaceFilter';

const GROUPS: { titleKey: string; options: FilterChip[] }[] = [
  { titleKey: 'sidebar.filter.status', options: [
    { group: 'status', value: 'needsYou' }, { group: 'status', value: 'running' }, { group: 'status', value: 'idle' },
  ] },
  { titleKey: 'sidebar.filter.kind', options: [{ group: 'kind', value: 'agent' }, { group: 'kind', value: 'terminal' }] },
  { titleKey: 'sidebar.filter.agent', options: [
    { group: 'agent', value: 'claude' }, { group: 'agent', value: 'codex' }, { group: 'agent', value: 'other' },
  ] },
  { titleKey: 'sidebar.filter.other', options: [
    { group: 'other', value: 'pr' }, { group: 'other', value: 'changes' }, { group: 'other', value: 'tasks' },
    { group: 'hideTasks', value: true },
  ] },
];

/** The i18n key naming one check (also the chip's label). */
export function filterChipKey(chip: FilterChip): string {
  return chip.group === 'hideTasks' ? 'sidebar.filter.hideTasks' : `sidebar.filter.${chip.group}.${chip.value}`;
}

export function chipOn(filter: WorkspaceFilter, chip: FilterChip): boolean {
  return chip.group === 'hideTasks' ? filter.hideTasks : (filter[chip.group] as string[]).includes(chip.value);
}

/**
 * The workspace filter popover: the text search on top, then the facet
 * checks in groups. ↑↓ move between the search and the checks, Space or
 * Enter toggles, Escape closes and hands focus back to the filter button.
 */
export default function WorkspaceFilterPopover({ query, onQuery, filter, onToggle, onClose, searchRef }: {
  query: string;
  onQuery: (value: string) => void;
  filter: WorkspaceFilter;
  onToggle: (chip: FilterChip) => void;
  onClose: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => { searchRef.current?.focus(); }, [searchRef]);
  // Closes on a press outside it (the filter button toggles on its own).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (panelRef.current?.contains(target) || target?.closest?.('[data-sidebar-search-toggle]')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('input, [data-filter-option]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <Popover ref={panelRef} className="wmux-ws-filter" aria-label={t('sidebar.filterWorkspaces')} onKeyDown={onKeyDown} data-ws-filter>
      <input
        ref={searchRef}
        type="text"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        placeholder={t('sidebar.searchPlaceholder')}
        aria-label={t('sidebar.searchPlaceholder')}
        className="ui-input h-8 text-[13px]"
        data-ws-filter-search
      />
      {GROUPS.map((group) => (
        <div key={group.titleKey} className="wmux-ws-filter-group" role="group" aria-label={t(group.titleKey)}>
          <div className="wmux-ws-filter-title">{t(group.titleKey)}</div>
          {group.options.map((chip) => {
            const on = chipOn(filter, chip);
            return (
              <button
                key={filterChipKey(chip)}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className="wmux-ws-filter-option"
                onClick={() => onToggle(chip)}
                data-filter-option={filterChipKey(chip)}
              >
                <span className="wmux-ws-filter-box" aria-hidden="true">{on && <IconCheck size={11} />}</span>
                {t(filterChipKey(chip))}
              </button>
            );
          })}
        </div>
      ))}
    </Popover>
  );
}
