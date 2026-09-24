import { forwardRef } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';

/**
 * Popover panel: the quiet floating card from DESIGN.md "Dialogs & forms" —
 * 14px radius, hairline, one soft shadow — anchored by its caller. Positioning,
 * outside-click and Escape stay with each caller: a popover is not modal, so
 * it does not join the modal layer.
 *
 * The root carries `ui-surface` as well as `ui-popover`, so buttons, inputs and
 * icon toggles inside it get the flat surface treatment (styles/ui.css scopes
 * those overrides to `.ui-surface`).
 *
 * - default: 6px inset, for menus built from icon + label rows.
 * - `padded`: 16px inset, for popovers that hold a form or prose.
 */
export interface PopoverProps extends HTMLAttributes<HTMLDivElement> {
  padded?: boolean;
  'data-testid'?: string;
}

const Popover = forwardRef<HTMLDivElement, PopoverProps>(function Popover(
  { padded = false, role = 'dialog', className = '', ...rest },
  ref,
) {
  const cls = `ui-popover ui-surface${padded ? ' ui-popover-padded' : ''}${className ? ` ${className}` : ''}`;
  return <div ref={ref} role={role} className={cls} {...rest} />;
});

export default Popover;

export interface PopoverSectionProps {
  /** Muted sentence-case header. Omit for a section without one. */
  title?: ReactNode;
  /** Trailing action on the header row (e.g. a `+` or a text button). */
  action?: ReactNode;
  /** Id for the header text, so a region or dialog can point at it. */
  titleId?: string;
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}

/** One section of a popover. Consecutive sections are split by a hairline. */
export function PopoverSection({
  title,
  action,
  titleId,
  children,
  className = '',
  'data-testid': testId,
}: PopoverSectionProps) {
  return (
    <div className={`ui-section${className ? ` ${className}` : ''}`} data-testid={testId}>
      {(title != null || action != null) && (
        <div className="ui-section-header">
          <span id={titleId} className="min-w-0">
            {title}
          </span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
