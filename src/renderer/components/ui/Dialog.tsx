import { createContext, forwardRef, useContext, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, RefObject } from 'react';
import { IconX } from '../icons';
import { FOCUS_RING } from '../focusRing';

/**
 * Modal dialog primitive: backdrop + panel with Header / Body / Footer slots.
 *
 * Stacking and backdrop follow the existing modal convention (the first-run
 * wizard, approval and project dialogs): an inline `fixed inset-0` root at
 * `--z-dialog` over `--backdrop-modal`, panel shadow `--shadow-modal`. No
 * portal, so a dialog stacks exactly where the component that renders it
 * already did.
 *
 * Behaviour:
 * - `role="dialog"`, `aria-modal`, labelled by the Header title and described
 *   by its description when present.
 * - Tab / Shift+Tab stay inside the panel.
 * - Escape closes (capture phase on window, so a focused terminal cannot eat
 *   it first). Only the top-most open dialog reacts. Pass `onEscape` to
 *   override, or `closeOnEscape={false}` to ignore Escape.
 * - Focus moves in on mount (`initialFocusRef`, else the first focusable
 *   control, else the panel) and returns to the element that had it before
 *   the dialog opened.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Focusable descendants in DOM order, skipping anything hidden via `hidden`. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.closest('[hidden]') && el.getAttribute('aria-hidden') !== 'true',
  );
}

// Open dialogs, oldest first. Escape and the focus trap only act for the last.
const openStack: symbol[] = [];

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
  /** Tailwind z-index class for the root. Default `z-[var(--z-dialog)]`. */
  zIndexClassName?: string;
  /** Set when the dialog has no DialogHeader title to point at. */
  ariaLabel?: string;
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
  zIndexClassName = 'z-[var(--z-dialog)]',
  ariaLabel,
  className = '',
  style,
  'data-testid': testId,
  backdropTestId,
}: DialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const [hasDescription, setHasDescription] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const tokenRef = useRef<symbol>(Symbol('dialog'));

  // Latest handlers in refs so the listeners below are installed once.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const closeOnEscapeRef = useRef(closeOnEscape);
  closeOnEscapeRef.current = closeOnEscape;

  // Register on the stack, move focus in, and hand it back on unmount.
  useEffect(() => {
    const token = tokenRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openStack.push(token);

    const panel = panelRef.current;
    const target = initialFocusRef?.current ?? (panel ? focusableWithin(panel)[0] : null) ?? panel;
    target?.focus();

    return () => {
      const i = openStack.lastIndexOf(token);
      if (i !== -1) openStack.splice(i, 1);
      if (opener && opener.isConnected) opener.focus();
    };
    // Mount/unmount only: initialFocusRef is read once, like autoFocus.
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (openStack[openStack.length - 1] !== tokenRef.current) return;
      const panel = panelRef.current;
      if (!panel) return;

      if (e.key === 'Escape') {
        if (!closeOnEscapeRef.current && !onEscapeRef.current) return;
        e.stopPropagation();
        e.preventDefault();
        if (onEscapeRef.current) onEscapeRef.current();
        else onCloseRef.current();
        return;
      }

      if (e.key !== 'Tab') return;
      const items = focusableWithin(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
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
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={ariaLabel ? undefined : titleId}
          aria-label={ariaLabel}
          aria-describedby={hasDescription ? descriptionId : undefined}
          tabIndex={-1}
          className={`ui-dialog${className ? ` ${className}` : ''}`}
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
  /** Defaults to the Dialog's onClose. */
  onClose?: () => void;
}

/** Title (14px/600), optional description (13px, --text-sub), close ×. */
export const DialogHeader = forwardRef<HTMLButtonElement, DialogHeaderProps>(function DialogHeader(
  { title, description, closeLabel, closeTestId, onClose },
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
