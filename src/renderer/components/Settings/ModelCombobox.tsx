// ─── Model combobox for role bindings ────────────────────────────────────────
//
// Text input + a listbox of the models the agent CLI reported (ModelCatalog).
// Opening shows the FULL list regardless of the current value — a native
// <datalist> filters by the value, so a chosen field re-opened showed only
// itself — and typing filters. Free text is always accepted: a codex id or a
// model newer than the catalog must stay typeable.
//
// Keyboard: ArrowDown/ArrowUp move the active option (wrapping), Enter commits
// it (or keeps the typed text when none is active), Escape and Tab close. Focus
// stays on the input (aria-activedescendant), so options are not tab stops.

import { useEffect, useId, useState } from 'react';
import Input from '../ui/Input';
import Popover from '../ui/Popover';
import type { CatalogModel } from '../../../shared/modelCatalog';

export interface ModelComboboxProps {
  value: string;
  onChange: (value: string) => void;
  models: readonly CatalogModel[];
  'aria-label': string;
  placeholder?: string;
  className?: string;
  style?: React.CSSProperties;
}

export function ModelCombobox({
  value,
  onChange,
  models,
  placeholder,
  className,
  style,
  'aria-label': ariaLabel,
}: ModelComboboxProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  // What the user typed since opening; null = show everything.
  const [query, setQuery] = useState<string | null>(null);
  // Index into `shown` of the keyboard-highlighted option; -1 = none.
  const [active, setActive] = useState(-1);
  const baseId = useId();
  const listId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-option-${i}`;

  const q = query?.trim().toLowerCase() ?? '';
  const shown = q
    ? models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
    : models;
  const listOpen = open && shown.length > 0;
  const activeIndex = listOpen && active < shown.length ? active : -1;

  // Keep the highlighted option visible while arrowing through a long list.
  useEffect(() => {
    if (activeIndex < 0) return;
    document.getElementById(`${baseId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, baseId]);

  const close = () => {
    setOpen(false);
    setQuery(null);
    setActive(-1);
  };

  const commit = (id: string) => {
    onChange(id);
    close();
  };

  const move = (delta: 1 | -1) => {
    if (!open) {
      setOpen(true);
      setActive(delta === 1 ? 0 : shown.length - 1);
      return;
    }
    if (shown.length === 0) return;
    setActive((i) => {
      if (i < 0 || i >= shown.length) return delta === 1 ? 0 : shown.length - 1;
      return (i + delta + shown.length) % shown.length;
    });
  };

  return (
    <div className="relative" style={style} data-model-combobox>
      <Input
        type="text"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={listOpen}
        aria-autocomplete="list"
        aria-controls={listOpen ? listId : undefined}
        aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
        value={query ?? value}
        placeholder={placeholder}
        className={className}
        style={{ width: '100%' }}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          // Committed per keystroke, like the other binding fields: no edit can
          // be stranded by the panel unmounting. The store normalizes; the
          // field keeps showing the raw text until blur.
          setQuery(e.target.value);
          setActive(-1);
          setOpen(true);
          onChange(e.target.value);
        }}
        // Tabbing (or clicking) away closes the list; it never stays open
        // behind a field that no longer has focus.
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            move(e.key === 'ArrowDown' ? 1 : -1);
          } else if (e.key === 'Escape') {
            close();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIndex >= 0) {
              commit(shown[activeIndex].id);
            } else {
              // The typed text is already committed per keystroke.
              close();
              e.currentTarget.blur();
            }
          }
        }}
      />
      {listOpen && (
        // The quiet popover panel from ui/ (DESIGN.md). The roles section opts
        // into overflowVisible so the list is not clipped by the group.
        <Popover
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className="absolute left-0 top-full mt-1 z-50 min-w-[340px] max-h-64 overflow-y-auto"
          // Keep focus on the input: a mousedown here (an option, the
          // scrollbar) would otherwise blur it and close the list first.
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown.map((m, i) => (
            <button
              key={m.id}
              id={optionId(i)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={m.id === value}
              data-active={i === activeIndex || undefined}
              onClick={() => commit(m.id)}
              className={`flex items-center justify-between gap-3 w-full px-2.5 py-1 rounded-md text-left text-[12px] hover:bg-[var(--surface-fill-hover)] ${
                i === activeIndex ? 'bg-[var(--surface-fill-hover)] ' : ''
              }${
                m.id === value ? 'text-[var(--text-main)] font-semibold' : 'text-[var(--text-sub)] hover:text-[var(--text-main)]'
              }`}
            >
              <span className="font-mono whitespace-nowrap">{m.id}</span>
              <span className="opacity-70 whitespace-nowrap">{m.label}</span>
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}
