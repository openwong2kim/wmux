// The Git page header's repo switcher: the shown repo's name is a button that
// opens a filterable list — All repos on top, every repo of the open
// workspaces, then Follow active workspace. Type to filter, arrows move, Enter
// picks, Esc closes and returns focus to the button. A popover, not a modal:
// a press outside closes it.
import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import { IconChevron } from '../icons';
import Popover from '../ui/Popover';

/** 'all', 'follow', or a repo group's key. */
export type RepoChoice = string;

export interface RepoOption {
  value: RepoChoice;
  label: string;
  /** Muted second part: a repo's checkouts, its counts. */
  sub?: string;
}

export function RepoSwitcher({ label, current, options, onPick, onOpenChange }: {
  label: string;
  current: RepoChoice;
  /** All repos first, the repos, then Follow active workspace. */
  options: RepoOption[];
  onPick: (value: RepoChoice) => void;
  /** The menu opened or closed (the page resolves every repo while it is open). */
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  useEffect(() => { onOpenChangeRef.current?.(open); }, [open]);

  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q)) : options;
  const at = Math.min(active, Math.max(shown.length - 1, 0));

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    if (refocus) triggerRef.current?.focus();
  };
  const openMenu = () => {
    setQuery('');
    setActive(Math.max(0, options.findIndex((o) => o.value === current)));
    setOpen(true);
  };
  const pick = (value: RepoChoice) => {
    onPick(value);
    close(true);
  };
  // A press outside closes it (focus stays where the press put it).
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (shown.length === 0) return;
      setActive((at + (e.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : shown.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[at]) pick(shown[at].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    }
  };

  return (
    <div className="wmux-git-repo-switch" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`wmux-git-repo-trigger ${FOCUS_RING}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('git.repoMenu.label', { repo: label })}
        onClick={() => (open ? close(false) : openMenu())}
        data-git-repo-switcher
      >
        <span className="wmux-git-repo-trigger-text" data-git-page-repo>{label}</span>
        <span className="wmux-git-chevron" data-open={open ? 'true' : undefined} aria-hidden="true"><IconChevron size={12} /></span>
      </button>
      {open && (
        <Popover className="wmux-git-repo-menu" data-git-repo-menu>
          <input
            type="text"
            className={`wmux-git-repo-filter ${FOCUS_RING}`}
            autoFocus
            value={query}
            placeholder={t('git.repoMenu.filter')}
            aria-label={t('git.repoMenu.filter')}
            role="combobox"
            aria-expanded
            aria-controls={`${id}-list`}
            aria-activedescendant={shown[at] ? `${id}-opt-${at}` : undefined}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKey}
            data-git-repo-filter
          />
          <ul id={`${id}-list`} role="listbox" aria-label={t('git.repoMenu.title')} className="wmux-git-repo-list">
            {shown.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-opt-${i}`}
                role="option"
                aria-selected={o.value === current}
                data-active={i === at ? 'true' : undefined}
                data-git-repo-option={o.value}
                className="wmux-git-repo-option"
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o.value)}
              >
                <span className="wmux-git-repo-option-label">{o.label}</span>
                {o.sub && <span className="wmux-git-repo-option-sub">{o.sub}</span>}
              </li>
            ))}
            {shown.length === 0 && <li className="wmux-git-note" role="presentation">{t('git.repoMenu.none')}</li>}
          </ul>
        </Popover>
      )}
    </div>
  );
}
