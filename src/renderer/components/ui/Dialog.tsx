import { createContext, forwardRef, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { IconX } from '../icons';
import { FOCUS_RING } from '../focusRing';
import { focusableWithin, useModalLayer } from './modalLayer';

export { focusableWithin } from './modalLayer';

/**
 * Modal dialog primitive: backdrop + panel with Header / Body / Footer slots.
 *
 * Stacking and backdrop follow the existing modal convention (the approval
 * and project dialogs): an inline `fixed inset-0` root at `--z-dialog` over
 * `--backdrop-modal`. No portal, so a dialog stacks exactly where the
 * component that renders it already did. The panel is a quiet surface: 14px
 * radius, 24px padding, a hairline and one soft shadow (styles/ui.css).
 *
 * Behaviour (keyboard and focus live in ./modalLayer, shared with the tour):
 * - `role="dialog"`, `aria-modal`, labelled by the Header title and described
 *   by its description when present.
 * - Escape closes the top-most dialog only (never mid-IME), and does not reach
 *   anything underneath. Pass `onEscape` to override, or
 *   `closeOnEscape={false}` to ignore it.
 * - Tab / Shift+Tab wrap inside the panel while focus is inside it.
 * - Focus moves in on mount (`initialFocusRef`, else the first focusable
 *   control, else the panel), comes back if a re-render drops it on <body>,
 *   and returns to the opener on close.
 * - `focusOnOpen="none"` is for a dialog that opens by itself (an approval, a
 *   launch prompt): it leaves focus where the user is, so their next Enter or
 *   Space cannot answer it unseen. The panel is not a focus target, and
 *   Escape / Tab / focus healing apply only once focus is inside it.
 */

interface DialogIds {
  titleId: string;
  descriptionId: string;
  onClose: () => void;
  setHasDescription: (has: boolean) => void;
}

const DialogContext = createContext<DialogIds | null>(null);

export interface DialogProps {
  onClose: () => void;
  children?: ReactNode;
  /** Panel width in px (capped to the viewport). Default 480. */
  width?: number;
  /** Replace the default Escape behaviour (closing). */
  onEscape?: () => void;
  closeOnEscape?: boolean;
  /** Close when the backdrop itself is clicked. Default false. */
  closeOnBackdrop?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** `first` (default): focus moves in on open. `none`: focus stays where the
   *  user is — for a dialog the app opens by itself. */
  focusOnOpen?: 'first' | 'none';
  /** Tailwind z-index class for the root. Default `z-[var(--z-dialog)]`. */
  zIndexClassName?: string;
  /** Set when the dialog has no DialogHeader title to point at. */
  ariaLabel?: string;
  /** `alertdialog` for a prompt that interrupts to demand an answer
   *  (approvals, consent). Default `dialog`. */
  role?: 'dialog' | 'alertdialog';
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
  backdropTestId?: string;
}

export default function Dialog({
  onClose,
  children,
  width = 480,
  onEscape,
  closeOnEscape = true,
  closeOnBackdrop = false,
  initialFocusRef,
  focusOnOpen = 'first',
  zIndexClassName = 'z-[var(--z-dialog)]',
  ariaLabel,
  role = 'dialog',
  className = '',
  style,
  'data-testid': testId,
  backdropTestId,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [hasDescription, setHasDescription] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const passive = focusOnOpen === 'none';
  const attachLayer = useModalLayer({
    onEscape: onEscape ?? (closeOnEscape ? () => onCloseRef.current() : undefined),
    passive,
  });
  const setPanel = useCallback(
    (el: HTMLDivElement | null) => {
      panelRef.current = el;
      attachLayer(el);
    },
    [attachLayer],
  );

  useEffect(() => {
    if (passive) return;
    const panel = panelRef.current;
    const target = initialFocusRef?.current ?? (panel ? focusableWithin(panel)[0] : null) ?? panel;
    target?.focus();
    // Mount only: initialFocusRef is read once, like autoFocus.
  }, []);

  return (
    <div
      className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center`}
      style={{ backgroundColor: 'var(--backdrop-modal)' }}
      data-testid={backdropTestId}
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <DialogContext.Provider value={{ titleId, descriptionId, onClose, setHasDescription }}>
        <div
          ref={setPanel}
          role={role}
          aria-modal="true"
          aria-labelledby={ariaLabel ? undefined : titleId}
          aria-label={ariaLabel}
          aria-describedby={hasDescription ? descriptionId : undefined}
          tabIndex={passive ? undefined : -1}
          className={`ui-dialog ui-surface${className ? ` ${className}` : ''}`}
          style={{ width, ...style }}
          data-testid={testId}
        >
          {children}
        </div>
      </DialogContext.Provider>
    </div>
  );
}

function useDialogIds(): DialogIds {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error('Dialog parts must be rendered inside <Dialog>');
  return ctx;
}

export interface DialogHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Accessible name of the × button. Omit to render no close button. */
  closeLabel?: string;
  closeTestId?: string;
  /** Disable the × while an action that must not be dismissed is in flight. */
  closeDisabled?: boolean;
  /** Defaults to the Dialog's onClose. */
  onClose?: () => void;
}

/** Title (16px/600), optional description (13px, --text-sub), close ×. */
export const DialogHeader = forwardRef<HTMLButtonElement, DialogHeaderProps>(function DialogHeader(
  { title, description, closeLabel, closeTestId, closeDisabled, onClose },
  closeRef,
) {
  const ids = useDialogIds();
  const hasDescription = description != null;
  const { setHasDescription } = ids;
  useEffect(() => {
    setHasDescription(hasDescription);
  }, [hasDescription, setHasDescription]);
  return (
    <div className="ui-dialog-header">
      <div className="ui-dialog-heading">
        <h2 id={ids.titleId} className="ui-dialog-title">
          {title}
        </h2>
        {hasDescription && (
          <p id={ids.descriptionId} className="ui-dialog-description">
            {description}
          </p>
        )}
      </div>
      {closeLabel && (
        <button
          ref={closeRef}
          type="button"
          className={`ui-icon-btn ui-dialog-close ${FOCUS_RING}`}
          aria-label={closeLabel}
          data-testid={closeTestId}
          disabled={closeDisabled}
          onClick={onClose ?? ids.onClose}
        >
          <IconX size={14} />
        </button>
      )}
    </div>
  );
});

export function DialogBody({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`ui-dialog-body${className ? ` ${className}` : ''}`}>{children}</div>;
}

/** Right-aligned action row. Put the single primary action last. */
export function DialogFooter({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`ui-dialog-footer${className ? ` ${className}` : ''}`}>{children}</div>;
}
