// ─── Settings layout: section, row, note ─────────────────────────────────────
//
// DESIGN.md "Settings": a section is a muted sentence-case heading over ONE
// rounded container; its rows are Field rows separated by hairlines, never a
// boxed card per row. A long explanation collapses to one line with a Learn
// more disclosure instead of a four-line paragraph. `id` (a catalog id) makes
// a section or row a jump target for settings search — SettingsPanel's
// `jumpTo` scrolls to `[data-setting-id]`.
//
// Shared by SettingsPanel and the section files it renders (Claude
// integration, accounts, quick commands), which is why it is its own module:
// those files are imported BY SettingsPanel and cannot import from it.

import { useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { useT } from '../../hooks/useT';
import { FOCUS_RING } from '../focusRing';
import Field from '../ui/Field';

/**
 * One-line clamp with a disclosure that appears only when the line actually
 * overflows at the current width (measured, not guessed from the length, so
 * CJK copy and a resized window both get it right). The clamp is visual: the
 * full text stays in the DOM, so a control's aria-describedby reads all of it.
 */
function useClamp<T extends HTMLElement>(text: string | undefined) {
  const ref = useRef<T>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);
  return {
    ref,
    clampClass: expanded ? undefined : 'settings-clamp',
    toggle: overflows || expanded
      ? <MoreToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
      : null,
  };
}

/** The Learn more / Show less disclosure under collapsed copy. The full text
 *  stays in the DOM either way, so assistive tech always reads all of it. */
function MoreToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className={`settings-more ${FOCUS_RING}`}
      aria-expanded={expanded}
      onClick={onToggle}
    >
      {expanded ? t('settings.showLess') : t('settings.learnMore')}
    </button>
  );
}

export function SettingsSection({
  id,
  title,
  description,
  action,
  overflowVisible = false,
  children,
  'data-testid': testId,
}: {
  id?: string;
  /** Omitted for a lead group whose one row already names itself. */
  title?: string;
  description?: string;
  /** Trailing control on the heading line (e.g. a Refresh or Reset). */
  action?: ReactNode;
  /** For a group holding an in-place dropdown (the font list): the group's
   *  rounded clip would otherwise cut the list off. */
  overflowVisible?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}) {
  const clamp = useClamp<HTMLParagraphElement>(description);
  return (
    <section className="settings-section scroll-mt-4" data-setting-id={id} data-testid={testId}>
      {(title || action) && (
        <div className="settings-section-head">
          {title && <h3 className="ui-group-label settings-section-title">{title}</h3>}
          {action}
        </div>
      )}
      {description && (
        <div className="settings-section-desc">
          <p ref={clamp.ref} className={`m-0 ${clamp.clampClass ?? ''}`}>{description}</p>
          {clamp.toggle}
        </div>
      )}
      <div className={`ui-group${overflowVisible ? ' settings-group-open' : ''}`}>{children}</div>
    </section>
  );
}

export function SettingRow({
  id,
  label,
  description,
  layout = 'inline',
  children,
}: {
  id?: string;
  label: string;
  description?: string;
  layout?: 'inline' | 'stacked';
  children?: ReactNode;
}) {
  const clamp = useClamp<HTMLSpanElement>(description);
  return (
    <div data-setting-id={id} className="settings-row scroll-mt-4">
      <Field
        label={label}
        layout={layout}
        description={description == null ? undefined : (
          <span ref={clamp.ref} className={clamp.clampClass}>{description}</span>
        )}
      >
        {children}
      </Field>
      {clamp.toggle}
    </div>
  );
}

/** A muted line inside a section's container: a caveat, an empty state, or a
 *  status that belongs to the rows above it. `tone` tints the text only. */
export function SettingNote({
  children,
  tone = 'muted',
  className = '',
  ...rest
}: HTMLAttributes<HTMLParagraphElement> & { tone?: 'muted' | 'warning' | 'danger' }) {
  return (
    <p className={`ui-note settings-note ${className}`} data-tone={tone} {...rest}>
      {children}
    </p>
  );
}
